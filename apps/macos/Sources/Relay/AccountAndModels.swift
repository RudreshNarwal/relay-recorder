import AppKit
import Combine
import Security
import AVFoundation
import FluidAudio
import RelayCore

struct KeychainTokens {
    static func read(origin: String) throws -> String? {
        var query = base(origin); query[kSecReturnData] = true; query[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, let token = String(data: data, encoding: .utf8) else { throw RelayError.server("Keychain read failed (\(status)).") }
        return token
    }
    static func save(_ token: String, origin: String) throws {
        var attributes = base(origin); attributes[kSecValueData] = Data(token.utf8); attributes[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update = SecItemUpdate(base(origin) as CFDictionary, [kSecValueData: Data(token.utf8)] as CFDictionary)
            guard update == errSecSuccess else { throw RelayError.server("Keychain update failed (\(update)).") }
        } else if status != errSecSuccess { throw RelayError.server("Keychain save failed (\(status)).") }
    }
    static func remove(origin: String) { SecItemDelete(base(origin) as CFDictionary) }
    private static func base(_ origin: String) -> [CFString: Any] { [kSecClass: kSecClassGenericPassword, kSecAttrService: "app.relay.device", kSecAttrAccount: origin] }
}

@MainActor final class Account: ObservableObject {
    @Published var serverText = UserDefaults.standard.string(forKey: "server") ?? "http://localhost:3110"
    @Published var user: NativeUser?
    @Published var workspaces: [Workspace] = []
    @Published var workspaceID = UserDefaults.standard.string(forKey: "workspace") ?? ""
    @Published var status = "Sign in to sync. Recordings also work offline."
    @Published var signingIn = false
    @Published var speechOptions: [SpeechOption] = []
    @Published var speechStatus = "Sign in to load configured external speech providers."
    private(set) var api: RelayAPI?
    private var signInTask: Task<Void, Never>?
    func restore() async {
        do {
            let origin = try ServerOrigin(serverText)
            guard let token = try KeychainTokens.read(origin: origin.url.absoluteString) else { return }
            let client = RelayAPI(origin: origin, token: token)
            let me: MeResponse = try await client.request("/api/v1/me")
            api = client; user = me.user; workspaces = me.workspaces
            if !workspaces.contains(where: { $0.id == workspaceID }) { workspaceID = workspaces.first?.id ?? "" }
            status = "Signed in as \(me.user.email)"
            await refreshSpeechOptions()
        } catch { status = error.localizedDescription }
    }
    func signIn() {
        guard !signingIn else { return }
        signingIn = true; status = "Approve this Mac in your browser."
        signInTask = Task {
            defer { signingIn = false }
            do {
                let origin = try ServerOrigin(serverText)
                let verifier = DeviceProof.verifier()
                let client = RelayAPI(origin: origin)
                let start: DeviceStart = try await client.request("/api/v1/device/start", method: "POST", body: RelayAPI.json(["challenge": DeviceProof.challenge(verifier: verifier)]))
                guard let link = URLComponents(string: start.verificationUrl), let base = URLComponents(url: origin.url, resolvingAgainstBaseURL: false), link.scheme == base.scheme, link.host == base.host, link.port == base.port, link.path == "/device", let url = link.url else { throw RelayError.server("Server returned an unsafe verification link.") }
                NSWorkspace.shared.open(url)
                let deadline = Date().addingTimeInterval(300)
                while Date() < deadline {
                    try Task.checkCancellation()
                    let reply = try await client.raw("/api/v1/device/exchange", method: "POST", body: RelayAPI.json(["id": start.id, "verifier": verifier]))
                    if reply.status == 200 {
                        let session = try JSONDecoder().decode(DeviceSession.self, from: reply.data)
                        try KeychainTokens.save(session.token, origin: origin.url.absoluteString)
                        serverText = origin.url.absoluteString; UserDefaults.standard.set(serverText, forKey: "server")
                        await restore(); return
                    }
                    try await Task.sleep(for: .seconds(2))
                }
                throw RelayError.server("Sign-in expired. Try again.")
            } catch is CancellationError { status = "Sign-in canceled." }
            catch { status = error.localizedDescription }
        }
    }
    func cancelSignIn() { signInTask?.cancel() }
    func signOut() async {
        if let api {
            do { let _: EmptyResponse = try await api.request("/api/v1/device/session", method: "DELETE") }
            catch { status = "Local sign-in removed. Server revocation failed: \(error.localizedDescription)" }
        }
        if let origin = try? ServerOrigin(serverText) { KeychainTokens.remove(origin: origin.url.absoluteString) }
        user = nil; workspaces = []; api = nil; speechOptions = []
        speechStatus = "Sign in to load configured external speech providers."
    }
    func selectWorkspace(_ value: String) {
        workspaceID = value; UserDefaults.standard.set(value, forKey: "workspace"); speechOptions = []
        Task { await refreshSpeechOptions() }
    }
    func refreshSpeechOptions() async {
        guard let client = api, !workspaceID.isEmpty else { return }
        let workspace = workspaceID
        speechStatus = "Loading available speech providers…"
        do {
            let reply: SpeechCapabilitiesResponse = try await client.request("/api/v1/capabilities", query: [URLQueryItem(name: "workspaceId", value: workspace)])
            guard api === client, workspaceID == workspace else { return }
            speechOptions = reply.transcription.filter { $0.execution == "server" && $0.provider != "parakeet" }
            speechStatus = speechOptions.isEmpty ? "No external providers enabled for this workspace. Configure and test them in web Settings." : "External providers are configured by your server owner."
        } catch {
            guard api === client, workspaceID == workspace else { return }
            speechStatus = "Could not refresh speech providers. Saved recording choices remain unchanged. \(error.localizedDescription)"
        }
    }
}

@MainActor final class LocalTranscriber: ObservableObject {
    @Published var busy = false
    @Published var downloading = false
    @Published var progress = 0.0
    @Published var status = "Parakeet v3 runs locally after a one-time model download."
    @Published var installed = false
    @Published var ready = false
    /// Installed and either loaded or still being verified at launch; a failed verification counts as unavailable.
    var availableLocally: Bool { ready || (installed && busy && !downloading) }
    /// Relay's own download location.
    let ownDirectory: URL
    /// FluidAudio's default cache, shared with other FluidAudio apps such as FluidVoice. Used read-only, never deleted.
    let sharedDirectory: URL?
    @Published private(set) var directory: URL
    var usingSharedModel: Bool { directory != ownDirectory }
    private var manager: AsrManager?
    private var task: Task<Void, Never>?
    init(root: URL, sharedDirectory: URL? = AsrModels.defaultCacheDirectory(for: .v3)) {
        ownDirectory = root.appendingPathComponent("Models", isDirectory: true).appendingPathComponent(AsrModels.defaultCacheDirectory(for: .v3).lastPathComponent, isDirectory: true)
        self.sharedDirectory = sharedDirectory
        // Prefer Relay's copy; otherwise reuse a copy another app already downloaded, if it passes the pinned checksums.
        if !AsrModels.modelsExist(at: ownDirectory, version: .v3), let sharedDirectory, AsrModels.modelsExist(at: sharedDirectory, version: .v3) { directory = sharedDirectory }
        else { directory = ownDirectory }
        installed = AsrModels.modelsExist(at: directory, version: .v3)
        if installed { verify() }
    }
    /// Checksum and load whichever copy is selected. A shared copy that fails falls back to Relay's own location.
    func verify() {
        guard !busy else { return }
        task = Task { [self] in
            busy = true; defer { busy = false }
            do { try await verifyAndLoad() }
            catch is CancellationError { ready = false }
            catch {
                ready = false
                if usingSharedModel {
                    directory = ownDirectory; installed = AsrModels.modelsExist(at: ownDirectory, version: .v3)
                    status = "Found Parakeet from another app, but it isn't Relay's verified version. Download Relay's copy to transcribe on this Mac."
                } else { status = error.localizedDescription }
            }
        }
    }
    func download() {
        guard !busy else { return }
        busy = true; downloading = true; progress = 0; status = "Downloading Parakeet v3…"; directory = ownDirectory
        task = Task { [self] in
            defer { busy = false; downloading = false; installed = AsrModels.modelsExist(at: directory, version: .v3) }
            do {
                let manifest = try ParakeetManifest.bundled()
                try FileManager.default.createDirectory(at: directory.deletingLastPathComponent(), withIntermediateDirectories: true)
                let free = try directory.deletingLastPathComponent().resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
                guard free > manifest.downloadBytes * 2 + 256 * 1024 * 1024 else { throw RelayError.server("Free at least 1.3 GB for model files and compilation, then retry.") }
                ModelRegistry.revisionOverrides[manifest.repository] = manifest.revision
                try await ModelHub.download(.parakeetV3, to: directory.deletingLastPathComponent(), variant: "int8", additionalModelNames: ["JointDecisionv3.mlmodelc", "parakeet_vocab.json"], progressHandler: { [weak self] update in
                    Task { @MainActor in
                        self?.progress = min(0.9, update.fractionCompleted * 1.8)
                        switch update.phase {
                        case .listing: self?.status = "Listing pinned model files…"
                        case .downloading(let completed, let total): self?.status = "Downloading model files \(completed)/\(total)…"
                        case .compiling(let name): self?.status = "Compiling \(name)…"
                        }
                    }
                })
                try await verifyAndLoad()
            } catch is CancellationError { status = "Download canceled. Cached files can be resumed." }
            catch { ready = false; status = error.localizedDescription }
        }
    }
    private func verifyAndLoad() async throws {
        ready = false; manager = nil; status = "Checking pinned model checksums and loading Parakeet…"
        let directory = self.directory, containment = usingSharedModel ? directory.deletingLastPathComponent() : directory
        let verification = Task.detached(priority: .utility) {
            let manifest = try ParakeetManifest.bundled()
            try ModelIntegrity.verify(directory: directory, files: manifest.files, containment: containment)
            return try AsrModels.loadLocal(from: directory, version: .v3)
        }
        let models = try await withTaskCancellationHandler(operation: { try await verification.value }, onCancel: { verification.cancel() })
        try Task.checkCancellation()
        let loaded = AsrManager(config: .default); try await loaded.loadModels(models)
        try Task.checkCancellation()
        manager = loaded; ready = true; installed = true; progress = 1
        status = usingSharedModel ? "Using Parakeet v3 already on this Mac (FluidAudio, shared with apps like FluidVoice). Verified; speech stays on this Mac." : "Parakeet v3 verified and ready. Speech stays on this Mac."
    }
    func cancelDownload() { task?.cancel() }
    func remove() throws {
        guard !busy else { throw RelayError.invalidState }
        manager = nil; ready = false
        // Never delete another app's model; only stop using it.
        if usingSharedModel { directory = ownDirectory; installed = false; progress = 0; status = "Stopped using the shared model. Other apps keep their copy."; return }
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
        installed = false; progress = 0; status = "Local model removed."
    }
    func transcribe(_ media: URL) async throws -> TranscriptPayload {
        // Launch verification is quick and expected; wait for it rather than failing recordings queued at startup.
        if busy && !downloading { await task?.value }
        guard !busy else { throw RelayError.server("Wait for the current local model operation.") }
        busy = true; status = "Transcribing on this Mac…"
        defer { busy = false }
        let asset = AVURLAsset(url: media)
        guard !(try await asset.loadTracks(withMediaType: .audio)).isEmpty else {
            status = "Recording has no audio. Saved an empty transcript."
            return TranscriptPayload(segments: [])
        }
        guard installed else { throw RelayError.server("Download Parakeet v3 in Settings before local transcription.") }
        if manager == nil {
            try await verifyAndLoad()
        }
        let audio = media.deletingLastPathComponent().appendingPathComponent("relay-transcript-\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: audio) }
        if FileManager.default.fileExists(atPath: audio.path) { try FileManager.default.removeItem(at: audio) }
        guard let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else { throw RelayError.invalidMedia }
        try await exporter.export(to: audio, as: .m4a)
        var decoder = try TdtDecoderState()
        let result = try await manager!.transcribe(audio, decoderState: &decoder)
        let words = buildWordTimings(from: result.tokenTimings ?? [])
        let segments: [TranscriptSegment]
        if words.isEmpty {
            segments = result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [] : [TranscriptSegment(start: 0, end: result.duration, text: result.text)]
        } else {
            // Short, timed phrases make captions useful while preserving the model's word boundaries.
            segments = stride(from: 0, to: words.count, by: 12).map { start in
                let group = Array(words[start..<min(start + 12, words.count)])
                return TranscriptSegment(start: group.first!.startTime, end: group.last!.endTime, text: group.map(\.word).joined(separator: " "), words: group.map { TranscriptWord(start: $0.startTime, end: $0.endTime, text: $0.word) })
            }
        }
        status = "Local transcript ready."
        return TranscriptPayload(segments: segments)
    }
}
