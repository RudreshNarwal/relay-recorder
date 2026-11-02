# Playback engagement

Recording editors open **Insights** to select a ready revision and UTC date range, view eligible sessions, signed-in viewer history, anonymous totals, timeline coverage and the last watched section per session. Ranges select sessions whose server receipt start time falls inside the range. Defaults are the published revision and the previous 30 days; a request is bounded to 90 days and 10,000 sessions.

New browser players send adjacent visible playback intervals. Seeks, paused/hidden playback and long stalled ticks break the interval. Speed changes start a new interval. Each event has a UUID, sequence and session/revision identity. Retries keep the same event identity; accepted duplicates add no credit. Owner playback is always classified as preview by the server. Other instrumentation can explicitly send `kind: preview` for internal/test traffic.

| Metric | Definition |
|---|---|
| Playback sessions | Sessions containing eligible played media; owner previews and hidden-only sessions excluded |
| Unique viewers | Signed-in account or video-scoped pseudonymous cookie; no IP/email-domain inference |
| Active watch time | Elapsed wall time capped by played media / speed, merged across simultaneous tabs for each viewer |
| Unique media per viewer, summed | Union of media ranges per viewer, then summed across viewers |
| Repeated media coverage | Repeated media seconds beyond unique coverage; includes duplicate tabs |
| Completion | At least 90% unique timeline coverage per session; a seek to the end is insufficient |
| Timeline coverage | Unique viewers who watched any part of each 1% section |
| Session exits | Final watched section of each eligible session; not a claim that earlier sections were watched |

Anonymous users are reported only in aggregate. Losing/resetting the viewer cookie creates another unknown identity. Client telemetry cannot establish attention or resist deliberate falsification. The server rejects implausible rates, long windows, stale/future timestamps, overlapping sequences, changed event payloads and cross-video/revision/session identities. Clock skew and network failures can undercount playback. Playback remains available when analytics fails.

Raw events and bounded session summaries commit atomically. No background aggregation queue is needed for this per-video read model; worker downtime cannot leave accepted counts stale. The additive `/watch-intervals` and `/engagement` endpoints are described in [OpenAPI](openapi.json). The original `/events` and `/analytics` endpoints remain compatible and explicitly approximate. Historical point events cannot establish watch time or coverage and are displayed separately.

Download/share context reports the current sharing policy; download counts are unavailable. [Workspace reports](REPORTS.md) add adoption/inventory/operations/provider pages, protected CSV, minimal audit, configurable analytics retention and a documented million-event synthetic read benchmark. Raw analytics defaults to 90 days; session aggregates default to 13 months. Bounded worker cleanup enforces this without deleting recording media.

[Calls to action](BRANDING.md) report deduplicated impressions/clicks by CTA and presentation version. CTA daily totals use UTC calendar days intersecting the chosen range; playback metrics use session-start timestamps. Click rate does not prove downstream conversion. Unknown or missing telemetry remains a limitation.

Verification includes hand-calculated seeks, 2× speed, replay, duplicate tabs, hidden/owner playback and lost anonymous identity; PostgreSQL idempotency/ACL/revision cases; Chromium actual-MP4 playback; report/export/revocation/retention cases; and one-million-interval synthetic data. Reference timings and workload limitations are in REPORTS.md.
