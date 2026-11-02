import AppKit
import SwiftUI
import AVKit
import ScreenCaptureKit
import RelayCore

@MainActor final class AppModel: ObservableObject {
    typealias Phase = CaptureLifecycle.Phase
    @Published private(set) var capture = CaptureLifecycle()
    var phase: Phase { capture.phase }
    @Published var captureFormat = "Choose a source, then preview to check the actual recording format."
    @Published var captureQuality = ""
    @Published var busy = false
    @Published var countdown = 0
    @Published var duration = 0.0
    @Published var error: String?
    @Published var settings = CaptureSettings()
    @Published var displays: [SCDisplay] = []
    @Published var windows: [SCWindow] = []
    @Published var displayID: CGDirectDisplayID = 0
    @Published var windowID: CGWindowID = 0
    @Published var cameras: [AVCaptureDevice] = []
    @Published var microphones: [AVCaptureDevice] = []
    @Published var preview: CGImage?
    @Published var cameraPreview: CGImage?
    @Published var records: [RecordingRecord] = []
    @Published var selection: UUID?
    @Published var active: RecordingRecord?
    @Published var uploadStatus = "Recordings are saved locally first."
    @Published var uploadingIDs: Set<UUID> = []
    @Published var notes = UserDefaults.standard.string(forKey: "speakerNotes") ?? ""
    @Published var notesVisible = false
    @Published var drawing = false
    @Published var transcriptionPreference: TranscriptionPreference = {
        if let saved = UserDefaults.standard.string(forKey: "transcriptionPreference"), let preference = TranscriptionPreference(rawValue: saved) { return preference }
        if let legacy = UserDefaults.standard.string(forKey: "transcriptionMode") { return legacy == "on_device" ? .localOnly : .server }
        return .automatic
    }()
    struct ExternalSpeechPreference: Codable {
        let server: String
        let workspaceID: String
        let selection: SpeechSelection
    }
    @Published var externalSpeechPreference: ExternalSpeechPreference? = UserDefaults.standard.data(forKey: "externalSpeechPreference").flatMap { try? JSONDecoder().decode(ExternalSpeechPreference.self, from: $0) }
    let root: URL
    let store: JournalStore
    let uploader: RecordingUploader
    let account = Account()
    let transcriber: LocalTranscriber
    let engine = CaptureEngine()
    let overlays = CaptureOverlays()
    private var loaded = false
    private var pendingCaptureStop: (cancel: Bool, sync: Bool)?
    private var terminating = false
    private var uploadLoop: Task<Void, Never>?
    private var ticker: Timer?
    private var cursorTimer: Timer?
    var hotkeys: GlobalHotkeys?
    var isCapturing: Bool { [.recording, .paused].contains(phase) }
    var controlsLocked: Bool { phase != .idle }
    init() {
        root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Relay", isDirectory: true)
        store = try! JournalStore(root: root)
        uploader = RecordingUploader(store: store)
        transcriber = LocalTranscriber(root: root)
        overlays.onCameraMove = { [weak self] point in self?.engine.updateOverlay(camera: point) }
        overlays.onInk = { [weak self] ink in self?.engine.updateOverlay(ink: ink) }
    }
    func load() async {
        guard !loaded else { return }; loaded = true
        do { records = try await store.recover() } catch { self.error = error.localizedDescription }
        await account.restore()
        // Fill the source pickers at launch only when access is already granted, so launch never triggers a permission prompt.
        if CGPreflightScreenCaptureAccess() { try? await refreshSources() }
        Task { [weak self] in
            guard let self else { return }
            for record in self.records where record.state == .ready || record.state == .uploaded {
                if record.state != .uploaded || (record.transcriptionMode == .onDevice && record.transcriptSyncState != .synced) {
                    await self.transcribeAndUpload(record.id)
                }
            }
        }
        hotkeys = GlobalHotkeys { [weak self] action in
            guard let self else { return }
            Task { @MainActor in
                switch action {
                case 1: await self.start()
                case 2: await self.stop()
                case 3: await self.togglePause()
                case 4: await self.screenshot()
                case 5: self.toggleDrawing()
                default: break
                }
            }
        }
        cursorTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in Task { @MainActor in
            guard let self, self.phase != .idle else { return }; self.updateCursor()
        } }
        ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in Task { @MainActor in
            guard let self else { return }
            if let record = self.active, self.isCapturing, let current = try? await self.store.updateCapture(id: record.id, duration: self.duration) { self.applyJournal(current) }
        } }
    }
    func loadSources() async {
        guard !busy, phase == .idle else { return }
        busy = true; defer { busy = false }
        do { try await refreshSources() } catch { self.error = "Screen Recording permission is required. Enable Relay in System Settings → Privacy & Security → Screen & System Audio Recording. \(error.localizedDescription)" }
    }
    /// Keeps a valid selection, defaulting to the main display so Preview and Record work without a manual pick.
    private func refreshSources() async throws {
        if settings.mode != .camera {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            displays = content.displays
            windows = content.windows.filter { $0.owningApplication?.processID != ProcessInfo.processInfo.processIdentifier && $0.frame.width > 40 && $0.frame.height > 40 && $0.windowLayer == 0 }
            if !displays.contains(where: { $0.displayID == displayID }) { displayID = displays.first(where: { $0.displayID == CGMainDisplayID() })?.displayID ?? displays.first?.displayID ?? 0 }
            if !windows.contains(where: { $0.windowID == windowID }) { windowID = windows.first?.windowID ?? 0 }
        }
        cameras = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .external], mediaType: .video, position: .unspecified).devices
        microphones = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
    }
    private func bindCaptureCallbacks(_ generation: UInt64) {
        captureQuality = ""; preview = nil; cameraPreview = nil
        engine.onQuality = { [weak self] status in Task { @MainActor in guard let self, self.capture.acceptsCallbacks(generation) else { return }; self.captureQuality = status } }
        engine.onPreview = { [weak self] image in Task { @MainActor in guard let self, self.capture.acceptsCallbacks(generation) else { return }; self.preview = image } }
        engine.onCamera = { [weak self] image in Task { @MainActor in guard let self, self.capture.acceptsCallbacks(generation) else { return }; self.cameraPreview = image; self.overlays.cameraImage(image) } }
        engine.onDuration = { [weak self] time in Task { @MainActor in guard let self, self.capture.acceptsCallbacks(generation) else { return }; self.duration = time } }
        engine.onError = { [weak self] message in Task { @MainActor in guard let self, self.capture.acceptsCallbacks(generation) else { return }; self.error = message; await self.stop(sync: false) } }
    }
    func previewCapture() async {
        guard !terminating, !busy, phase == .idle else { return }
        busy = true; defer { busy = false }
        do {
            let generation = try capture.beginPreparation(); bindCaptureCallbacks(generation)
            try await prepare()
            if !capture.prepared(generation, record: false) { await engine.shutdown(); overlays.hide(); capture.finished(generation) }
        } catch { let generation = capture.generation; await engine.shutdown(); overlays.hide(); capture.finished(generation); if !(error is CancellationError) { self.error = error.localizedDescription } }
    }
    private func prepare() async throws {
        if settings.mode != .camera, !displays.contains(where: { $0.displayID == displayID }) || (settings.mode == .window && !windows.contains(where: { $0.windowID == windowID })) {
            do { try await refreshSources() } catch { throw RelayError.server("Screen Recording permission is required. Enable Relay in System Settings → Privacy & Security → Screen & System Audio Recording, then try again.") }
        }
        let display = displays.first { $0.displayID == displayID }
        let window = windows.first { $0.windowID == windowID }
        if settings.mode != .camera, display == nil && settings.mode != .window { throw RelayError.server("No display is available to record. Connect a display and try again.") }
        let capabilities = try CaptureCapabilities.inspect(settings: settings, display: display, window: window, root: root)
        captureFormat = capabilities.summary
        try await engine.prepare(settings: capabilities.settings, display: display, window: window)
        guard phase == .preparing else { throw CancellationError() }
        if let screen = screenForSelection() {
            overlays.configure(screen: screen, displayRegion: settings.mode == .region ? settings.region : CGRect(x: 0, y: 0, width: 1, height: 1))
            if let bounds = captureRect() { overlays.configure(bounds: bounds) }
            if settings.camera && settings.mode != .camera { overlays.showCamera(shape: settings.cameraShape, corner: settings.cameraCorner) }
        }
    }
    func start() async {
        guard !terminating, !busy, phase == .idle || phase == .preview else { return }
        busy = true; defer { busy = false }
        do {
            let generation: UInt64
            if phase == .idle {
                generation = try capture.beginPreparation(); bindCaptureCallbacks(generation)
                try await prepare()
                guard capture.prepared(generation, record: true) else { throw CancellationError() }
            } else { generation = try capture.beginCountdown() }
            for number in (1...3).reversed() {
                countdown = number
                try await Task.sleep(for: .seconds(1))
                guard phase == .countdown else { throw CancellationError() }
            }
            var record = RecordingRecord(title: "Recording \(Date().formatted(date: .abbreviated, time: .shortened))", transcriptionMode: transcriptionPreference.resolve(localReady: transcriber.availableLocally))
            bindAccount(&record)
            record.enhanceAudio = settings.enhanceVoice
            if transcriptionPreference == .external {
                guard let selected = externalSpeechPreference, selected.server == (try ServerOrigin(account.serverText)).url.absoluteString, selected.workspaceID == account.workspaceID else {
                    throw RelayError.server("Choose an external speech provider for this server and workspace in Settings, or choose Parakeet.")
                }
                // Keep the explicit version when offline; the server revalidates it before accepting audio for transcription.
                record.transcriptionSelection = selected.selection
                record.server = selected.server; record.workspaceID = selected.workspaceID
            } else { record.transcriptionSelection = .parakeet(record.transcriptionMode) }
            record.state = .recording; try await store.save(record)
            active = record; duration = 0; records.insert(record, at: 0); selection = record.id
            guard phase == .countdown else { throw CancellationError() }
            try await engine.startRecording(to: store.mediaURL(for: record))
            guard capture.started(generation) else { throw CancellationError() }
            countdown = 0
            beginUploadLoop()
        } catch {
            let generation = capture.generation
            if active != nil { _ = try? await engine.finish() }
            await engine.shutdown(); overlays.hide(); countdown = 0
            if let record = active { if let current = try? await store.updateCapture(id: record.id, state: error is CancellationError ? .canceled : .interrupted, error: error is CancellationError ? nil : error.localizedDescription) { replace(current) }; active = nil }
            capture.finished(generation)
            if !(error is CancellationError) { self.error = error.localizedDescription }
        }
    }
    func cancelCountdown() async {
        await stop(cancel: true, sync: false)
    }
    func finishBeforeTermination() async {
        terminating = true
        await stop(sync: false)
        await capture.waitForCleanup()
    }
    func closePreview() async {
        guard phase == .preview, !busy else { return }
        busy = true; let generation = capture.generation; capture.requestStop()
        await engine.shutdown(); overlays.hide(); capture.finished(generation); busy = false
    }
    func togglePause() async {
        guard !busy, isCapturing else { return }
        busy = true
        defer {
            busy = false
            if let pending = pendingCaptureStop { pendingCaptureStop = nil; Task { await self.stop(cancel: pending.cancel, sync: pending.sync) } }
        }
        do {
            let pause = phase == .recording; try await engine.setPaused(pause)
            try capture.setPaused(pause)
            if let record = active { applyJournal(try await store.updateCapture(id: record.id, state: pause ? .paused : .recording, duration: duration)) }
        } catch { self.error = error.localizedDescription }
    }
    func stop(cancel: Bool = false, sync: Bool = true) async {
        if phase == .preparing || phase == .countdown { capture.requestStop(); countdown = 0; return }
        if phase == .preview { await closePreview(); return }
        if busy, isCapturing { pendingCaptureStop = (cancel || pendingCaptureStop?.cancel == true, sync); return }
        guard !busy, isCapturing else { return }
        let generation = capture.generation
        busy = true; capture.requestStop()
        uploadLoop?.cancel()
        var failure: Error?
        do { duration = try await engine.finish() } catch { failure = error }
        await engine.shutdown(); overlays.hide(); drawing = false
        await uploadLoop?.value; uploadLoop = nil
        if var record = active {
            do {
                record = try await store.updateCapture(id: record.id, state: cancel ? .canceled : (failure == nil ? .ready : .interrupted), duration: duration, error: failure?.localizedDescription)
            } catch {
                // Even a failed capture-state write must not make remote cancellation use an entry snapshot.
                if let current = try? await store.record(id: record.id) { record = current }
                self.error = error.localizedDescription
            }
            replace(record); active = nil
            if cancel, let api = account.api {
                do { record = try await uploader.cancel(id: record.id, api: api); replace(record) }
                catch { self.error = "Local recording retained. Remote cancellation failed: \(error.localizedDescription)" }
            }
            if !cancel, failure == nil {
                busy = false; capture.finished(generation)
                if sync { await transcribeAndUpload(record.id) }
                return
            }
        }
        if let failure { error = failure.localizedDescription }
        busy = false; capture.finished(generation)
    }
    func restart() async {
        guard isCapturing, !busy else { return }
        await stop(cancel: true); await start()
    }
    private func bindAccount(_ record: inout RecordingRecord) {
        if let api = account.api, !account.workspaceID.isEmpty {
            record.server = api.origin.url.absoluteString; record.workspaceID = account.workspaceID
        }
    }
    private func beginUploadLoop() {
        uploadLoop = Task {
            while !Task.isCancelled, isCapturing {
                if let record = active, let api = account.api, record.workspaceID != nil {
                    do {
                        let uploaded = try await uploader.upload(record, api: api, sealed: false)
                        applyJournal(uploaded)
                        uploadStatus = "\(uploaded.uploadedParts.count) complete parts synced. Local original retained."
                    } catch {
                        if let current = try? await store.record(id: record.id) { applyJournal(current) }
                        if Task.isCancelled { return }
                        uploadStatus = "Saved locally. Sync retries: \(error.localizedDescription)"
                    }
                }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
    private func applyJournal(_ current: RecordingRecord) {
        if active?.id == current.id { active = current }
        replace(current)
    }
    func usePrivateTranscriptionAndRetry(_ id: UUID) async {
        guard !uploadingIDs.contains(id), active?.id != id else { return }
        do { replace(try await store.usePrivateTranscriptionAfterRejection(id: id)) }
        catch { self.error = error.localizedDescription; return }
        await transcribeAndUpload(id)
    }
    func useServerParakeetAndUpload(_ id: UUID) async {
        guard !uploadingIDs.contains(id), active?.id != id else { return }
        do { replace(try await store.useServerParakeet(id: id)) }
        catch { self.error = error.localizedDescription; return }
        await transcribeAndUpload(id)
    }
    func transcribeAndUpload(_ id: UUID) async {
        guard !uploadingIDs.contains(id), let entry = records.first(where: { $0.id == id }),
              ![.preparing, .recording, .paused, .interrupted, .canceled].contains(entry.state) else { return }
        uploadingIDs.insert(id); defer { uploadingIDs.remove(id) }
        var record: RecordingRecord
        do { record = try await store.record(id: id) }
        catch { self.error = error.localizedDescription; return }
        // Media acknowledgment is independent of model availability and speech failures.
        if let api = account.api {
            do {
                if record.server == nil {
                    guard !account.workspaceID.isEmpty else { throw RelayError.missingWorkspace }
                    record = try await store.bindServer(id: id, server: api.origin.url.absoluteString, workspaceID: account.workspaceID)
                }
                record = try await uploader.upload(record, api: api, sealed: true)
                replace(record); uploadStatus = "Media synced. Processing continues on your server."
            } catch {
                if let current = try? await store.recordSyncFailure(id: id, message: error.localizedDescription) { record = current; applyJournal(current) }
                uploadStatus = "Saved locally. Media sync: \(error.localizedDescription)"
            }
        } else { uploadStatus = "Saved locally. Sign in to sync." }
        guard record.transcriptionMode == .onDevice, record.transcriptSyncState != .synced else { return }
        do {
            if record.transcript == nil {
                let transcript = try await transcriber.transcribe(store.mediaURL(for: record))
                record = try await store.setTranscript(id: id, transcript: transcript); replace(record)
            }
            if record.state == .uploaded, let api = account.api {
                record = try await uploader.syncTranscript(id: id, api: api)
                replace(record); uploadStatus = "Media and transcript synced. Local original retained."
            }
        } catch {
            if let current = try? await store.recordTranscriptionFailure(id: id, message: error.localizedDescription) { applyJournal(current) }
            // Speech errors cannot regress a durable media acknowledgment.
            uploadStatus = record.state == .uploaded ? "Media synced. Transcript needs attention: \(error.localizedDescription)" : "Saved locally. Transcript: \(error.localizedDescription)"
        }
    }
    func rename(_ id: UUID, title: String) async {
        guard var record = records.first(where: { $0.id == id }), active?.id != id else { return }
        let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        record.title = String(clean.prefix(240))
        do {
            record = try await store.rename(id: id, title: record.title); replace(record)
            if let videoID = record.videoID, let api = account.api, record.server == api.origin.url.absoluteString {
                let _: EmptyResponse = try await api.request("/api/v1/videos/\(videoID)", method: "PATCH", body: RelayAPI.json(["title": record.title]))
            }
        } catch { self.error = error.localizedDescription }
    }
    func delete(_ id: UUID) async {
        guard let record = records.first(where: { $0.id == id }), active?.id != id, !uploadingIDs.contains(id) else { return }
        do { try await store.remove(record); records.removeAll { $0.id == id }; selection = nil }
        catch { self.error = error.localizedDescription }
    }
    func export(_ record: RecordingRecord) async {
        let panel = NSSavePanel(); panel.allowedContentTypes = [.mpeg4Movie]; panel.nameFieldStringValue = record.title + ".mp4"
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        do {
            let source = try await store.mediaURL(for: record)
            guard source.resolvingSymlinksInPath().standardizedFileURL != destination.resolvingSymlinksInPath().standardizedFileURL else { return }
            let staging = destination.deletingLastPathComponent().appendingPathComponent(".relay-export-" + UUID().uuidString + ".mp4")
            defer { try? FileManager.default.removeItem(at: staging) }
            try FileManager.default.copyItem(at: source, to: staging)
            if FileManager.default.fileExists(atPath: destination.path) { _ = try FileManager.default.replaceItemAt(destination, withItemAt: staging) }
            else { try FileManager.default.moveItem(at: staging, to: destination) }
        }
        catch { self.error = error.localizedDescription }
    }
    func recover(_ id: UUID) async {
        guard var record = records.first(where: { $0.id == id }), record.state == .interrupted else { return }
        do {
            let media = try await store.mediaURL(for: record)
            let committed = FragmentMovie.committedSize(at: media)
            guard committed > 0 else { throw RelayError.invalidMedia }
            let physical = ((try FileManager.default.attributesOfItem(atPath: media.path))[.size] as? NSNumber)?.intValue ?? 0
            if physical > committed {
                let backup = media.appendingPathExtension("interrupted-original")
                if !FileManager.default.fileExists(atPath: backup.path) { try FileManager.default.copyItem(at: media, to: backup) }
                let handle = try FileHandle(forWritingTo: media); try handle.truncate(atOffset: UInt64(committed)); try handle.synchronize(); try handle.close()
            }
            let asset = AVURLAsset(url: media)
            guard !(try await asset.loadTracks(withMediaType: .video)).isEmpty else { throw RelayError.invalidMedia }
            record.duration = try await asset.load(.duration).seconds
            guard record.duration.isFinite, record.duration > 0 else { throw RelayError.invalidMedia }
            record = try await store.updateCapture(id: id, state: .ready, duration: record.duration); replace(record)
        } catch { self.error = "Recovery failed. Original retained. \(error.localizedDescription)" }
    }
    func screenshot() async {
        guard phase != .idle else { return }
        let panel = NSSavePanel(); panel.allowedContentTypes = [.png]; panel.nameFieldStringValue = "Relay screenshot.png"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try await engine.screenshot(to: url) } catch { self.error = error.localizedDescription }
    }
    func toggleDrawing() {
        guard phase != .idle, settings.mode != .camera else { return }
        drawing.toggle(); overlays.setDrawing(drawing)
    }
    func clearInk() { overlays.clearInk() }
    func toggleNotes() { notesVisible.toggle(); overlays.showNotes(notesVisible, text: notes) }
    func saveNotes() { UserDefaults.standard.set(notes, forKey: "speakerNotes"); if notesVisible { overlays.showNotes(true, text: notes) } }
    func setTranscriptionPreference(_ value: TranscriptionPreference) { transcriptionPreference = value; UserDefaults.standard.set(value.rawValue, forKey: "transcriptionPreference") }
    func selectExternalSpeech(_ option: SpeechOption) {
        guard let api = account.api, !account.workspaceID.isEmpty else { return }
        let preference = ExternalSpeechPreference(server: api.origin.url.absoluteString, workspaceID: account.workspaceID, selection: option.selection)
        externalSpeechPreference = preference
        if let data = try? JSONEncoder().encode(preference) { UserDefaults.standard.set(data, forKey: "externalSpeechPreference") }
        setTranscriptionPreference(.external)
    }
    func mediaURL(_ record: RecordingRecord) -> URL { root.appendingPathComponent(record.id.uuidString).appendingPathExtension("mp4") }
    private func replace(_ record: RecordingRecord) {
        if let index = records.firstIndex(where: { $0.id == record.id }) { records[index] = record }
        else { records.insert(record, at: 0) }
    }
    /// Shape and corner apply live to an open preview or recording.
    func setCameraShape(_ shape: CameraShape) { settings.cameraShape = shape; overlays.setCameraShape(shape); engine.updateOverlay(shape: shape) }
    func setCameraCorner(_ corner: CameraCorner) { settings.cameraCorner = corner; overlays.moveCamera(to: corner) }
    func chooseRegion() {
        guard phase == .idle, let screen = screenForSelection() else { error = "Load sources and select a display first."; return }
        overlays.pickRegion(on: screen) { [weak self] rect in self?.settings.region = rect }
    }
    private func screenForSelection() -> NSScreen? { NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID } ?? NSScreen.main }
    private func captureRect() -> CGRect? {
        if settings.mode == .window, let window = windows.first(where: { $0.windowID == windowID }) {
            let desktopTop = NSScreen.screens.first?.frame.maxY ?? 0
            return CGRect(x: window.frame.minX, y: desktopTop - window.frame.maxY, width: window.frame.width, height: window.frame.height)
        }
        guard let screen = screenForSelection() else { return nil }
        let region = settings.mode == .region ? settings.region : CGRect(x: 0, y: 0, width: 1, height: 1)
        return CGRect(x: screen.frame.minX + region.minX * screen.frame.width, y: screen.frame.minY + (1 - region.maxY) * screen.frame.height, width: region.width * screen.frame.width, height: region.height * screen.frame.height)
    }
    private func updateCursor() {
        guard let bounds = captureRect(), settings.mode != .camera else { engine.updateOverlay(cursor: CGPoint(x: -1, y: -1)); return }
        let point = NSEvent.mouseLocation
        let x = (point.x - bounds.minX) / bounds.width
        let y = (point.y - bounds.minY) / bounds.height
        engine.updateOverlay(cursor: x >= 0 && x <= 1 && y >= 0 && y <= 1 ? CGPoint(x: x, y: y) : CGPoint(x: -1, y: -1))
    }
}
