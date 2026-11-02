import AVFoundation
import AudioToolbox

/// Live microphone noise suppression with Apple's on-device Voice Isolation unit.
/// Runs on the capture queue before mixing, so system audio is never processed.
public final class VoiceIsolation {
    public let format: AVAudioFormat
    /// Output trails input by this much; callers shift microphone timestamps back to keep lip sync.
    public private(set) var latency: TimeInterval = 0
    private let engine = AVAudioEngine()
    private let maximumFrames: AVAudioFrameCount
    private var input: AVAudioPCMBuffer?

    public init(format: AVAudioFormat, maximumFrames: AVAudioFrameCount = 4096) throws {
        self.format = format; self.maximumFrames = maximumFrames
        let unit = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_AUSoundIsolation, componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0))
        engine.attach(unit)
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: maximumFrames)
        engine.connect(engine.inputNode, to: unit, format: format)
        engine.connect(unit, to: engine.mainMixerNode, format: format)
        let ready = engine.inputNode.setManualRenderingInputPCMFormat(format) { [unowned self] frames in
            guard let input, frames <= input.frameLength else { return nil }
            return UnsafePointer(input.mutableAudioBufferList)
        }
        guard ready else { throw RelayError.invalidMedia }
        AudioUnitSetParameter(unit.audioUnit, AudioUnitParameterID(kAUSoundIsolationParam_SoundToIsolate), kAudioUnitScope_Global, 0, AudioUnitParameterValue(kAUSoundIsolationSoundType_HighQualityVoice), 0)
        AudioUnitSetParameter(unit.audioUnit, AudioUnitParameterID(kAUSoundIsolationParam_WetDryMixPercent), kAudioUnitScope_Global, 0, 100, 0)
        try engine.start()
        latency = unit.auAudioUnit.latency
    }

    /// Returns a processed copy with the same length; chunks longer buffers.
    public func process(_ buffer: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        guard buffer.format == format, let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: max(1, buffer.frameLength)) else { throw RelayError.invalidMedia }
        var offset: AVAudioFrameCount = 0
        while offset < buffer.frameLength {
            let count = min(maximumFrames, buffer.frameLength - offset)
            guard let chunk = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count), let rendered = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count) else { throw RelayError.invalidMedia }
            chunk.frameLength = count
            for channel in 0..<Int(format.channelCount) { chunk.floatChannelData![channel].update(from: buffer.floatChannelData![channel] + Int(offset), count: Int(count)) }
            input = chunk
            defer { input = nil }
            guard try engine.renderOffline(count, to: rendered) == .success, rendered.frameLength == count else { throw RelayError.invalidMedia }
            for channel in 0..<Int(format.channelCount) { (output.floatChannelData![channel] + Int(offset)).update(from: rendered.floatChannelData![channel], count: Int(count)) }
            offset += count
        }
        output.frameLength = buffer.frameLength
        return output
    }
}
