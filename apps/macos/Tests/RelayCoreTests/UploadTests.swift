import Foundation
import Testing
@testable import RelayCore

private final class ContractServer {
    let process = Process()
    let origin: ServerOrigin
    init() throws {
        let script = Bundle.module.url(forResource: "upload_server", withExtension: "py", subdirectory: "Fixtures")!
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = [script.path]; process.standardOutput = pipe; process.standardError = Pipe()
        try process.run()
        var line = Data()
        while let byte = try pipe.fileHandleForReading.read(upToCount: 1), !byte.isEmpty {
            if byte == Data([10]) { break }; line.append(byte)
        }
        let port = try #require(String(data: line, encoding: .utf8).flatMap(Int.init))
        origin = try ServerOrigin("http://127.0.0.1:\(port)")
    }
    deinit { if process.isRunning { process.terminate() }; process.waitUntilExit() }
}
private struct Stats: Decodable { let sizes: [Int]; let requests: [Int]; let finalizes: Int; let cancels: Int; let creates: Int }

@Test func rejectedSpeechAdmissionCanBeReselectedWithoutChangingRecordingIdentity() async throws {
    let server = try ContractServer()
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try JournalStore(root: root)
    var record = RecordingRecord(title: "Revoked speech", transcriptionMode: .serverAPI)
    record.transcriptionSelection = SpeechSelection(execution: "server", provider: "deepgram", configurationId: UUID().uuidString, configurationVersion: 1)
    record.state = .ready; record.workspaceID = UUID().uuidString; record.server = server.origin.url.absoluteString
    try await store.save(record)
    let media = try await store.mediaURL(for: record), bytes = Data(repeating: 0x61, count: 1024)
    try bytes.write(to: media)
    let api = RelayAPI(origin: server.origin, token: "test-token")
    await #expect(throws: RelayError.self) { try await store.usePrivateTranscriptionAfterRejection(id: record.id) }
    let _: EmptyResponse = try await api.request("/api/v1/test-control", method: "POST", body: RelayAPI.json(["rejectCreation": true]))
    await #expect(throws: RelayError.self) { try await RecordingUploader(store: store).upload(record, api: api, sealed: true) }
    #expect(try await store.record(id: record.id).transcriptionAdmissionRejected == true)
    let relaunched = try JournalStore(root: root)
    let selected = try await relaunched.usePrivateTranscriptionAfterRejection(id: record.id)
    #expect(selected.id == record.id && selected.videoID == nil)
    #expect(selected.transcriptionSelection == .parakeet(.serverAPI))
    let _: EmptyResponse = try await api.request("/api/v1/test-control", method: "POST", body: RelayAPI.json([:]))
    // A stale caller snapshot cannot restore the rejected provider.
    let completed = try await RecordingUploader(store: relaunched).upload(record, api: api, sealed: true)
    #expect(completed.state == .uploaded)
    #expect(try Data(contentsOf: media) == bytes)
    await #expect(throws: RelayError.self) { try await relaunched.usePrivateTranscriptionAfterRejection(id: record.id) }
    let (data, _) = try await URLSession.shared.data(from: server.origin.url.appending(path: "stats"))
    let stats = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(stats["clientIds"] as? [String] == [record.id.uuidString, record.id.uuidString])
    #expect(stats["creates"] as? Int == 1)
    #expect((stats["transcription"] as? [String: Any])?["provider"] as? String == "parakeet")
}

@Test func ambiguousAdmissionRetryRevokesEarlierProofOfRejection() async throws {
    let server = try ContractServer()
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try JournalStore(root: root)
    var record = RecordingRecord(title: "Ambiguous admission", transcriptionMode: .serverAPI)
    record.state = .ready; record.workspaceID = UUID().uuidString; record.server = server.origin.url.absoluteString
    try await store.save(record)
    let api = RelayAPI(origin: server.origin, token: "test-token"), uploader = RecordingUploader(store: store)
    let _: EmptyResponse = try await api.request("/api/v1/test-control", method: "POST", body: RelayAPI.json(["rejectCreation": true]))
    await #expect(throws: RelayError.self) { try await uploader.upload(record, api: api, sealed: true) }
    #expect(try await store.record(id: record.id).transcriptionAdmissionRejected == true)
    let _: EmptyResponse = try await api.request("/api/v1/test-control", method: "POST", body: RelayAPI.json(["ambiguousCreation": true]))
    await #expect(throws: RelayError.self) { try await uploader.upload(record, api: api, sealed: true) }
    let relaunched = try JournalStore(root: root)
    #expect(try await relaunched.record(id: record.id).transcriptionAdmissionRejected != true)
    await #expect(throws: RelayError.self) { try await relaunched.usePrivateTranscriptionAfterRejection(id: record.id) }
}

@Test func explicitExternalSpeechSelectionSurvivesJournalAndUpload() async throws {
    let server = try ContractServer()
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try JournalStore(root: root)
    var record = RecordingRecord(title: "Explicit speech", transcriptionMode: .serverAPI)
    record.transcriptionSelection = SpeechSelection(execution: "server", provider: "deepgram", configurationId: UUID().uuidString, configurationVersion: 2, model: "nova-3")
    record.state = .ready; record.workspaceID = UUID().uuidString; record.server = server.origin.url.absoluteString
    try await store.save(record)
    try Data(repeating: 0x61, count: 1024).write(to: await store.mediaURL(for: record))
    let recovered = try await JournalStore(root: root).record(id: record.id)
    #expect(recovered.transcriptionSelection == record.transcriptionSelection)
    _ = try await RecordingUploader(store: store).upload(recovered, api: RelayAPI(origin: server.origin, token: "test-token"), sealed: true)
    let (data, _) = try await URLSession.shared.data(from: server.origin.url.appending(path: "stats"))
    let accepted = try #require((JSONSerialization.jsonObject(with: data) as? [String: Any])?["transcription"] as? [String: Any])
    #expect(accepted["provider"] as? String == "deepgram")
    #expect(accepted["configurationVersion"] as? Int == 2)
}

@Test func pendingLocalTranscriptDoesNotBlockMediaFinalization() async throws {
    let server = try ContractServer()
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try JournalStore(root: root)
    var record = RecordingRecord(title: "Speech can finish later", transcriptionMode: .onDevice)
    record.state = .ready; record.workspaceID = UUID().uuidString; record.server = server.origin.url.absoluteString
    try await store.save(record)
    let media = try await store.mediaURL(for: record)
    let bytes = Data(repeating: 0x61, count: 1024)
    try bytes.write(to: media)
    let api = RelayAPI(origin: server.origin, token: "test-token")
    let saved = try await RecordingUploader(store: store).upload(record, api: api, sealed: true)
    #expect(saved.state == .uploaded)
    #expect(saved.transcript == nil)
    let restored = try #require(try await JournalStore(root: root).recover().first)
    _ = try await RecordingUploader(store: store).upload(restored, api: api, sealed: true)
    let (data, _) = try await URLSession.shared.data(from: server.origin.url.appending(path: "stats"))
    #expect(try JSONDecoder().decode(Stats.self, from: data).finalizes == 1)
    #expect(try Data(contentsOf: media) == bytes)
}

@Test func lateTranscriptRetriesIndependentlyAfterRelaunch() async throws {
    let server = try ContractServer()
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try JournalStore(root: root)
    var record = RecordingRecord(title: "Late captions", transcriptionMode: .onDevice)
    record.state = .ready; record.workspaceID = UUID().uuidString; record.server = server.origin.url.absoluteString
    try await store.save(record)
    try Data(repeating: 1, count: 1024).write(to: await store.mediaURL(for: record))
    let api = RelayAPI(origin: server.origin, token: "test-token")
    let uploader = RecordingUploader(store: store)
    _ = try await uploader.upload(record, api: api, sealed: true)
    _ = try await store.setTranscript(id: record.id, transcript: TranscriptPayload(segments: [TranscriptSegment(start: 0, end: 1, text: "Hello")]))
    let _: EmptyResponse = try await api.request("/api/v1/test-control", method: "POST", body: RelayAPI.json(["transcriptFailures": 1]))
    await #expect(throws: RelayError.self) { try await uploader.syncTranscript(id: record.id, api: api) }
    let failed = try await store.record(id: record.id)
    #expect(failed.state == .uploaded)
    #expect(failed.transcriptSyncState == .failed)
    #expect(failed.uploadedParts.count == 1)
    let relaunched = try JournalStore(root: root)
    _ = try await relaunched.recover()
    let synced = try await RecordingUploader(store: relaunched).syncTranscript(id: record.id, api: api)
    #expect(synced.state == .uploaded && synced.transcriptSyncState == .synced)
    _ = try await RecordingUploader(store: relaunched).syncTranscript(id: record.id, api: api)
    let (data, _) = try await URLSession.shared.data(from: server.origin.url.appending(path: "stats"))
    let stats = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(stats["finalizes"] as? Int == 1)
    #expect((stats["transcripts"] as? [[String: Any]])?.count == 1)
}

@Test func staleTranscriptAcknowledgmentCannotMarkReplacementAsSynced() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try JournalStore(root: root)
    var record = RecordingRecord(title: "Versioned speech", transcriptionMode: .onDevice)
    record.state = .uploaded
    try await store.save(record)
    _ = try await store.setTranscript(id: record.id, transcript: TranscriptPayload(segments: []))
    let sending = try await store.beginTranscriptSync(id: record.id)
    _ = try await store.setTranscript(id: record.id, transcript: TranscriptPayload(segments: [TranscriptSegment(start: 0, end: 1, text: "New words")]))
    let late = try await store.finishTranscriptSync(id: record.id, version: sending.transcriptVersion!, error: nil)
    #expect(late.transcriptSyncState == .pending)
    #expect(late.transcript?.segments.first?.text == "New words")
    #expect(late.state == .uploaded)
}

@Test func growingUploadRetriesAndResumesWithoutSendingTailOrFinalizingEarly() async throws {
    let server = try ContractServer()
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try JournalStore(root: root)
    var record = RecordingRecord(title: "Real file", transcriptionMode: .serverAPI)
    record.state = .recording; record.workspaceID = UUID().uuidString; record.server = server.origin.url.absoluteString
    try await store.save(record)
    let media = try await store.mediaURL(for: record)
    let bytes = Data(repeating: 0x7B, count: UploadPlan.partSize + 1024)
    try bytes.write(to: media)
    try Data(String(bytes.count).utf8).write(to: media.appendingPathExtension("committed"))
    let api = RelayAPI(origin: server.origin, token: "test-token")
    let uploader = RecordingUploader(store: store)
    let first = try await uploader.upload(record, api: api, sealed: false)
    #expect(first.uploadedParts.count == 1)
    let statsURL = server.origin.url.appending(path: "stats")
    let (firstStats, _) = try await URLSession.shared.data(from: statsURL)
    let before = try JSONDecoder().decode(Stats.self, from: firstStats)
    #expect(before.sizes == [UploadPlan.partSize])
    #expect(before.requests == [0, 0]) // one transient failure, then digest-identical retry
    #expect(before.finalizes == 0)
    // Simulate process restart. Acknowledgments come from disk, never an in-memory uploader cache.
    let restored = try #require(try await JournalStore(root: root).recover().first)
    #expect(restored.state == .interrupted)
    let final = try await RecordingUploader(store: store).upload(restored, api: api, sealed: true)
    #expect(final.state == .uploaded)
    let (lastStats, _) = try await URLSession.shared.data(from: statsURL)
    let after = try JSONDecoder().decode(Stats.self, from: lastStats)
    #expect(after.sizes == [UploadPlan.partSize, 1024])
    #expect(after.requests == [0, 0, 1])
    #expect(after.finalizes == 1)
    #expect(try Data(contentsOf: media) == bytes) // successful sync never removes local media
}
@Test func bearerClientRefusesRedirects() async throws {
    let server = try ContractServer()
    let api = RelayAPI(origin: server.origin, token: "test-token")
    await #expect(throws: RelayError.self) { try await api.raw("/api/v1/redirect") }
}

@Test func capabilityQueryValuesCannotInjectAnotherParameterOrOrigin() async throws {
    let server = try ContractServer()
    let api = RelayAPI(origin: server.origin, token: "test-token")
    let value = "workspace&next=https://example.invalid/#fragment"
    let response: [String: [String]] = try await api.request("/api/v1/query-echo", query: [URLQueryItem(name: "workspaceId", value: value)])
    #expect(response == ["workspaceId": [value]])
    await #expect(throws: RelayError.self) { try await api.raw("/api/v1/query-echo?workspaceId=unsafe") }
}

@Test func uploaderRejectsConcurrentJobsInsteadOfMultiplyingNetworkConcurrency() async throws {
    let server = try ContractServer()
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try JournalStore(root: root)
    var record = RecordingRecord(title: "Bounded uploads", transcriptionMode: .serverAPI)
    record.workspaceID = UUID().uuidString; record.server = server.origin.url.absoluteString
    try await store.save(record)
    let media = try await store.mediaURL(for: record)
    try Data(repeating: 1, count: 1024).write(to: media)
    try Data("1024".utf8).write(to: media.appendingPathExtension("committed"))
    let api = RelayAPI(origin: server.origin, token: "test-token")
    let uploader = RecordingUploader(store: store)
    let snapshot = record
    let first = Task { try await uploader.upload(snapshot, api: api, sealed: false) }
    try await Task.sleep(for: .milliseconds(50))
    await #expect(throws: RelayError.self) { try await uploader.upload(snapshot, api: api, sealed: false) }
    _ = try await first.value
}


@Test func laterPartFailureRetainsJournalProgressAcrossCaptureAndErrorUpdates() async throws {
    let server = try ContractServer()
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try JournalStore(root: root)
    var snapshot = RecordingRecord(title: "In flight", transcriptionMode: .serverAPI)
    snapshot.state = .recording; snapshot.workspaceID = UUID().uuidString; snapshot.server = server.origin.url.absoluteString
    try await store.save(snapshot)
    let media = try await store.mediaURL(for: snapshot)
    try Data(repeating: 0x3B, count: UploadPlan.partSize * 2 + 128).write(to: media)
    let api = RelayAPI(origin: server.origin, token: "test-token")
    let _: EmptyResponse = try await api.request("/api/v1/test-control", method: "POST", body: RelayAPI.json(["failPart": 1, "failCount": 3]))
    let uploader = RecordingUploader(store: store)
    let entry = snapshot
    let job = Task { try await uploader.upload(entry, api: api, sealed: true) }
    for _ in 0..<200 {
        if try await store.record(id: entry.id).uploadedParts.count == 1 { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    // The actual capture writers run while upload awaits the next part/retry.
    let paused = try await store.updateCapture(id: entry.id, state: .paused, duration: 12)
    #expect(paused.videoID != nil)
    #expect(paused.uploadedParts.map(\.index) == [0])
    try await store.updateCapture(id: entry.id, duration: 11) // an older queued timer cannot rewind duration
    try await store.rename(id: entry.id, title: "Renamed while syncing")
    try await store.setTranscript(id: entry.id, transcript: TranscriptPayload(segments: []))
    try await store.updateCapture(id: entry.id, state: .ready, duration: 13)
    await #expect(throws: RelayError.self) { try await job.value }
    // Old whole-snapshot writes are rejected rather than silently erasing upload-owned fields.
    snapshot.state = .ready; snapshot.error = "Later part failed"
    await #expect(throws: RelayError.self) { try await store.save(snapshot) }
    let failed = try await store.recordSyncFailure(id: entry.id, message: "Later part failed")
    #expect(failed.uploadedParts.map(\.index) == [0])
    let restarted = try #require(try await JournalStore(root: root).recover().first)
    #expect(restarted.videoID != nil)
    #expect(restarted.uploadedParts.map(\.index) == [0])
    #expect(restarted.duration == 13)
    #expect(restarted.title == "Renamed while syncing")
    #expect(restarted.transcript != nil)
    // Retry deliberately receives the stale entry snapshot. Uploader must load the current journal.
    let resumed = try await RecordingUploader(store: store).upload(entry, api: api, sealed: true)
    #expect(resumed.state == .uploaded)
    let (data, _) = try await URLSession.shared.data(from: server.origin.url.appending(path: "stats"))
    let stats = try JSONDecoder().decode(Stats.self, from: data)
    #expect(stats.requests.filter { $0 == 0 }.count == 1)
    #expect(stats.creates == 1)
    #expect(stats.finalizes == 1)
    // Late capture/error callbacks cannot regress a successful completion either.
    let lateTick = try await store.updateCapture(id: entry.id, state: .recording, duration: 0)
    let lateError = try await store.recordSyncFailure(id: entry.id, message: "stale failure")
    #expect(lateTick.state == .uploaded && lateError.state == .uploaded)
    #expect(lateError.error == nil)
}

@Test func cancellationAfterAcknowledgmentUsesJournalRemoteIDAndKeepsOriginal() async throws {
    let server = try ContractServer()
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try JournalStore(root: root)
    var entry = RecordingRecord(title: "Cancel in flight", transcriptionMode: .serverAPI)
    entry.state = .recording; entry.workspaceID = UUID().uuidString; entry.server = server.origin.url.absoluteString
    try await store.save(entry)
    let media = try await store.mediaURL(for: entry)
    let bytes = Data(repeating: 0x61, count: UploadPlan.partSize * 2)
    try bytes.write(to: media)
    try Data(String(bytes.count).utf8).write(to: media.appendingPathExtension("committed"))
    let api = RelayAPI(origin: server.origin, token: "test-token")
    let _: EmptyResponse = try await api.request("/api/v1/test-control", method: "POST", body: RelayAPI.json(["failPart": 1, "failCount": 100]))
    let uploader = RecordingUploader(store: store)
    let stale = entry
    let job = Task { try await uploader.upload(stale, api: api, sealed: false) }
    for _ in 0..<200 {
        if try await store.record(id: entry.id).uploadedParts.count == 1 { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(stale.videoID == nil)
    job.cancel()
    var canceled = false
    do { _ = try await job.value } catch { canceled = true }
    #expect(canceled)
    try await store.updateCapture(id: entry.id, state: .canceled, duration: 8)
    // This is the same remote-cancel operation called by AppModel after its capture task drains.
    let saved = try await uploader.cancel(id: stale.id, api: api)
    #expect(saved.state == .canceled)
    #expect(saved.videoID != nil)
    #expect(saved.uploadedParts.map(\.index) == [0])
    let queuedTimer = try await store.updateCapture(id: entry.id, state: .recording, duration: 3)
    #expect(queuedTimer.state == .canceled && queuedTimer.duration == 8)
    let restored = try #require(try await JournalStore(root: root).recover().first)
    #expect(restored.videoID == saved.videoID)
    #expect(restored.uploadedParts == saved.uploadedParts)
    let (data, _) = try await URLSession.shared.data(from: server.origin.url.appending(path: "stats"))
    let stats = try JSONDecoder().decode(Stats.self, from: data)
    #expect(stats.cancels == 1)
    #expect(stats.requests.filter { $0 == 0 }.count == 1)
    #expect(stats.finalizes == 0)
    #expect(try Data(contentsOf: media) == bytes)
}
