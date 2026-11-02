# Loom Enterprise and Relay

Checked against official product documentation on October 26, 2026. Enterprise includes Loom's Business + AI features. This compares advertised Loom capabilities with Relay's current source and validation evidence, not equivalent production maturity.

| Capability | Loom premium offering | Relay today |
|---|---|---|
| Screen, camera, system audio, up to 4K | Available | Implemented on Apple Silicon/macOS 15+; physical capture QA pending |
| Recorder platforms | Mac, Windows, Chrome, iOS, Android | Mac recorder; browser workspace/import/playback. No Windows/mobile recorder or extension |
| Recovery and uploads | Cloud recording workflow | Local originals, durable journal, resumable checksum-verified uploads; automated failure/restart coverage |
| Recording limits | Paid plans advertise unrestricted length | Defaults: six hours and 32 GiB; bounded operator limits are snapshotted for admitted recordings |
| Notes, drawing, cursor emphasis | Available | Implemented; hardware interaction checks pending |
| Visual/audio polish | Background options and noise reduction | Camera background blur and timed video blur. Live microphone noise suppression with Apple Voice Isolation while recording (system audio untouched), plus server-side Enhance voice (RNNoise denoising and leveling) on playback with the original kept. Both on by default; no background replacement |
| Trim, stitch, transcript editing | Available | Implemented with preview and revision publication; privacy effects follow manual edits, and inherited corrections survive stitching. Real FFmpeg/browser checks passed |
| Filler and silence cleanup | AI-assisted | Private VAD/energy-based pauses, timed English filler candidates, optional contextual AI proposals, selection/preview/undo; quality benchmark and Loom parity pending |
| Advanced presentation edits | Styled captions, overlays, rewind | Timed text/arrow/box overlays, styled burned captions, fitted canvas presets, animated thumbnails and optional export audio filters implemented; native rewind/background replacement and full preview/export polish remain pending |
| Transcription and captions | 50+ languages | Parakeet v3, 25 documented languages; real Mac/server speech and silence passed. Explicit Deepgram/AssemblyAI/OpenAI settings; external live qualification pending. Untimed output disables captions |
| Titles, summaries, chapters, tasks | Loom AI | Implemented through five selectable provider integrations; live credentials not tested |
| AI documents, issues, messages | Workflow generation | 14 versioned templates, custom workspace templates, editable manual/AI drafts, proposal review, Markdown/JSON export; fixture/API/browser checks pass, live AI quality unqualified |
| Record for agents | Available in open beta | Transcript-based agent handoff drafts with revision/timestamp evidence, editing and export; interaction metadata, keyframes and Record-for-agents capture remain pending |
| Meeting capture and recaps | Available | Opt-in recap drafts after attended capture/file upload, plus reviewed external delivery; calendars, provider imports, speakers and autonomous bots remain pending |
| Protected sharing, embeds, downloads | Available | Private/workspace/unlisted/password/explicit access, embeds, download controls; access regressions pass |
| Comments, replies, reactions | Available, with view and comment email alerts | Implemented, with first-view and comment/reply emails through SMTP or Resend, per-user preferences and send-time access checks; retained comment occurrences and complete chapters map across repeated edits, with removed discussion omitted |
| Team organization | Libraries, spaces, roles | Workspaces, owner/admin/member roles, invitations, folders, search, favorites/archive/watch-later |
| Analytics | Viewer, engagement, administration reports | Played intervals, revision/date filters, known-viewer history, anonymous totals, 90% coverage completion, coverage/exit charts; browser/API checks passed. Workspace adoption, inventory, processing and provider reports; protected CSV, minimal audit and analytics retention implemented. Million-event synthetic read benchmark passed |
| Branding and calls to action | Configurable branding and linked CTAs | Workspace logos/colors/header/footer/credit, preview, video overrides and revision-pinned timed CTAs; protected logo and telemetry tests pass |
| Enterprise governance | SSO/SCIM, audit and retention controls | Email/password, device login, role/video permissions; minimal action log and configurable analytics retention; SSO/SCIM, comprehensive audit suite and custom media retention remain separate |
| Integrations | Collaboration/CRM connections | Nine reviewed-write adapters with encrypted scoped tokens and durable outbox; protocol/API tests pass. OAuth, live qualification, Salesforce, calendar connections and richer connector features remain pending |
| Hosting and operation | Managed cloud service and Enterprise SLA | Self-hosted Docker/PostgreSQL/filesystem, backup/restore, health checks; operator-managed, no SLA |

Relay defaults to verified local Mac Parakeet when ready, otherwise private-server Parakeet. External speech requires an explicitly selected, tested, versioned provider configuration. Its server owner selects Gemini AI Studio, Vertex AI, OpenAI, Anthropic, or OpenRouter for transcript-based generation. There is no automatic provider fallback. Hosting and selected AI-provider costs remain yours.

Windows, Chrome, iOS/Android, rich agent-context capture, automatic meeting capture/calendar imports, remaining native presentation tools and full integration scope remain unfinished. Transcript agent drafts, local recap automation, revision presentation and reviewed connector delivery now cover useful portions of those workstreams. Enterprise SSO/SCIM and custom media retention remain a separate follow-up. Meeting qualification constraints are tracked in [MEETING-CAPABILITIES.md](MEETING-CAPABILITIES.md); no autonomous meeting recorder is currently qualified.

## Sources and evidence

- [Loom pricing and Enterprise feature matrix](https://www.loom.com/pricing): plan inclusion, recording/editing, sharing, collaboration, analytics, governance, integrations, and SLA.
- [Loom AI](https://www.loom.com/ai): generated notes, workflow documents/messages/issues, meeting recaps, and language coverage. Features marked “coming soon” are not counted as shipped here.
- [Atlassian recording platform documentation](https://support.atlassian.com/loom/docs/the-loom-recording-platforms/): platform availability and differences.
- [Atlassian Record for agent documentation](https://support.atlassian.com/loom/docs/record-for-agent/): beta status, technical metadata, and agent handoff.
- Relay: [implementation contract](IMPLEMENTATION.md), [validation and release gates](VALIDATION.md), [native validation](../apps/macos/IMPLEMENTATION.md), and [worker validation](../services/worker/VALIDATION.md).
