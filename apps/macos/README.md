# Relay for macOS

Native macOS 15+ recorder for Apple Silicon. Swift 6.2+ and the macOS SDK are required. Xcode is recommended; standalone Command Line Tools can build the package.

```sh
cd apps/macos
swift test
swift build
./scripts/package.sh
open dist/Relay.app
```

The packaging script builds release arm64, assembles a real app bundle, embeds SwiftPM frameworks and resources, generates the Relay icon, signs the app, verifies its signature and creates `dist/Relay.dmg`. Use `RELAY_CONFIGURATION=debug RELAY_SKIP_BUILD=1 ./scripts/package.sh` to package an existing debug build.

For distribution, set `RELAY_SIGNING_IDENTITY` to a Developer ID Application identity. Set `RELAY_NOTARY_PROFILE` to a Keychain profile created with `xcrun notarytool store-credentials` to submit and staple the DMG. Ad-hoc signing is the default for local development; it does not provide notarized distribution or Gatekeeper approval. Install to a stable location before granting permissions. Camera, microphone and Screen Recording approvals belong to macOS and may need renewing after changing signing identity.

Open Settings, enter your self-hosted HTTPS origin and sign in through your browser. Loopback HTTP is accepted for local development. Select a workspace. Tokens are stored only in Keychain. Recording works without a network connection or sign-in.

Choose a source, click **Load sources**, select the display/window or drag a region, then preview or record. Capture permissions are requested only through those deliberate controls. Recording starts after a three-second countdown. Drag the camera bubble to position it. Drawing becomes an interactive overlay until disabled with ⌘⇧6. Speaker notes stay outside display captures. The camera blur uses Apple's local person segmentation.

Global shortcuts: ⌘⇧2 record, ⌘⇧3 stop, ⌘⇧4 pause/resume, ⌘⇧5 screenshot, ⌘⇧6 drawing. macOS may reserve shortcuts or another app may register them first; menu-bar controls remain available.

The default quality is 1080p30; 720p30, 1440p30 and 4K30 are available. Performance depends on display size, camera blur, encoder and hardware. Screen and microphone audio mix into one AAC track. Turn off speaker playback or use headphones when needed to avoid capturing both an acoustic echo and the system-audio signal.

Local transcription requires downloading Parakeet TDT v3 in Settings. Progress includes downloads and Core ML compilation. Models remain in the local Relay support directory and can be removed. Auto selects the verified runnable local model, otherwise self-hosted Parakeet, before capture. Local-only remains pending until its model is ready. An explicit external choice stores its provider/configuration version and server/workspace binding with the recording. Owner-configured external choices load from authenticated capabilities; credentials remain on the server. Media uploads independently of local speech, and late transcripts retry after restart. Each recording retains its choice; no error switches providers. If initial admission explicitly rejects an unavailable speech configuration, the local library offers “Use private server Parakeet and retry.” This preserves the recording UUID and original bytes. An uncertain/lost response or an admitted upload cannot unlock reselection. The local model uses a pinned 483,105,645-byte manifest and SHA-256 verification. The local development server defaults to http://localhost:3110.

Local originals, atomic recording journals and committed-fragment markers live in `~/Library/Application Support/Relay/`. Relaunch marks active recordings interrupted. Select **Recover fragments** to validate complete fragments; if a partial tail exists, its original is preserved as `.mp4.interrupted-original` before recovery. Sync verifies each 8 MiB part by SHA-256, retries bounded failures and resumes from persisted acknowledgments. Media remains local after successful upload. Deleting local recordings requires explicit confirmation and does not delete server copies.

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for architecture and remaining manual validation.
