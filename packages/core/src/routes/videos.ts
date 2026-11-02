import {presentationSchema,validatePresentation} from '../presentation';
import {videoBrand} from './branding';
import {audit} from '../audit';
import {recordingLimits,captureLimits,validateCaptureLimits} from '../capabilities';
import {z} from 'zod';
import {query,transaction} from '../db';
import {body,fail,json,uuid} from '../http';
import {accessVideo,membership,lockEditableVideo,videoDTO,revisionDTO,transcriptDTO,aiDTO,shareToken} from '../access';
import {requireActor,type Actor} from '../auth';
import {validateClips} from '../policy';
import {revisionComments} from '../annotations';
import {cleanupEditSchema,validateCleanupEdit} from './cleanup';
import {resolveRecordingTranscription,transcriptionSelectionSchema} from '../transcription-config';
const word=z.object({start:z.number().finite().nonnegative(),end:z.number().finite().nonnegative(),text:z.string().max(2000)}).refine(x=>x.end>=x.start,'Invalid timestamps');
const segment=z.object({start:z.number().finite().nonnegative(),end:z.number().finite().nonnegative(),text:z.string().max(20000),words:z.array(word).max(10000).optional()}).refine(x=>x.end>=x.start,'Invalid timestamps');
export async function videoDetail(request:Request,id:string,user:Actor|null){
 const {row,editable}=await accessVideo(request,id,user);const revisionId=row.published_revision_id||(editable?row.initial_revision_id:null);
 const [transcripts,comments,revisions,ais,reactions]=await Promise.all([
  query('SELECT * FROM transcripts WHERE video_id=$1 AND revision_id=$2',[id,revisionId]),
  revisionComments(id,revisionId),
  editable?query('SELECT * FROM revisions WHERE video_id=$1 ORDER BY created_at DESC',[id]):Promise.resolve([]),
  query('SELECT * FROM ai_results WHERE video_id=$1 AND revision_id=$2',[id,revisionId]),
  query('SELECT emoji,count(*)::int AS count,bool_or(user_id=$2) AS reacted FROM reactions WHERE video_id=$1 GROUP BY emoji',[id,user?.id||null])]);
 const emails=editable?await query<{email:string}>('SELECT email FROM video_access WHERE video_id=$1',[id]):[];
 return {...await videoBrand(row),video:videoDTO(row,shareToken(request)),transcript:transcriptDTO(transcripts[0]),comments,reactions,revisions:revisions.map(revisionDTO),ai:aiDTO(ais[0]),permissions:{edit:editable,download:editable||row.allow_download!==false},share:editable&&row.share_token?{token:row.share_token,url:`/share/${row.share_token}`,visibility:row.visibility,allowDownload:row.allow_download,emails:emails.map(x=>x.email)}:null};
}
export async function videos(request:Request,parts:string[],user:Actor|null):Promise<Response|null>{
 if(parts[0]!=='videos')return null;const method=request.method;const url=new URL(request.url);
 if(parts.length===1&&method==='GET'){
  const u=requireActor(user),workspaceId=uuid(url.searchParams.get('workspaceId')||undefined),role=await membership(workspaceId,u);
  const filter=url.searchParams.get('filter')||'all';const folder=url.searchParams.get('folderId');if(folder)uuid(folder);
  const list=await query(`SELECT v.*,b.favorite,b.watch_later FROM videos v LEFT JOIN bookmarks b ON b.video_id=v.id AND b.user_id=$2
   WHERE v.workspace_id=$1 AND v.deleted_at IS NULL AND v.status<>'canceled'
   AND (v.owner_id=$2 OR $3 OR v.visibility='workspace' OR (v.visibility='shared' AND EXISTS(SELECT 1 FROM video_access a WHERE a.video_id=v.id AND a.email=$4)))
   AND ($5='' OR v.title ILIKE '%'||$5||'%' OR v.description ILIKE '%'||$5||'%' OR EXISTS(SELECT 1 FROM transcripts t WHERE t.revision_id=v.published_revision_id AND (t.segments::text ILIKE '%'||$5||'%' OR t.text ILIKE '%'||$5||'%')))
   AND ($6::uuid IS NULL OR v.folder_id=$6) AND v.archived=$7
   AND ($8<>'favorites' OR b.favorite=true) AND ($8<>'watch-later' OR b.watch_later=true)
   ORDER BY v.created_at DESC LIMIT 200`,[workspaceId,u.id,['owner','admin'].includes(role),u.emailVerified?u.email.toLowerCase():null,(url.searchParams.get('q')||'').slice(0,200),folder,filter==='archived',filter]);return json({videos:list.map(v=>videoDTO(v))});
 }
 const id=uuid(parts[1]);
 if(parts.length===2&&method==='GET')return json(await videoDetail(request,id,user));
 if(parts.length===2&&method==='PATCH'){
  const u=requireActor(user);const input=await body(request,z.object({title:z.string().trim().min(1).max(300).optional(),description:z.string().max(10000).optional(),folderId:z.uuid().nullable().optional(),archived:z.boolean().optional(),favorite:z.boolean().optional(),watchLater:z.boolean().optional()}).strict());
  const changesContent=['title','description','folderId','archived'].some(k=>k in input);const {row}=await accessVideo(request,id,u,changesContent);
  if(input.folderId&&!(await query('SELECT 1 FROM folders WHERE id=$1 AND workspace_id=$2',[input.folderId,row.workspace_id])).length)fail(400,'Folder belongs to another workspace');
  await transaction(async c=>{if(changesContent)await c.query(`UPDATE videos SET title=COALESCE($2,title),description=COALESCE($3,description),folder_id=CASE WHEN $4 THEN $5 ELSE folder_id END,archived=COALESCE($6,archived),updated_at=now() WHERE id=$1`,[id,input.title??null,input.description??null,'folderId'in input,input.folderId??null,input.archived??null]);if('favorite'in input||'watchLater'in input)await c.query(`INSERT INTO bookmarks(video_id,user_id,favorite,watch_later) VALUES($1,$2,$3,$4) ON CONFLICT(video_id,user_id) DO UPDATE SET favorite=CASE WHEN $5 THEN $3 ELSE bookmarks.favorite END,watch_later=CASE WHEN $6 THEN $4 ELSE bookmarks.watch_later END`,[id,u.id,input.favorite??false,input.watchLater??false,'favorite'in input,'watchLater'in input]);});return json(await videoDetail(request,id,u));
 }
 if(parts.length===2&&method==='DELETE'){await accessVideo(request,id,user,true);await transaction(async c=>{const current=await lockEditableVideo(c,id,user);await audit(c,current.workspace_id,user!.id,'video.deleted','video',id);await c.query("UPDATE videos SET deleted_at=now(),updated_at=now() WHERE id=$1",[id]);await c.query("UPDATE jobs SET status='failed',last_error='Video deleted',updated_at=now() WHERE video_id=$1 AND status IN ('queued','running')",[id]);await c.query('DELETE FROM shares WHERE video_id=$1',[id]);await c.query("INSERT INTO jobs(kind,video_id,payload,available_at) VALUES('cleanup',$1,jsonb_build_object('deleteMedia',true),now()+interval '7 days')",[id]);});return json({ok:true});}
 if(parts[2]==='revisions'){
  const {row}=await accessVideo(request,id,user,true);
  if(parts.length===3&&method==='GET')return json({revisions:(await query('SELECT * FROM revisions WHERE video_id=$1 ORDER BY created_at DESC',[id])).map(revisionDTO)});
  if(parts.length===3&&method==='POST'){
   const input=await body(request,z.object({clips:z.array(z.object({videoId:z.uuid(),revisionId:z.uuid().optional(),start:z.number().finite().nonnegative(),end:z.number().finite().positive()})).min(1).max(100),blurs:z.array(z.object({start:z.number().finite().nonnegative(),end:z.number().finite().positive(),x:z.number().min(0).max(1),y:z.number().min(0).max(1),width:z.number().positive().max(1),height:z.number().positive().max(1)})).max(50).default([]),thumbnailTime:z.number().finite().nonnegative().optional(),expectedRevisionId:z.uuid().nullable().optional(),cleanup:cleanupEditSchema.optional(),presentation:presentationSchema.optional()}));
   if(!row.published_revision_id)fail(409,'Wait for video processing before editing');const expected=input.expectedRevisionId??row.published_revision_id;if(expected!==row.published_revision_id)fail(409,'A newer revision is available; reload the editor');
   const durations=new Map<string,number>();const resolved=[];
   for(const clip of input.clips){const source=await accessVideo(request,clip.videoId,user,true);if(source.row.workspace_id!==row.workspace_id)fail(400,'Stitch sources must belong to this workspace');const revisionId=clip.revisionId||source.row.published_revision_id;if(!revisionId)fail(409,'A source video is still processing');const revision=(await query('SELECT * FROM revisions WHERE id=$1 AND video_id=$2 AND status=\'ready\'',[revisionId,clip.videoId]))[0];if(!revision)fail(400,'Source revision is unavailable');validateClips([clip],new Map([[clip.videoId,revision.duration]]));durations.set(clip.videoId,revision.duration);resolved.push({...clip,revisionId});}
   const duration=input.clips.reduce((n,c)=>n+c.end-c.start,0);if(duration>captureLimits().maxDurationSeconds)fail(400,'Video exceeds the server duration limit');
   for(const blur of input.blurs)if(blur.end<=blur.start||blur.end>duration||blur.x+blur.width>1||blur.y+blur.height>1)fail(400,'Blur region or time is outside the edited video');if((input.thumbnailTime||0)>duration)fail(400,'Thumbnail is outside the edited video');
   if(input.presentation)try{validatePresentation(input.presentation,duration);}catch(error){fail(400,(error as Error).message);}
   const edit={...input,clips:resolved,expectedRevisionId:expected,limits:captureLimits()};const revision=await transaction(async c=>{const current=(await c.query('SELECT published_revision_id FROM videos WHERE id=$1 FOR UPDATE',[id])).rows[0];if(current.published_revision_id!==expected)fail(409,'A newer revision is available');if(input.cleanup)await validateCleanupEdit(c,input.cleanup,id,expected);const r=(await c.query('INSERT INTO revisions(video_id,edit,duration) VALUES($1,$2,$3) RETURNING *',[id,JSON.stringify(edit),duration])).rows[0];await c.query("INSERT INTO jobs(kind,video_id,revision_id,payload) VALUES('render',$1,$2,$3)",[id,r.id,JSON.stringify({expectedRevisionId:expected})]);return r;});return json({revision:revisionDTO(revision)},202);
  }
  if(parts[4]==='publish'&&method==='POST'){const revisionId=uuid(parts[3]);await transaction(async c=>{await c.query('SELECT id FROM videos WHERE id=$1 FOR UPDATE',[id]);const revision=(await c.query("SELECT * FROM revisions WHERE id=$1 AND video_id=$2 AND status='ready'",[revisionId,id])).rows[0];if(!revision)fail(409,'Revision is not ready');await c.query("UPDATE videos SET published_revision_id=$2,duration=$3,status='ready',updated_at=now() WHERE id=$1",[id,revisionId,revision.duration]);await c.query('UPDATE revisions SET published_at=now() WHERE id=$1',[revisionId]);});return json({ok:true});}
 }
 if(parts[2]==='transcript'){
  const {row,editable}=await accessVideo(request,id,user,method==='PUT');const revisionId=row.published_revision_id||(editable?row.initial_revision_id:null);
  if(method==='GET'){
   const selected=url.searchParams.get('revision');
   if(selected){if(!editable)fail(403,'Only editors may preview revision transcripts');uuid(selected);if(!(await query("SELECT 1 FROM revisions WHERE id=$1 AND video_id=$2 AND status='ready'",[selected,id])).length)fail(404,'Revision is not ready');}
   return json({transcript:transcriptDTO((await query('SELECT * FROM transcripts WHERE video_id=$1 AND revision_id=$2',[id,selected||revisionId]))[0])});
  }
  if(method==='PUT'){
   const input=await body(request,z.object({revisionId:z.uuid(),source:z.enum(['manual','on_device']).default('manual'),segments:z.array(segment).max(50000).default([]),text:z.string().max(1000000).optional(),timing:z.literal('none').optional(),language:z.string().max(40).optional()}),8_000_000);
   const t=await transaction(async c=>{
    const current=(await c.query('SELECT * FROM videos WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!current||current.deleted_at)fail(404,'Video not found');
    if(current.status==='canceled')fail(409,'Recording is canceled');
    const device=input.source==='on_device';if(input.timing==='none'&&(device||input.segments.length||input.text===undefined))fail(400,'Untimed corrections require text and no timed segments');if(input.text!==undefined&&input.timing!=='none')fail(400,'Text-only correction requires untimed mode');
    const target=device?current.initial_revision_id:(current.published_revision_id||current.initial_revision_id);
    if(input.revisionId!==target||(device&&current.transcription_mode!=='on_device'))fail(409,'Transcript belongs to a different revision');
    const revision=(await c.query('SELECT duration,edit FROM revisions WHERE id=$1 AND video_id=$2',[target,id])).rows[0];
    if(!revision)fail(409,'Transcript revision is unavailable');
    const duration=Number(revision.duration)||(target===current.published_revision_id?Number(current.duration):0);
    const limits=validateCaptureLimits(revision.edit?.limits??recordingLimits(current));
    let prior=0;for(const s of input.segments){if(s.start<prior||s.end>limits.maxDurationSeconds||(duration>0&&s.end>duration+1))fail(400,'Transcript timestamps are outside this recording');prior=s.start;let wordPrior=s.start;for(const w of s.words||[]){if(w.start<wordPrior||w.start<s.start||w.end>s.end)fail(400,'Word timestamps are outside their segment');wordPrior=w.start;}}
    const existing=(await c.query('SELECT * FROM transcripts WHERE revision_id=$1 FOR UPDATE',[target])).rows[0];
    if(device&&existing?.user_edited)fail(409,'Manual transcript corrections are preserved','TRANSCRIPT_CORRECTED');
    if(device&&existing?.status==='ready'){
     // JSONB normalizes object key order, so compare structurally in PostgreSQL.
     const same=(await c.query('SELECT segments=$2::jsonb AND language IS NOT DISTINCT FROM $3 AS same FROM transcripts WHERE revision_id=$1',[target,JSON.stringify(input.segments),input.language||null])).rows[0].same;
     if(!same)fail(409,'A different transcript is already available. Edit it in the workspace.','TRANSCRIPT_CHANGED');
     return existing;
    }
    const timing=input.timing??(input.segments.every(s=>s.words?.length)?'word':'segment');
    return(await c.query(`INSERT INTO transcripts(video_id,revision_id,language,segments,status,user_edited,text,timing) VALUES($1,$2,$3,$4,'ready',$5,$6,$7) ON CONFLICT(revision_id) DO UPDATE SET language=EXCLUDED.language,segments=EXCLUDED.segments,text=EXCLUDED.text,timing=EXCLUDED.timing,status='ready',error=NULL,user_edited=EXCLUDED.user_edited,updated_at=now() RETURNING *`,[id,target,input.language||null,JSON.stringify(input.segments),!device,input.text??input.segments.map(s=>s.text).join(' '),timing])).rows[0];
   });return json({transcript:transcriptDTO(t)});
  }
 }
 if(parts[2]==='transcribe'&&method==='POST'){
  const {row}=await accessVideo(request,id,user,true);
  const input=await body(request,z.object({mode:z.literal('server_api').optional(),transcription:transcriptionSelectionSchema.optional(),expectedRevisionId:z.uuid().optional()}));
  const selected=await resolveRecordingTranscription({transcription:input.transcription,transcriptionMode:input.mode},row.workspace_id,requireActor(user));
  if(selected.execution!=='server')fail(400,'This endpoint starts server transcription');
  const revisionId=input.expectedRevisionId??row.published_revision_id;if(!revisionId||revisionId!==row.published_revision_id)fail(409,'The published revision changed or is still processing');
  await transaction(async c=>{
   const current=(await c.query('SELECT published_revision_id,deleted_at,status FROM videos WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(current.deleted_at||current.status==='canceled'||current.published_revision_id!==revisionId)fail(409,'The published revision changed');
   if((await c.query('SELECT user_edited FROM transcripts WHERE revision_id=$1 FOR UPDATE',[revisionId])).rows[0]?.user_edited)fail(409,'Manual corrections are preserved. Automatic transcription cannot replace this corrected transcript.');
   if((await c.query("SELECT 1 FROM jobs WHERE video_id=$1 AND revision_id=$2 AND kind='transcribe' AND status IN ('queued','running')",[id,revisionId])).rowCount)fail(409,'Transcription is already queued or running');
   await c.query("INSERT INTO transcripts(video_id,revision_id,status) VALUES($1,$2,'queued') ON CONFLICT(revision_id) DO UPDATE SET status='queued',error=NULL",[id,revisionId]);
   await c.query("INSERT INTO jobs(kind,video_id,revision_id,payload) VALUES('transcribe',$1,$2,$3)",[id,revisionId,JSON.stringify({transcription:selected,requestedBy:user!.id})]);
  });return json({ok:true},202);
 }
 return null;
}
