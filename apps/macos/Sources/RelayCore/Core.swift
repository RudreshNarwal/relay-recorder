import Foundation
import CryptoKit
import Darwin

public enum RelayError: LocalizedError, Sendable {
    case invalidState, invalidServer, invalidMedia, server(String), missingWorkspace, speechConfigurationUnavailable
    public var errorDescription: String? {
        switch self {
        case .invalidState: "This action is unavailable in the current recording state."
        case .invalidServer: "Use an HTTPS server origin, or HTTP on localhost. Remove credentials and paths."
        case .invalidMedia: "The recording has no valid media. The original has been retained for recovery."
        case .server(let message): message
        case .missingWorkspace: "Sign in and select a workspace first."
        case .speechConfigurationUnavailable: "The selected speech provider changed or is unavailable. Retry it, or explicitly choose private server Parakeet for this recording."
        }
    }
}
public struct RecordingClock: Sendable {
    private enum State { case idle, running, paused, stopped }
    private var state: State = .idle
    private var accumulated: Double = 0
    private var anchor: Double = 0
    public init() {}
    public mutating func start(at time: Double) throws {
        guard state == .idle else { throw RelayError.invalidState }
        state = .running; anchor = time
    }
    public mutating func pause(at time: Double) throws {
        guard state == .running else { throw RelayError.invalidState }
        accumulated = elapsed(at: time); state = .paused
    }
    public mutating func resume(at time: Double) throws {
        guard state == .paused else { throw RelayError.invalidState }
        anchor = time; state = .running
    }
    public mutating func stop(at time: Double) throws {
        guard state == .running || state == .paused else { throw RelayError.invalidState }
        accumulated = elapsed(at: time); state = .stopped
    }
    public func elapsed(at time: Double) -> Double {
        accumulated + (state == .running ? max(0, time - anchor) : 0)
    }
}
public enum TranscriptionMode: String, Codable, CaseIterable, Sendable { case onDevice = "on_device", serverAPI = "server_api" }
public enum TranscriptionPreference: String, Codable, CaseIterable, Sendable {
    case automatic = "auto", localOnly = "local_only", server, external
    public func resolve(localReady: Bool) -> TranscriptionMode {
        self == .localOnly || (self == .automatic && localReady) ? .onDevice : .serverAPI
    }
}
public struct SpeechSelection: Codable, Equatable, Sendable {
    public let execution: String
    public let provider: String
    public let configurationId: String?
    public let configurationVersion: Int?
    public let model: String?
    public let language: String?
    public init(execution: String, provider: String, configurationId: String? = nil, configurationVersion: Int? = nil, model: String? = nil, language: String? = nil) {
        self.execution = execution; self.provider = provider; self.configurationId = configurationId
        self.configurationVersion = configurationVersion; self.model = model; self.language = language
    }
    public static func parakeet(_ mode: TranscriptionMode) -> Self { Self(execution: mode == .onDevice ? "device" : "server", provider: "parakeet") }
    public var label: String { provider == "parakeet" ? (execution == "device" ? "On-device Parakeet v3" : "Server Parakeet API") : "\(provider) · \(model ?? "configured model")" }
}
public struct SpeechCapabilitiesResponse: Decodable, Sendable { public let transcription: [SpeechOption] }
public struct SpeechOption: Decodable, Identifiable, Sendable {
    public let execution: String
    public let provider: String
    public let configurationId: String?
    public let configurationVersion: Int?
    public let model: String
    public let capabilities: Capabilities
    public struct Capabilities: Decodable, Sendable { public let languages: [String]; public let timing: String; public let externalAudio: Bool }
    public var id: String { configurationId ?? "\(execution)-\(provider)" }
    public var selection: SpeechSelection { SpeechSelection(execution: execution, provider: provider, configurationId: configurationId, configurationVersion: configurationVersion, model: model) }
}
public enum TranscriptSyncState: String, Codable, Sendable { case pending, uploading, synced, failed }
public enum RecordingState: String, Codable, Sendable { case preparing, recording, paused, interrupted, ready, uploading, uploaded, failed, canceled }
public struct UploadedPart: Codable, Equatable, Sendable { public let index: Int; public let sha256: String; public let size: Int }
public struct RecordingRecord: Codable, Identifiable, Sendable {
    public var id = UUID()
    public var title: String
    public var createdAt = Date()
    public var state: RecordingState = .preparing
    public var duration: Double = 0
    public var transcriptionMode: TranscriptionMode
    public var transcriptionSelection: SpeechSelection?
    public var transcriptionAdmissionRejected: Bool?
    /// Nil for journals written before the option existed; the server then applies its default.
    public var enhanceAudio: Bool?
    public var server: String?
    public var workspaceID: String?
    public var videoID: String?
    public var revisionID: String?
    public var uploadedParts: [UploadedPart] = []
    public var error: String?
    public var transcript: TranscriptPayload?
    public var transcriptSyncState: TranscriptSyncState?
    public var transcriptSyncError: String?
    public var transcriptVersion: UUID?
    public init(title: String, transcriptionMode: TranscriptionMode) { self.title = title; self.transcriptionMode = transcriptionMode }
}
public struct TranscriptWord: Codable, Sendable { public let start: Double; public let end: Double; public let text: String; public init(start: Double, end: Double, text: String) { self.start = start; self.end = end; self.text = text } }
public struct TranscriptSegment: Codable, Sendable { public let start: Double; public let end: Double; public let text: String; public let words: [TranscriptWord]?; public init(start: Double, end: Double, text: String, words: [TranscriptWord]? = nil) { self.start = start; self.end = end; self.text = text; self.words = words } }
public struct TranscriptPayload: Codable, Sendable { public var revisionId: String; public let segments: [TranscriptSegment]; public var language: String?; public init(revisionId: String = "", segments: [TranscriptSegment], language: String? = nil) { self.revisionId = revisionId; self.segments = segments; self.language = language } }
public actor JournalStore {
    public let root: URL
    public init(root: URL) throws { self.root = root; try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
    /// Creation only. Existing records can only change through field-owned transactions below.
    public func save(_ record: RecordingRecord) throws {
        guard !FileManager.default.fileExists(atPath: journalURL(record.id).path) else { throw RelayError.invalidState }
        _ = try persist(record)
    }
    public func record(id: UUID) throws -> RecordingRecord {
        try JSONDecoder().decode(RecordingRecord.self, from: Data(contentsOf: journalURL(id)))
    }
    @discardableResult public func updateCapture(id: UUID, state: RecordingState? = nil, duration: Double? = nil, error: String? = nil) throws -> RecordingRecord {
        var current = try record(id: id)
        // A queued timer or pause callback must not reopen a completed or canceled capture.
        guard ![.uploaded, .canceled].contains(current.state) else { return current }
        if let duration, duration.isFinite { current.duration = max(current.duration, max(0, duration)) }
        if let state {
            guard [.recording, .paused, .ready, .interrupted, .canceled].contains(state) else { throw RelayError.invalidState }
            current.state = state; current.error = error
        }
        return try persist(current)
    }
    @discardableResult public func recordSyncFailure(id: UUID, message: String) throws -> RecordingRecord {
        var current = try record(id: id)
        guard ![.uploaded, .canceled].contains(current.state) else { return current }
        if [.preparing, .ready, .uploading, .failed].contains(current.state) { current.state = .ready }
        current.error = message
        return try persist(current)
    }
    /// A new request invalidates earlier rejection proof before any network access.
    /// If its response is lost, the pinned selection must remain unchanged on retry.
    func beginAdmission(id: UUID) throws -> RecordingRecord {
        var current = try record(id: id)
        guard current.videoID == nil, current.state != .canceled else { throw RelayError.invalidState }
        current.transcriptionAdmissionRejected = false
        return try persist(current)
    }
    func rejectTranscriptionAdmission(id: UUID) throws {
        var current = try record(id: id)
        guard current.videoID == nil, current.state != .canceled else { throw RelayError.invalidState }
        current.transcriptionAdmissionRejected = true
        _ = try persist(current)
    }
    @discardableResult public func usePrivateTranscriptionAfterRejection(id: UUID) throws -> RecordingRecord {
        var current = try record(id: id)
        guard current.transcriptionAdmissionRejected == true, current.videoID == nil,
              current.state == .ready else { throw RelayError.invalidState }
        current.transcriptionMode = .serverAPI; current.transcriptionSelection = .parakeet(.serverAPI)
        current.transcriptionAdmissionRejected = false; current.error = nil
        return try persist(current)
    }
    /// Moves a not-yet-admitted on-device recording to private-server Parakeet, e.g. when the local model is missing.
    @discardableResult public func useServerParakeet(id: UUID) throws -> RecordingRecord {
        var current = try record(id: id)
        guard current.videoID == nil, [.ready, .failed].contains(current.state) else { throw RelayError.invalidState }
        current.transcriptionMode = .serverAPI; current.transcriptionSelection = .parakeet(.serverAPI)
        current.transcriptionAdmissionRejected = false; current.transcriptSyncState = nil; current.transcriptSyncError = nil; current.error = nil
        return try persist(current)
    }
    @discardableResult public func rename(id: UUID, title: String) throws -> RecordingRecord {
        var current = try record(id: id); current.title = title; return try persist(current)
    }
    @discardableResult public func setTranscript(id: UUID, transcript: TranscriptPayload) throws -> RecordingRecord {
        var current = try record(id: id)
        guard current.state != .canceled else { throw RelayError.invalidState }
        current.transcript = transcript; current.transcriptVersion = UUID()
        current.transcriptSyncState = .pending; current.transcriptSyncError = nil
        return try persist(current)
    }
    @discardableResult public func beginTranscriptSync(id: UUID) throws -> RecordingRecord {
        var current = try record(id: id)
        guard current.state == .uploaded, current.transcript != nil else { throw RelayError.invalidState }
        current.transcriptVersion = current.transcriptVersion ?? UUID()
        current.transcriptSyncState = .uploading; current.transcriptSyncError = nil
        return try persist(current)
    }
    @discardableResult public func finishTranscriptSync(id: UUID, version: UUID, error: String?) throws -> RecordingRecord {
        var current = try record(id: id)
        guard current.state != .canceled, current.transcriptVersion == version else { return current }
        current.transcriptSyncState = error == nil ? .synced : .failed
        current.transcriptSyncError = error
        return try persist(current)
    }
    @discardableResult public func recordTranscriptionFailure(id: UUID, message: String) throws -> RecordingRecord {
        var current = try record(id: id)
        guard current.state != .canceled, current.transcript == nil else { return current }
        current.transcriptSyncState = .failed; current.transcriptSyncError = message
        return try persist(current)
    }
    @discardableResult public func bindServer(id: UUID, server: String, workspaceID: String) throws -> RecordingRecord {
        var current = try record(id: id)
        guard current.server == nil || (current.server == server && current.workspaceID == workspaceID) else { throw RelayError.invalidState }
        current.server = server; current.workspaceID = workspaceID
        return try persist(current)
    }
    /// Upload owns remote identifiers and acknowledgments. Other writers cannot replace these fields.
    @discardableResult public func mergeUpload(_ upload: RecordingRecord, completed: Bool = false) throws -> RecordingRecord {
        var current = try record(id: upload.id)
        if let videoID = upload.videoID {
            guard current.videoID == nil || current.videoID == videoID else { throw RelayError.invalidState }
            current.videoID = videoID
            current.transcriptionAdmissionRejected = false
        }
        if let revisionID = upload.revisionID {
            guard current.revisionID == nil || current.revisionID == revisionID else { throw RelayError.invalidState }
            current.revisionID = revisionID
        }
        for part in upload.uploadedParts {
            if let previous = current.uploadedParts.first(where: { $0.index == part.index }) {
                guard previous == part else { throw RelayError.server("Conflicting local upload acknowledgment. Original media retained.") }
            } else { current.uploadedParts.append(part) }
        }
        current.uploadedParts.sort { $0.index < $1.index }
        if completed {
            guard current.state != .canceled else { throw RelayError.invalidState }
            current.state = .uploaded; current.error = nil
        }
        return try persist(current)
    }
    public func recover() throws -> [RecordingRecord] {
        var records: [RecordingRecord] = []
        for url in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) where url.pathExtension == "json" {
            // Preserve a damaged journal; one bad record must not hide the entire library.
            guard var record = try? JSONDecoder().decode(RecordingRecord.self, from: Data(contentsOf: url)), url.deletingPathExtension().lastPathComponent == record.id.uuidString else { continue }
            if [.preparing, .recording, .paused].contains(record.state) {
                record.state = .interrupted
                record.error = "Capture was interrupted. Complete MP4 fragments remain available for recovery."
                _ = try persist(record)
            } else if record.state == .uploading { record.state = .ready; _ = try persist(record) }
            if record.transcriptSyncState == .uploading {
                record.transcriptSyncState = .pending; record.transcriptSyncError = nil
                _ = try persist(record)
            }
            records.append(record)
        }
        return records.sorted { $0.createdAt > $1.createdAt }
    }
    public func remove(_ record: RecordingRecord) throws {
        for suffix in ["json", "mp4", "mp4.committed", "mp4.interrupted-original", "png", "wav", "m4a"] {
            let url = root.appendingPathComponent(record.id.uuidString).appendingPathExtension(suffix)
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        }
    }
    public func mediaURL(for record: RecordingRecord) throws -> URL { root.appendingPathComponent(record.id.uuidString).appendingPathExtension("mp4") }
    private func journalURL(_ id: UUID) -> URL { root.appendingPathComponent(id.uuidString).appendingPathExtension("json") }
    private func persist(_ record: RecordingRecord) throws -> RecordingRecord {
        let url = journalURL(record.id)
        try durableWrite(JSONEncoder().encode(record), to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return record
    }
}
public struct UploadSlice: Equatable, Sendable { public let index: Int; public let offset: UInt64; public let size: Int }
public enum UploadPlan {
    public static let partSize = 8_388_608
    public static func parts(fileSize: Int, sealed: Bool) -> [UploadSlice] {
        guard fileSize > 0 else { return [] }
        let count = fileSize / partSize + (sealed && fileSize % partSize != 0 ? 1 : 0)
        return (0..<count).map { UploadSlice(index: $0, offset: UInt64($0 * partSize), size: min(partSize, fileSize - $0 * partSize)) }
    }
}
public struct ServerOrigin: Sendable {
    public let url: URL
    public init(_ raw: String) throws {
        guard let parts = URLComponents(string: raw), let host = parts.host?.lowercased(),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.scheme == "https" || (parts.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)),
              let url = parts.url else { throw RelayError.invalidServer }
        self.url = url
    }
}
public enum DeviceProof {
    public static func challenge(verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    public static func verifier() -> String {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<32).map { _ in UInt8.random(in: 0...255, using: &generator) }).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

/// Atomic replacement plus file synchronization keeps a journal readable across process interruption.
func durableWrite(_ data: Data, to url: URL) throws {
    try data.write(to: url, options: .atomic)
    let handle = try FileHandle(forWritingTo: url)
    try handle.synchronize(); try handle.close()
    let directory = open(url.deletingLastPathComponent().path, O_RDONLY)
    if directory >= 0 { _ = fsync(directory); close(directory) }
}
