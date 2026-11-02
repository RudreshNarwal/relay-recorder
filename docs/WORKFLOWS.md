# Workflow documents

Open a published recording, then **Workflows**. Choose a template, output language and tone. Create a manual draft or generate one from the recording's ready transcript. The server's selected AI provider receives transcript text and template instructions; it receives no screenshots or tools.

Built-in version 1 templates cover SOPs, guides, pull requests, QA plans, code documentation, bug reports, Jira/Linear issues, Slack/Teams messages and email. Workspace owners/admins can create custom templates or save new versions. Existing artifacts retain an immutable template snapshot. Changes to built-in instructions or headings must introduce a new version.

Edit the title and each section, then save. Regeneration preserves human changes and creates a separate proposal. **Compare proposal** shows the saved draft and generated candidate; accepting is explicit. Copy Markdown or export the saved document as Markdown/JSON. Draft generation never sends messages, creates external issues, or executes commands. Reviewed delivery to configured destinations is available through the durable outbox; see [INTEGRATIONS.md](INTEGRATIONS.md). Rich agent-context capture remains pending.

Manual drafts remain usable without cloud credentials. Generation requires a ready nonempty transcript of at most 100,000 characters. The server limits output to 4,096 tokens, 300 title characters, and 15,000 characters per section. Custom templates have 1–20 unique headings. Limits are 100 custom templates per workspace, 30 draft creations per user/hour, 20 generations per user/hour, and 100 generations per workspace/hour. Lists show at most the newest 100 artifacts for the published revision.

Drafts and exports require video-editor permission. Only the current published revision is exposed. Jobs pin the transcript content version, template snapshot and selected AI configuration. Access, settings, transcript and revision are rechecked before generation and publication. A changed configuration requires a fresh generation; retries never switch providers. Generation failures do not change media readiness.

Optimistic draft versions reject conflicting saves. Publication preserves edits made while a provider request runs. Available token usage is recorded on the job even when publication is rejected, and successful generation also exposes usage on the artifact. Cost is null when pricing is unavailable. Provider error messages are redacted. Retries use the existing bounded PostgreSQL job queue and renewable leases.

Schema version 8 adds templates, artifacts and artifact-specific job keys. Existing media-job keys remain unchanged. Back up before deployment. Roll back application images only after draining or disabling workflow jobs; retain the additive schema. An older worker does not understand workflow jobs. Do not remove the tables while drafts or jobs exist.

Verification uses actual SDK adapters with HTTP fixtures for all five providers, isolated PostgreSQL API/race/migration tests, and Chromium editor flows. Live cloud generation and usefulness review require configured provider credentials; none are available in the current validation environment.

A Call to action draft template suggests a label, destination to confirm, timing and reason. Review it before manually publishing a timed link through Presentation. No external link is published by generation.

## Agent prompts and meeting recaps

Two additional built-in templates provide an **Agent implementation prompt** and **Meeting recap**. Agent handoffs include goal, context, steps/evidence, expected results, acceptance criteria and open questions. Recaps separate decisions, actions, evidence and unknowns; they do not invent speaker identities, owners or due dates. Timed transcripts carry the published revision ID and timestamp evidence into generation. Both templates support manual drafts, human corrections, proposal review, copy, Markdown and JSON export.

These are transcript-based documents. Record-for-agents interaction metadata, selected keyframes, structured visual evidence and Chrome/Windows capture hooks remain pending. Neither template executes commands or controls an agent.

The Workflows panel has an explicit per-recording recap switch. When enabled, the worker waits for a ready nonempty transcript and a configured cloud model, then queues one private recap draft per published revision. It uses the same user/workspace generation budgets, deduplicates across workers/restarts, and fences policy changes before generation and publication. Exhausted workspace quotas cannot starve other eligible workspaces. Disabling the rule prevents in-flight results from publishing. Existing drafts remain editable; regeneration stays explicit. Playback and transcription do not depend on recap success.

This is recap automation for an attended recording or uploaded meeting file. Calendar sync, cloud recording retrieval, autonomous meeting capture and automatic recipient delivery remain separate unfinished capabilities; the switch does not join a meeting. Schema 12 adds only rule/run records; originals and prior workflow artifacts remain intact.
