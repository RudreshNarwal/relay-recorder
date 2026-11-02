import Testing
import RelayCore
@testable import Relay

@Test func libraryStatusNamesWhereEachRecordingIs() {
    var record = RecordingRecord(title: "Demo", transcriptionMode: .serverAPI)
    let label = { StatusBadge.style(for: record).0 }
    record.state = .ready; #expect(label() == "On this Mac")
    record.state = .interrupted; #expect(label() == "Needs recovery")
    record.state = .uploaded; #expect(label() == "In workspace")
    record.transcriptionMode = .onDevice; record.transcriptSyncState = nil; #expect(label() == "Transcript pending")
    record.transcriptSyncState = .synced; #expect(label() == "In workspace")
    record.state = .failed; #expect(label() == "Upload failed")
}
