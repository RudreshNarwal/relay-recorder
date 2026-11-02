import CryptoKit
import Foundation
import Testing
@testable import RelayCore

@Test func automaticSpeechUsesOnlyHealthyLocalParakeet() throws {
    #expect(TranscriptionPreference.automatic.resolve(localReady: true) == .onDevice)
    #expect(TranscriptionPreference.automatic.resolve(localReady: false) == .serverAPI)
    #expect(TranscriptionPreference.localOnly.resolve(localReady: false) == .onDevice)
    #expect(TranscriptionPreference.server.resolve(localReady: true) == .serverAPI)
}

@Test func timestampedWordsSurviveJournalAndLegacySegmentsDecode() throws {
    let legacy = try JSONDecoder().decode(TranscriptSegment.self, from: Data(#"{"start":0,"end":1,"text":"hello"}"#.utf8))
    #expect(legacy.words == nil)
    let segment = TranscriptSegment(start: 0, end: 1, text: "hello world", words: [TranscriptWord(start: 0, end: 0.4, text: "hello"), TranscriptWord(start: 0.5, end: 1, text: "world")])
    let roundTrip = try JSONDecoder().decode(TranscriptPayload.self, from: JSONEncoder().encode(TranscriptPayload(segments: [segment])))
    #expect(roundTrip.segments[0].words?[1].start == 0.5)
    #expect(roundTrip.segments[0].words?[1].text == "world")
}

@Test func modelVerificationRejectsCorruptionPartialFilesAndUnsafePaths() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let file = ModelArtifact(path: "weights.bin", size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    try Data("abc".utf8).write(to: root.appendingPathComponent("weights.bin.partial"))
    #expect(throws: (any Error).self) { try ModelIntegrity.verify(directory: root, files: [file]) }
    try Data("abd".utf8).write(to: root.appendingPathComponent("weights.bin"))
    #expect(throws: (any Error).self) { try ModelIntegrity.verify(directory: root, files: [file]) }
    try Data("abc".utf8).write(to: root.appendingPathComponent("weights.bin"))
    try ModelIntegrity.verify(directory: root, files: [file])
    #expect(throws: (any Error).self) { try ModelIntegrity.verify(directory: root, files: [ModelArtifact(path: "../weights.bin", size: 3, sha256: file.sha256)]) }
}

// A shared FluidAudio cache links model files across sibling folders; links may not escape the allowed root.
@Test func sharedModelSymlinksMustStayInsideTheAllowedFolderAndStillMatchChecksums() throws {
    let base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: base) }
    let real = base.appendingPathComponent("Models/parakeet-coreml"), linked = base.appendingPathComponent("Models/parakeet")
    try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: linked, withIntermediateDirectories: true)
    try Data("weights".utf8).write(to: real.appendingPathComponent("vocab.json"))
    try FileManager.default.createSymbolicLink(at: linked.appendingPathComponent("vocab.json"), withDestinationURL: real.appendingPathComponent("vocab.json"))
    let good = ModelArtifact(path: "vocab.json", size: 7, sha256: "4e5c13e3e5bbdc1a8f1b3a4e6d4e1d1f1a5dd5c54d0e9e0c0e8c4a8e0ad9f0b1")
    let actual = ModelArtifact(path: "vocab.json", size: 7, sha256: SHA256.hash(data: Data("weights".utf8)).map { String(format: "%02x", $0) }.joined())
    #expect(throws: RelayError.self) { try ModelIntegrity.verify(directory: linked, files: [actual]) }
    try ModelIntegrity.verify(directory: linked, files: [actual], containment: base.appendingPathComponent("Models"))
    #expect(throws: RelayError.self) { try ModelIntegrity.verify(directory: linked, files: [good], containment: base.appendingPathComponent("Models")) }
}
