import SwiftUI
import AppKit
import AVKit
import RelayCore

// Explicit wrapper alias keeps builds compatible with SDKs that also declare a State macro.
typealias ViewState<Value> = SwiftUI.State<Value>

@main struct RelayApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup("Relay", id: "main") {
            RelayWindow(model: model)
                .frame(minWidth: 1060, minHeight: 720)
                .tint(Color(red: 0.447, green: 0.329, blue: 0.862))
                .task { delegate.model = model; await model.load() }
        }
        .commands {
            CommandMenu("Recording") {
                Button("Start recording") { Task { await model.start() } }.disabled(model.busy || model.isCapturing)
                Button("Pause / resume") { Task { await model.togglePause() } }.disabled(!model.isCapturing || model.busy)
                Button("Stop and save") { Task { await model.stop() } }.disabled(!model.isCapturing || model.busy)
                Divider()
                Button("Save screenshot…") { Task { await model.screenshot() } }.disabled(model.phase == .idle)
                Button("Toggle drawing") { model.toggleDrawing() }.disabled(model.phase == .idle)
                Button("Speaker notes") { model.toggleNotes() }
            }
        }
        MenuBarExtra { RelayMenu(model: model) } label: { Image(systemName: model.isCapturing ? "record.circle.fill" : "record.circle") }
    }
}
struct RelayMenu: View {
    @ObservedObject var model: AppModel
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Group {
            Text(model.isCapturing ? "Relay · \(elapsed(model.duration))" : "Relay")
            Button("Open library") { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) }
            Divider()
            Button("Record · ⌘⇧2") { Task { await model.start() } }.disabled(model.busy || model.controlsLocked)
            Button("Pause / resume · ⌘⇧4") { Task { await model.togglePause() } }.disabled(model.busy || !model.isCapturing)
            Button("Stop and save · ⌘⇧3") { Task { await model.stop() } }.disabled(model.busy || !model.isCapturing)
            Button("Screenshot · ⌘⇧5") { Task { await model.screenshot() } }.disabled(model.phase == .idle)
            Button("Draw · ⌘⇧6") { model.toggleDrawing() }.disabled(model.phase == .idle)
            Button("Speaker notes") { model.toggleNotes() }
            Divider()
            Button("Quit Relay") { NSApp.terminate(nil) }

        }
    }
}
@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var model: AppModel?
    private var terminationPending = false
    func applicationDidFinishLaunching(_ notification: Notification) { NSApp.setActivationPolicy(.regular) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminationPending { return .terminateLater }
        guard let model, model.phase != .idle else { return .terminateNow }
        let alert = NSAlert(); alert.messageText = "Save the current recording before quitting?"; alert.informativeText = "Relay will stop capture and retain local media. Upload can resume next launch."
        alert.addButton(withTitle: "Stop, save and quit"); alert.addButton(withTitle: "Keep recording")
        guard alert.runModal() == .alertFirstButtonReturn else { return .terminateCancel }
        terminationPending = true
        Task { await model.finishBeforeTermination(); sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
}

struct RelayWindow: View {
    @ObservedObject var model: AppModel
    @ViewState private var tab = "Record"
    @ViewState private var deleteTarget: RecordingRecord?
    @ViewState private var query = ""
    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 24) {
                HStack { Image(systemName: "record.circle.fill").foregroundStyle(Color(red: 0.447, green: 0.329, blue: 0.862)); Text("Relay").font(.largeTitle.bold()) }.padding(.top, 20)
                Text("Your ideas. In motion.").foregroundStyle(.secondary)
                ForEach(["Record", "Library", "Settings"], id: \.self) { value in
                    Button { tab = value } label: { Label(value, systemImage: value == "Record" ? "record.circle" : value == "Library" ? "rectangle.stack" : "gearshape").frame(maxWidth: .infinity, alignment: .leading).padding(12).background(tab == value ? Color.accentColor.opacity(0.15) : Color.clear, in: RoundedRectangle(cornerRadius: 10)) }.buttonStyle(.plain)
                }
                Spacer()
                Text("Saved on this Mac first.").font(.caption).foregroundStyle(.secondary)
                Text(model.uploadStatus).font(.caption).foregroundStyle(.secondary).lineLimit(5)
            }.padding(20).navigationSplitViewColumnWidth(220)
        } detail: {
            Group {
                if tab == "Settings" { SettingsView(model: model, account: model.account, transcriber: model.transcriber) }
                else if tab == "Library" { library }
                else { RecordingView(model: model) }
            }.padding(28)
        }
        .alert("Relay", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) { Button("OK") { model.error = nil } } message: { Text(model.error ?? "") }
        .confirmationDialog("Delete local recording?", isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }), titleVisibility: .visible) {
            Button("Delete local media permanently", role: .destructive) { if let target = deleteTarget { Task { await model.delete(target.id) } }; deleteTarget = nil }
            Button("Cancel", role: .cancel) { deleteTarget = nil }
        } message: { Text("This removes the recording and its recovery files from this Mac. Server copies remain available.") }
    }
    private var library: some View {
        let visible = model.records.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) }
        return VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Library").font(.largeTitle.bold())
                    Text(model.records.isEmpty ? "Recordings are saved on this Mac first." : "\(model.records.count) recording\(model.records.count == 1 ? "" : "s") · saved on this Mac first").foregroundStyle(.secondary)
                }
                Spacer()
                Button { tab = "Record" } label: { Label("New recording", systemImage: "record.circle") }.buttonStyle(.borderedProminent).controlSize(.large)
            }
            if model.records.isEmpty {
                ContentUnavailableView {
                    Label("No recordings yet", systemImage: "video")
                } description: {
                    Text("Record your screen, camera, or both. Every recording lands here first.")
                } actions: {
                    Button("Start recording") { tab = "Record" }.buttonStyle(.borderedProminent)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                HSplitView {
                    VStack(alignment: .leading, spacing: 10) {
                        TextField("Search recordings", text: $query).textFieldStyle(.roundedBorder)
                        List(selection: $model.selection) {
                            ForEach(visible) { record in
                                LibraryRow(record: record, mediaURL: model.mediaURL(record), capturing: model.active?.id == record.id).tag(record.id).contextMenu {
                                    if let url = workspaceURL(record) {
                                        Button("Open in workspace") { NSWorkspace.shared.open(url) }
                                        Button("Copy link") { copyLink(url) }
                                        Divider()
                                    }
                                    Button("Export…") { Task { await model.export(record) } }.disabled(model.active?.id == record.id)
                                    Button("Delete…", role: .destructive) { deleteTarget = record }.disabled(model.active?.id == record.id || model.uploadingIDs.contains(record.id))
                                }
                            }
                        }
                        .listStyle(.inset(alternatesRowBackgrounds: false))
                        .overlay { if visible.isEmpty { ContentUnavailableView.search(text: query) } }
                    }.frame(minWidth: 280, idealWidth: 330, maxWidth: 440)
                    Group {
                        if let record = model.records.first(where: { $0.id == model.selection }) {
                            LocalDetail(model: model, record: record, onDelete: { deleteTarget = record })
                        } else {
                            ContentUnavailableView("Select a recording", systemImage: "play.rectangle", description: Text("Choose one to play, rename, or share it."))
                        }
                    }.frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // Open on the newest recording so the detail pane is never blank on arrival.
        .onAppear { if model.selection == nil || !model.records.contains(where: { $0.id == model.selection }) { model.selection = model.records.first?.id } }
    }
}

struct RecordingView: View {
    @ObservedObject var model: AppModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack { VStack(alignment: .leading) { Text("Show what you mean.").font(.largeTitle.bold()); Text("A clear recording starts a better conversation.").foregroundStyle(.secondary) }; Spacer(); if model.isCapturing { Label(elapsed(model.duration), systemImage: "record.circle.fill").foregroundStyle(model.phase == .paused ? .orange : .red).monospacedDigit().font(.title2) } }
                LocalSpeechBanner(model: model, transcriber: model.transcriber)
                ZStack {
                    RoundedRectangle(cornerRadius: 18).fill(Color.black)
                    if let preview = model.preview { Image(decorative: preview, scale: 1).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 18)) }
                    else { VStack(spacing: 12) { Image(systemName: "video.badge.waveform").font(.system(size: 42)); Text("Preview your source before recording").font(.headline); Text("Permissions are requested when you load sources or preview.").font(.caption) }.foregroundStyle(.white.opacity(0.8)) }
                    if model.phase == .countdown { Text("\(model.countdown)").font(.system(size: 100, weight: .bold)).foregroundStyle(.white).shadow(radius: 15) }
                    if model.phase == .paused { Text("PAUSED").font(.title.bold()).padding().background(.ultraThinMaterial, in: Capsule()) }
                }.aspectRatio(16 / 9, contentMode: .fit).frame(maxHeight: 380)
                configuration.disabled(model.controlsLocked || model.busy)
                Text(model.captureFormat).font(.caption).foregroundStyle(.secondary)
                if !model.captureQuality.isEmpty { Text(model.captureQuality).font(.caption).monospacedDigit().foregroundStyle(.secondary) }
                HStack(spacing: 12) {
                    if model.phase == .canceling { Text("Canceling startup… Waiting for capture setup to finish.").foregroundStyle(.secondary) }
                    else if model.phase == .preparing { Button("Cancel startup") { Task { await model.stop(cancel: true) } } }
                    else if model.phase == .countdown { Button("Cancel countdown") { Task { await model.cancelCountdown() } } }
                    else if model.isCapturing {
                        Button(model.phase == .paused ? "Resume" : "Pause") { Task { await model.togglePause() } }.keyboardShortcut(" ", modifiers: [])
                        Button("Stop & save") { Task { await model.stop() } }.buttonStyle(.borderedProminent).tint(.red)
                        Button("Restart") { Task { await model.restart() } }
                        Button("Cancel", role: .destructive) { Task { await model.stop(cancel: true) } }
                    } else {
                        Button("Record · ⌘⇧2") { Task { await model.start() } }.buttonStyle(.borderedProminent).controlSize(.large)
                        if model.phase == .preview { Button("Close preview") { Task { await model.closePreview() } } }
                        else { Button("Preview") { Task { await model.previewCapture() } } }
                    }
                    Spacer()
                    if model.phase != .idle {
                        Button { model.toggleDrawing() } label: { Image(systemName: model.drawing ? "pencil.tip.crop.circle.fill" : "pencil.tip.crop.circle") }.help("Toggle drawing · ⌘⇧6")
                        Button("Clear ink") { model.clearInk() }
                        Button { Task { await model.screenshot() } } label: { Image(systemName: "camera.viewfinder") }.help("Save screenshot · ⌘⇧5")
                    }
                    Button { model.toggleNotes() } label: { Image(systemName: "note.text") }.help("Speaker notes")
                }.disabled(model.busy && model.phase != .countdown && model.phase != .preparing)
                DisclosureGroup("Speaker notes") { TextEditor(text: $model.notes).font(.body).frame(height: 110).onChange(of: model.notes) { _, _ in model.saveNotes() }; Text("Notes remain outside screen recordings.").font(.caption).foregroundStyle(.secondary) }
                Text("Global controls: ⌘⇧2 record · ⌘⇧3 stop · ⌘⇧4 pause · ⌘⇧5 screenshot · ⌘⇧6 draw").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    private var configuration: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Picker("Source", selection: $model.settings.mode) { ForEach(CaptureSettings.Mode.allCases) { Text($0.rawValue).tag($0) } }.frame(width: 240)
                Button("Load sources") { Task { await model.loadSources() } }
                if model.settings.mode == .window {
                    Picker("Window", selection: $model.windowID) { Text("Select window").tag(CGWindowID(0)); ForEach(model.windows, id: \.windowID) { Text("\($0.owningApplication?.applicationName ?? "App") · \($0.title ?? "Window")").tag($0.windowID) } }.frame(maxWidth: 350)
                } else if model.settings.mode != .camera {
                    Picker("Display", selection: $model.displayID) { Text("Select display").tag(CGDirectDisplayID(0)); ForEach(model.displays, id: \.displayID) { Text("Display \($0.displayID) · \($0.width)×\($0.height)").tag($0.displayID) } }.frame(maxWidth: 300)
                }
            }
            if model.settings.mode == .region { HStack { Button("Select region…") { model.chooseRegion() }; Text("\(Int(model.settings.region.width * 100))% × \(Int(model.settings.region.height * 100))% of display").font(.caption).foregroundStyle(.secondary) } }
            HStack {
                Picker("Quality", selection: Binding(get: { model.settings.height }, set: { model.settings.height = $0; model.settings.width = $0 * 16 / 9 })) { Text("720p · 30 fps").tag(720); Text("1080p · 30 fps").tag(1080); Text("1440p · 30 fps").tag(1440); Text("4K · 30 fps").tag(2160) }.frame(width: 250)
                Toggle("Microphone", isOn: $model.settings.microphone)
                Toggle("System audio", isOn: $model.settings.systemAudio).disabled(model.settings.mode == .camera)
                Toggle("Camera overlay", isOn: $model.settings.camera).disabled(model.settings.mode == .camera)
            }
            HStack {
                if model.settings.camera || model.settings.mode == .camera {
                    Picker("Camera", selection: Binding(get: { model.settings.cameraID ?? "" }, set: { model.settings.cameraID = $0.isEmpty ? nil : $0 })) { Text("Default camera").tag(""); ForEach(model.cameras, id: \.uniqueID) { Text($0.localizedName).tag($0.uniqueID) } }.frame(maxWidth: 280)
                    Toggle("Blur background", isOn: $model.settings.blurCamera)
                    if model.settings.mode != .camera {
                        Picker("Shape", selection: Binding(get: { model.settings.cameraShape }, set: { model.setCameraShape($0) })) { ForEach(CameraShape.allCases) { Text($0.rawValue).tag($0) } }.frame(maxWidth: 170)
                        Picker("Position", selection: Binding(get: { model.settings.cameraCorner }, set: { model.setCameraCorner($0) })) { ForEach(CameraCorner.allCases) { Text($0.rawValue).tag($0) } }.frame(maxWidth: 200)
                    }
                }
            }
            HStack {
                if model.settings.microphone || model.settings.systemAudio {
                    Toggle("Enhance voice", isOn: $model.settings.enhanceVoice).help("Reduce background noise and level volume on the server. Your original recording is kept.")
                }
                if model.settings.microphone {
                    Toggle("Noise suppression", isOn: $model.settings.suppressNoise).help("Apple Voice Isolation removes background noise from your microphone while you record. System audio is not affected.")
                    Picker("Mic", selection: Binding(get: { model.settings.microphoneID ?? "" }, set: { model.settings.microphoneID = $0.isEmpty ? nil : $0 })) { Text("Default microphone").tag(""); ForEach(model.microphones, id: \.uniqueID) { Text($0.localizedName).tag($0.uniqueID) } }.frame(maxWidth: 280)
                }
                Toggle("Cursor emphasis", isOn: $model.settings.cursorEmphasis)
            }
        }
    }
}

struct LocalDetail: View {
    @ObservedObject var model: AppModel
    let record: RecordingRecord
    let onDelete: () -> Void
    @ViewState private var title = ""
    @ViewState private var player: AVPlayer?
    private var busy: Bool { model.active?.id == record.id }
    private var syncing: Bool { model.uploadingIDs.contains(record.id) }
    private var needsSync: Bool { record.state != .canceled && record.state != .interrupted && (record.state != .uploaded || (record.transcriptionMode == .onDevice && record.transcriptSyncState != .synced)) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                PlayerView(player: player).aspectRatio(16 / 9, contentMode: .fit).frame(minHeight: 220).clipShape(RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        TextField("Title", text: $title).textFieldStyle(.plain).font(.title2.bold()).onSubmit(save)
                        if title != record.title && !title.trimmingCharacters(in: .whitespaces).isEmpty { Button("Save title", action: save).keyboardShortcut(.defaultAction) }
                    }.disabled(busy)
                    HStack(spacing: 8) {
                        StatusBadge(record: record)
                        Text("\(record.createdAt.formatted(date: .abbreviated, time: .shortened)) · \(elapsed(record.duration)) · \((record.transcriptionSelection ?? .parakeet(record.transcriptionMode)).label)").font(.callout).foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 10) {
                    if let url = workspaceURL(record) {
                        Button { NSWorkspace.shared.open(url) } label: { Label("Open in workspace", systemImage: "arrow.up.forward.app") }.buttonStyle(.borderedProminent)
                        Button { copyLink(url) } label: { Label("Copy link", systemImage: "link") }
                    }
                    if record.state == .interrupted {
                        Button { Task { await model.recover(record.id) } } label: { Label("Recover fragments", systemImage: "bandage") }.buttonStyle(.borderedProminent)
                    } else if needsSync {
                        let upload = Button { Task { await model.transcribeAndUpload(record.id) } } label: { Label(record.state == .uploaded ? "Retry transcript" : "Upload to workspace", systemImage: "arrow.up.circle") }.disabled(syncing || busy)
                        // Without the local model, the server-Parakeet recovery below is the primary path.
                        if record.transcriptionMode == .onDevice && !model.transcriber.availableLocally { upload.buttonStyle(.bordered) } else { upload.buttonStyle(.borderedProminent) }
                    }
                    if syncing { ProgressView().controlSize(.small) }
                    Spacer()
                    Button { Task { await model.export(record) } } label: { Label("Export…", systemImage: "square.and.arrow.up") }.disabled(busy)
                }.controlSize(.large)
                if let error = record.error { Callout(text: error) }
                if record.transcriptionAdmissionRejected == true && record.videoID == nil && record.state == .ready {
                    VStack(alignment: .leading, spacing: 6) {
                        Button("Use private server Parakeet and retry") { Task { await model.usePrivateTranscriptionAndRetry(record.id) } }.disabled(syncing || busy)
                        Text("This recording will use Parakeet on your Relay server. Its identity and local media stay intact.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                TranscriptStatus(model: model, transcriber: model.transcriber, record: record)
                if let transcript = record.transcript, !transcript.segments.isEmpty {
                    GroupBox {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(transcript.segments.enumerated()), id: \.offset) { _, segment in
                                Button { player?.seek(to: CMTime(seconds: segment.start, preferredTimescale: 600)); player?.play() } label: {
                                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                                        Text(elapsed(segment.start)).monospacedDigit().font(.callout).foregroundStyle(.secondary)
                                        Text(segment.text).frame(maxWidth: .infinity, alignment: .leading)
                                    }.contentShape(Rectangle())
                                }.buttonStyle(.plain).help("Play from \(elapsed(segment.start))")
                            }
                        }.padding(6)
                    } label: { Label("Transcript", systemImage: "text.quote") }
                }
                Divider()
                Button("Delete local recording…", role: .destructive, action: onDelete).disabled(busy || syncing)
            }.padding(20)
        }
        .task(id: record.id) { player?.pause(); player = AVPlayer(url: model.mediaURL(record)); title = record.title }
        .onChange(of: record.title) { _, newValue in title = newValue }
        .onDisappear { player?.pause() }
    }
    private func save() {
        let trimmed = title.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed != record.title else { title = record.title; return }
        Task { await model.rename(record.id, title: trimmed) }
    }
}

struct LibraryRow: View {
    let record: RecordingRecord
    let mediaURL: URL
    let capturing: Bool
    var body: some View {
        HStack(spacing: 12) {
            RecordingThumbnail(url: mediaURL, enabled: !capturing && ![.preparing, .recording, .paused].contains(record.state))
            VStack(alignment: .leading, spacing: 4) {
                Text(record.title).font(.headline).lineLimit(2)
                Text("\(record.createdAt.formatted(date: .abbreviated, time: .shortened)) · \(elapsed(record.duration))").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                StatusBadge(record: record)
            }
        }.padding(.vertical, 6)
    }
}

/// First frame of the local recording; falls back to an icon while capturing or if the file is unreadable.
struct RecordingThumbnail: View {
    let url: URL
    let enabled: Bool
    @ViewState private var image: CGImage?
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6).fill(.quaternary)
            if let image { Image(decorative: image, scale: 1).resizable().scaledToFill() } else { Image(systemName: "video").foregroundStyle(.secondary) }
        }
        .frame(width: 96, height: 54).clipShape(RoundedRectangle(cornerRadius: 6))
        .task(id: "\(url.path)-\(enabled)") {
            guard enabled else { image = nil; return }
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true; generator.maximumSize = CGSize(width: 192, height: 108)
            image = try? await generator.image(at: CMTime(seconds: 0.5, preferredTimescale: 600)).image
        }
    }
}

struct StatusBadge: View {
    let record: RecordingRecord
    var body: some View {
        let (text, icon, color) = Self.style(for: record)
        Label(text, systemImage: icon).font(.caption.weight(.medium)).foregroundStyle(color)
            .padding(.horizontal, 7).padding(.vertical, 2).background(color.opacity(0.12), in: Capsule())
    }
    static func style(for record: RecordingRecord) -> (String, String, Color) {
        switch record.state {
        case .preparing, .recording, .paused: ("Recording", "record.circle", .red)
        case .interrupted: ("Needs recovery", "exclamationmark.triangle", .orange)
        case .ready: ("On this Mac", "internaldrive", .secondary)
        case .uploading: ("Uploading", "arrow.up.circle", .blue)
        case .uploaded: record.transcriptionMode == .onDevice && record.transcriptSyncState != .synced ? ("Transcript pending", "clock", .orange) : ("In workspace", "checkmark.circle", .green)
        case .failed: ("Upload failed", "xmark.octagon", .red)
        case .canceled: ("Canceled", "slash.circle", .secondary)
        }
    }
}

struct Callout: View {
    let text: String
    var body: some View {
        Label { Text(text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) } icon: { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
            .font(.callout).padding(10).background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }
}

func workspaceURL(_ record: RecordingRecord) -> URL? {
    guard let video = record.videoID, let origin = record.server, let base = URL(string: origin) else { return nil }
    return base.appending(path: "videos/\(video)")
}
func copyLink(_ url: URL) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(url.absoluteString, forType: .string) }
struct SettingsView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var account: Account
    @ObservedObject var transcriber: LocalTranscriber
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Make Relay yours.").font(.largeTitle.bold())
                GroupBox("Your server") {
                    VStack(alignment: .leading, spacing: 12) {
                        TextField("https://relay.example.com", text: $account.serverText).textFieldStyle(.roundedBorder).disabled(account.user != nil || account.signingIn)
                        HStack {
                            if account.user != nil { Button("Sign out") { Task { await account.signOut() } } }
                            else if account.signingIn { ProgressView().controlSize(.small); Button("Cancel sign-in") { account.cancelSignIn() } }
                            else { Button("Sign in with browser") { account.signIn() }.buttonStyle(.borderedProminent) }
                        }
                        Text(account.status).font(.caption).foregroundStyle(.secondary)
                        if !account.workspaces.isEmpty { Picker("Workspace", selection: Binding(get: { account.workspaceID }, set: { account.selectWorkspace($0) })) { ForEach(account.workspaces) { Text($0.name).tag($0.id) } } }
                    }.padding(12)
                }
                GroupBox("Transcription") {
                    VStack(alignment: .leading, spacing: 14) {
                        Picker("New recordings", selection: Binding(get: { model.transcriptionPreference }, set: { model.setTranscriptionPreference($0) })) { Text("Auto · local Parakeet when ready, otherwise self-hosted").tag(TranscriptionPreference.automatic); Text("Local only · Parakeet v3").tag(TranscriptionPreference.localOnly); Text("Self-hosted · Parakeet v3").tag(TranscriptionPreference.server); Text("External · explicitly selected provider").tag(TranscriptionPreference.external) }.pickerStyle(.radioGroup)
                        if model.transcriptionPreference == .external {
                            if let saved = model.externalSpeechPreference {
                                Text("Saved choice: \(saved.selection.label), configuration version \(saved.selection.configurationVersion ?? 0)").font(.caption)
                            }
                            ForEach(account.speechOptions) { option in
                                Button("Use \(option.provider) · \(option.model) · v\(option.configurationVersion ?? 0)") { model.selectExternalSpeech(option) }
                                Text("\(option.capabilities.timing) timing · languages: \(option.capabilities.languages.joined(separator: ", "))").font(.caption).foregroundStyle(.secondary)
                            }
                            Text("Audio will be sent to the selected external provider through your server. Provider charges apply. Text-only models cannot supply captions or timed word cuts.").font(.caption).foregroundStyle(.secondary)
                            Text(account.speechStatus).font(.caption).foregroundStyle(.secondary)
                            Button("Refresh providers") { Task { await account.refreshSpeechOptions() } }.disabled(account.user == nil)
                        }
                        Text("Auto uses the verified, runnable model on this Mac when available. Otherwise it selects your private server before recording. Local only keeps transcription pending until the model is ready. Each recording preserves its choice.").font(.caption).foregroundStyle(.secondary)
                        Text("Parakeet v3 supports 25 European languages. Unsupported languages cannot be transcribed reliably. Relay never switches transcription providers automatically.").font(.caption).foregroundStyle(.secondary)
                        DisclosureGroup("Supported languages") {
                            Text("Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek, Hungarian, Italian, Latvian, Lithuanian, Maltese, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Ukrainian.").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        Divider()
                        HStack {
                            Label(transcriber.installed ? (transcriber.usingSharedModel ? "Parakeet v3 found on this Mac" : "Parakeet v3 installed") : "Parakeet v3 not installed", systemImage: transcriber.installed ? "checkmark.circle" : "arrow.down.circle")
                            Spacer()
                            if transcriber.busy { if transcriber.downloading { Button("Cancel download") { transcriber.cancelDownload() } } else { Text("Transcribing…").foregroundStyle(.secondary) } }
                            else {
                                if transcriber.installed { Button("Verify & load") { transcriber.verify() } } else { Button("Download model") { transcriber.download() } }
                                if transcriber.installed { Button(transcriber.usingSharedModel ? "Stop using shared model" : "Remove model", role: .destructive) { do { try transcriber.remove() } catch { model.error = error.localizedDescription } } }
                            }
                        }
                        if transcriber.busy { ProgressView(value: transcriber.progress) }
                        Text(transcriber.status).font(.caption).foregroundStyle(.secondary)
                        Button("Show model files") { NSWorkspace.shared.open(transcriber.directory.deletingLastPathComponent()) }
                    }.padding(12)
                }
                GroupBox("Local library") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Originals and recording journals remain on this Mac until you explicitly delete them. Interrupted recordings can be recovered from complete fragments.").font(.callout)
                        Button("Show recordings in Finder") { NSWorkspace.shared.open(model.root) }
                        Text(model.root.path).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    }.padding(12)
                }
                Button("Open privacy settings") { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!) }
            }.frame(maxWidth: 780, alignment: .leading)
        }
    }
}
func elapsed(_ seconds: Double) -> String { let value = seconds.isFinite ? max(0, Int(seconds)) : 0; return String(format: "%02d:%02d", value / 60, value % 60) }

/// AppKit's player view. SwiftUI's `VideoPlayer` aborts while loading its AVKit overlay in this
/// command-line (SwiftPM) build, which crashed the app when a recording was opened in Library.
struct PlayerView: NSViewRepresentable {
    let player: AVPlayer?
    func makeNSView(context: Context) -> AVPlayerView { let view = AVPlayerView(); view.controlsStyle = .inline; view.player = player; return view }
    func updateNSView(_ view: AVPlayerView, context: Context) { if view.player !== player { view.player = player } }
}

/// Shown before recording when "Local only" is chosen but Parakeet is not on this Mac yet. Recording is never blocked.
struct LocalSpeechBanner: View {
    @ObservedObject var model: AppModel
    @ObservedObject var transcriber: LocalTranscriber
    var body: some View {
        if model.transcriptionPreference == .localOnly && !transcriber.availableLocally {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: transcriber.downloading ? "arrow.down.circle" : "exclamationmark.triangle.fill").foregroundStyle(transcriber.downloading ? Color.accentColor : .orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text(transcriber.downloading ? "Downloading Parakeet v3 for on-device transcripts…" : "Parakeet isn't on this Mac yet").font(.headline)
                    Text(transcriber.downloading ? transcriber.status : "You chose Local only, so new recordings wait for the model before they get a transcript.").font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                if transcriber.downloading { ProgressView(value: transcriber.progress).frame(width: 120) }
                else {
                    Button("Download Parakeet") { transcriber.download() }.buttonStyle(.borderedProminent).disabled(transcriber.busy)
                    Button("Use Auto") { model.setTranscriptionPreference(.automatic) }.help("Use Parakeet on this Mac when ready, otherwise Parakeet on your private Relay server.")
                }
            }
            .padding(14).background(Color.orange.opacity(transcriber.downloading ? 0.05 : 0.1), in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

/// On-device transcript state; when the local model is missing, offers recovery instead of a bare error.
struct TranscriptStatus: View {
    @ObservedObject var model: AppModel
    @ObservedObject var transcriber: LocalTranscriber
    let record: RecordingRecord
    var body: some View {
        if record.transcriptionMode == .onDevice, record.transcriptSyncState != .synced, record.transcript == nil, !transcriber.availableLocally {
            VStack(alignment: .leading, spacing: 8) {
                Label("This recording is set to transcribe on this Mac, but Parakeet isn't installed.", systemImage: "waveform.badge.exclamationmark").font(.callout)
                HStack {
                    Button(transcriber.downloading ? "Downloading…" : "Download Parakeet") { transcriber.download() }.disabled(transcriber.busy)
                    if record.videoID == nil && [.ready, .failed].contains(record.state) {
                        Button("Transcribe with server Parakeet") { Task { await model.useServerParakeetAndUpload(record.id) } }
                            .buttonStyle(.borderedProminent).disabled(model.uploadingIDs.contains(record.id) || model.active?.id == record.id)
                            .help("Uploads this recording and transcribes it with Parakeet on your private Relay server.")
                    }
                }
                if transcriber.downloading { ProgressView(value: transcriber.progress) }
            }.padding(12).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        } else if record.transcriptionMode == .onDevice, record.transcriptSyncState != .synced {
            Text("Transcript: \(record.transcriptSyncState?.rawValue ?? "pending")").font(.callout).foregroundStyle(.secondary)
            if let speechError = record.transcriptSyncError { Callout(text: speechError) }
        }
    }
}
