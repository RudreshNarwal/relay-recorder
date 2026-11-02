import Foundation
import Testing
import RelayCore
@testable import Relay

@Test @MainActor func autoChecksTheLocalModelFirstIncludingWhileItLoads() {
    let model = LocalTranscriber(root: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString), sharedDirectory: nil)
    #expect(!model.availableLocally)
    #expect(TranscriptionPreference.automatic.resolve(localReady: model.availableLocally) == .serverAPI)
    model.installed = true; model.busy = true
    #expect(model.availableLocally, "Installed and still verifying at launch counts as local")
    #expect(TranscriptionPreference.automatic.resolve(localReady: model.availableLocally) == .onDevice)
    model.busy = false
    #expect(!model.availableLocally, "Installed but failed verification falls back to the server")
    model.installed = false; model.busy = true; model.downloading = true
    #expect(!model.availableLocally, "A download in progress is not local yet")
}
