# Mac capture acceptance

Target: Apple Silicon, macOS 15+. The current environment has Command Line Tools only; full Xcode and external platform devices/accounts are unavailable. No physical capture, prolonged recording, or signed distribution is qualified by these changes.

## Implemented preflight and lifecycle checks

- Compute actual screen/window/region pixel dimensions from ScreenCaptureKit's content rectangle and pixel scale. Preserve aspect ratio, even encoder dimensions and the selected resolution ceiling. Do not upscale a smaller source.
- Choose a camera format that supports 30 fps; validate the negotiated camera frames rather than silently enlarging lower-resolution output. Device selections cannot silently fall back after disconnect.
- Test a hardware-required H.264 compression session at the proposed dimensions. The movie writer also requires hardware encoding.
- Detect denied screen/camera/microphone permissions and missing devices, with recovery instructions. Show actual dimensions, 30 fps target and estimated storage before capture.
- Require one minute's estimated storage plus a 512 MiB reserve; check disk capacity every second during capture, including pause. Stop before consuming the reserve. Surface durable sink failures on subsequent appends, retaining prior bytes.
- Serialize preparation/countdown/capture/pause/finish. Stop/cancel during setup prevents recording; cleanup must finish before another start. Generation checks reject stale UI callbacks. Device/session interruption and prolonged encoder backpressure stop capture with a recoverable error.
- Show accepted/dropped frame counts. These are diagnostics, not proof of sustained 4K or audio synchronization.

Synthetic validation includes source-size limits, hardware rejection, disk/permission rejection, concurrent start, cancellation during preparation/countdown, stale callbacks, paused stop, immutable committed prefixes, actual H.264 decode and disk-sidecar failure. Existing journal/upload/transcript recovery tests remain required.

## Physical acceptance ledger

Record hardware, OS, display scaling, camera/mic IDs, actual dimensions/fps, encoded/dropped counts, audio drift, recovered tail duration, and fixture/log locations for every result. All rows below are **not run**.

| Case | Required evidence |
|---|---|
| Display, window, region, camera-only, screen+camera | Actual encoded dimensions, correctly selected source, no upscaling |
| Mic/system audio off, either source, both | Audible output, independent level/sync checks, no feedback loop |
| Permission denial/revocation; device disconnect | Clear recovery action, no uncontrolled capture restart, retained original |
| Stop/cancel during permissions/countdown; rapid start presses | One capture owner, no stale preview/recording resurrection |
| Pause/resume, stop while paused, restart | Media clock excludes pause and audio stays aligned |
| Low disk / volume removal / app termination | Previously committed bytes decode after relaunch; no lost upload acknowledgments |
| 30-minute 4K30; six-hour default-limit soak | Real dropped-frame and drift measurements, memory/disk bounds |
| Packaged FluidAudio real speech/silence | Verified local model, independent pending transcript, playable media before captions |
| Developer ID signing/notarization | Authorized credentials and Gatekeeper verification |
