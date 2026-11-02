import Foundation
import CryptoKit

public struct Workspace: Codable, Identifiable, Sendable { public let id: String; public let name: String; public let role: String }
public struct NativeUser: Codable, Sendable { public let id: String; public let name: String; public let email: String }
public struct MeResponse: Codable, Sendable { public let user: NativeUser; public let workspaces: [Workspace] }
public struct DeviceStart: Codable, Sendable { public let id: String; public let verificationUrl: String; public let expiresAt: String }
public struct DeviceSession: Codable, Sendable { public let token: String; public let user: NativeUser }
public struct RemoteVideo: Codable, Sendable { public let id: String; public let initialRevisionId: String?; public let publishedRevisionId: String?; public let status: String }
public struct RemoteUpload: Codable, Sendable { public let id: String; public let partSize: Int; public let receivedParts: [Int] }
public struct RecordingResponse: Codable, Sendable { public let video: RemoteVideo; public let upload: RemoteUpload }
public struct VideoResponse: Codable, Sendable { public let video: RemoteVideo }
public struct EmptyResponse: Decodable, Sendable {}

private final class RefuseRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
public actor RelayAPI {
    public nonisolated let origin: ServerOrigin
    private let token: String?
    private let session: URLSession
    public init(origin: ServerOrigin, token: String? = nil) {
        self.origin = origin; self.token = token
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 45
        config.timeoutIntervalForResource = 120
        self.session = URLSession(configuration: config, delegate: RefuseRedirects(), delegateQueue: nil)
    }
    public func request<T: Decodable & Sendable>(_ path: String, method: String = "GET", body: Data? = nil, contentType: String = "application/json", digest: String? = nil, query: [URLQueryItem] = []) async throws -> T {
        let response = try await raw(path, method: method, body: body, contentType: contentType, digest: digest, query: query)
        return try JSONDecoder().decode(T.self, from: response.data.isEmpty ? Data("{}".utf8) : response.data)
    }
    public func raw(_ path: String, method: String = "GET", body: Data? = nil, contentType: String = "application/json", digest: String? = nil, query: [URLQueryItem] = []) async throws -> (data: Data, status: Int) {
        guard path.hasPrefix("/api/v1/"), !path.contains(".."), !path.contains("?") else { throw RelayError.invalidServer }
        guard var url = URLComponents(url: origin.url.appending(path: String(path.dropFirst())), resolvingAgainstBaseURL: false) else { throw RelayError.invalidServer }
        if !query.isEmpty { url.queryItems = query }
        guard let endpoint = url.url else { throw RelayError.invalidServer }
        var request = URLRequest(url: endpoint)
        request.httpMethod = method; request.httpBody = body
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let digest { request.setValue(digest, forHTTPHeaderField: "X-Content-SHA256") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw RelayError.server("Invalid server response.") }
        guard (200..<300).contains(response.statusCode) else {
            let error = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            if response.statusCode == 409, error?["code"] as? String == "SPEECH_CONFIGURATION_UNAVAILABLE" { throw RelayError.speechConfigurationUnavailable }
            throw RelayError.server(error?["error"] as? String ?? "Server returned HTTP \(response.statusCode).")
        }
        return (data, response.statusCode)
    }
    public static func json(_ values: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
}

public actor RecordingUploader {
    private let store: JournalStore
    private var uploading = false
    public init(store: JournalStore) { self.store = store }
    /// One upload loop owns a recording at a time. Only complete immutable fragment bytes are exposed by capture.
    public func upload(_ snapshot: RecordingRecord, api: RelayAPI, sealed: Bool) async throws -> RecordingRecord {
        guard !uploading else { throw RelayError.server("Another recording is syncing. Retry shortly.") }
        uploading = true
        defer { uploading = false }
        do {
            try Task.checkCancellation()
            return try await performUpload(id: snapshot.id, api: api, sealed: sealed)
        } catch {
            // Persist only the failure field; the current journal already owns every acknowledged part.
            _ = try? await store.recordSyncFailure(id: snapshot.id, message: error.localizedDescription)
            throw error
        }
    }
    /// Cancel uses the journal's remote ID, including IDs persisted before an interrupted upload returned.
    public func cancel(id: UUID, api: RelayAPI) async throws -> RecordingRecord {
        let current = try await store.record(id: id)
        guard current.state == .canceled else { throw RelayError.invalidState }
        guard current.server == nil || current.server == api.origin.url.absoluteString else { throw RelayError.missingWorkspace }
        if let videoID = current.videoID {
            let _: EmptyResponse = try await api.request("/api/v1/recordings/\(videoID)", method: "DELETE")
        }
        return try await store.record(id: id)
    }
    /// Speech has its own durable acknowledgment and can finish after media publication.
    public func syncTranscript(id: UUID, api: RelayAPI) async throws -> RecordingRecord {
        guard !uploading else { throw RelayError.server("Another recording is syncing. Retry shortly.") }
        uploading = true
        defer { uploading = false }
        let current = try await store.record(id: id)
        guard current.state != .canceled else { throw RelayError.invalidState }
        guard current.server == api.origin.url.absoluteString else { throw RelayError.missingWorkspace }
        guard current.transcriptionMode == .onDevice, current.transcriptSyncState != .synced,
              current.transcript != nil else { return current }
        guard let videoID = current.videoID, let revisionID = current.revisionID else { throw RelayError.invalidState }
        let sending = try await store.beginTranscriptSync(id: id)
        guard var transcript = sending.transcript, let version = sending.transcriptVersion else { throw RelayError.invalidState }
        do {
            try Task.checkCancellation()
            transcript.revisionId = revisionID
            var body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(transcript)) as! [String: Any]
            body["source"] = "on_device"
            let _: EmptyResponse = try await api.request("/api/v1/videos/\(videoID)/transcript", method: "PUT", body: RelayAPI.json(body))
            return try await store.finishTranscriptSync(id: id, version: version, error: nil)
        } catch {
            _ = try? await store.finishTranscriptSync(id: id, version: version, error: error.localizedDescription)
            throw error
        }
    }
    private func performUpload(id: UUID, api: RelayAPI, sealed: Bool) async throws -> RecordingRecord {
        var record = try await store.record(id: id)
        guard record.state != .canceled else { throw RelayError.invalidState }
        if record.state == .uploaded { return record }
        guard let workspace = record.workspaceID, record.server == api.origin.url.absoluteString else { throw RelayError.missingWorkspace }
        if record.videoID == nil {
            record = try await store.beginAdmission(id: id)
            var body: [String: Any] = [
                "clientId": record.id.uuidString, "workspaceId": workspace, "title": record.title,
                "transcriptionMode": record.transcriptionMode.rawValue, "mimeType": "video/mp4"
            ]
            if let enhance = record.enhanceAudio { body["enhanceAudio"] = enhance }
            if let selection = record.transcriptionSelection { body["transcription"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(selection)) }
            let reply: RecordingResponse
            do { reply = try await api.request("/api/v1/recordings", method: "POST", body: RelayAPI.json(body)) }
            catch RelayError.speechConfigurationUnavailable {
                try await store.rejectTranscriptionAdmission(id: id)
                throw RelayError.speechConfigurationUnavailable
            }
            guard reply.upload.partSize == UploadPlan.partSize else { throw RelayError.server("Unsupported upload part size.") }
            record.videoID = reply.video.id; record.revisionID = reply.video.initialRevisionId ?? reply.video.publishedRevisionId
            record = try await store.mergeUpload(record)
        }
        guard let videoID = record.videoID, UUID(uuidString: videoID) != nil else { throw RelayError.server("Invalid recording identifier.") }
        let remote: RecordingResponse = try await api.request("/api/v1/recordings/\(videoID)")
        if remote.video.status == "canceled" { throw RelayError.server("Remote recording was canceled. Local media retained.") }
        record.revisionID = record.revisionID ?? remote.video.initialRevisionId ?? remote.video.publishedRevisionId
        let file = try await store.mediaURL(for: record)
        let physicalSize = ((try FileManager.default.attributesOfItem(atPath: file.path))[.size] as? NSNumber)?.intValue ?? 0
        let size = sealed ? physicalSize : min(physicalSize, FragmentMovie.committedSize(at: file))
        let plan = UploadPlan.parts(fileSize: size, sealed: sealed)
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        for slice in plan {
            try Task.checkCancellation()
            try handle.seek(toOffset: slice.offset)
            let bytes = try handle.read(upToCount: slice.size) ?? Data()
            guard bytes.count == slice.size else { throw RelayError.invalidMedia }
            let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            let expected = UploadedPart(index: slice.index, sha256: digest, size: slice.size)
            if remote.upload.receivedParts.contains(slice.index), record.uploadedParts.contains(expected) { continue }
            // Retry transient failures with bounded, cancelable backoff; the same digest makes retries idempotent.
            var acknowledged: UploadedPart?
            for attempt in 0..<3 {
                do {
                    acknowledged = try await api.request("/api/v1/recordings/\(videoID)/parts/\(slice.index)", method: "PUT", body: bytes, contentType: "application/octet-stream", digest: digest)
                    break
                } catch {
                    if attempt == 2 { throw error }
                    try await Task.sleep(for: .seconds(1 << attempt))
                }
            }
            guard acknowledged == expected else { throw RelayError.server("Upload acknowledgment failed digest verification. Local file retained.") }
            record.uploadedParts.removeAll { $0.index == slice.index }; record.uploadedParts.append(expected)
            record = try await store.mergeUpload(record)
        }
        if sealed {
            guard !plan.isEmpty else { throw RelayError.invalidMedia }
            let _: VideoResponse = try await api.request("/api/v1/recordings/\(videoID)/finalize", method: "POST", body: RelayAPI.json([
                "parts": record.uploadedParts.sorted { $0.index < $1.index }.map { ["index": $0.index, "sha256": $0.sha256, "size": $0.size] as [String: Any] },
                "duration": record.duration, "mimeType": "video/mp4"
            ]))
            record.state = .uploaded; record.error = nil
            record = try await store.mergeUpload(record, completed: true)
        }
        return record
    }
}
