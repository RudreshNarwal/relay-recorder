import Foundation
import Testing
import RelayCore
@testable import Relay

@Test(.enabled(if: ProcessInfo.processInfo.environment["RELAY_MODEL_LIVE_TEST"] == "1"))
@MainActor func pinnedModelDownloadsVerifiesAndTranscribesOfflineWithoutChangingSource() async throws {
    let environment = ProcessInfo.processInfo.environment
    let root = URL(fileURLWithPath: try #require(environment["RELAY_MODEL_TEST_ROOT"]))
    let speech = URL(fileURLWithPath: try #require(environment["RELAY_MODEL_TEST_SPEECH"]))
    let silence = URL(fileURLWithPath: try #require(environment["RELAY_MODEL_TEST_SILENCE"]))
    let model = LocalTranscriber(root: root, sharedDirectory: nil)
    // Let initialization check a previously installed model before explicitly downloading.
    await Task.yield()
    while model.busy { try await Task.sleep(for: .milliseconds(100)) }
    if !model.ready { model.download() }
    let deadline = Date().addingTimeInterval(900)
    while model.busy && Date() < deadline { try await Task.sleep(for: .milliseconds(100)) }
    #expect(model.ready, Comment(rawValue: model.status))
    guard model.ready else { model.cancelDownload(); return }
    let original = try Data(contentsOf: speech)
    let transcript = try await model.transcribe(speech)
    #expect(transcript.segments.map(\.text).joined(separator: " ").lowercased().contains("hello world"))
    #expect(transcript.segments.allSatisfy { !($0.words ?? []).isEmpty })
    #expect(try Data(contentsOf: speech) == original)
    let empty = try await model.transcribe(silence)
    #expect(empty.segments.isEmpty)
}

/// Uses a Parakeet copy another FluidAudio app (e.g. FluidVoice) already downloaded, without touching it.
@Test(.enabled(if: ProcessInfo.processInfo.environment["RELAY_SHARED_MODEL_TEST"] == "1"))
@MainActor func sharedFluidAudioModelIsDetectedVerifiedAndTranscribesWithoutDownloading() async throws {
    let speech = URL(fileURLWithPath: try #require(ProcessInfo.processInfo.environment["RELAY_MODEL_TEST_SPEECH"]))
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let model = LocalTranscriber(root: root)
    #expect(model.usingSharedModel && model.installed, "Expected the shared FluidAudio copy to be picked up")
    await Task.yield()
    let deadline = Date().addingTimeInterval(300)
    while model.busy && Date() < deadline { try await Task.sleep(for: .milliseconds(100)) }
    #expect(model.ready, Comment(rawValue: model.status))
    #expect(!FileManager.default.fileExists(atPath: model.ownDirectory.path), "Nothing was downloaded into Relay's folder")
    let transcript = try await model.transcribe(speech)
    print("SHARED_TRANSCRIPT: " + transcript.segments.map(\.text).joined(separator: " "))
    #expect(transcript.segments.map(\.text).joined(separator: " ").lowercased().contains("dashboard"))
    print("SHARED_STATUS: " + model.status)
}
