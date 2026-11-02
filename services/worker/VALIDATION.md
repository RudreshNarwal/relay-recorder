# Worker and ASR validation

## Current speech, cleanup and review-fix evidence, 2026-10-26

The latest dedicated PostgreSQL/FFmpeg worker run passed 48 tests, with one optional live-ASR test skipped there. The isolated Linux API run passed 24 tests with zero skips using the real private Parakeet service and acoustic `/analyze` endpoint. Default repository suite passed 71 tests with 31 environment-gated skips; typecheck and production Next build passed. Logs: `.context/build/review-worker-suite-final.log`, `review-live-api-green.log`, `review-full-suite-final.log`, `review-typecheck-final.log`, `review-production-build.log`.

Current speech adapters cover Deepgram, AssemblyAI and OpenAI with HTTP transport fixtures. Word/segment/untimed precision is preserved, invalid timestamps rejected, configuration/access/lease checked before disclosure, and usage/remote IDs retained. Rendering reads source transcripts under locks after media processing, carries corrected spans/metadata, and does not queue inherited external transcription for edited composites. Missing source transcripts preserve known corrections and surface an incomplete status. An explicit revision-scoped speech request is required; corrected text remains protected. Whole-source untimed text is retained; partial untimed cuts cannot reveal removed text.

Cleanup uses the real private pinned VAD and energy protection, optional bounded contextual proposals, versioned provenance, and ordinary immutable revisions. Tests cover quiet speech/music/breath protection, repeated occurrences, annotation privacy, real 5 ms audio edge fades, and stale analysis rejection. Earlier live pinned speech/silence and five Python service tests passed (`t3-live-model.log`, `t3-asr-green.log`).

The previous automatic server-transcription policy for incomplete stitched revisions below is historical and superseded by explicit selection. External live credentials, overlap reconciliation, long-duration qualification and the consented cleanup quality corpus/Loom comparison remain pending. No premium-quality parity is claimed.

## Expansion foundation validation, 2026-10-26

The capacity/audio changes pass repository typecheck and the default suite (47 passed, 23 environment-gated cases skipped before the live audio gate was added). AAC/MP4 and Opus/WebM fixtures exercise real probe/decode, trimming, mixed video stitching, HLS, MP4, waveform energy, and audio frequency preservation. Tests reject truncated files, unsupported playlists, wrong declared kind, and excess duration. Capacity tests cover the largest bounded manifest and fixed limits after operator changes.

An isolated Linux ARM64 worker run passed all 18 API tests with zero skips. It used the running private Parakeet v3/Silero service, synthesized speech and silence audio-only fixtures, and a separate `relay_api_test` database. Speech produced timed words and captions; silence produced no transcript segments. Playback, original hashes, trim/caption alignment, exports, password access, and unpublished-original denial passed. Evidence: `.context/build/f3-live-asr.log`. This is a pipeline check, not a language-accuracy benchmark or long-duration soak.

For reproduction, supply `ASR_LIVE_TEST=1` and `ASR_FIXTURE_DIR` containing `speech.m4a` (including “hello world”) and `silence.m4a` when running `tests/api.test.ts` with a reachable private `ASR_URL` and matching token. The test creates/uses only `relay_api_test`, never the application's main database. No cloud speech provider is contacted.

Validated on 2026-10-26. Worker-owned TypeScript compiled cleanly; repository typecheck later reported unrelated work-in-progress errors in `tests/api.test.ts` (request body type and UUID default parameter inference).

## Observed passing checks

- `pnpm exec tsx --test tests/worker-ai.test.ts tests/worker-jobs.test.ts tests/worker-media.test.ts`: 22 tests. These exercise five real AI SDK adapters using HTTP transport fixtures, invalid authentication, rate limiting, malformed output, secret redaction, encrypted administrator connection tests, explicit Vertex ADC routing, retry/publication rules, six-hour transcription window planning, checksum corruption, real FFmpeg trim/stitch/audio frequency preservation, waveform energy, timed blur, HLS, thumbnails, 4K preservation, six-hour duration rejection, and network/local playlist rejection.
- Four optional PostgreSQL integration tests were executed separately against a migrated `relay_worker_test` database and passed. They cover parallel claims and expired leases; original preservation, caption remapping, stale publication and manually edited AI fields; explicit seven-day deletion with active cross-video source references; and the full worker-to-private-ASR HTTP path with actual speech.
- Python focused ASR tests: four passed, covering timestamp offsets and sentencepiece word assembly, silence, authentication/upload resource checks, and WAV shape validation.
- Real pinned Parakeet v3 plus Silero VAD recognized synthesized speech with word timestamps and returned no segments for silence. This passed on macOS Apple Silicon and inside the built Linux ARM64 CPU Docker image. The Linux check used the cached model assets with `HF_HUB_OFFLINE=1`.
- `docker build -t relay-asr-worker-test services/asr` completed successfully.
- Full repository `pnpm test` at the last worker verification: 35 passed, 11 optional API/worker integration gates skipped by default. Worker integration gates were exercised separately as described above.

## Reproduction

Set `TEST_DATABASE_URL` to a dedicated, migrated PostgreSQL database, then run the worker integration files with `node --test-concurrency=1 --import tsx --test tests/worker*.test.ts`. The live ASR test also requires `ASR_LIVE_TEST=1`, `ASR_TEST_WAV` pointing to mono PCM16 16 kHz speech containing “hello”, a running private service in `ASR_URL`, and its matching `INTERNAL_API_TOKEN`. Fixtures create and remove their own users, workspaces, videos and temporary media. The processing test temporarily writes the test database's `ai` setting, so never point it at a real instance.

`services/asr/README.md` documents Python and pinned-model test commands. Model cache and local virtualenv are ignored by Git.

## Limits of this evidence

Cloud providers were tested through their actual SDK request/response boundaries with mocked HTTP responses; no live provider account credentials were supplied. The real speech sample was approximately five seconds. Six-hour support is bounded and split into 30-minute windows, but a six-hour transcription load test was not run. The real 4K fixture was brief; sustained 4K performance was not benchmarked.

## Revision ownership follow-up

The schema-v2 AI integration gate also passed against PostgreSQL. It verifies ambiguous legacy snapshots (including nullable revision IDs), repeated migration preserving current edits, same-revision regeneration, clean notes for a newly published revision, retained historical notes on republishing, required/stale PATCH preconditions, revision-scoped failure and expired-lease updates, and rejection of generation based on an in-flight changed transcript. Provider/model are asserted inside the actual mocked HTTP boundary, before returning success; authentication failure metadata and changed-provider retry rejection are also covered.

The media pipeline integration now verifies completeness across stitched sources. Missing source speech leaves on-device mode explicitly failed without automatic server fallback; edited revisions require explicit transcription selection before sending their audio; a destination recording never grants consent for other stitched sources. Valid empty silence remains ready and does not trigger duplicate ASR. Clips using an original source read the initial transcript timeline even after a trimmed revision becomes published.

The full suite after these additions reported 38 passing tests and 17 optional integration skips; dedicated worker revision and media integration gates passed separately. Repository typecheck passed after root-owned API test typing fixes.
