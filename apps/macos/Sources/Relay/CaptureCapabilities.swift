import AppKit
import AVFoundation
import ScreenCaptureKit
import VideoToolbox
import RelayCore

struct CaptureCapabilities {
    let format: CaptureFormat
    let settings: CaptureSettings
    var summary: String {
        "Actual output: \(format.width)×\(format.height) · \(format.framesPerSecond) fps · approximately \(ByteCountFormatter.string(fromByteCount: format.estimatedBytesPerMinute, countStyle: .file))/minute" + (format.limitedBySource ? ". Limited by source size; no upscaling." : "")
    }
    static func freeBytes(at url: URL) throws -> Int64 {
        let attributes = try FileManager.default.attributesOfFileSystem(forPath: url.path)
        guard let bytes = attributes[.systemFreeSize] as? NSNumber else { throw RelayError.server("Disk capacity is unavailable. Check the recording volume and retry.") }
        return bytes.int64Value
    }
    static func inspect(settings: CaptureSettings, display: SCDisplay?, window: SCWindow?, root: URL) throws -> Self {
        var actual = settings
        var denied: String?
        if settings.mode != .camera && !CGPreflightScreenCaptureAccess() { denied = "Screen Recording" }
        if (settings.camera || settings.mode == .camera) && [.denied, .restricted].contains(AVCaptureDevice.authorizationStatus(for: .video)) { denied = "Camera" }
        if settings.microphone && [.denied, .restricted].contains(AVCaptureDevice.authorizationStatus(for: .audio)) { denied = "Microphone" }
        if settings.camera || settings.mode == .camera {
            let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .external], mediaType: .video, position: .unspecified).devices
            let device = settings.cameraID == nil ? AVCaptureDevice.default(for: .video) : devices.first { $0.uniqueID == settings.cameraID }
            guard let device else { throw RelayError.server("Selected camera is disconnected. Load sources and choose an available camera.") }
            actual.cameraID = device.uniqueID
            let formats = device.formats.filter { $0.videoSupportedFrameRateRanges.contains { $0.minFrameRate <= 30 && $0.maxFrameRate >= 30 } }.sorted {
                let a = CMVideoFormatDescriptionGetDimensions($0.formatDescription), b = CMVideoFormatDescriptionGetDimensions($1.formatDescription)
                return Int(a.width) * Int(a.height) < Int(b.width) * Int(b.height)
            }
            let targetWidth = settings.mode == .camera ? settings.width : 640, targetHeight = settings.mode == .camera ? settings.height : 480
            actual.cameraFormat = formats.first { let d = CMVideoFormatDescriptionGetDimensions($0.formatDescription); return d.width >= targetWidth && d.height >= targetHeight } ?? formats.last
            guard actual.cameraFormat != nil else { throw RelayError.server("Selected camera has no 30 fps format. Choose another camera.") }
        }
        if settings.microphone {
            let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
            let device = settings.microphoneID == nil ? AVCaptureDevice.default(for: .audio) : devices.first { $0.uniqueID == settings.microphoneID }
            guard let device else { throw RelayError.server("Selected microphone is disconnected. Load sources and choose an available microphone.") }
            actual.microphoneID = device.uniqueID
        }
        let width: Int, height: Int
        if settings.mode == .camera {
            let dimensions = CMVideoFormatDescriptionGetDimensions(actual.cameraFormat!.formatDescription)
            width = Int(dimensions.width); height = Int(dimensions.height)
        } else {
            let filter: SCContentFilter
            if settings.mode == .window {
                guard let window else { throw RelayError.server("Load sources and select a window first.") }
                filter = SCContentFilter(desktopIndependentWindow: window)
            } else {
                guard let display else { throw RelayError.server("Load sources and select a display first.") }
                filter = SCContentFilter(display: display, excludingWindows: [])
            }
            let region = settings.mode == .region ? settings.region : CGRect(x: 0, y: 0, width: 1, height: 1)
            guard region.width.isFinite, region.height.isFinite, region.width > 0, region.height > 0, region.minX >= 0, region.minY >= 0, region.maxX <= 1, region.maxY <= 1 else { throw RelayError.server("Choose a valid region inside the selected display.") }
            width = Int(filter.contentRect.width * CGFloat(filter.pointPixelScale) * region.width)
            height = Int(filter.contentRect.height * CGFloat(filter.pointPixelScale) * region.height)
        }
        let format = try CaptureFormat.preflight(sourceWidth: width, sourceHeight: height, requestedWidth: settings.width, requestedHeight: settings.height, hardwareEncoder: hardwareEncoder, availableBytes: freeBytes(at: root), hasAudio: settings.microphone || (settings.systemAudio && settings.mode != .camera), deniedPermission: denied)
        actual.width = format.width; actual.height = format.height
        return Self(format: format, settings: actual)
    }
    private static func hardwareEncoder(width: Int, height: Int) -> Bool {
        var encoder: VTCompressionSession?
        let result = VTCompressionSessionCreate(allocator: kCFAllocatorDefault, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264, encoderSpecification: [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true] as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &encoder)
        defer { if let encoder { VTCompressionSessionInvalidate(encoder) } }
        guard result == noErr, let encoder else { return false }
        return VTCompressionSessionPrepareToEncodeFrames(encoder) == noErr
    }
}
