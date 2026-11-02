import Foundation
import Testing
import AVFoundation
@testable import RelayCore

// Synthesized speech plus generated noise exercises Apple's Voice Isolation unit without a microphone.
@Test func voiceIsolationKeepsSpeechAndRemovesNoiseInCaptureSizedChunks() throws {
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let spoken = root.appendingPathComponent("speech.aiff")
    let say = try Process.run(URL(fileURLWithPath: "/usr/bin/say"), arguments: ["-o", spoken.path, "Please review the billing dashboard and the export button before Friday."])
    say.waitUntilExit(); #expect(say.terminationStatus == 0)
    let file = try AVAudioFile(forReading: spoken)
    let raw = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))); try file.read(into: raw)
    let converter = try #require(AVAudioConverter(from: file.processingFormat, to: format))
    let speechFrames = Int(Double(raw.frameLength) * 48000 / file.processingFormat.sampleRate), tail = 48000
    let speech = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(speechFrames + 4096)))
    var supplied = false
    converter.convert(to: speech, error: nil) { _, status in if supplied { status.pointee = .endOfStream; return nil }; supplied = true; status.pointee = .haveData; return raw }
    let total = Int(speech.frameLength) + tail
    var noisy = [[Float]](repeating: [Float](repeating: 0, count: total), count: 2), seed: UInt32 = 7
    for i in 0..<total {
        seed = seed &* 1_664_525 &+ 1_013_904_223
        let noise = (Float(seed >> 8) / Float(1 << 24) - 0.5) * 0.12
        for c in 0..<2 { noisy[c][i] = noise + (i < Int(speech.frameLength) ? speech.floatChannelData![c][i] : 0) }
    }
    let isolation = try VoiceIsolation(format: format)
    var output = [Float](), start = 0
    while start < total {
        let count = min(1024, total - start), chunk = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)))
        chunk.frameLength = AVAudioFrameCount(count)
        for c in 0..<2 { for i in 0..<count { chunk.floatChannelData![c][i] = noisy[c][start + i] } }
        let processed = try isolation.process(chunk); #expect(processed.frameLength == chunk.frameLength)
        output += UnsafeBufferPointer(start: processed.floatChannelData![0], count: count)
        start += count
    }
    let shift = Int(isolation.latency * 48000)
    func rms(_ values: ArraySlice<Float>) -> Float { (values.reduce(0) { $0 + $1 * $1 } / Float(max(1, values.count))).squareRoot() }
    let speechEnd = Int(speech.frameLength)
    let noiseIn = rms(noisy[0][(speechEnd + 12000)..<total]), noiseOut = rms(output[(speechEnd + 12000 + shift)..<total])
    let speechIn = rms(ArraySlice(UnsafeBufferPointer(start: speech.floatChannelData![0], count: speechEnd))), speechOut = rms(output[min(shift, speechEnd)..<speechEnd])
    #expect(noiseOut < noiseIn / 4, "Noise should fall by 12 dB or more: \(noiseIn) → \(noiseOut)")
    #expect(speechOut > speechIn / 3, "Speech should stay within about 10 dB: \(speechIn) → \(speechOut)")
}
