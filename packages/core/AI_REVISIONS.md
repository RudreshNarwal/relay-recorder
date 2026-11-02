# Revision-owned AI notes

Schema version 2 keys `ai_results` by `(video_id, revision_id)`. Publishing a revision selects only its own notes. Generating notes for a new revision creates a new, empty row; regeneration preserves only edits recorded for that same revision. Previous rows remain available when their revision is published again.

The previous schema keyed notes only by video and could relabel older text with a newer revision ID. That makes the provenance of existing rows ambiguous. The migration snapshots each legacy row, including nullable revision IDs and human edits, into `ai_results_legacy.record`, then initializes the live revision-keyed table without copying ambiguous text. The archive has no application HTTP reader and is reserved for direct database-owner recovery. Regenerate notes after migrating; archived text is never returned by normal video or share reads.

`pnpm migrate` applies this migration within the existing schema transaction. It detects the old primary key, so applying it again leaves current revision rows and human edits untouched. Tests cover both legacy snapshot preservation and repeated migration after new edits.

`AIResult` now includes `revisionId`. `POST /api/v1/videos/:id/ai` accepts optional `expectedRevisionId` and `regenerate`; its transaction locks and checks the published revision. `PATCH` requires `expectedRevisionId` alongside changed fields. Missing preconditions return 428; stale published revisions return 409. The web editor captures the AI revision when its modal opens. Revision metadata is excluded from `userEdited`.

The worker fences success, failure and lease recovery updates by both video and revision. It also checks the transcript's exact `updated_at` version before saving generation. A transcript changed during an in-flight request causes a retry instead of publishing notes derived from the earlier text.

Before calling a provider, the worker records its provider/model and `processing` status, clears usage from the previous attempt, and pins a hash of the stored settings in the job payload. Plaintext credentials are never persisted there. A retry encountering changed settings fails with a configuration-change error instead of silently choosing another provider, model, project, or key. Authentication failures retain the attempted provider/model and failed status without exposing the provider response body.
