import Foundation
import Testing
@testable import RelayCore

@Test func capturePreflightNeverUpscalesSmallSources() throws {
    let result = try CaptureFormat.preflight(sourceWidth: 1280, sourceHeight: 800, requestedWidth: 3840, requestedHeight: 2160, hardwareEncoder: { _, _ in true }, availableBytes: 10_000_000_000, hasAudio: true)
    #expect(result.width == 1280)
    #expect(result.height == 800)
    #expect(result.framesPerSecond == 30)
    #expect(result.limitedBySource)
    #expect(result.estimatedBytesPerMinute > 38_400_000)
    let portrait = try CaptureFormat.preflight(sourceWidth: 1080, sourceHeight: 1920, requestedWidth: 1920, requestedHeight: 1080, hardwareEncoder: { _, _ in true }, availableBytes: 10_000_000_000, hasAudio: false)
    #expect(portrait.width == 606)
    #expect(portrait.height == 1080)
}

@Test func unsupportedEncoderDiskAndPermissionBlockBeforeCapture() throws {
    #expect(throws: RelayError.self) { try CaptureFormat.preflight(sourceWidth: 1920, sourceHeight: 1080, requestedWidth: 1920, requestedHeight: 1080, hardwareEncoder: { _, _ in false }, availableBytes: 10_000_000_000, hasAudio: true) }
    #expect(throws: RelayError.self) { try CaptureFormat.preflight(sourceWidth: 1920, sourceHeight: 1080, requestedWidth: 1920, requestedHeight: 1080, hardwareEncoder: { _, _ in true }, availableBytes: 100_000_000, hasAudio: true) }
    #expect(throws: RelayError.self) { try CaptureFormat.preflight(sourceWidth: 0, sourceHeight: 1080, requestedWidth: 1920, requestedHeight: 1080, hardwareEncoder: { _, _ in true }, availableBytes: 10_000_000_000, hasAudio: true) }
    #expect(throws: RelayError.self) { try CaptureFormat.preflight(sourceWidth: 1920, sourceHeight: 1080, requestedWidth: 1920, requestedHeight: 1080, hardwareEncoder: { _, _ in true }, availableBytes: 10_000_000_000, hasAudio: true, deniedPermission: "Microphone") }
}

@Test func captureLifecycleRejectsConcurrentStartsAndStaleCallbacks() throws {
    var capture = CaptureLifecycle()
    let first = try capture.beginPreparation()
    #expect(throws: RelayError.self) { try capture.beginPreparation() }
    capture.requestStop()
    #expect(capture.phase == .canceling)
    #expect(!capture.acceptsCallbacks(first))
    let rejectedPreparation = capture.prepared(first, record: true)
    #expect(!rejectedPreparation)
    capture.finished(first)
    let next = try capture.beginPreparation()
    let rejectedOld = capture.prepared(first, record: true)
    #expect(!rejectedOld)
    let preview = capture.prepared(next, record: false)
    #expect(preview)
    #expect(capture.phase == .preview)
    let countdown = try capture.beginCountdown()
    #expect(countdown == next)
    capture.requestStop()
    let rejectedStart = capture.started(next)
    #expect(!rejectedStart)
    capture.finished(first)
    #expect(capture.phase == .canceling)
    capture.finished(next)
    #expect(capture.phase == .idle)
}

@Test func captureStopWhilePausedKeepsGenerationUntilFinish() throws {
    var capture = CaptureLifecycle()
    let generation = try capture.beginPreparation()
    let prepared = capture.prepared(generation, record: true)
    #expect(prepared)
    let started = capture.started(generation)
    #expect(started)
    try capture.setPaused(true)
    capture.requestStop()
    #expect(capture.phase == .finishing)
    #expect(!capture.acceptsCallbacks(generation))
    #expect(throws: RelayError.self) { try capture.beginPreparation() }
    capture.finished(generation)
    #expect(capture.phase == .idle)
}

@Test @MainActor func captureCleanupWaitsForPauseWriterAndJournalCompletion() async throws {
    var capture = CaptureLifecycle()
    let generation = try capture.beginPreparation()
    _ = capture.prepared(generation, record: true)
    _ = capture.started(generation)
    var approved = false
    let observed = capture
    let termination = Task { await observed.waitForCleanup(); approved = true }
    try await Task.sleep(for: .milliseconds(10))
    #expect(!approved) // A stop queued behind pause has not begun cleanup yet.
    try capture.setPaused(true)
    capture.requestStop()
    try await Task.sleep(for: .milliseconds(10))
    #expect(!approved) // Writer finalization is still running.
    capture.finished(generation &+ 1)
    try await Task.sleep(for: .milliseconds(10))
    #expect(!approved) // A stale callback cannot approve termination.
    capture.finished(generation) // Called only after writer and journal writes finish.
    await termination.value
    #expect(approved)
    await capture.waitForCleanup() // Already-finished cleanup cannot hang a second quit.
}
