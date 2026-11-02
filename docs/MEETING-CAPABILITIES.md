# Meeting capture qualification

Checked against official documentation on 2026-10-26. No authorized meeting tenant, SDK credentials, test meeting, or Azure Windows runner was supplied. No meeting was joined, recorded, purchased, or messaged. Documentation establishes prerequisites; it does not establish a working adapter.

| Platform | Capture method under evaluation | Runner / architecture | Account scopes and approvals | Permission flow | Tested media | Cost owner | Result |
|---|---|---|---|---|---|---|---|
| Zoom | RTMS; the originally proposed Meeting SDK bot is disqualified | RTMS Node/native runtime; deployment architecture must pass decoding tests | Operator-owned Zoom app, RTMS scopes/entitlement, account authorization and applicable app review; exact scopes depend on selected meeting-start route | Explicit meeting RTMS authorization and host controls; stop on revocation | None | Operator; no paid service enabled | **blocked**: no authorized account/meeting; SDK plan conflicts with current usage policy |
| Google Meet | Official Media API for an already eligible app; permitted visible participant remains an unqualified alternative | Official reference WebRTC client or isolated visible browser; architecture unverified | Eligible Cloud project, OAuth scopes, Workspace admin approval and meeting consent. Official API currently accepts no new signups | Host/org consenter; stop when consent is removed; encrypted/watermarked meetings rejected | None | Operator | **blocked**: no enrolled project or authorized browser-participant feasibility test |
| Microsoft Teams | Official application-hosted media bot | Production Windows Server guest OS in Azure; supported .NET media library/VM architecture requires qualification | Entra application, least-privilege Graph calling/media permissions with tenant admin consent and recording-status policy | Tenant/meeting admission and recording notification; stop on policy denial/removal | None | Operator-owned Azure Windows host | **blocked**: no tenant application, meeting, or runner |

## Evidence and plan correction

The [Zoom Meeting SDK for Linux documentation](https://developers.zoom.us/docs/meeting-sdk/linux/) now states: “The Meeting SDK is designed for human use cases and does not support bots or AI notetakers.” It directs notetakers/realtime media integrations to [Zoom RTMS](https://developers.zoom.us/docs/rtms/). Do not implement the former SDK bot or silently substitute browser automation. RTMS needs a separate authorized account/consent/decoded-output test; it is not automatically equivalent to a participant joining a meeting.

The [Meet Media API overview](https://developers.google.com/workspace/meet/media-api/guides/overview) states: “The Google Meet Media API is no longer accepting new signups.” It documents consent, encryption/watermark restrictions, and stopping a connection after permission changes. A general Cloud project does not establish eligibility. Browser participation cannot be labeled supported without checking provider terms and testing an authorized visible session.

The [Teams media-bot requirements](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots) require production deployment on a Windows Server guest OS in Azure. An additional Linux Compose service cannot satisfy this requirement. An operator-owned Azure runner or a separately chosen managed connector remains a deployment decision.

Retrieved HTML/text evidence is stored under `.context/meeting-feasibility/`; these snapshots are investigation evidence, not redistributed SDKs. The integration plan's original Zoom Linux SDK assumption is superseded by this finding. All three automatic-capture release gates remain open. Attended capture and authorized cloud imports remain separate deliverables and never count as successful bots.

## Required live matrix

Machine-readable cases are in `tests/fixtures/meetings/cases.json`. Run each case per qualified platform and retain: account/tenant configuration without secrets, app/scopes/version, runner OS/architecture, host permission outcome, timestamps, stream IDs, original/decoded media hashes, duration, audio/video drift, interruption recovery, and duplicate-session counts. A case passes only after inspecting decoded output and state transitions. No fixture-only response or calendar event is sufficient.

For a blocked platform, keep controls unavailable with its concrete requirement. Never bypass host admission, recording denial, participant removal, or tenant restrictions. New service purchases, app terms, third-party messages, and public distribution require separate authorization.

## Implemented local recap path

Uploaded or attended meeting recordings can now opt into one private recap draft per published revision after transcription. Users review/edit the recap and may explicitly deliver it through a configured destination. Duplicate scheduling, disabled policies, AI budgets, publication changes and access revocation have automated coverage. This path does not alter the blocked capture qualifications above: no calendar-to-bot flow or provider recording import is claimed.
