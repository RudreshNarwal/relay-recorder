CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS instance_admins (user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS workspaces (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS memberships (workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE, user_id text REFERENCES "user"(id) ON DELETE CASCADE, role text NOT NULL CHECK(role IN ('owner','admin','member')), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS invites (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, email text NOT NULL, role text NOT NULL CHECK(role IN ('admin','member')), token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL, accepted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS folders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name text NOT NULL, parent_id uuid REFERENCES folders(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS videos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 owner_id text NOT NULL REFERENCES "user"(id), title text NOT NULL, description text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','processing','ready','failed','canceled')),
 duration double precision NOT NULL DEFAULT 0 CHECK(duration>=0), folder_id uuid REFERENCES folders(id) ON DELETE SET NULL, archived boolean NOT NULL DEFAULT false,
 transcription_mode text NOT NULL DEFAULT 'server_api' CHECK(transcription_mode IN ('on_device','server_api')), visibility text NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','workspace','unlisted','password','shared')),
 initial_revision_id uuid, published_revision_id uuid, mime_type text, error text, finalized_manifest jsonb,
 deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,client_id)
);
CREATE INDEX IF NOT EXISTS videos_workspace ON videos(workspace_id,created_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS upload_parts (video_id uuid REFERENCES videos(id) ON DELETE CASCADE, part_index integer NOT NULL CHECK(part_index>=0), sha256 text NOT NULL CHECK(length(sha256)=64), size integer NOT NULL CHECK(size>0 AND size<=8388608), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(video_id,part_index));
CREATE TABLE IF NOT EXISTS revisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','ready','failed')), edit jsonb NOT NULL DEFAULT '{"clips":[],"blurs":[]}', duration double precision NOT NULL DEFAULT 0, error text, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz);
CREATE TABLE IF NOT EXISTS bookmarks (video_id uuid REFERENCES videos(id) ON DELETE CASCADE, user_id text REFERENCES "user"(id) ON DELETE CASCADE, favorite boolean NOT NULL DEFAULT false, watch_later boolean NOT NULL DEFAULT false, PRIMARY KEY(video_id,user_id));
CREATE TABLE IF NOT EXISTS shares (video_id uuid PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE, token text UNIQUE NOT NULL, password_hash text, allow_download boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS video_access (video_id uuid REFERENCES videos(id) ON DELETE CASCADE, email text NOT NULL, PRIMARY KEY(video_id,email));
CREATE TABLE IF NOT EXISTS comments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE, revision_id uuid NOT NULL REFERENCES revisions(id), user_id text NOT NULL REFERENCES "user"(id), body text NOT NULL, timestamp double precision, parent_id uuid REFERENCES comments(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS reactions (video_id uuid REFERENCES videos(id) ON DELETE CASCADE, user_id text REFERENCES "user"(id) ON DELETE CASCADE, emoji text NOT NULL, timestamp double precision, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(video_id,user_id,emoji));
CREATE TABLE IF NOT EXISTS notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, video_id uuid REFERENCES videos(id) ON DELETE CASCADE, body text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS transcripts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE, revision_id uuid NOT NULL UNIQUE REFERENCES revisions(id) ON DELETE CASCADE, language text, segments jsonb NOT NULL DEFAULT '[]', status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','ready','failed')), error text, user_edited boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ai_results (video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE, revision_id uuid NOT NULL REFERENCES revisions(id) ON DELETE CASCADE, title text, summary text, chapters jsonb NOT NULL DEFAULT '[]', action_items jsonb NOT NULL DEFAULT '[]', user_edited jsonb NOT NULL DEFAULT '[]', provider text, model text, status text NOT NULL DEFAULT 'queued', error text, usage jsonb, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(video_id,revision_id));
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK(kind IN ('process','render','transcribe','ai','cleanup')), video_id uuid REFERENCES videos(id) ON DELETE CASCADE, revision_id uuid REFERENCES revisions(id), payload jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed')), attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3, available_at timestamptz NOT NULL DEFAULT now(), locked_at timestamptz, locked_by text, last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(available_at,created_at) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_unique ON jobs(kind,video_id,revision_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS device_logins (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), challenge text NOT NULL, user_id text REFERENCES "user"(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes', consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS device_tokens (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS view_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE, revision_id uuid NOT NULL REFERENCES revisions(id), session_id uuid NOT NULL, viewer_key text NOT NULL, event text NOT NULL CHECK(event IN ('play','progress','complete')), position double precision NOT NULL CHECK(position>=0), duration double precision NOT NULL CHECK(duration>=0), created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS view_events_video ON view_events(video_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS view_events_dedup ON view_events(video_id,revision_id,session_id,event,(floor(position)));
CREATE TABLE IF NOT EXISTS rate_limits (key text PRIMARY KEY, count integer NOT NULL DEFAULT 1, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;

-- Version 2: one immutable ownership key per video revision. Legacy rows may
-- already mix content from different revisions, so archive them without exposing
-- them through application reads. Regeneration creates a clean revision row.
CREATE TABLE IF NOT EXISTS ai_results_legacy (
 video_id uuid PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
 record jsonb NOT NULL, migrated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON ai_results_legacy FROM PUBLIC;
DO $ai_revision_migration$
DECLARE legacy_key text;
BEGIN
 SELECT c.conname INTO legacy_key FROM pg_constraint c
 JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
 WHERE c.conrelid='ai_results'::regclass AND c.contype='p'
 AND array_length(c.conkey,1)=1 AND a.attname='video_id';
 IF legacy_key IS NOT NULL THEN
  INSERT INTO ai_results_legacy(video_id,record)
  SELECT video_id,to_jsonb(ai_results) FROM ai_results ON CONFLICT(video_id) DO NOTHING;
  DELETE FROM ai_results;
  EXECUTE format('ALTER TABLE ai_results DROP CONSTRAINT %I',legacy_key);
  ALTER TABLE ai_results ALTER COLUMN revision_id SET NOT NULL;
  ALTER TABLE ai_results ADD PRIMARY KEY(video_id,revision_id);
  ALTER TABLE ai_results DROP CONSTRAINT IF EXISTS ai_results_revision_id_fkey;
  ALTER TABLE ai_results ADD CONSTRAINT ai_results_revision_id_fkey FOREIGN KEY(revision_id) REFERENCES revisions(id) ON DELETE CASCADE;
 END IF;
END
$ai_revision_migration$;
INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;

-- Version 3: admission limits stay fixed for each accepted recording.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS capture_limits jsonb NOT NULL DEFAULT '{"maxUploadBytes":34359738368,"maxDurationSeconds":21600}';
INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;

-- Version 4: source media kind is immutable; playback remains a rendered revision.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS media_kind text NOT NULL DEFAULT 'video' CHECK(media_kind IN ('video','audio'));
INSERT INTO schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;

-- Version 5: explicit, versioned speech selections. Secrets never enter recording DTOs.
CREATE TABLE IF NOT EXISTS transcription_configurations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 provider text NOT NULL CHECK(provider IN ('deepgram','assemblyai','openai')), model text NOT NULL, region text NOT NULL,
 encrypted_key text NOT NULL, enabled boolean NOT NULL DEFAULT false, verified_version integer,
 workspace_ids uuid[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE transcription_configurations ADD COLUMN IF NOT EXISTS test_state jsonb NOT NULL DEFAULT '{}';
ALTER TABLE transcription_configurations ADD COLUMN IF NOT EXISTS test_lease uuid;
ALTER TABLE transcription_configurations ADD COLUMN IF NOT EXISTS test_running_until timestamptz;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS transcription jsonb;
UPDATE videos SET transcription=jsonb_build_object('execution',CASE WHEN transcription_mode='on_device' THEN 'device' ELSE 'server' END,'provider','parakeet') WHERE transcription IS NULL;
ALTER TABLE videos ALTER COLUMN transcription SET DEFAULT '{"execution":"server","provider":"parakeet"}';
ALTER TABLE videos ALTER COLUMN transcription SET NOT NULL;
-- Existing recordings keep their rendered audio; new recordings enhance voice unless the recorder opts out.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS enhance_audio boolean NOT NULL DEFAULT false;
INSERT INTO schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;

-- Version 6: record speech attempts and retain truthful untimed transcripts.
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS text text NOT NULL DEFAULT '';
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS timing text NOT NULL DEFAULT 'segment' CHECK(timing IN ('word','segment','none'));
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS model text;
CREATE TABLE IF NOT EXISTS transcription_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
 video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,revision_id uuid NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
 provider text NOT NULL,model text NOT NULL,configuration_id uuid,configuration_version integer,
 status text NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','ready','failed','superseded')),
 usage jsonb,remote_requests jsonb NOT NULL DEFAULT '[]',error text,
 created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS transcription_attempts_revision ON transcription_attempts(revision_id,created_at);
INSERT INTO schema_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;

-- Version 7: content versions and acoustic cleanup proposals never mutate source media.
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
CREATE OR REPLACE FUNCTION relay_transcript_content_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.segments,NEW.text,NEW.language,NEW.timing,NEW.user_edited) IS DISTINCT FROM ROW(OLD.segments,OLD.text,OLD.language,OLD.timing,OLD.user_edited) THEN
  NEW.version=OLD.version+1;
 ELSE NEW.version=OLD.version;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS transcript_content_version ON transcripts;
CREATE TRIGGER transcript_content_version BEFORE UPDATE ON transcripts FOR EACH ROW EXECUTE FUNCTION relay_transcript_content_version();
CREATE TABLE IF NOT EXISTS cleanup_analyses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
 revision_id uuid NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,transcript_version text,
 language text,status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','ready','failed')),
 suggestions jsonb NOT NULL DEFAULT '[]',error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cleanup_analyses_revision ON cleanup_analyses(revision_id,created_at DESC);
ALTER TABLE cleanup_analyses ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS revision_comment_anchors (
 revision_id uuid NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
 comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
 timestamps double precision[] NOT NULL DEFAULT '{}',PRIMARY KEY(revision_id,comment_id)
);
-- The authoritative job-kind constraint is installed after the additive
-- migrations below. Reapplying an older intermediate constraint would reject
-- jobs introduced by a later schema version.
INSERT INTO schema_migrations(version) VALUES(7) ON CONFLICT DO NOTHING;

-- Version 8: independent revision-scoped workflow drafts and resource-owned jobs.
CREATE TABLE IF NOT EXISTS workflow_templates (
 id text NOT NULL,version integer NOT NULL CHECK(version>0),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 definition jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(id,version)
);
CREATE INDEX IF NOT EXISTS workflow_templates_workspace ON workflow_templates(workspace_id,id,version DESC);
CREATE TABLE IF NOT EXISTS workflow_artifacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
 revision_id uuid NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,transcript_version text,template jsonb NOT NULL,
 requested_by text REFERENCES "user"(id) ON DELETE SET NULL,ai_fingerprint text,provider text,model text,
 status text NOT NULL DEFAULT 'manual' CHECK(status IN ('manual','queued','processing','ready','proposed','failed')),
 draft jsonb NOT NULL,proposal jsonb,version integer NOT NULL DEFAULT 1 CHECK(version>0),user_edited boolean NOT NULL DEFAULT false,
 language text,tone text,usage jsonb,cost numeric,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_artifacts_revision ON workflow_artifacts(video_id,revision_id,created_at DESC);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS resource_key text NOT NULL DEFAULT '';
DROP INDEX IF EXISTS jobs_active_unique;
CREATE UNIQUE INDEX jobs_active_unique ON jobs(kind,video_id,revision_id,resource_key) WHERE status IN ('queued','running');
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('process','render','transcribe','ai','cleanup','analyze_cleanup','workflow','report','delivery'));
INSERT INTO schema_migrations(version) VALUES(8) ON CONFLICT DO NOTHING;

-- Version 9: idempotent played intervals and transactionally updated session summaries.
CREATE TABLE IF NOT EXISTS watch_sessions (
 id uuid PRIMARY KEY,video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
 revision_id uuid NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
 viewer_key text NOT NULL,user_id text REFERENCES "user"(id) ON DELETE SET NULL,
 kind text NOT NULL CHECK(kind IN ('playback','preview')),sequence integer NOT NULL DEFAULT -1,
 last_wall_end double precision NOT NULL DEFAULT 0,summary jsonb NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS watch_sessions_report ON watch_sessions(video_id,revision_id,started_at);
CREATE TABLE IF NOT EXISTS watch_intervals (
 event_id uuid PRIMARY KEY,session_id uuid NOT NULL REFERENCES watch_sessions(id) ON DELETE CASCADE,
 video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,sequence integer NOT NULL,
 digest text NOT NULL,interval jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(session_id,sequence)
);
CREATE INDEX IF NOT EXISTS watch_intervals_retention ON watch_intervals(created_at);
INSERT INTO schema_migrations(version) VALUES(9) ON CONFLICT DO NOTHING;

-- Version 10: protected reports, minimal audit history and provider metering.
CREATE TABLE IF NOT EXISTS report_exports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 requested_by text REFERENCES "user"(id) ON DELETE SET NULL,request jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','ready','failed','expired')),
 csv text CHECK(octet_length(csv)<=10485760),video_ids uuid[] NOT NULL DEFAULT '{}',user_ids text[] NOT NULL DEFAULT '{}',
 row_count integer,error text,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours'
);
CREATE INDEX IF NOT EXISTS report_exports_workspace ON report_exports(workspace_id,requested_by,created_at DESC);
CREATE INDEX IF NOT EXISTS report_exports_expiry ON report_exports(expires_at) WHERE csv IS NOT NULL;
CREATE TABLE IF NOT EXISTS audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
 actor_id text REFERENCES "user"(id) ON DELETE SET NULL,action text NOT NULL,object_type text NOT NULL,object_id text NOT NULL,
 result text NOT NULL DEFAULT 'success' CHECK(result='success'),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_workspace ON audit_events(workspace_id,id DESC);
CREATE TABLE IF NOT EXISTS ai_usage (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
 video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,attempt integer NOT NULL,
 provider text NOT NULL,model text NOT NULL,usage jsonb,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(job_id,attempt)
);
CREATE INDEX IF NOT EXISTS ai_usage_video ON ai_usage(video_id,created_at);
CREATE INDEX IF NOT EXISTS watch_sessions_revision_report ON watch_sessions(revision_id,started_at);
CREATE INDEX IF NOT EXISTS watch_sessions_user_report ON watch_sessions(user_id,started_at);
CREATE INDEX IF NOT EXISTS watch_sessions_retention ON watch_sessions(started_at);
CREATE INDEX IF NOT EXISTS view_events_retention ON view_events(created_at);
CREATE INDEX IF NOT EXISTS videos_workspace_cursor ON videos(workspace_id,id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS revisions_video_cursor ON revisions(video_id,id) WHERE status='ready';
CREATE INDEX IF NOT EXISTS jobs_video_report ON jobs(video_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_report_active ON jobs(resource_key) WHERE kind='report' AND status IN ('queued','running');
INSERT INTO schema_migrations(version) VALUES(10) ON CONFLICT DO NOTHING;

-- Version 11: private raster logos, bounded branding and revision-pinned CTAs.
CREATE TABLE IF NOT EXISTS brand_assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 bytes bytea NOT NULL CHECK(octet_length(bytes)<=2000000),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brand_assets_workspace ON brand_assets(workspace_id,created_at);
CREATE TABLE IF NOT EXISTS workspace_branding (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,settings jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS video_presentation (
 video_id uuid PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,revision_id uuid NOT NULL REFERENCES revisions(id),
 settings jsonb NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cta_events (
 event_id uuid PRIMARY KEY,video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,revision_id uuid NOT NULL REFERENCES revisions(id),
 presentation_version integer NOT NULL,cta_id uuid NOT NULL,session_id uuid NOT NULL,viewer_key text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('impression','click')),digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(video_id,revision_id,presentation_version,cta_id,session_id,viewer_key,kind)
);
CREATE INDEX IF NOT EXISTS cta_events_report ON cta_events(video_id,revision_id,created_at);
CREATE INDEX IF NOT EXISTS cta_events_retention ON cta_events(created_at);
INSERT INTO schema_migrations(version) VALUES(11) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS cta_daily (
 video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,revision_id uuid NOT NULL REFERENCES revisions(id),
 presentation_version integer NOT NULL,cta_id uuid NOT NULL,day date NOT NULL,impressions integer NOT NULL DEFAULT 0,clicks integer NOT NULL DEFAULT 0,
 PRIMARY KEY(video_id,revision_id,presentation_version,cta_id,day)
);
CREATE INDEX IF NOT EXISTS cta_daily_retention ON cta_daily(day);

-- Version 12: opt-in, owner-draft meeting recaps. Additive; legacy clients are unchanged.
CREATE TABLE IF NOT EXISTS meeting_recap_rules (
 video_id uuid PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
 requested_by text REFERENCES "user"(id) ON DELETE SET NULL,
 enabled boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meeting_recap_runs (
 video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
 revision_id uuid NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
 artifact_id uuid NOT NULL REFERENCES workflow_artifacts(id) ON DELETE CASCADE,
 PRIMARY KEY(video_id,revision_id)
);
INSERT INTO schema_migrations(version) VALUES(12) ON CONFLICT DO NOTHING;

-- Version 13: encrypted, explicitly configured destinations and a durable reviewed outbox.
CREATE TABLE IF NOT EXISTS connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 provider text NOT NULL,name text NOT NULL,audience text NOT NULL,destination jsonb NOT NULL,
 encrypted_token text NOT NULL,version integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disconnected')),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connections_workspace ON connections(workspace_id,created_at);
CREATE TABLE IF NOT EXISTS deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,revision_id uuid NOT NULL REFERENCES revisions(id),
 artifact_id uuid NOT NULL REFERENCES workflow_artifacts(id) ON DELETE CASCADE,artifact_version integer NOT NULL,
 connection_id uuid NOT NULL REFERENCES connections(id),connection_version integer NOT NULL,
 actor_id text REFERENCES "user"(id) ON DELETE SET NULL,idempotency_key uuid NOT NULL,
 access_digest text NOT NULL,draft jsonb NOT NULL,status text NOT NULL DEFAULT 'queued'
 CHECK(status IN ('queued','sending','sent','failed','uncertain','canceled')),
 external_id text,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS deliveries_artifact ON deliveries(artifact_id,created_at DESC);
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('process','render','transcribe','ai','cleanup','analyze_cleanup','workflow','report','delivery'));
INSERT INTO schema_migrations(version) VALUES(13) ON CONFLICT DO NOTHING;

-- Version 14: optional OAuth grants. Existing scoped-token destinations remain valid.
CREATE TABLE IF NOT EXISTS oauth_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,kind text NOT NULL,app_version integer NOT NULL,
 version integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disconnected','reconnect_required')),
 encrypted_access_token text NOT NULL,encrypted_refresh_token text,expires_at timestamptz,scopes jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),error text
);
CREATE INDEX IF NOT EXISTS oauth_accounts_workspace ON oauth_accounts(workspace_id,user_id);
CREATE TABLE IF NOT EXISTS oauth_attempts (
 state_hash text PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,kind text NOT NULL,app_version integer NOT NULL,
 browser_hash text NOT NULL,encrypted_verifier text NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS oauth_attempts_expiry ON oauth_attempts(expires_at);
ALTER TABLE connections ADD COLUMN IF NOT EXISTS oauth_account_id uuid REFERENCES oauth_accounts(id);
INSERT INTO schema_migrations(version) VALUES(14) ON CONFLICT DO NOTHING;

ALTER TABLE connections ADD COLUMN IF NOT EXISTS oauth_resource_id text;

-- Calendar details belong to the consenting user; workspace role alone grants no access.
CREATE TABLE IF NOT EXISTS calendar_sync (
 account_id uuid PRIMARY KEY REFERENCES oauth_accounts(id) ON DELETE CASCADE,
 cursor jsonb,full_synced_at timestamptz,synced_at timestamptz,
 next_at timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 0,
 error text
);
CREATE TABLE IF NOT EXISTS meeting_instances (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
 external_id text NOT NULL,title text NOT NULL,starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,
 join_url text,provider text,all_day boolean NOT NULL DEFAULT false,canceled boolean NOT NULL DEFAULT false,
 generation integer NOT NULL DEFAULT 1,selected_generation integer,
 updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(account_id,external_id)
);
CREATE INDEX IF NOT EXISTS meeting_instances_schedule ON meeting_instances(starts_at) WHERE selected_generation IS NOT NULL;
INSERT INTO schema_migrations(version) VALUES(15) ON CONFLICT DO NOTHING;
-- Email notifications use the in-app notification row as a durable outbox. Existing rows are never emailed.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'comment' CHECK(kind IN ('comment','view'));
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS detail text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS email_state text NOT NULL DEFAULT 'none' CHECK(email_state IN ('none','pending','sent','skipped','failed'));
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS email_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS email_next_at timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS email_error text;
CREATE INDEX IF NOT EXISTS notifications_email_due ON notifications(email_next_at) WHERE email_state='pending';
CREATE INDEX IF NOT EXISTS notifications_view_cap ON notifications(video_id,created_at) WHERE kind='view';
CREATE TABLE IF NOT EXISTS notification_preferences (user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE, comment_email boolean NOT NULL DEFAULT true, view_email boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now());
