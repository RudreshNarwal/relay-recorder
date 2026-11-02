# Delivery and validation

## Public source alpha qualification, 2026-11-02

The launch checks below were run locally. They are separate from the historical evidence later in this document.

| Check | Result |
| --- | --- |
| Frozen dependency installation | Passed in the original workspace and the clean public export |
| TypeScript tests | 119 passed; 68 environment-gated skips |
| Typecheck and production web build | Passed |
| Dedicated PostgreSQL migration and integration suite | 120 passed; 2 live-Parakeet checks skipped |
| Native Swift tests | 33 tests passed; live-model checks remain opt-in |
| Private ASR HTTP/unit tests | 5 passed without model downloads |
| GitHub Actions workflow static validation | Passed with actionlint |
| Source export secret scan | No findings from gitleaks; this is not a security audit |

The clean export starts without the private repository's Git history. It excludes extracted third-party application code, internal planning documents, credentials, installed dependencies, and generated artifacts. Third-party notices identify the bundled assets and model provenance.

Developer ID signing, notarization, physical capture qualification, fresh-host Docker startup, and live external-provider qualification were not completed in this launch pass. The alpha is distributed as source, with no signed Mac download or Homebrew package. GitHub-hosted CI results are recorded separately in the public repository's Actions tab. Local evidence files are retained by the maintainer; historical `.context/` references below are not included in the source release.

The original Mac/web implementation covers the five initial milestone areas. The approved cross-platform expansion remains unfinished. Automated and browser evidence is listed below; hardware and external-account checks remain explicit release gates. The public release excludes third-party investigation/extraction files.

| Milestone | Implemented behavior | Evidence |
|---|---|---|
| Native recording | Screen/window/region/camera/screen+camera, audio selection and mixing, preview/countdown, pause/resume/stop/restart/cancel, overlays, blur, notes, screenshots, shortcuts/menu controls, 1080p30–4K, local library/export and durable recovery | Swift builds, synthetic H.264 encode/decode, immutable fragments, journal/clock/HTTP recovery tests; hardware matrix remains manual |
| Accounts/upload/sharing | Verified accounts/password reset, workspaces/roles/invites/folders/search/bookmarks/archive/import, resumable checksummed uploads, separate processing state, HLS/MP4 playback and protected share/embed/download | Real browser flows with PostgreSQL and FFmpeg; API isolation, duplicate finalize, canceled upload, password revocation, unpublished transcript, media revision, and device exchange regressions |
| Editing/collaboration | Waveform trim/split/delete/stitch, transcript cuts, previewable filler/silence removal, thumbnails, timed blur, immutable originals/revisions, comments/replies/reactions/notifications/watch later/analytics | Browser edit-preview-render-publication, captions/comments UI, real FFmpeg audio/blur/stitch/caption mapping tests |
| Transcription/AI | FluidAudio local Parakeet model management, private server Parakeet, correction/search/captions/retry, five configurable cloud model adapters, encrypted credentials, revision-scoped output and preserved manual edits | Real server-model speech/silence on macOS and Linux ARM64, worker→ASR→captions, five actual SDK adapters against deterministic HTTP fixtures |
| Packaging/operation | Mac app/DMG scripts, Docker Compose web/database/worker/ASR, schema migration, health, cleanup, backup/restore, HTTPS guide and OpenAPI | Swift release packaging/signature/DMG verification; production Next build/typecheck; server container smoke and operational checks |

## Agent, recap, integration and presentation additions, 2026-10-26

The current extension adds two templates (14 total), transcript-based agent handoffs with revision/timestamp evidence, and opt-in meeting recap drafts after a recording's published transcript is ready. Manual workflows remain usable without AI credentials. Recap rules deduplicate by recording/revision, recheck access and policy version, and share bounded workflow generation budgets. This does not join meetings, synchronize calendars, identify speakers or automatically distribute recaps.

Nine scoped-token adapters support reviewed writes to GitHub, Slack, Jira Cloud, Confluence Cloud, Linear, Notion, Teams, Gmail drafts and Outlook drafts. Encrypted credentials stay server-side. The durable outbox fences draft/revision/access/connection versions, preserves uncertain outcomes instead of blindly retrying, and allows reconciliation of historical deliveries after another revision publishes. No real external messages or drafts were created during validation; provider responses were intercepted with deterministic fixtures. OAuth/refresh and live-account qualification remain unfinished.

Revision presentation adds canvas presets, timed text/arrow/box layers, styled burned captions, optional noise reduction/volume leveling, and bounded animated thumbnails. Source originals and access rules remain intact. Browser preview and exported media share overlap-normalized caption cues; repeated clips use one source transcript snapshot, and publication rejects concurrent corrections. Audio treatments run only during rendering. The production image installs libass-capable FFmpeg and Noto fonts.

Fresh evidence for this extension: `pnpm test` **111 passed, 62 environment-gated skips**; PostgreSQL/API **52 passed, one optional live-ASR skip**; isolated worker suite **62 passed, one optional live-ASR skip**; production FFmpeg presentation **7 passed, zero skipped**; Chromium workflows/cleanup/presentation/delivery **6 passed**; OpenAPI contract **3 passed**. Typecheck passed. The existing real-Parakeet and native evidence below remains applicable to unchanged model/native code; it is not a newly performed physical acceptance run.

An independent review found four defects, covered by failing regressions before fixes: repeated-clip transcript snapshot consistency, historical delivery reconciliation, overlapping preview/export captions, and quota-exhausted workspaces starving later recap candidates. All four regressions now pass. The browser fixture initially lacked byte-range responses and placed an untimed-per-word caption across a trim boundary; corrected fixtures verify accurate seeking, retained captions, and omission of removed speech. Those fixture failures required no production behavior change.

Evidence: `.context/build/pending-final-suite.log`, `pending-final-api.log`, `pending-final-workers.log`, `pending-final-presentation.log`, `pending-final-browser.log`, `pending-final-openapi.log`, and `pending-final-typecheck.log`. Fixture screenshots: `.context/reviewed-delivery.png` and `.context/presentation-preview.png`.

Production build and `pnpm startup` passed after the extension: web, worker, PostgreSQL, Parakeet and development mail are healthy at http://localhost:3110. Startup launched no native app; `.env` remained byte-for-byte unchanged, and served OpenAPI matches the canonical document. No server owner is configured; run `docker compose exec web pnpm bootstrap` before first use. Native code and packages are unchanged by this extension. Evidence: `.context/build/pending-final-production.log`, `pending-final-startup.log`, and `pending-final-smoke.log`.

A consistent pre-upgrade database/media backup is retained privately at `.context/backups/pre-integrations-presentation-verified/`. The ordinary backup attempt encountered Docker's removed metadata for older container images; the successful fallback stopped both writers, dumped PostgreSQL and archived the existing media volume read-only using an available image, then restarted services. Archive readability passed; this extension did not rerun a full restore drill.

Known bounded limitations: connection listing returns the latest 100 rows including disconnected entries, so substantial connection churn can hide older active destinations; near the 100,000-character workflow input boundary, serialized timestamp evidence can exceed the generation budget after admission; browser caption background geometry/fonts can differ from final libass output. These are not claims of exact Loom parity. See [integrations](INTEGRATIONS.md), [presentation](PRESENTATION.md), [meeting capability gates](MEETING-CAPABILITIES.md), and [the full comparison](LOOM-COMPARISON.md) for remaining product work. Rich agent interaction capture, calendar imports, autonomous meeting bots, OAuth, native rewind/background replacement, and Windows/Chrome/mobile recorders remain unfinished. Enterprise SSO/SCIM and custom media retention remain separate follow-up.

## Continuation evidence, 2026-10-26

Workflow documents now include 12 built-in templates, custom versioned templates, manual drafts without AI, guarded generation, proposal comparison and Markdown/JSON export. Review fixes make workflow publication/job acknowledgement atomic, retain drafts across tabs, and make native quit await capture cleanup. Mac preflight checks source dimensions, hardware encoding, devices/permissions and disk capacity. Long speech windows preserve overlap and legacy checkpoints through real FFmpeg extraction.

Workspace Reports now covers engagement, team adoption, inventory, processing and returned provider usage. CSV snapshots are bounded, private, permission-checked and expire after 24 hours. Minimal action history and configurable analytics-only retention are implemented. One-million-interval benchmark: 42/9/9/11/12 ms report reads on Apple M4/16GiB/PostgreSQL17.11. Restore verification matched report/audit/metering/branding/CTA table digests in a fresh isolated database. See [Reports](REPORTS.md) for definitions and workload limitations.

Customer branding adds protected re-encoded logos, colors, header/footer/credit, live preview, video overrides and revision-pinned timed CTAs. API tests cover revoked shares, cross-workspace logos, duplicate clicks and owner previews. Chromium covers mobile width, share/embed output and safe links. See [Branding](BRANDING.md) for limits.

Fresh combined verification: `pnpm test` **93 passed, 49 environment-gated skips**; dedicated worker suite **60 passed, one optional live-ASR skip**; Swift **29 passed**; Chromium **7 passed**. Typecheck passed. The production Docker build and Mac release package passed. The refreshed-image private-Parakeet/API run passed **41 tests, zero skipped**. A preliminary run had used an old image lacking the newly explicit Sharp dependency; rebuilding resolved the environment mismatch. Final startup refresh passed; the served OpenAPI exactly matches the canonical document and all five services are healthy.

Evidence: `.context/build/final-expanded-suite.log`, `final-expanded-workers.log`, `final-expanded-live-api.log`, `final-expanded-browser.log`, `final-expanded-typecheck.log`, `continuation-quit-green.log`, `final-expanded-mac.log`, `final-expanded-startup.log`, `final-metadata-restore.log`, and `b2-million-events.log`. Screenshots under `.context/` use test fixtures, not customer data. No external paid-provider calls were used in adapter fixtures; private Parakeet checks use the actual model.

Unavailable resources are confirmed: no Windows runner, physical iPhone/iPad/Android devices, authorized Loom/meeting-provider accounts, or full Xcode installation. At that earlier checkpoint, Windows/Chrome/mobile implementation, agent context capture, connectors/calendars/meeting recaps, advanced presentation and physical/end-to-end acceptance were unfinished; the newer extension evidence above records the delivered slices and remaining gaps. This release does not achieve full Loom parity. Enterprise SSO/SCIM and custom media retention remain separate follow-up work. Workflow listing still exposes only the latest 100 drafts for a revision; older stored drafts need future pagination.

`pnpm startup` starts web/server only at **http://localhost:3110**. All five services reported healthy after rebuilding; `.env` remained unchanged and the served DMG matches the rebuilt package. No server owner is configured. Interactive startup invokes owner bootstrap; noninteractive use requires `docker compose exec web pnpm bootstrap`. Native packaging is ad-hoc signed, without Developer ID or notarization; no capture/app was launched. A private pre-upgrade backup is retained under `.context/backups/pre-reports-branding/`.

## Speech and cleanup expansion evidence, 2026-10-26

Current changes add explicit versioned speech settings, Mac/browser selection, untimed transcript handling, late-caption loading, acoustic cleanup with review/undo, optional contextual proposals, and occurrence-aware comments/chapters/privacy effects. Latest review-fix verification: default suite **71 passed, 31 environment-gated skips**; dedicated worker suite **48 passed, one live-ASR skip**; isolated Linux API with real private Parakeet and acoustic analysis **24 passed, zero skipped**; native suite **23 passed**. Chromium real-MP4 preview/edit/save, typecheck and production build pass. The earlier five Python service checks and pinned-model/CoreML checks remain applicable; those models were unchanged in the review fixes.

The independent review identified four defects, each covered by a failing regression before its fix: manual edits leaving privacy blurs behind; inherited external-audio consent after stitching; lost manual-transcript protection; and native rejected-admission recovery. Derivatives now preserve available corrections and truthful metadata, require explicit provider selection for new transcription, and retain untimed text only across whole-source clips. A live API regression caught and fixed an overly broad guard on the initial revision's empty clip list.

Evidence: `.context/build/review-live-api-green.log`, `review-worker-suite-final.log`, `review-native-green.log`, `review-edit-ui-green.log`, `review-full-suite-final.log`, `review-typecheck-final.log`, `review-production-build.log`. Earlier acoustic/model evidence: `t3-asr-green.log`, `t3-live-model.log`. Browser checks use deterministic API fixtures with real generated MP4; independent API/worker gates use PostgreSQL, FFmpeg and private models. This is not a physical-Mac end-to-end acceptance run.

`pnpm startup` rebuilt the web/server stack on port 3110; all five services are healthy. It preserved the existing environment file and launched no native app. No server-owner account is configured in this workspace; an interactive `pnpm startup` invokes bootstrap, or run `docker compose exec web pnpm bootstrap`. A private pre-upgrade database backup is under `.context/backups/`. `pnpm package:mac` rebuilt the local app/DMG and web download; ad-hoc signature and DMG integrity verification passed. Developer ID signing/notarization and physical capture acceptance remain pending.

Quality gates remain pending: live external provider credentials; real long-form speech recognition quality; a consented 30-clip-per-language cleanup corpus and matched Loom premium comparison; hardware/platform/distribution tests. Cleanup remains explicitly experimental. See [transcription operations](TRANSCRIPTION.md) and [cleanup fixture manifest](../tests/fixtures/cleanup/manifest.json).

## Reproduction and evidence

- `pnpm test`: core policies, UI upload/edit behavior, FFmpeg, AI adapters, jobs and media checks. Optional integration gates skip without their documented environment.
- `node --env-file=.env --import tsx --test tests/api.test.ts`: isolated `relay_api_test` database, automatically migrated/reset. Never point test infrastructure at a production host.
- Worker integration and real model commands: [worker validation](../services/worker/VALIDATION.md), [ASR README](../services/asr/README.md).
- Native commands and manual matrix: [native implementation](../apps/macos/IMPLEMENTATION.md).
- Browser evidence in this workspace: `.context/relay-library-desktop.png`, `.context/relay-library-mobile.png`, `.context/relay-player-desktop.png`, `.context/relay-player-mobile.png`, `.context/relay-ai-settings.png`, `.context/relay-login-desktop.png`. These show real fixture data, not production customer data.

## Remaining release gates

- Run the native hardware matrix deliberately: every screen/camera/audio combination, permissions denied then granted, device disconnect, region/multiple displays, simultaneous start/stop/cancel, low disk, forced termination, and physical-device audio synchronization.
- Packaged-app model/capture acceptance remains pending. The source-level FluidAudio path now passed a real pinned-model download, SHA-256 verification, offline load, speech/silence inference, word timestamps, and original-byte preservation.
- Complete one real Mac recording through interrupted upload, web edit/share/comment, captions/summary, and exported playback. Browser/server and native encoder/upload paths were exercised separately.
- Supply cloud credentials for live tests of each chosen provider, including billing/quota behavior. Fixture tests do not prove access to a particular paid model.
- Exercise sustained six-hour/4K recordings at the intended concurrency. Brief synthetic 4K and six-hour boundary tests do not prove sustained throughput or disk capacity.
- Supply deployment domain/SMTP and Apple Developer ID/notarization credentials for public hosting and trusted distribution.

These are unverified environment-dependent checks, not claims of completed production acceptance. Parakeet v3 language coverage is limited to its supported languages. No silent cloud fallback or voice synthesis is included.

## Historical baseline local run

The final core suite reports **38 passed**, with 17 environment-gated integration cases skipped by the default command. The 11 API cases pass separately against their dedicated database; six worker integration gates were exercised separately, including real ASR. Four Python service tests and 13 native Swift tests pass. TypeScript checks and production Next/Docker builds pass.

All five Compose services are healthy. A real HTTP container run covered duplicate upload/finalization, FFmpeg publication, actual Parakeet speech recognition, edit/blur rendering, a timestamped comment, unlisted sharing, and MP4 playback. A temporary bootstrap owner successfully signed in and was removed afterward.

The backup script was executed against the running local stack. Its database snapshot and media archive restored into a fresh isolated database and volume. Revision/comment records matched, and original/playback file SHA-256 digests matched exactly. Temporary validation data was removed from the main instance.

An independent code review identified five defects, each fixed with regression coverage: unpublished transcript leakage, native journal progress overwrite, mixed-revision playback, bookmark readback, and incomplete stitched transcripts. Follow-up review found no remaining defect in those fixes. These checks do not replace the hardware and external-account release gates above.

## pnpm startup verification

The dependency lock was imported without upgrading the application packages. `pnpm install --frozen-lockfile`, `pnpm typecheck`, and the 38 default tests pass (17 environment-gated cases skip). The Docker production build runs through pnpm, and both non-root web/worker containers report the pinned pnpm 10.15.0. `pnpm startup` successfully starts all five healthy services. Repeat startup preserves `.env` byte-for-byte. First-owner setup remains interactive; non-interactive startup prints the bootstrap command instead of creating credentials.
