# Should Relay migrate to Rust?

**Keep the current stack. A full Rust rewrite is not justified by the evidence.** The pending features are product behavior, provider authorization and platform work; changing language does not supply those capabilities.

| Layer | Current fit | Rust assessment |
|---|---|---|
| Mac recorder | SwiftUI, ScreenCaptureKit, AVFoundation, Keychain | Keep Swift. Rust would still need native bindings and does not remove platform permission/lifecycle work. |
| Web and API | React/Next.js, Better Auth, AI SDK | Keep TypeScript. A rewrite would replace useful ecosystem integrations while retaining the browser frontend. |
| Media processing | FFmpeg, bounded PostgreSQL jobs | FFmpeg performs the expensive encoding in native code already. Profile before changing the orchestration language. |
| Speech | FluidAudio on Mac; onnx-asr service | Keep the existing model runtimes and measured compatibility. Rust cannot expand Parakeet's language coverage. |
| Future shared/native components | Separate platform clients | Consider Rust for a measured CPU/memory bottleneck or a carefully bounded shared library, after stable interfaces and cross-platform tests exist. |

Rust can improve memory safety compared with manually managed native code and can suit high-throughput services. Swift, JavaScript and the model runtimes already manage memory at most Relay application boundaries. There is no measured TypeScript bottleneck showing a Rust rewrite would improve recording quality, encoding speed or reliability here. No Rust migration or destructive schema conversion was performed.

If profiling later justifies a component migration, preserve the `/api/v1` contract, journal/upload formats and revision invariants; run old/new implementations against the same failure fixtures, then roll out one component with a rollback path. Do not rewrite all layers at once.
