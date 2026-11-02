import Foundation
import Testing
@testable import RelayCore

@Test func clockExcludesPausesAndFreezesOnStop() throws {
    var clock = RecordingClock()
    try clock.start(at: 10)
    try clock.pause(at: 13)
    #expect(clock.elapsed(at: 99) == 3)
    try clock.resume(at: 20)
    try clock.stop(at: 24)
    #expect(clock.elapsed(at: 100) == 7)
    #expect(throws: RelayError.self) { try clock.resume(at: 101) }
}
@Test func illegalTransitionsPreserveActiveRecording() throws {
    var clock = RecordingClock()
    #expect(throws: RelayError.self) { try clock.pause(at: 1) }
    try clock.start(at: 2)
    #expect(throws: RelayError.self) { try clock.start(at: 3) }
    #expect(clock.elapsed(at: 4) == 2)
}
@Test func journalSurvivesRestartAndMarksInterruptedCapture() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try JournalStore(root: root)
    var recording = RecordingRecord(title: "Offline", transcriptionMode: .onDevice)
    recording.state = .recording
    try await store.save(recording)
    let recovered = try await JournalStore(root: root).recover()
    #expect(recovered.count == 1)
    #expect(recovered.first?.id == recording.id)
    #expect(recovered.first?.state == .interrupted)
    let media = try await store.mediaURL(for: recording)
    #expect(media.path.hasPrefix(root.path))
}
@Test func partsBoundedAndTailHeldUntilClosed() {
    #expect(UploadPlan.parts(fileSize: 8_388_609, sealed: false).map(\.size) == [8_388_608])
    #expect(UploadPlan.parts(fileSize: 8_388_609, sealed: true).map(\.size) == [8_388_608, 1])
    #expect(UploadPlan.parts(fileSize: 0, sealed: true).isEmpty)
}
@Test func uploadRequiresSecureServerOrigin() throws {
    _ = try ServerOrigin("https://relay.example")
    _ = try ServerOrigin("http://localhost:3000")
    #expect(throws: RelayError.self) { try ServerOrigin("http://evil.example") }
    #expect(throws: RelayError.self) { try ServerOrigin("https://user:secret@example.org") }
    #expect(throws: RelayError.self) { try ServerOrigin("https://example.org/path") }
}
@Test func pkceMatchesRFC7636() {
    #expect(DeviceProof.challenge(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
}

@Test func missingLocalModelRecordingMovesToServerParakeetOnlyBeforeUpload() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try JournalStore(root: root)
    var record = RecordingRecord(title: "Local", transcriptionMode: .onDevice)
    record.state = .ready; record.transcriptionSelection = .parakeet(.onDevice); record.transcriptSyncState = .failed
    record.transcriptSyncError = "Download Parakeet v3 in Settings before local transcription."
    try await store.save(record)
    let moved = try await store.useServerParakeet(id: record.id)
    #expect(moved.transcriptionMode == .serverAPI && moved.transcriptionSelection == .parakeet(.serverAPI))
    #expect(moved.transcriptSyncState == nil && moved.transcriptSyncError == nil)
    // Once the server admitted the recording, its speech choice is fixed there.
    var uploaded = RecordingRecord(title: "Uploaded", transcriptionMode: .onDevice); uploaded.state = .ready; uploaded.videoID = UUID().uuidString
    try await store.save(uploaded)
    await #expect(throws: RelayError.self) { try await store.useServerParakeet(id: uploaded.id) }
}
