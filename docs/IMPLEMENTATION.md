# Relay implementation contract

Original implementation: native macOS 15+ Apple Silicon recorder, Next.js web workspace, PostgreSQL, filesystem media, FFmpeg worker, local/API Parakeet v3, and server-owner cloud AI selection (AI Studio, Vertex, OpenAI, Anthropic, OpenRouter). The public [roadmap](ROADMAP.md) adds recorder platforms, workflows, meetings, analytics, branding, and integrations. SSO/SCIM and custom media retention remain separate follow-ups; billing remains excluded. Planned expansion features are not implied to be implemented by this contract.

## Ownership
- Root: packages/core, Next API route, database migrations, root dependencies, deployment and integration tests.
- Native agent: apps/macos only, native packaging script there.
- Web agent: apps/web/app and components, except app/api (root owns); UI tests under tests/ui*.
- Worker agent: services/worker, services/asr, tests/worker*, tests/asr*.

## HTTP contract
All application endpoints use /api/v1. JSON successful responses are objects below; errors {error:string,code?:string}, with meaningful HTTP status. Browser cookies via Better Auth /api/auth/*; native Authorization: Bearer <device token>. IDs UUID except Better Auth user IDs are text. API timestamps ISO8601. Time offsets in seconds (number), upload part index starts 0. Client response data uses camelCase.

GET /me -> {user:{id,name,email,isAdmin},workspaces:Workspace[]}
POST /workspaces {name} -> {workspace}; GET/PATCH /workspaces/:id; GET /workspaces/:id/members -> {members}; POST /workspaces/:id/invites {email,role:'admin'|'member'} -> {invite:{token,url,expiresAt}}; POST /invites/:token/accept; PATCH/DELETE /workspaces/:id/members/:userId.
GET /folders?workspaceId= -> {folders}; POST /folders {workspaceId,name,parentId?}; PATCH/DELETE /folders/:id.
GET /videos?workspaceId=&q=&folderId=&filter=all|favorites|watch-later|archived -> {videos:Video[]}
POST /recordings {clientId:UUID,workspaceId,title,transcriptionMode:'on_device'|'server_api',mimeType?} -> {video:Video,upload:{id,partSize:8388608,receivedParts:number[]}}
PUT /recordings/:id/parts/:index application/octet-stream, X-Content-SHA256 required -> {index,sha256,size}. At most 8MiB/part.
GET /recordings/:id -> {video,upload:{id,partSize,receivedParts}}
POST /recordings/:id/finalize {parts:[{index,sha256,size}],duration?,mimeType:'video/mp4'|'video/quicktime'|'video/webm'} -> {video}. Input is contiguous chunks of ONE media file; native can upload growing file bytes, finalization only after recording stops. Idempotent finalize.
DELETE /recordings/:id cancels incomplete session; local file removal requires explicit user action.
GET /videos/:id -> {video,transcript:Transcript|null,comments:Comment[],revisions:Revision[],ai:AIResult|null,permissions:{edit:boolean},share:Share|null}
PATCH /videos/:id {title?,description?,folderId?,archived?,favorite?,watchLater?}; DELETE /videos/:id.
GET /videos/:id/media/:asset where asset=playback.mp4|thumbnail.jpg|waveform.json|captions.vtt|captions.srt|hls/index.m3u8|hls/<segment>.ts. Public viewers only access published revision; range requests supported. Share token query ?share=... and unlock cookie carry permission. Original assets never public.
GET /videos/:id/export -> MP4 download (same auth).
POST /videos/:id/revisions {clips:[{videoId,revisionId?,start,end}],blurs:[{start,end,x,y,width,height}],thumbnailTime?:number} -> {revision}. Rect coordinates 0..1. Async render; version publish happens on success. GET /videos/:id/revisions -> {revisions}; POST /videos/:id/revisions/:revisionId/publish. Include expectedRevisionId in edit request to detect stale editors.
POST /videos/:id/share {visibility:'private'|'workspace'|'unlisted'|'password'|'shared',password?,emails?:string[],allowDownload?:boolean} -> {share:{token,url,visibility,allowDownload}}; DELETE rotates/revokes token; GET /shares/:token -> video detail; POST /shares/:token/unlock {password}. UI routes /share/:token and /embed/:token.
POST /videos/:id/comments {body,timestamp?,parentId?,revisionId?}; PATCH/DELETE /comments/:id; POST /videos/:id/reactions {emoji,timestamp?}; DELETE /videos/:id/reactions/:emoji.
GET /notifications -> {notifications}; POST /notifications/:id/read.
POST /videos/:id/events {sessionId:UUID,event:'play'|'progress'|'complete',position,duration,revisionId?}; GET /videos/:id/analytics -> {views,uniqueViewers,completionRate,timeline:[{second,views}]} (editor only).
GET /videos/:id/transcript -> {transcript}; PUT /videos/:id/transcript {revisionId,source?:'manual'|'on_device',segments:[{start,end,text,words?:[{start,end,text}]}],language?}; POST /videos/:id/transcribe {mode:'server_api'}.
POST /videos/:id/ai {regenerate?:boolean}; PATCH /videos/:id/ai {title?,summary?,chapters?,actionItems?} marks user-edited fields; AI generation must preserve them.
GET /admin/ai -> {settings:{provider,model,project?,location?,configured,enabled}}; PUT /admin/ai {provider:'google'|'vertex'|'openai'|'anthropic'|'openrouter',model,apiKey?,project?,location?,enabled}; POST /admin/ai/test -> {ok,message}. Only bootstrap-designated instance admin.
POST /device/start {challenge:string} -> {id,verificationUrl,expiresAt}; browser GET /device?id=... presents approval; authenticated POST /device/approve {id}; POST /device/exchange {id,verifier} -> {token,user} or 202 while pending. SHA256 base64url challenge, one-use code, 5-minute expiry. DELETE /device/session revokes current token.
GET /health -> {ok,database,storage}; GET /admin/jobs -> {jobs}; POST /admin/jobs/:id/retry.

## API DTOs
Workspace {id,name,role}; Folder {id,workspaceId,name,parentId}; Video {id,clientId,workspaceId,ownerId,title,description,status:'uploading'|'processing'|'ready'|'failed'|'canceled',duration,createdAt,updatedAt,folderId,archived,favorite,watchLater,publishedRevisionId,transcriptionMode,thumbnailUrl,playbackUrl,visibility,error?}. Revision {id,videoId,status,createdAt,duration,edit:{clips,blurs,thumbnailTime?}}. Transcript {id,videoId,revisionId,language,segments,status,error?}. Comment {id,videoId,userId,userName,body,timestamp,revisionId,parentId,createdAt}. AIResult {title,summary,chapters:[{start,title}],actionItems:string[],provider,model,status,userEdited:string[],error?}.

## Database/worker contract
pg Pool from packages/core/src/db.ts: db(), query<T>(sql,params?), transaction(callback). Worker claims jobs via FOR UPDATE SKIP LOCKED with lease heartbeat. Tables in packages/core/schema.sql are source of truth. Table snake_case fields; JSONB edits/segments/payload. jobs {id,kind:'process'|'render'|'transcribe'|'ai'|'cleanup',video_id,revision_id,payload,status:'queued'|'running'|'done'|'failed',attempts,max_attempts,available_at,locked_at,locked_by,last_error,created_at,updated_at}. Worker must guard successful publication against deleted videos/superseded revisions.
Storage DATA_DIR default ./data; videoRoot(id), revisionRoot(videoId,revisionId), uploadRoot(id), safeAssetPath(root,relative) exported by packages/core/src/storage.ts. Source lives <DATA_DIR>/videos/<videoId>/original/source.<ext>. Each revision has playback.mp4, thumbnail.jpg, waveform.json, captions.vtt/srt, hls/index.m3u8. Upload chunks <DATA_DIR>/uploads/<videoId>/<index>.part. Finalize queues process with payload {parts,mimeType}. Original never removed automatically. New base revision precreated in videos.published_revision_id? No: process job carries revision_id for initial revision; publish only after ready. Native incoming transcript may target initial revision ID returned by recording creation as video.initialRevisionId.
AI config encryption functions encryptSecret/decryptSecret in packages/core/src/secrets.ts; settings table key 'ai', value JSON config includes encryptedApiKey. AI worker reads settings, not browser input. Credentials never logged. API provider integration belongs worker src/ai.ts; export testAIConnection(config) for server. No silent fallback.
Parakeet API service POST /transcribe multipart audio WAV -> {language?,segments:[{start,end,text,words?}]} protected INTERNAL_API_TOKEN, GET /health. Bind only internal/private interface. Models pinned/cached. Worker prepares 16k mono WAV, invokes service, normalizes times; no speech cloud calls. On-device uploads skip server transcription if already supplied.

## Lifecycle invariants
Stable UUID before network. Separate capture/upload/process/publish. Idempotent part digests and finalization; authenticated ownership. Never delete unacknowledged local media. Auth guards every media request. Non-editors only published revision. Edits reference accessible source videos and preserve originals. AI sends transcript text only, credentials admin-only. Timestamp revisions immutable; edits remap transcript/captions. Bounded upload limits/retries/concurrency. Tests must exercise access isolation and actual file/FFmpeg paths.

Device transcript ingestion is independent of media finalization. `source:on_device` accepts only the recording’s initial revision, is idempotent, and preserves manual corrections. Native journals track transcript sync separately from media acknowledgments.

## Audio and capacity expansion

`GET /capabilities` requires authentication and returns current admission limits and enabled features without secrets. Recording upload state includes `maxUploadBytes` and `maxDurationSeconds`, snapshotted on creation. Parts stay 8 MiB. Legacy recordings retain 32 GiB/six-hour defaults; operator settings affect new sessions only.

Creation accepts optional `mediaKind:'video'|'audio'` (default video); the DTO reports the original source kind. Audio accepts `audio/mp4` (AAC) and `audio/webm` (Opus). The worker checks actual streams and duration; MIME labels cannot override file inspection. Originals stay immutable/private. Audio derives a Relay-colored waveform canvas as normal MP4/HLS, with existing transcript, revision, caption, sharing, and export paths. Mixed audio/video edits remain supported; `mediaKind` describes the original source, not every clip in later revisions.
