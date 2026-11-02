# Relay for macOS

The app is an independent SwiftUI implementation. It does not use Loom binaries, capture APIs, branding, or extracted source. Target: macOS 15+, Apple Silicon.

## Design

- ScreenCaptureKit handles screen, window and normalized region capture. AVFoundation handles camera and microphone input. A serial capture queue owns timing, composition, pause state, and writer input. The default is 1920×1080 at 30 fps; output supports 720p, 1440p and 2160p.
- AVAssetWriter's MPEG-4 Apple HLS segment delegate emits initialization and complete media fragments. Relay appends those bytes to one MP4, synchronizes the file, then advances an atomic committed-byte marker. Uploads use only this immutable prefix. Complete 8 MiB parts upload while capture continues; the partial tail uploads only after stop. Local originals remain until the user explicitly deletes them.
- A durable JSON journal contains the stable client UUID, recording metadata, remote identifiers, and acknowledged part digests. Relaunch marks active recordings interrupted and retains all media. Recovery only exposes committed fragments and preserves the original on disk.
- System and microphone PCM are converted to 48 kHz stereo and mixed on the capture queue before one AAC encoder. Pauses use the same clock for video and audio. A small audio holdback allows both sources to arrive before mixing.
- The camera overlay and ink are composed into video, not captured from Relay's UI. Relay windows are excluded from display capture. Notes stay local and outside the recorded source.
- Native browser authorization uses a random verifier and SHA-256 base64url challenge. Tokens live in Keychain, scoped to server origin. HTTPS is required except loopback development. Redirects are refused to avoid forwarding bearer credentials.
- FluidAudio is pinned to 0.17.7. The app explicitly downloads and manages Parakeet TDT v3 models. It does not download speech models automatically during capture or use a speech cloud fallback.

## Validation limits

Automated tests use synthetic media only. No user's desktop or microphone was captured during implementation. Screen Recording, Camera and Microphone permission prompts, physical devices, system audio availability, Continuity Camera, overlay placement across multiple displays, global shortcut conflicts, real Parakeet inference, offline-to-online upload resumption and playback after forced process termination require deliberate manual QA on a signed packaged app.

## Current speech/recovery follow-up, 2026-10-26

The latest `swift test --package-path apps/macos` passes 23 tests. In addition to the baseline below, it covers local/server speech policy, timestamped-word journal compatibility, pinned-model checksum rejection, external-provider selection/version persistence, safe capability query encoding, independent late-transcript retry, and rejected-admission reselection. The rejection flow preserves the recording UUID and original bytes across relaunch; ambiguous responses and already-admitted uploads cannot change their pinned selection. Evidence: `.context/build/review-native-green.log`.

The separate real-model test downloaded and verified all 21 pinned CoreML artifacts, loaded offline, recognized synthetic speech with word timing, returned no speech for silence, and preserved its input bytes. This does not replace the packaged-app physical-capture acceptance matrix.

## Historical baseline verified in this workspace

- `swift test --package-path apps/macos`: 13 tests passed. Coverage includes pause clock transitions, journal restart recovery and corrupt-record isolation, fixed 8 MiB boundaries and held tails, HTTPS origin validation, RFC 7636 challenge, redirect refusal, real loopback HTTP retries and persisted restart resume, retained media after finalization, a one-job concurrency bound across recordings, and real in-flight failure/cancellation orchestration after an acknowledged part.
- The encoder test writes 100 synthetic BGRA frames through the actual Apple H.264 encoder, verifies an emitted committed prefix stays byte-identical after stop, checks final committed byte count, and decodes all 100 frames with AVAssetReader. No desktop, camera or microphone is used by tests.
- `swift build --package-path apps/macos`: passed for the complete SwiftUI executable.
- The release packaging script produces a code-sign-verified `.app` and a validated compressed DMG. An app launch smoke check stayed running without requesting capture or device permissions. No screen recording was started.
- Packaging script syntax and both property lists validate. Command Line Tools emits warnings for missing Xcode developer-framework search paths; they do not prevent successful native builds or tests.

## Manual acceptance run

1. Install the signed app at a stable location. Verify Screen Recording, Camera and Microphone denial and subsequent approval flows.
2. Preview and record every source mode, with microphone/system audio independently and together. Confirm audio levels, pause removal, duration, camera blur, movable camera, cursor highlight, drawing, notes exclusion, screenshots and global/menu controls.
3. Run 1080p30 and 4K30 recordings on target hardware. Confirm monitor resolution, Retina scaling, window framing and region boundaries on multiple displays.
4. Disconnect the network mid-recording, reconnect, stop, and verify the uploaded video. Force-quit during capture, relaunch, recover fragments, and confirm playback before syncing. Inspect `.interrupted-original` retention when a partial tail exists.
5. Complete browser sign-in, sign-out and token revocation against the deployed server. Download Parakeet v3, confirm progress and model removal, transcribe a real audio recording locally, and verify timed transcript upload. Repeat with server API transcription selected.
6. Distribute only with a Developer ID identity and notarization credentials when Gatekeeper-trusted installation is required. The local ad-hoc artifact verifies its code signature but is not notarized.


## Journal ownership correction

Journal creation rejects replacement of an existing record. Every subsequent write is a journal-owned atomic mutation: capture state/duration, title, transcript, server binding, sync error, or upload identifiers/acknowledgments. Upload acknowledgments are monotonic; a different digest for an existing index is rejected. Completed and canceled records reject late capture-state/error regressions. The uploader reloads the authoritative journal before resuming, and cancellation loads its remote identifier from that journal.

The regression was first reproduced against the old AppModel catch behavior: the remote identifier became nil, the acknowledged part list became empty, and resume uploaded part 0 twice. The replacement tests run actual HTTP uploads, persist part 0, force the next part to exhaust retries, interleave pause/timer/rename/transcript writes, attempt the rejected stale snapshot write, and restart/resume from an intentionally stale entry snapshot. They verify one creation, one part-0 request, and successful finalization. A separate task-cancellation test verifies remote DELETE uses the persisted identifier, acknowledged progress survives relaunch, terminal state cannot be reopened by a queued timer, and original bytes remain intact.

Native Settings now discloses Parakeet v3's 25 supported European languages, the reliability limitation for unsupported languages, and that Relay never switches providers automatically.

## Capture preflight follow-up

Preflight now reports actual source-limited dimensions without upscaling, checks a hardware-required H.264 encoder, selects a 30 fps camera format, and estimates storage. Capture preserves a 512 MiB disk reserve and reports encoder/device interruptions. Preparation/countdown cancellation is generation-owned; old callbacks cannot revive a canceled session. Durable fragment-sink errors surface before continued recording, retaining existing bytes. See [Mac QA ledger](../../docs/qa/macos-capture.md) for automated evidence and the still-unrun physical matrix.
