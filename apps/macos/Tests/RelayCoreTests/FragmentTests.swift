import Foundation
import Testing
import AVFoundation
import CryptoKit
@testable import RelayCore

// Synthetic generated pixels exercise the real Apple encoder. No capture permission or devices are touched.
@Test func fragmentedMovieKeepsCommittedPrefixImmutableAndPlayable() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("synthetic.mp4")
    let movie = try FragmentMovie(url: url, width: 640, height: 360, hasAudio: false)
    var prefix = Data()
    for frame in 0..<100 {
        var pixel: CVPixelBuffer?
        CVPixelBufferCreate(nil, 640, 360, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixel)
        let buffer = try #require(pixel)
        CVPixelBufferLockBaseAddress(buffer, [])
        let bytes = CVPixelBufferGetBytesPerRow(buffer) * CVPixelBufferGetHeight(buffer)
        memset(CVPixelBufferGetBaseAddress(buffer), Int32(frame % 255), bytes)
        CVPixelBufferUnlockBaseAddress(buffer, [])
        while !movie.video.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
        #expect(try movie.append(buffer, at: CMTime(value: Int64(frame), timescale: 30)))
        if frame == 65 {
            // Wait for the closed fragment to reach disk, without closing the movie.
            for _ in 0..<100 where FragmentMovie.committedSize(at: url) == 0 { try await Task.sleep(for: .milliseconds(10)) }
            let committed = FragmentMovie.committedSize(at: url)
            #expect(committed > 0)
            prefix = try Data(contentsOf: url).prefix(committed)
        }
    }
    try await movie.finish()
    let final = try Data(contentsOf: url)
    #expect(!prefix.isEmpty)
    #expect(final.prefix(prefix.count) == prefix)
    #expect(FragmentMovie.committedSize(at: url) == final.count)
    let asset = AVURLAsset(url: url)
    #expect(try await asset.loadTracks(withMediaType: .video).count == 1)
    let duration = try await asset.load(.duration).seconds
    #expect(duration > 3 && duration < 4)
    let reader = try AVAssetReader(asset: asset)
    let track = try #require(try await asset.loadTracks(withMediaType: .video).first)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    reader.add(output)
    #expect(reader.startReading())
    var count = 0
    while output.copyNextSampleBuffer() != nil { count += 1 }
    #expect(count == 100)
    #expect(reader.status == .completed)
    // Capture must never overwrite an existing original.
    #expect(throws: RelayError.self) { try FragmentMovie(url: url, width: 640, height: 360, hasAudio: false) }
}

@Test func corruptJournalDoesNotHideOtherRecordings() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try JournalStore(root: root)
    let record = RecordingRecord(title: "Intact", transcriptionMode: .serverAPI)
    try await store.save(record)
    try Data("broken".utf8).write(to: root.appendingPathComponent(UUID().uuidString + ".json"))
    let recovered = try await store.recover()
    #expect(recovered.count == 1)
    #expect(recovered.first?.id == record.id)
}

@Test func committedBoundaryFailureStopsTheNextAppendAndRetainsOriginalBytes() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path); try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("disk-error.mp4")
    let movie = try FragmentMovie(url: url, width: 160, height: 90, hasAudio: false)
    var pixel: CVPixelBuffer?
    CVPixelBufferCreate(nil, 160, 90, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixel)
    let buffer = try #require(pixel)
    for frame in 0..<70 {
        while !movie.video.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
        _ = try movie.append(buffer, at: CMTime(value: Int64(frame), timescale: 30))
    }
    for _ in 0..<100 where FragmentMovie.committedSize(at: url) == 0 { try await Task.sleep(for: .milliseconds(10)) }
    let committed = FragmentMovie.committedSize(at: url)
    #expect(committed > 0)
    let prefix = try Data(contentsOf: url).prefix(committed)
    // The open movie can still append bytes, but atomic sidecar commits now fail.
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: root.path)
    var failed = false
    for frame in 70..<170 {
        while !movie.video.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
        do { _ = try movie.append(buffer, at: CMTime(value: Int64(frame), timescale: 30)) }
        catch { failed = true; break }
        try await Task.sleep(for: .milliseconds(5))
    }
    #expect(failed, "A committed-boundary write failure must surface before capture continues indefinitely")
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
    try? await movie.finish()
    #expect(try Data(contentsOf: url).prefix(prefix.count) == prefix)
}
