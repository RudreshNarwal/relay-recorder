import AppKit
import Carbon
import RelayCore

@MainActor final class CaptureOverlays: NSObject, NSWindowDelegate {
    var onCameraMove: ((CGPoint) -> Void)?
    var onInk: (([InkStroke]) -> Void)?
    private var camera: NSPanel?
    private var cameraView: NSView?
    private var inkPanel: NSPanel?
    private var inkView: InkView?
    private var notesPanel: NSPanel?
    private var picker: NSPanel?
    private var captureBounds = CGRect.zero
    func configure(screen: NSScreen, displayRegion: CGRect) {
        captureBounds = CGRect(x: screen.frame.minX + screen.frame.width * displayRegion.minX, y: screen.frame.minY + screen.frame.height * (1 - displayRegion.maxY), width: screen.frame.width * displayRegion.width, height: screen.frame.height * displayRegion.height)
    }
    func configure(bounds: CGRect) { captureBounds = bounds }
    func showCamera(shape: CameraShape, corner: CameraCorner) {
        if camera == nil {
            let frame = CameraBubble.frame(position: corner.position, in: captureBounds)
            let panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.level = .floating; panel.isMovableByWindowBackground = true; panel.hasShadow = true
            panel.isOpaque = false; panel.backgroundColor = .clear
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            let view = NSView(frame: CGRect(origin: .zero, size: frame.size)); view.wantsLayer = true
            view.layer?.backgroundColor = NSColor.black.cgColor; view.layer?.masksToBounds = true
            view.layer?.contentsGravity = .resizeAspectFill
            panel.contentView = view; panel.delegate = self; camera = panel; cameraView = view
        }
        setCameraShape(shape)
        camera?.orderFrontRegardless(); if let camera { updateCameraPosition(camera) }
    }
    func setCameraShape(_ shape: CameraShape) {
        guard let cameraView else { return }
        cameraView.layer?.cornerRadius = cameraView.bounds.width * shape.cornerFraction
        camera?.invalidateShadow()
    }
    func moveCamera(to corner: CameraCorner) {
        guard let camera else { return }
        camera.setFrame(CameraBubble.frame(position: corner.position, in: captureBounds), display: true)
        updateCameraPosition(camera)
    }
    func cameraImage(_ image: CGImage) { cameraView?.layer?.contents = image }
    func windowDidMove(_ notification: Notification) { if let camera, notification.object as? NSWindow === camera { updateCameraPosition(camera) } }
    private func updateCameraPosition(_ panel: NSPanel) {
        guard captureBounds.width > 0, captureBounds.height > 0 else { return }
        onCameraMove?(CameraBubble.position(of: panel.frame, in: captureBounds))
    }
    func setDrawing(_ enabled: Bool) {
        if inkPanel == nil {
            let panel = NSPanel(contentRect: captureBounds, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.level = .floating; panel.isOpaque = false; panel.backgroundColor = .clear
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            let view = InkView(frame: CGRect(origin: .zero, size: captureBounds.size)); view.onChange = { [weak self] strokes in self?.onInk?(strokes) }
            panel.contentView = view; inkView = view; inkPanel = panel
        }
        inkPanel?.ignoresMouseEvents = !enabled
        inkView?.drawingEnabled = enabled; inkView?.needsDisplay = true
        inkPanel?.orderFrontRegardless()
        if enabled { NSCursor.crosshair.push() } else { NSCursor.pop() }
    }
    func clearInk() { inkView?.strokes = []; inkView?.needsDisplay = true; onInk?([]) }
    func showNotes(_ visible: Bool, text: String) {
        guard visible else { notesPanel?.orderOut(nil); return }
        if notesPanel == nil {
            let panel = NSPanel(contentRect: CGRect(x: NSScreen.main?.visibleFrame.minX ?? 30, y: NSScreen.main?.visibleFrame.midY ?? 300, width: 360, height: 320), styleMask: [.titled, .closable, .resizable, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.title = "Relay · Speaker notes"; panel.level = .floating
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            let scroll = NSScrollView(frame: CGRect(x: 0, y: 0, width: 360, height: 320)); scroll.hasVerticalScroller = true; scroll.autoresizingMask = [.width, .height]
            let view = NSTextView(frame: scroll.bounds); view.isEditable = false; view.font = .systemFont(ofSize: 22); view.textContainerInset = NSSize(width: 16, height: 16); view.autoresizingMask = [.width]; view.isVerticallyResizable = true
            scroll.documentView = view; panel.contentView = scroll; notesPanel = panel
        }
        ((notesPanel?.contentView as? NSScrollView)?.documentView as? NSTextView)?.string = text
        notesPanel?.orderFrontRegardless()
    }
    func hide() {
        camera?.orderOut(nil); inkPanel?.orderOut(nil)
        if inkView?.drawingEnabled == true { NSCursor.pop() }
        camera = nil; cameraView = nil; inkPanel = nil; inkView = nil
        onInk?([])
    }
    func pickRegion(on screen: NSScreen, completion: @escaping (CGRect) -> Void) {
        picker?.close()
        let panel = RegionPanel(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        panel.level = .screenSaver; panel.isOpaque = false; panel.backgroundColor = .clear
        let view = RegionView(frame: CGRect(origin: .zero, size: screen.frame.size))
        view.onFinish = { [weak self, weak panel] rect in panel?.close(); self?.picker = nil; if let rect { completion(rect) } }
        panel.onCancel = { view.onFinish?(nil) }
        panel.contentView = view; picker = panel; panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

@MainActor private final class InkView: NSView {
    var strokes: [InkStroke] = []
    var drawingEnabled = false
    var onChange: (([InkStroke]) -> Void)?
    override func mouseDown(with event: NSEvent) { guard drawingEnabled else { return }; strokes.append(InkStroke(points: [point(event)])); needsDisplay = true }
    override func mouseDragged(with event: NSEvent) {
        guard drawingEnabled, !strokes.isEmpty else { return }
        strokes[strokes.count - 1].points.append(point(event)); onChange?(strokes); needsDisplay = true
    }
    override func draw(_ dirtyRect: NSRect) {
        for stroke in strokes where stroke.points.count > 1 {
            let path = NSBezierPath(); path.lineWidth = 4; path.lineCapStyle = .round; stroke.color.setStroke()
            path.move(to: CGPoint(x: stroke.points[0].x * bounds.width, y: stroke.points[0].y * bounds.height))
            for p in stroke.points.dropFirst() { path.line(to: CGPoint(x: p.x * bounds.width, y: p.y * bounds.height)) }; path.stroke()
        }
        if drawingEnabled {
            let label = "Drawing enabled · ⌘⇧6 to return to desktop"
            label.draw(at: CGPoint(x: 20, y: bounds.height - 40), withAttributes: [.font: NSFont.boldSystemFont(ofSize: 16), .foregroundColor: NSColor.systemYellow])
        }
    }
    private func point(_ event: NSEvent) -> CGPoint { let p = convert(event.locationInWindow, from: nil); return CGPoint(x: max(0, min(1, p.x / bounds.width)), y: max(0, min(1, p.y / bounds.height))) }
}
@MainActor private final class RegionPanel: NSPanel {
    var onCancel: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override func keyDown(with event: NSEvent) { if event.keyCode == 53 { onCancel?() } else { super.keyDown(with: event) } }
}
@MainActor private final class RegionView: NSView {
    var onFinish: ((CGRect?) -> Void)?
    private var origin: CGPoint?
    private var selection = CGRect.zero
    override func mouseDown(with event: NSEvent) { origin = convert(event.locationInWindow, from: nil) }
    override func mouseDragged(with event: NSEvent) {
        guard let origin else { return }; let p = convert(event.locationInWindow, from: nil)
        selection = CGRect(x: min(origin.x, p.x), y: min(origin.y, p.y), width: abs(p.x - origin.x), height: abs(p.y - origin.y)).intersection(bounds); needsDisplay = true
    }
    override func mouseUp(with event: NSEvent) {
        mouseDragged(with: event)
        guard selection.width >= 40, selection.height >= 40 else { onFinish?(nil); return }
        onFinish?(CGRect(x: selection.minX / bounds.width, y: 1 - selection.maxY / bounds.height, width: selection.width / bounds.width, height: selection.height / bounds.height))
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.3).setFill(); bounds.fill()
        NSColor.systemTeal.setStroke(); let path = NSBezierPath(rect: selection); path.lineWidth = 3; path.stroke()
        "Drag to select recording region · Escape cancels".draw(at: CGPoint(x: 24, y: bounds.height - 52), withAttributes: [.font: NSFont.boldSystemFont(ofSize: 22), .foregroundColor: NSColor.white])
    }
}

@MainActor final class GlobalHotkeys {
    private var references: [EventHotKeyRef] = []
    private var handler: EventHandlerRef?
    private let action: (Int) -> Void
    init(action: @escaping (Int) -> Void) {
        self.action = action
        var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let event, let userData else { return OSStatus(eventNotHandledErr) }
            var id = EventHotKeyID(); GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            let owner = Unmanaged<GlobalHotkeys>.fromOpaque(userData).takeUnretainedValue()
            MainActor.assumeIsolated { owner.action(Int(id.id)) }
            return noErr
        }, 1, &type, Unmanaged.passUnretained(self).toOpaque(), &handler)
        for (index, key) in [kVK_ANSI_2, kVK_ANSI_3, kVK_ANSI_4, kVK_ANSI_5, kVK_ANSI_6].enumerated() {
            var reference: EventHotKeyRef?
            if RegisterEventHotKey(UInt32(key), UInt32(cmdKey | shiftKey), EventHotKeyID(signature: 0x524C4159, id: UInt32(index + 1)), GetApplicationEventTarget(), 0, &reference) == noErr, let reference { references.append(reference) }
        }
    }
    deinit { for reference in references { UnregisterEventHotKey(reference) }; if let handler { RemoveEventHandler(handler) } }
}
