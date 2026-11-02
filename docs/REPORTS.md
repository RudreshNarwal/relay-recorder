# Workspace reports and analytics retention

Workspace owners/admins open **Reports** in the sidebar. Ordinary members use Insights on recordings they own. Existing workspace policy allows owners/admins to administer private workspace recordings; reports do not invent a stronger owner-only privacy boundary. Cross-workspace access is denied.

Reports use UTC and date ranges of at most 90 days. Cursor pagination is stable by immutable object ID; each page is a current read, not a frozen multi-page snapshot.

| Report | Meaning |
|---|---|
| Viewer engagement | Sessions started in range, grouped by ready revision; includes current publication flag, views, known/anonymous viewers, watch/rewatch seconds and 90% unique-coverage completion. Uses the same calculations as per-video Insights. |
| Team adoption | Current members, role and join date, recordings created and eligible playback sessions in range. Active means either activity; it does not mean login or attendance. |
| Recording inventory | Non-deleted recordings created in range; source upload bytes, duration, status, visibility and current publication. Source bytes exclude rendered files and are not a filesystem quota measurement. |
| Processing diagnostics | Video jobs created in range, state, attempt budget and expired-lease signal. Provider error bodies and job payloads are excluded. |
| Provider usage | Known returned language-model attempts and speech attempts in range. Model/provider and available tokens/audio seconds only; unknown usage/cost remains blank. Not a provider invoice or proof that every interrupted request was unbilled. Older generations predate metering. |

Each page is limited to 100 rows. Engagement pages read at most 10,000 session summaries; larger requests explicitly ask for a smaller date range/page. Raw events are never scanned to reconstruct reports.

CSV exports use the existing durable worker queue. Limits: 5,000 rows, 10 MB, 25 seconds, ten requests/user/hour, three pending exports/user/workspace. CSV snapshots live in PostgreSQL and expire 24 hours after request. Formula-like strings are prefixed with an apostrophe and all values are quoted. Downloads require the requesting account's current owner/admin membership. Membership revocation, deleted recordings and deleted/removed user dependencies invalidate access. Creation, final publication and download recheck permissions. Publication and job completion commit together. Files are never exposed by public static URLs.

Audit history records successful report requests/downloads, membership changes/removal, accepted invitations, sharing changes/revocation and video deletion. Rows contain actor/object IDs, fixed action names and timestamps, with no arbitrary metadata, passwords, keys, tokens, URLs or transcript text. Deleted actors become null. It starts with this release; it is not a retroactive or comprehensive Enterprise security audit suite. Instance retention changes are recorded with no workspace scope. Audit history currently has no automatic expiry; operator backup/deletion policy applies.

Instance owners can configure **analytics** retention: 90 days of raw interval/legacy events and 13 months of session aggregates by default. Ranges are 1–365 days and 1–36 months; aggregate retention must cover raw retention. Aggregate summaries retain pseudonymous/known viewer attribution for permitted reports. The worker performs a bounded sweep each minute under a database advisory lock: 10,000 raw events/type, 1,000 aggregate sessions and 1,000 expired exports/pass. Backlogs drain over multiple passes. Expired exports cannot be downloaded while awaiting byte cleanup. Sweep failures appear in worker logs. Media originals, edits, captions and recording journals are never affected. Custom media retention and SSO/SCIM remain separate follow-up work.

## Verification and scale

Automated checks cover cross-workspace/member denial, queued and downloaded exports after revocation, deleted users/videos, formula injection, pagination, revision engagement and retention boundaries. Chromium covers filtering, paging, export preparation and the protected download link. UI screenshots use fixture data.

The opt-in benchmark creates and drops only a randomly named isolated database:

```sh
RELAY_REPORT_PERF=1 node --env-file-if-exists=.env --import tsx scripts/benchmark-reports.ts
```

Reference: Apple M4, 16 GiB host RAM, Docker PostgreSQL 17.11. One million synthetic raw intervals, 1,000 fully watched session summaries and one revision. Five engagement reads: **42, 9, 9, 11, 12 ms**; totals matched the reference. Session/sequence lookup used its unique index, **0.24 ms** execution. Fixture loading has a separate 180-second budget; measured queries retain the normal 30-second budget. This measures report reads at that data shape, not API ingestion throughput, concurrent customers, or a production SLA. Multi-workspace/high-session workloads still need deployment-specific sizing.

`report_exports`, `audit_events` and `ai_usage` are ordinary PostgreSQL tables included in the existing database backup. Treat dumps as private: they can contain CSV names, emails and content titles. Restore the whole consistent database with its users, memberships, videos and schema migrations. Report links still expire at their original timestamps after restore; the worker cleans expired bytes. Never publish a dump or export directory.
