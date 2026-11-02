import AppKit
import AVFoundation
import ScreenCaptureKit
import CoreImage
import Vision
import RelayCore

struct CaptureSettings {
    enum Mode: String, CaseIterable, Identifiable { case display = "Screen", window = "Window", region = "Region", camera = "Camera only"; var id: String { rawValue } }
    var mode: Mode = .display
    var width = 1920
    var height = 1080
    var microphone = true
    var systemAudio = true
    var enhanceVoice = true
    var suppressNoise = true
    var camera = false
    var cameraID: String?
    var cameraFormat: AVCaptureDevice.Format?
    var microphoneID: String?
    var blurCamera = false
    var cameraShape: CameraShape = .circle
    var cameraCorner: CameraCorner = .bottomRight
    var cursorEmphasis = true
    var region = CGRect(x: 0.1, y: 0.1, width: 0.8, height: 0.8)
}
struct InkStroke { var points: [CGPoint]; var color: NSColor = .systemYellow }

/// Capture, composition, timing, writer mutation and audio mixing share one serial queue.
final class CaptureEngine: NSObject, SCStreamOutput, SCStreamDelegate, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "app.relay.capture", qos: .userInitiated)
    private var stream: SCStream?
    private var cameraSession: AVCaptureSession?
    private var movie: FragmentMovie?
    private var clock = RecordingClock()
    private var paused = false
    private var recording = false
    private var settings = CaptureSettings()
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var cameraFrame: CVPixelBuffer?
    private var screenFrame: CVPixelBuffer?
    private var renderTimer: DispatchSourceTimer?
    private var renderEpoch: UInt64 = 0
    private var cameraPosition = CGPoint(x: 0.8, y: 0.2)
    private var cursorPosition = CGPoint(x: -1, y: -1)
    private var strokes: [InkStroke] = []
    private var frameCount = 0
    private var lastPTS = CMTime.negativeInfinity
    private var lastPreview: Double = 0
    private var audioBlocks: [Int: [Float]] = [:]
    private var audioNextBlock = 0
    private var voiceIsolation: VoiceIsolation?
    private let mixFormat = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    private var latestPreview: CGImage?
    private var recordingURL: URL?
    private var lastDiskCheck = 0.0
    private var lastCameraSample = 0.0
    private var writtenFrames = 0
    private var droppedFrames = 0
    private var consecutiveDrops = 0
    private var reportedError = false
    private var sessionObservers: [NSObjectProtocol] = []
    var onQuality: (@Sendable (String) -> Void)?
    var onPreview: (@Sendable (CGImage) -> Void)?
    var onCamera: (@Sendable (CGImage) -> Void)?
    var onError: (@Sendable (String) -> Void)?
    var onDuration: (@Sendable (Double) -> Void)?
    static var now: Double { CMClockGetTime(CMClockGetHostTimeClock()).seconds }

    func prepare(settings: CaptureSettings, display: SCDisplay?, window: SCWindow?) async throws {
        guard stream == nil, cameraSession == nil else { throw RelayError.invalidState }
        self.settings = settings; cameraPosition = settings.cameraCorner.position
        if settings.camera || settings.mode == .camera {
            guard await AVCaptureDevice.requestAccess(for: .video) else { throw RelayError.server("Camera access denied. Enable Relay in System Settings → Privacy & Security → Camera.") }
        }
        if settings.microphone {
            guard await AVCaptureDevice.requestAccess(for: .audio) else { throw RelayError.server("Microphone access denied. Enable Relay in System Settings → Privacy & Security → Microphone.") }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async { [self] in
                do {
                    self.reportedError = false
                    let session = AVCaptureSession()
                    session.beginConfiguration(); session.sessionPreset = .high
                    if settings.camera || settings.mode == .camera {
                        let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .external], mediaType: .video, position: .unspecified).devices
                        guard let device = (settings.cameraID == nil ? AVCaptureDevice.default(for: .video) : devices.first(where: { $0.uniqueID == settings.cameraID })) else { throw RelayError.server("No camera is connected.") }
                        let input = try AVCaptureDeviceInput(device: device)
                        guard session.canAddInput(input) else { throw RelayError.server("Camera is unavailable.") }
                        session.addInput(input)
                        let output = AVCaptureVideoDataOutput()
                        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
                        output.alwaysDiscardsLateVideoFrames = true
                        output.setSampleBufferDelegate(self, queue: self.queue)
                        guard session.canAddOutput(output) else { throw RelayError.invalidMedia }
                        session.addOutput(output)
                    }
                    if settings.microphone {
                        let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
                        guard let device = (settings.microphoneID == nil ? AVCaptureDevice.default(for: .audio) : devices.first(where: { $0.uniqueID == settings.microphoneID })) else { throw RelayError.server("No microphone is connected.") }
                        let input = try AVCaptureDeviceInput(device: device)
                        guard session.canAddInput(input) else { throw RelayError.server("Microphone is unavailable.") }
                        session.addInput(input)
                        let output = AVCaptureAudioDataOutput(); output.setSampleBufferDelegate(self, queue: self.queue)
                        guard session.canAddOutput(output) else { throw RelayError.invalidMedia }
                        session.addOutput(output)
                    }
                    session.commitConfiguration()
                    if let format = settings.cameraFormat, let input = session.inputs.compactMap({ $0 as? AVCaptureDeviceInput }).first(where: { $0.device.hasMediaType(.video) }) {
                        try input.device.lockForConfiguration()
                        input.device.activeFormat = format
                        input.device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 30)
                        input.device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 30)
                        input.device.unlockForConfiguration()
                    }
                    self.renderEpoch &+= 1
                    let epoch = self.renderEpoch
                    let timer = DispatchSource.makeTimerSource(queue: self.queue)
                    timer.schedule(deadline: .now(), repeating: .nanoseconds(33_333_333))
                    timer.setEventHandler { [weak self] in
                        guard let self, self.renderEpoch == epoch else { return }
                        self.monitor()
                        if let pixel = self.settings.mode == .camera ? self.cameraFrame : self.screenFrame {
                            self.processFrame(pixel, time: Self.now)
                        }
                    }
                    self.renderTimer = timer; timer.resume()
                    if !session.inputs.isEmpty {
                        self.cameraSession = session
                        for name in [AVCaptureSession.runtimeErrorNotification, AVCaptureSession.wasInterruptedNotification] {
                            self.sessionObservers.append(NotificationCenter.default.addObserver(forName: name, object: session, queue: nil) { [weak self, weak session] _ in
                                self?.queue.async { [weak self, weak session] in guard let self, self.cameraSession === session else { return }; self.report("Camera or microphone capture was interrupted. Reconnect the device and start a new recording. Captured media is retained.") }
                            })
                        }
                        self.sessionObservers.append(NotificationCenter.default.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: nil) { [weak self, weak session] notification in
                            guard let device = notification.object as? AVCaptureDevice else { return }
                            self?.queue.async { [weak self, weak session] in
                                guard let self, self.cameraSession === session, device.uniqueID == self.settings.cameraID || device.uniqueID == self.settings.microphoneID else { return }
                                self.report("Selected capture device disconnected. Reconnect it and start a new recording. Captured media is retained.")
                            }
                        })
                        session.startRunning()
                    }
                    continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
        if settings.mode != .camera {
            let filter: SCContentFilter
            if settings.mode == .window {
                guard let window else { throw RelayError.server("Select a window.") }
                filter = SCContentFilter(desktopIndependentWindow: window)
            } else {
                guard let display else { throw RelayError.server("Select a display.") }
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                let ownApps = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
                filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])
            }
            let config = SCStreamConfiguration()
            config.width = settings.width; config.height = settings.height
            config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
            config.queueDepth = 5; config.showsCursor = true
            config.capturesAudio = settings.systemAudio
            config.excludesCurrentProcessAudio = true
            config.sampleRate = 48000; config.channelCount = 2
            config.scalesToFit = true; config.preservesAspectRatio = true
            if settings.mode == .region {
                let bounds = filter.contentRect
                config.sourceRect = CGRect(x: settings.region.minX * bounds.width, y: settings.region.minY * bounds.height, width: settings.region.width * bounds.width, height: settings.region.height * bounds.height)
            }
            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            if settings.systemAudio { try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue) }
            await withCheckedContinuation { continuation in queue.async { self.stream = stream; continuation.resume() } }
            try await stream.startCapture()
        }
    }
    func startRecording(to url: URL) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                do {
                    guard !self.recording else { throw RelayError.invalidState }
                    let videoBitsPerSecond = Double(self.settings.width * self.settings.height * 5)
                    let totalBitsPerSecond: Double = videoBitsPerSecond + 192_000
                    let bytesPerMinute = Int64(totalBitsPerSecond / 8 * 60 * 1.1)
                    guard try CaptureCapabilities.freeBytes(at: url.deletingLastPathComponent()) >= CaptureFormat.diskReserve + bytesPerMinute else { throw RelayError.server("Disk space fell below the capture reserve. Free space and retry; existing recordings are retained.") }
                    self.recordingURL = url; self.lastDiskCheck = Self.now; self.lastCameraSample = Self.now
                    self.writtenFrames = 0; self.droppedFrames = 0; self.consecutiveDrops = 0; self.reportedError = false
                    self.movie = try FragmentMovie(url: url, width: self.settings.width, height: self.settings.height, hasAudio: self.settings.microphone || (self.settings.systemAudio && self.settings.mode != .camera))
                    self.clock = RecordingClock(); try self.clock.start(at: Self.now)
                    self.paused = false; self.recording = true; self.lastPTS = .negativeInfinity
                    self.audioBlocks = [:]; self.audioNextBlock = 0
                    // Fresh unit per take so no audio from a previous recording leaks through its latency buffer.
                    self.voiceIsolation = self.settings.microphone && self.settings.suppressNoise ? try? VoiceIsolation(format: self.mixFormat) : nil
                    continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    func setPaused(_ pause: Bool) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                do {
                    guard self.recording else { throw RelayError.invalidState }
                    if pause { try self.clock.pause(at: Self.now) } else { try self.clock.resume(at: Self.now) }
                    self.paused = pause; continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    func finish() async throws -> Double {
        let result: (FragmentMovie, Double) = try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    guard self.recording, let movie = self.movie else { throw RelayError.invalidState }
                    let duration = self.clock.elapsed(at: Self.now)
                    self.flushAudio(through: duration)
                    try self.clock.stop(at: Self.now)
                    self.recording = false; self.movie = nil
                    continuation.resume(returning: (movie, duration))
                } catch { continuation.resume(throwing: error) }
            }
        }
        try await result.0.finish()
        return result.1
    }
    func shutdown() async {
        let previous: SCStream? = await withCheckedContinuation { continuation in
            queue.async { let value = self.stream; self.stream = nil; self.renderEpoch &+= 1; continuation.resume(returning: value) }
        }
        if let previous { try? await previous.stopCapture() }
        await withCheckedContinuation { continuation in
            queue.async {
                self.renderTimer?.cancel(); self.renderTimer = nil
                self.sessionObservers.forEach(NotificationCenter.default.removeObserver); self.sessionObservers = []
                self.cameraSession?.stopRunning(); self.cameraSession = nil; self.voiceIsolation = nil; self.cameraFrame = nil; self.screenFrame = nil; self.latestPreview = nil
                continuation.resume()
            }
        }
    }
    func updateOverlay(camera: CGPoint? = nil, cursor: CGPoint? = nil, ink: [InkStroke]? = nil, blur: Bool? = nil, shape: CameraShape? = nil) {
        queue.async {
            if let camera { self.cameraPosition = camera }
            if let cursor { self.cursorPosition = cursor }
            if let ink { self.strokes = ink }
            if let blur { self.settings.blurCamera = blur }
            if let shape { self.settings.cameraShape = shape }
        }
    }
    func screenshot(to url: URL) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                do {
                    guard let image = self.latestPreview, let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw RelayError.invalidMedia }
                    try data.write(to: url, options: .atomic); continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    private func report(_ message: String) {
        guard !reportedError else { return }; reportedError = true; onError?(message)
    }
    private func monitor() {
        guard recording, !reportedError, let recordingURL, Self.now - lastDiskCheck >= 1 else { return }
        lastDiskCheck = Self.now
        do {
            guard try CaptureCapabilities.freeBytes(at: recordingURL.deletingLastPathComponent()) >= CaptureFormat.diskReserve else { report("Disk recovery reserve reached. Capture stopped; free disk space before recording again."); return }
        } catch { report("Recording volume is unavailable. Captured media is retained; reconnect the volume before retrying."); return }
        if (settings.camera || settings.mode == .camera) && Self.now - lastCameraSample > 5 { report("Camera stopped delivering frames. Reconnect it and start a new recording."); return }
        let noise = settings.microphone && settings.suppressNoise ? (voiceIsolation == nil ? " · Noise suppression unavailable" : " · Noise suppression on") : ""
        onQuality?("Encoded \(writtenFrames) frames · Dropped \(droppedFrames) frames\(noise)")
    }
    private func droppedFrame() {
        droppedFrames += 1; consecutiveDrops += 1
        if consecutiveDrops >= 60 { report("The encoder could not keep up for two seconds. Capture stopped. Choose a lower resolution or close other demanding apps.") }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { [weak self] in guard let self, self.stream === stream else { return }; self.report(error.localizedDescription) }
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard self.stream === stream, sampleBuffer.isValid else { return }
        switch outputType {
        case .screen:
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]], let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue, let image = sampleBuffer.imageBuffer else { return }
            screenFrame = image
        case .audio: receiveAudio(sampleBuffer, microphone: false)
        default: break
        }
    }
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard cameraSession?.outputs.contains(where: { $0 === output }) == true else { return }
        if output is AVCaptureAudioDataOutput { receiveAudio(sampleBuffer, microphone: true); return }
        guard let image = sampleBuffer.imageBuffer else { return }
        lastCameraSample = Self.now
        if settings.mode == .camera && (CVPixelBufferGetWidth(image) < settings.width || CVPixelBufferGetHeight(image) < settings.height) { report("Camera negotiated a smaller format than requested. Choose a lower resolution and preview again."); return }
        cameraFrame = image

        if frameCount % 3 == 0, let preview = context.createCGImage(CIImage(cvPixelBuffer: image), from: CIImage(cvPixelBuffer: image).extent) { onCamera?(preview) }
    }
    private func processFrame(_ pixel: CVPixelBuffer, time: Double) {
        frameCount += 1
        let bounds = CGRect(x: 0, y: 0, width: settings.width, height: settings.height)
        var image = fit(CIImage(cvPixelBuffer: pixel), into: bounds)
        if settings.mode == .camera { image = cameraImage(pixel, bounds: bounds) }
        else if settings.camera, let cameraFrame {
            let rect = CameraBubble.frame(position: cameraPosition, in: bounds)
            let mask = CIFilter(name: "CIRoundedRectangleGenerator", parameters: ["inputExtent": CIVector(cgRect: rect), "inputRadius": rect.width * settings.cameraShape.cornerFraction, "inputColor": CIColor.white])?.outputImage ?? CIImage(color: .white).cropped(to: rect)
            let bubble = cameraImage(cameraFrame, bounds: rect, fill: true).applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: CIImage.empty(), kCIInputMaskImageKey: mask])
            image = bubble.composited(over: image)
        }
        if let annotations = annotationImage(bounds: bounds) { image = annotations.composited(over: image) }
        if Self.now - lastPreview >= 0.1, let preview = context.createCGImage(image, from: bounds) {
            latestPreview = preview; lastPreview = Self.now; onPreview?(preview)
        }
        guard recording, !paused, !reportedError, let movie else { return }
        let elapsed = clock.elapsed(at: time)
        let pts = CMTime(seconds: elapsed, preferredTimescale: 60000)
        guard pts > lastPTS else { return }
        var output: CVPixelBuffer?
        if let pool = movie.adaptor.pixelBufferPool { CVPixelBufferPoolCreatePixelBuffer(nil, pool, &output) }
        guard let output else { droppedFrame(); return }
        context.render(image, to: output)
        do {
            if try movie.append(output, at: pts) { lastPTS = pts; writtenFrames += 1; consecutiveDrops = 0 } else { droppedFrame() }
            flushAudio(through: max(0, elapsed - 0.15 - (voiceIsolation?.latency ?? 0))); onDuration?(elapsed)
        } catch { report(error.localizedDescription) }
    }
    private func fit(_ image: CIImage, into rect: CGRect) -> CIImage {
        let scale = min(rect.width / image.extent.width, rect.height / image.extent.height)
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let moved = scaled.transformed(by: CGAffineTransform(translationX: rect.midX - scaled.extent.midX, y: rect.midY - scaled.extent.midY))
        return moved.composited(over: CIImage(color: .black).cropped(to: rect)).cropped(to: rect)
    }
    private func cameraImage(_ pixel: CVPixelBuffer, bounds: CGRect, fill: Bool = false) -> CIImage {
        var image = CIImage(cvPixelBuffer: pixel)
        if settings.blurCamera {
            let request = VNGeneratePersonSegmentationRequest(); request.qualityLevel = .balanced
            request.outputPixelFormat = kCVPixelFormatType_OneComponent8
            if (try? VNImageRequestHandler(cvPixelBuffer: pixel).perform([request])) != nil, let mask = request.results?.first?.pixelBuffer {
                let maskImage = CIImage(cvPixelBuffer: mask).transformed(by: CGAffineTransform(scaleX: image.extent.width / CGFloat(CVPixelBufferGetWidth(mask)), y: image.extent.height / CGFloat(CVPixelBufferGetHeight(mask))))
                let background = image.clampedToExtent().applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: 20]).cropped(to: image.extent)
                image = image.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: background, kCIInputMaskImageKey: maskImage])
            }
        }
        guard fill else { return fit(image, into: bounds) }
        // The bubble crops the camera to fill its shape instead of letterboxing it with black bars.
        let scale = max(bounds.width / image.extent.width, bounds.height / image.extent.height)
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return scaled.transformed(by: CGAffineTransform(translationX: bounds.midX - scaled.extent.midX, y: bounds.midY - scaled.extent.midY)).cropped(to: bounds)
    }
    private func annotationImage(bounds: CGRect) -> CIImage? {
        guard !strokes.isEmpty || (settings.cursorEmphasis && cursorPosition.x >= 0) else { return nil }
        guard let bitmap = CGContext(data: nil, width: settings.width, height: settings.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        bitmap.setLineWidth(5); bitmap.setLineCap(.round)
        for stroke in strokes where stroke.points.count > 1 {
            bitmap.setStrokeColor(stroke.color.cgColor); bitmap.beginPath()
            bitmap.move(to: CGPoint(x: stroke.points[0].x * bounds.width, y: stroke.points[0].y * bounds.height))
            for point in stroke.points.dropFirst() { bitmap.addLine(to: CGPoint(x: point.x * bounds.width, y: point.y * bounds.height)) }; bitmap.strokePath()
        }
        if settings.cursorEmphasis, cursorPosition.x >= 0 {
            bitmap.setFillColor(NSColor.systemYellow.withAlphaComponent(0.3).cgColor)
            bitmap.fillEllipse(in: CGRect(x: cursorPosition.x * bounds.width - 18, y: cursorPosition.y * bounds.height - 18, width: 36, height: 36))
        }
        return bitmap.makeImage().map { CIImage(cgImage: $0) }
    }
    private func receiveAudio(_ sample: CMSampleBuffer, microphone: Bool) {
        guard recording, !paused, !reportedError, movie?.audio != nil, let description = sample.formatDescription else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        guard let source = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sample.numSamples)) else { return }
        source.frameLength = source.frameCapacity
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(sample.numSamples), into: source.mutableAudioBufferList) == noErr,
              let converter = AVAudioConverter(from: format, to: mixFormat), let converted = AVAudioPCMBuffer(pcmFormat: mixFormat, frameCapacity: AVAudioFrameCount(Double(sample.numSamples) * 48000 / format.sampleRate) + 64) else { return }
        var supplied = false; var conversionError: NSError?
        converter.convert(to: converted, error: &conversionError) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return source
        }
        guard conversionError == nil else { return }
        var mixed = converted, delay = 0.0
        if microphone, let voiceIsolation {
            // Suppression failure keeps the raw microphone rather than dropping speech.
            if let isolated = try? voiceIsolation.process(converted) { mixed = isolated; delay = voiceIsolation.latency } else { self.voiceIsolation = nil }
        }
        guard let channels = mixed.floatChannelData else { return }
        let start = Int((clock.elapsed(at: sample.presentationTimeStamp.seconds) - delay) * 48000)
        for frame in 0..<Int(mixed.frameLength) {
            let index = start + frame; let block = index / 1024
            guard index >= 0, block >= audioNextBlock, block <= audioNextBlock + 256 else { continue }
            if audioBlocks[block] == nil { audioBlocks[block] = [Float](repeating: 0, count: 2048) }
            let offset = (index % 1024) * 2
            audioBlocks[block]![offset] += channels[0][frame]
            audioBlocks[block]![offset + 1] += channels[1][frame]
        }
    }
    private func flushAudio(through time: Double) {
        guard let movie, movie.audio != nil else { return }
        let throughBlock = Int(time * 48000) / 1024
        while audioNextBlock < throughBlock {
            guard movie.audio?.isReadyForMoreMediaData == true else { break }
            let samples = audioBlocks.removeValue(forKey: audioNextBlock) ?? [Float](repeating: 0, count: 2048)
            let interleaved = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: true)!
            guard let pcm = AVAudioPCMBuffer(pcmFormat: interleaved, frameCapacity: 1024) else { break }
            pcm.frameLength = 1024
            let destination = pcm.mutableAudioBufferList.pointee.mBuffers.mData!.assumingMemoryBound(to: Float.self)
            for i in samples.indices { destination[i] = max(-1, min(1, samples[i])) }
            var description: CMAudioFormatDescription?
            CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: interleaved.streamDescription, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description)
            var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48000), presentationTimeStamp: CMTime(value: Int64(audioNextBlock * 1024), timescale: 48000), decodeTimeStamp: .invalid)
            var sample: CMSampleBuffer?
            CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil, formatDescription: description, sampleCount: 1024, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample)
            if let sample, CMSampleBufferSetDataBufferFromAudioBufferList(sample, blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, bufferList: pcm.audioBufferList) == noErr {
                CMSampleBufferSetDataReady(sample)
                do { _ = try movie.appendAudio(sample) } catch { report(error.localizedDescription); break }
            }
            audioNextBlock += 1
        }
    }
}
