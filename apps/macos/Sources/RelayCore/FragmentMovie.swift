import AVFoundation
import UniformTypeIdentifiers
import Foundation
import VideoToolbox

/// Each delegate callback contains a complete, immutable initialization or media fragment.
/// Appending these bytes makes one fragmented MP4 and never rewrites uploaded prefixes.
public final class FragmentMovie: NSObject, AVAssetWriterDelegate, @unchecked Sendable {
    public let writer: AVAssetWriter
    public let video: AVAssetWriterInput
    public let audio: AVAssetWriterInput?
    public let adaptor: AVAssetWriterInputPixelBufferAdaptor
    public let url: URL
    private let handle: FileHandle
    private let lock = NSLock()
    private var writeError: Error?
    public init(url: URL, width: Int, height: Int, hasAudio: Bool) throws {
        self.url = url
        guard !FileManager.default.fileExists(atPath: url.path) else { throw RelayError.server("Media already exists; refusing to replace the original.") }
        FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        handle = try FileHandle(forWritingTo: url)
        writer = AVAssetWriter(contentType: .mpeg4Movie)
        writer.outputFileTypeProfile = .mpeg4AppleHLS
        writer.preferredOutputSegmentInterval = CMTime(seconds: 1, preferredTimescale: 600)
        writer.initialSegmentStartTime = .zero
        video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoEncoderSpecificationKey: [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true],
            AVVideoWidthKey: width, AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: width * height * 5, AVVideoExpectedSourceFrameRateKey: 30, AVVideoMaxKeyFrameIntervalKey: 30]
        ])
        video.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height, kCVPixelBufferIOSurfacePropertiesKey as String: [:]])
        if hasAudio {
            audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 192000])
            audio?.expectsMediaDataInRealTime = true
        } else { audio = nil }
        super.init()
        guard writer.canAdd(video) else { throw RelayError.invalidMedia }
        writer.add(video)
        if let audio { guard writer.canAdd(audio) else { throw RelayError.invalidMedia }; writer.add(audio) }
        writer.delegate = self
        guard writer.startWriting() else { throw writer.error ?? RelayError.invalidMedia }
        writer.startSession(atSourceTime: .zero)
    }
    public func append(_ buffer: CVPixelBuffer, at time: CMTime) throws -> Bool {
        try checkSinkError()
        if let error = writer.error { throw error }
        guard video.isReadyForMoreMediaData else { return false }
        guard adaptor.append(buffer, withPresentationTime: time) else { throw writer.error ?? RelayError.invalidMedia }
        return true
    }
    public func appendAudio(_ buffer: CMSampleBuffer) throws -> Bool {
        try checkSinkError()
        guard let audio else { return false }
        if let error = writer.error { throw error }
        guard audio.isReadyForMoreMediaData else { return false }
        guard audio.append(buffer) else { throw writer.error ?? RelayError.invalidMedia }
        return true
    }
    public func finish() async throws {
        video.markAsFinished(); audio?.markAsFinished()
        await writer.finishWriting()
        try closeSink()
        guard writer.status == .completed else { throw writer.error ?? RelayError.invalidMedia }
    }
    private func checkSinkError() throws {
        lock.lock(); defer { lock.unlock() }
        if let writeError { throw writeError }
    }
    private func closeSink() throws {
        lock.lock(); defer { lock.unlock() }
        try handle.synchronize(); try handle.close()
        if let writeError { throw writeError }
    }
    public func assetWriter(_ writer: AVAssetWriter, didOutputSegmentData segmentData: Data, segmentType: AVAssetSegmentType) {
        lock.lock(); defer { lock.unlock() }
        do {
            try handle.write(contentsOf: segmentData)
            try handle.synchronize()
            let offset = try handle.offset()
            // Upload reads this committed boundary, never a partially written fragment.
            try durableWrite(Data(String(offset).utf8), to: url.appendingPathExtension("committed"))
        } catch { writeError = error }
    }
    public static func committedSize(at url: URL) -> Int {
        guard let data = try? Data(contentsOf: url.appendingPathExtension("committed")), let text = String(data: data, encoding: .utf8), let count = Int(text), count >= 0 else { return 0 }
        return count
    }
}
