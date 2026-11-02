# Loom Enterprise and Relay

Product and AI gap review refreshed against official documentation and Relay source on **November 2, 2026**. Enterprise includes Loom's Business + AI features. This compares advertised capabilities with implementation and recorded validation evidence, not equivalent production maturity. Earlier test results below are historical evidence; this documentation update did not rerun live AI, hardware capture, or competitor acceptance tests.

**Relay does not yet provide every Loom premium capability.** Existing AI generation and many editing/sharing features are included in the self-hosted core, without a Relay subscription gate. Infrastructure and optional provider usage still cost money. A self-hosted codebase cannot itself supply a managed-service SLA or enterprise certification.

## What Relay can do with AI now

- Transcribe locally or on the private server with Parakeet. This is separate from optional cloud text generation.
- Generate editable video titles, summaries, chapters, and action items from a ready transcript.
- Create SOPs, step-by-step guides, bug reports, issue drafts, PR descriptions, QA plans, code documentation, messages, email drafts, and CTA suggestions. There are 14 built-in templates plus custom workspace templates, with output language/tone controls.
- Produce transcript-based agent handoffs and opt-in recap drafts for attended or uploaded recordings. Review, edit, and export drafts; generation does not execute agent tasks or send messages.
- Propose silence/filler cuts and optional contextual repeat/tangent cuts. Cleanup is experimental, with preview and explicit application; it is not a demonstrated quality match for Loom.

The server owner configures Gemini AI Studio, Vertex AI, OpenAI, Anthropic, or OpenRouter in **Settings → AI providers**. Cloud generation sends transcript content and instructions to that provider, not screen images. Select a model, configure credentials, test the connection, then use AI notes in a recording's overview or open its Workflows panel. Private transcription and manual workflow drafts remain available without cloud generation.

Implementation evidence: [generation adapters](../services/worker/src/ai.ts), [14 workflow templates](../packages/core/src/workflows.ts), [generation job and human-edit preservation](../services/worker/src/jobs.ts), [workflow generation](../services/worker/src/workflows.ts), [workflow UI and operation](WORKFLOWS.md), and [cleanup behavior](TRANSCRIPTION.md). Calendar/OAuth status is grounded in the [calendar routes](../packages/core/src/routes/calendars.ts), [sync worker](../services/worker/src/calendars.ts), and [account/destination UI](../apps/web/components/connections.tsx). Adapter fixtures do not establish live model quality; provider accounts and consented evaluation recordings are still needed.

## Capability comparison

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
| Titles, summaries, chapters, tasks | AI generation; titles also included on free plans | Implemented through five selectable provider integrations; live credentials not tested |
| AI documents, issues, messages | Workflow generation | 14 versioned templates, custom workspace templates, editable manual/AI drafts, proposal review, Markdown/JSON export; fixture/API/browser checks pass, live AI quality unqualified |
| Record for agents | Context-rich prompts, public beta | Transcript-based agent handoff drafts with revision/timestamp evidence, editing and export; interaction metadata, keyframes and Record-for-agents capture remain pending |
| Agent tools and conversational library Q&A | Atlassian MCP and Rovo | No Relay MCP server or conversational video-library Q&A; transcript search and exported handoffs are not equivalents |
| Developer-context bug capture | Chrome bug-report recording mode | Bug-report text template exists; automatic browser device/console/network context is missing |
| Personalized video variants | Dynamic titles and audio clips | No recipient-variable pipeline or personalized audio generation; ordinary overlays and edited revisions are not equivalents |
| Meeting capture and recaps | Available | Opt-in recap drafts after attended capture/file upload, plus reviewed external delivery. Calendar OAuth/sync and per-occurrence selection exist; provider recording imports, automatic recap email sending, speaker identity and autonomous capture remain gaps |
| Protected sharing, embeds, downloads | Available | Private/workspace/unlisted/password/explicit access, embeds, download controls; access regressions pass |
| Comments, replies, reactions | Available, with view and comment email alerts | Implemented, with first-view and comment/reply emails through SMTP or Resend, per-user preferences and send-time access checks; retained comment occurrences and complete chapters map across repeated edits, with removed discussion omitted |
| Team organization | Libraries, spaces, roles | Workspaces, owner/admin/member roles, invitations, folders, search, favorites/archive/watch-later |
| Analytics | Viewer, engagement, administration reports | Played intervals, revision/date filters, known-viewer history, anonymous totals, 90% coverage completion, coverage/exit charts; browser/API checks passed. Workspace adoption, inventory, processing and provider reports; protected CSV, minimal audit and analytics retention implemented. Million-event synthetic read benchmark passed |
| Branding and calls to action | Branding, linked CTAs and automatic CTA generation | Workspace logos/colors/header/footer/credit, preview, video overrides and revision-pinned timed CTAs. A transcript-based CTA draft needs review and manual publication; no automatic destination inference from the recorded webpage |
| Enterprise governance | SSO/SCIM, audit and retention controls | Email/password, device login, role/video permissions; minimal action log and configurable analytics retention; SSO/SCIM, comprehensive audit suite and custom media retention remain separate |
| Integrations | Collaboration/CRM connections | Nine reviewed-write adapters, encrypted manual/OAuth credentials, refresh and durable outbox. OAuth account and calendar sync paths exist; destination discovery, live qualification, Salesforce and recording imports remain pending |
| Hosting and operation | Managed service, downloadable clients and Enterprise SLA | Self-hosted Docker/PostgreSQL/filesystem, backup/restore, health checks; source-only Mac distribution, signing/notarization pending, no hosted service or SLA |

Relay defaults to verified local Mac Parakeet when ready, otherwise private-server Parakeet. External speech requires an explicitly selected, tested, versioned provider configuration. Its server owner selects Gemini AI Studio, Vertex AI, OpenAI, Anthropic, or OpenRouter for transcript-based generation. There is no automatic provider fallback. Hosting and selected AI-provider costs remain yours.

Windows, Chrome, iOS/Android, rich agent-context capture, automatic meeting capture/provider recording imports, remaining native presentation tools and full integration scope remain unfinished. Transcript agent drafts, local recap automation, revision presentation and reviewed connector delivery now cover useful portions of those workstreams. Enterprise SSO/SCIM and custom media retention remain a separate follow-up. Meeting qualification constraints are tracked in [MEETING-CAPABILITIES.md](MEETING-CAPABILITIES.md); no autonomous meeting recorder is currently qualified.

## What remains before a premium-parity claim

Use the [roadmap](ROADMAP.md#premium-capability-gap-work) to sequence the work. A feature row becomes complete only after its supported platforms, access rules, failure handling, and real-user flow are qualified. No overall parity percentage is assigned: a tested adapter, an experimental algorithm, a missing recorder platform, and a commercial service commitment are not comparable units.

The largest remaining software gaps are cross-platform capture, agent/bug-report visual context, MCP and video Q&A, meeting capture/import and recap delivery, video personalization, enterprise identity/retention, connector live qualification/discovery, and remaining native presentation tools. Existing AI writing, cleanup, speech, and connector behavior also need live quality and reliability evidence. Paid Loom features can be targets for the free core; they must not be advertised as present until implemented and verified.

## Sources and evidence

- [Loom pricing and Enterprise feature matrix](https://www.atlassian.com/software/loom/pricing): plan inclusion, recording/editing, sharing, collaboration, analytics, governance, integrations, and SLA.
- [Loom AI feature guide](https://support.atlassian.com/loom/docs/loom-ai-features/): generated content, editing, CTA and recording modes. Auto titles are included on all plans; do not present them as exclusively paid.
- [Atlassian recording platform documentation](https://support.atlassian.com/loom/docs/the-loom-recording-platforms/): platform availability and differences.
- [Loom for agents](https://www.atlassian.com/software/loom/agents): context-rich agent prompts, Atlassian MCP, and Rovo search/chat; availability and credit terms vary.
- [Loom developer-context capture](https://support.atlassian.com/loom/docs/capture-console-and-network-logs/): browser device and log capture; features marked as still under development are not counted as available.
- [Recent Loom product investments](https://support.atlassian.com/loom/docs/looms-recent-product-investments/): video variables and other recent additions.
- Relay: [implementation contract](IMPLEMENTATION.md), [validation and release gates](VALIDATION.md), [native validation](../apps/macos/IMPLEMENTATION.md), and [worker validation](../services/worker/VALIDATION.md).
