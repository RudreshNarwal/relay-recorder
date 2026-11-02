import {presentationSchema} from '@core/presentation';
import {deliver,recoverDeliveries} from './deliveries';
import {buildReport} from './reports';
import {recordAIUsage} from './metering';
import {captureLimits,recordingLimits,validateCaptureLimits,durationLimitMessage} from '@core/capabilities';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { query, transaction } from '@core/db';
import { videoRoot, revisionRoot, uploadRoot, atomicWrite } from '@core/storage';
import { decryptSecret } from '@core/secrets';
import { extractAudioWindow, assembleParts, renderMedia, probe, command, normalizeSegments, captions, PermanentError, type Segment, type Clip } from './media';
import { generateVideoAI,generateCleanupAI,aiConfigurationFingerprint,safeAIError, type AIConfig } from './ai';
import {transcribeAudio,SpeechError,type SpeechCheckpoint} from './transcription';
import {speechCapabilities,type TranscriptionSelection} from '@core/transcription';
import type {SpeechConfiguration} from '@core/transcription-config';
import {canEditVideo} from '@core/policy';
import {analyzeCleanup} from './cleanup';
import {carryRevisionAnnotations} from '@core/annotations';
import {deriveTranscript,captureCaptionSources,type CaptionTranscript} from './revision-transcript';
import {withLease,LEASE_SECONDS} from './lease';
import {generateWorkflow} from './workflows';
import {speechWindows,mergeSpeechOverlap} from './speech/windows';
export type Job={id:string;kind:'process'|'render'|'transcribe'|'ai'|'cleanup'|'analyze_cleanup'|'workflow'|'report'|'delivery';video_id:string;revision_id:string;payload:Record<string,any>;locked_by:string;attempts:number;max_attempts:number};
export function failureDecision(error:unknown,attempt:number,maximum:number){const retry=!(error instanceof PermanentError)&&!(error instanceof SpeechError&&!error.retryable)&&attempt<maximum;return {retry,delaySeconds:retry?Math.min(300,Math.max(10*2**(attempt-1),error instanceof SpeechError?error.retryAfterSeconds:0)):0};}
export function publicationAllowed(video:{deleted_at:unknown;published_revision_id:string|null},expected:string|null){return !video.deleted_at&&video.published_revision_id===expected;}
export async function claimJob(workerId:string,supportedKinds:Job['kind'][]=['process','render','transcribe','ai','cleanup','analyze_cleanup','workflow','report','delivery']):Promise<Job|undefined>{
 const rows=await query<Job>(`WITH next AS (
 SELECT id FROM jobs WHERE (status='queued' AND available_at<=now() OR status='running' AND locked_at<now()-make_interval(secs=>$2)) AND attempts<max_attempts AND kind=ANY($3::text[])
 ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE jobs j SET status='running',attempts=attempts+1,locked_at=now(),locked_by=$1,updated_at=now()
 FROM next WHERE j.id=next.id RETURNING j.*`,[workerId,LEASE_SECONDS,supportedKinds]);return rows[0];
}
async function activeVideo(job:Job){const [video]=await query('SELECT * FROM videos WHERE id=$1 AND deleted_at IS NULL AND status<>\'canceled\'',[job.video_id]);if(!video)throw new PermanentError('Video no longer active');return video;}
async function sourcePath(videoId:string){const root=join(videoRoot(videoId),'original');const names=await readdir(root);const file=names.find(n=>/^source\.(mp4|mov|webm)$/.test(n));if(!file)throw new PermanentError('Original source missing');return join(root,file);}
async function writeCaptions(root:string,segments:Segment[]){await Promise.all([atomicWrite(join(root,'captions.vtt'),captions(segments,'vtt')),atomicWrite(join(root,'captions.srt'),captions(segments,'srt'))]);}
async function transcriptFor(revisionId:string){return (await query('SELECT *,updated_at::text AS transcript_version FROM transcripts WHERE revision_id=$1 AND status=\'ready\'',[revisionId]))[0];}
async function processMedia(job:Job){
 const video=await activeVideo(job);const [revision]=await query('SELECT * FROM revisions WHERE id=$1 AND video_id=$2',[job.revision_id,job.video_id]);if(!revision)throw new PermanentError('Revision missing');
 // Completed publication is idempotent: never replace files already served to viewers.
 if(revision.status==='ready')return;
 const staging=revisionRoot(job.video_id,job.revision_id)+`.${job.locked_by}.tmp`;
 await mkdir(staging,{recursive:true});
 try{
 await query("UPDATE revisions SET status='processing',error=NULL WHERE id=$1 AND status<>'ready'",[job.revision_id]);
 let clips:Clip[]=[];let transcriptSegments:Segment[]=[];let transcriptComplete=false;
 const speechSources:{revisionId:string;start:number;end:number;duration:number}[]=[];
 if(job.kind==='process'){
 const extension=({'video/mp4':'mp4','video/quicktime':'mov','video/webm':'webm','audio/mp4':'mp4','audio/webm':'webm'} as Record<string,string>)[job.payload.mimeType];if(!extension)throw new PermanentError('Unsupported source MIME type');
 const original=join(videoRoot(job.video_id),'original',`source.${extension}`);
 await assembleParts(uploadRoot(job.video_id),original,job.payload.parts,recordingLimits(video));
 const info=await probe(original,recordingLimits(video),video.media_kind??'video');clips=[{path:original,start:0,end:info.duration}];
 }else{
 const edit=revision.edit;
 if(!Array.isArray(edit.clips)||!edit.clips.length)throw new PermanentError('Edit has no clips');
 for(const c of edit.clips){
 const [source]=await query('SELECT * FROM videos WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND status=\'ready\'',[c.videoId,video.workspace_id]);if(!source)throw new PermanentError('Source video unavailable');
 const sourceRevision=c.revisionId??source.initial_revision_id;
 const [sr]=await query("SELECT id,duration FROM revisions WHERE id=$1 AND video_id=$2 AND status='ready'",[sourceRevision,c.videoId]);
 if(!sr)throw new PermanentError('Source revision unavailable');
 const path=c.revisionId?join(revisionRoot(c.videoId,sr.id),'playback.mp4'):await sourcePath(c.videoId);
 clips.push({path,start:c.start,end:c.end});
 speechSources.push({revisionId:sr.id,start:c.start,end:c.end,duration:Number(sr.duration)});
 }
 }
 const recipe=job.kind==='render'&&revision.edit.presentation?presentationSchema.parse(revision.edit.presentation):undefined;
 let burnedVersions=new Map<string,string>();let burnedSegments:Segment[]=[];
 if(recipe?.captions.burnIn){
  let snapshot;try{snapshot=await captureCaptionSources(speechSources,async id=>await transcriptFor(id) as CaptionTranscript|undefined);}catch(error){throw new PermanentError((error as Error).message);}
  burnedVersions=snapshot.versions;
  const speech=deriveTranscript(snapshot.sources);if(speech.status!=='ready'||speech.timing==='none')throw new PermanentError('Caption timing is unavailable for this edit');burnedSegments=speech.segments;
 }
 const result=await renderMedia(clips,staging,job.kind==='render'?revision.edit.blurs??[]:[],revision.edit.thumbnailTime??0,job.kind==='process'?recordingLimits(video):validateCaptureLimits(revision.edit.limits??recordingLimits(video)),recipe?{recipe,segments:burnedSegments}:undefined,job.kind==='process'?(video.enhance_audio?{denoise:true,normalize:true}:undefined):recipe?.audio);
 await withLease(job,async client=>{
 const current=(await client.query('SELECT * FROM videos WHERE id=$1 FOR UPDATE',[job.video_id])).rows[0];if(!current||current.deleted_at||current.status==='canceled')throw new PermanentError('Video no longer active');
 if(job.kind==='process'){const incoming=(await client.query("SELECT * FROM transcripts WHERE revision_id=$1 AND status='ready' FOR UPDATE",[job.revision_id])).rows[0];if(incoming){transcriptComplete=true;transcriptSegments=normalizeSegments(incoming.segments,result.duration);}}
 // Read after rendering, under row locks, so corrections made during rendering
 // are inherited as well. Incomplete derivatives retain their available text.
 let derived:ReturnType<typeof deriveTranscript>|undefined;
 if(job.kind==='render'){
  const sources=[];
  for(const source of speechSources){const transcript=(await client.query('SELECT * FROM transcripts WHERE revision_id=$1 FOR SHARE',[source.revisionId])).rows[0];if(burnedVersions.has(source.revisionId)&&String(transcript?.version)!==burnedVersions.get(source.revisionId))throw new PermanentError('Transcript changed during caption rendering. Render a fresh revision.');sources.push({...source,transcript});}
  derived=deriveTranscript(sources);transcriptComplete=derived.status==='ready';transcriptSegments=derived.timing==='none'?[]:derived.segments;
 }
 await writeCaptions(staging,transcriptComplete?transcriptSegments:[]);
 const destination=revisionRoot(job.video_id,job.revision_id);
 // Only this fenced lease can rename files. A previous attempt's unpublished directory may be replaced.
 await rm(destination,{force:true,recursive:true});await rename(staging,destination);
 await client.query("UPDATE revisions SET status='ready',duration=$2,error=NULL WHERE id=$1",[job.revision_id,result.duration]);
 if(job.kind==='render')await carryRevisionAnnotations(client,job.video_id,job.revision_id,revision.edit.clips);
 if(derived)await client.query("INSERT INTO transcripts(video_id,revision_id,language,segments,status,error,text,timing,user_edited,provider,model) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(revision_id) DO NOTHING",[job.video_id,job.revision_id,derived.language,JSON.stringify(derived.segments),derived.status,derived.error,derived.text,derived.timing,derived.userEdited,derived.provider,derived.model]);
 const expected=job.payload.expectedRevisionId??revision.edit.expectedRevisionId??null;
 if(publicationAllowed(current,expected)){
 await client.query("UPDATE videos SET published_revision_id=$2,status='ready',duration=$3,error=NULL,updated_at=now() WHERE id=$1",[job.video_id,job.revision_id,result.duration]);
 await client.query('UPDATE revisions SET published_at=now() WHERE id=$1',[job.revision_id]);
 }
 if(job.kind==='process'&&video.transcription_mode==='server_api'&&!transcriptComplete)await client.query("INSERT INTO jobs(kind,video_id,revision_id) VALUES('transcribe',$1,$2) ON CONFLICT DO NOTHING",[job.video_id,job.revision_id]);
 });
 }finally{await rm(staging,{recursive:true,force:true});}
}
export function transcriptionWindows(duration:number,maxSeconds=captureLimits().maxDurationSeconds){
 if(!Number.isFinite(duration)||duration<=0||duration>maxSeconds)throw new PermanentError('ASR duration must be positive. '+durationLimitMessage(maxSeconds));
 const windows:{start:number;duration:number}[]=[];
 for(let start=0;start<duration;start+=1800)windows.push({start,duration:Math.min(1800,duration-start)});
 return windows;
}
async function transcribe(job:Job){
 const video=await activeVideo(job);
 const [revision]=await query("SELECT * FROM revisions WHERE id=$1 AND video_id=$2 AND status='ready'",[job.revision_id,job.video_id]);if(!revision)throw new PermanentError('Revision not ready');
 if(revision.edit?.clips?.length>0&&!job.payload.transcription)throw new SpeechError('Select transcription explicitly for this revision before sending audio');
 const selection:TranscriptionSelection=job.payload.transcription??video.transcription??{execution:'server',provider:'parakeet'};
 if(selection.execution!=='server')throw new SpeechError('Choose server transcription explicitly for this recording');
 const root=revisionRoot(job.video_id,job.revision_id),wav=join(root,`audio.${job.locked_by}.wav`);
 const initial=await withLease(job,async client=>{
  const current=(await client.query('SELECT deleted_at,status FROM videos WHERE id=$1 FOR UPDATE',[job.video_id])).rows[0];
  if(!current||current.deleted_at||current.status==='canceled')throw new PermanentError('Video no longer active');
  const existing=(await client.query('SELECT user_edited FROM transcripts WHERE revision_id=$1 FOR UPDATE',[job.revision_id])).rows[0];
  if(existing?.user_edited)return;
  return(await client.query("INSERT INTO transcripts(video_id,revision_id,status) VALUES($1,$2,'processing') ON CONFLICT(revision_id) DO UPDATE SET status='processing',error=NULL,updated_at=now() RETURNING updated_at::text AS version",[job.video_id,job.revision_id])).rows[0];
 });
 if(!initial)return;
 let model=selection.model??'nemo-parakeet-tdt-0.6b-v3',region='self-hosted',apiKey:string|undefined;
 const authorize=async()=>{
  const [held]=await query("SELECT 1 FROM jobs WHERE id=$1 AND locked_by=$2 AND status='running' AND locked_at>now()-interval '2 minutes'",[job.id,job.locked_by]);if(!held)throw new SpeechError('Speech job lease lost');
  const current=await activeVideo(job);
  if(selection.provider==='parakeet')return;
  const [config]=await query<SpeechConfiguration>('SELECT * FROM transcription_configurations WHERE id=$1',[selection.configurationId]);
  if(!config||!config.enabled||config.verified_version!==config.version||config.version!==selection.configurationVersion||config.provider!==selection.provider||!config.workspace_ids.includes(video.workspace_id))throw new SpeechError('Speech configuration changed or was revoked. Choose a provider explicitly to retry.');
  const requester=job.payload.requestedBy??video.owner_id;
  const [actor]=await query('SELECT u.id,u.email,m.role FROM "user" u JOIN memberships m ON m.user_id=u.id AND m.workspace_id=$2 WHERE u.id=$1',[requester,video.workspace_id]);
  if(!actor||!canEditVideo({ownerId:current.owner_id,visibility:current.visibility},{user:{id:actor.id,email:actor.email,isAdmin:false},role:actor.role}))throw new SpeechError('Speech requester no longer has video access');
  model=config.model;region=config.region;
  try{apiKey=decryptSecret(config.encrypted_key);}catch{throw new SpeechError('Speech credentials cannot be decrypted; update provider settings');}
 };
 let attemptId:string|undefined;
 try{
  attemptId=await withLease(job,async client=>(await client.query('INSERT INTO transcription_attempts(job_id,video_id,revision_id,provider,model,configuration_id,configuration_version) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[job.id,job.video_id,job.revision_id,selection.provider,model,selection.configurationId??null,selection.configurationVersion??null])).rows[0].id);
  await authorize();
  const limits=speechCapabilities(selection.provider,model),texts:string[]=[],usage:unknown[]=[],requests:string[]=[];
  let segments:Segment[]=[];
  let language:string|undefined,timing:'word'|'segment'|'none'='word';
  const duration=Number(revision.duration),maxDuration=Number((revision.edit?.limits??recordingLimits(video)).maxDurationSeconds);
  if(!Number.isFinite(duration)||duration<=0||duration>maxDuration)throw new SpeechError('Speech revision duration exceeds its admission limit');
  const windowVersion=await withLease(job,async client=>{
   const row=(await client.query("UPDATE jobs SET payload=jsonb_set(payload,'{speechWindowVersion}',COALESCE(payload->'speechWindowVersion',CASE WHEN payload ? 'speechWindows' THEN '1'::jsonb ELSE '2'::jsonb END)) WHERE id=$1 RETURNING payload",[job.id])).rows[0];
   return row.payload.speechWindowVersion;
  });
  // Keep the exact old window boundaries when resuming already-submitted jobs.
  const windows=speechWindows(duration,limits.maxInputSeconds,windowVersion===1?'none':limits.timing);
  for(const [index,window] of windows.entries()){
   const {start,duration:seconds}=window;
   await authorize();
   await extractAudioWindow(join(root,'playback.mp4'),wav,start,seconds);
   const checkpoint=async(value:SpeechCheckpoint)=>withLease(job,async client=>{await client.query("UPDATE jobs SET payload=jsonb_set(payload,'{speechWindows}',COALESCE(payload->'speechWindows','{}'::jsonb)||jsonb_build_object($2::text,COALESCE(payload->'speechWindows'->$2::text,'{}'::jsonb)||$3::jsonb)) WHERE id=$1",[job.id,String(start),JSON.stringify(value)]);});
   const [latest]=await query('SELECT payload FROM jobs WHERE id=$1',[job.id]);
   const result=await transcribeAudio({path:wav,duration:seconds,provider:selection.provider,model,region,apiKey,configurationVersion:selection.configurationVersion??1,language:selection.language,speakers:limits.diarization,resume:latest.payload.speechWindows?.[String(start)],checkpoint,authorize},AbortSignal.timeout(65*60_000));
   if(result.timing==='none')timing='none';else if(timing==='word'&&result.timing==='segment')timing='segment';
   texts.push(result.text??result.segments.map(s=>s.text).join(' '));if(result.usage)usage.push(result.usage);if(result.requestId)requests.push(result.requestId);
   await query('UPDATE transcription_attempts SET usage=$2,remote_requests=$3 WHERE id=$1',[attemptId,JSON.stringify(usage),JSON.stringify(requests)]);
   // Speaker IDs from independent windows must not imply the same person's identity.
   const shift=(s:import('@core/policy').Word)=>({...s,start:s.start+start,end:s.end+start,...(s.speaker?{speaker:`${start}:${s.speaker}`}:{})});
   const shifted=result.segments.map(s=>({...shift(s),...(s.words?{words:s.words.map(shift)}:{})}));
   const previous=windows[index-1];
   segments=previous&&previous.start+previous.duration>start?mergeSpeechOverlap(segments,shifted,start,previous.start+previous.duration):[...segments,...shifted];
   language??=result.language;
  }
  await authorize();
  await withLease(job,async client=>{
   const current=(await client.query('SELECT deleted_at,status FROM videos WHERE id=$1 FOR UPDATE',[job.video_id])).rows[0];if(!current||current.deleted_at||current.status==='canceled')throw new PermanentError('Video no longer active');
   const t=(await client.query('SELECT user_edited,updated_at::text AS version FROM transcripts WHERE revision_id=$1 FOR UPDATE',[job.revision_id])).rows[0];
   if(!t||t.user_edited||t.version!==initial.version){await client.query("UPDATE transcription_attempts SET status='superseded',finished_at=now() WHERE id=$1",[attemptId]);return;}
   const timed=timing==='none'?[]:segments;await writeCaptions(root,timed);
   await client.query("UPDATE transcripts SET segments=$2,text=$3,timing=$4,language=$5,provider=$6,model=$7,status='ready',error=NULL,updated_at=now() WHERE revision_id=$1 AND NOT user_edited",[job.revision_id,JSON.stringify(timed),timing==='none'?texts.join(' ').trim():timed.map(s=>s.text).join(' '),timing,language??null,selection.provider,model]);
   await client.query("UPDATE transcription_attempts SET status='ready',usage=$2,remote_requests=$3,finished_at=now() WHERE id=$1",[attemptId,JSON.stringify(usage),JSON.stringify(requests)]);
  });
 }catch(error){
  if(attemptId)await query("UPDATE transcription_attempts SET status='failed',error=$2,finished_at=now() WHERE id=$1",[attemptId,error instanceof SpeechError?error.message:'Speech processing failed']).catch(()=>{});
  throw error;
 }finally{await rm(wav,{force:true});}
}
async function ai(job:Job){
 const video=await activeVideo(job);const revisionId=job.revision_id??video.published_revision_id;if(revisionId!==video.published_revision_id)throw new PermanentError('AI revision superseded');
 const transcript=await transcriptFor(revisionId);if(!transcript)throw new PermanentError('Ready transcript required for AI');
 const [setting]=await query("SELECT value FROM settings WHERE key='ai'");if(!setting)throw new PermanentError('AI settings not configured');
 const stored:AIConfig=setting.value;
 const configurationHash=aiConfigurationFingerprint(stored);
 await withLease(job,async client=>{
  const current=(await client.query('SELECT published_revision_id,deleted_at,status FROM videos WHERE id=$1 FOR UPDATE',[job.video_id])).rows[0];
  if(!current||current.deleted_at||current.status==='canceled'||current.published_revision_id!==revisionId)throw new PermanentError('AI revision superseded');
  const held=(await client.query('SELECT payload FROM jobs WHERE id=$1',[job.id])).rows[0];
  if(held.payload.aiConfiguration?.hash&&held.payload.aiConfiguration.hash!==configurationHash)throw new PermanentError('AI configuration changed; request a new generation');
  await client.query("UPDATE jobs SET payload=payload||jsonb_build_object('aiConfiguration',$2::jsonb) WHERE id=$1",[job.id,JSON.stringify({provider:stored.provider,model:stored.model,hash:configurationHash})]);
  await client.query("INSERT INTO ai_results(video_id,revision_id,provider,model,status) VALUES($1,$2,$3,$4,'processing') ON CONFLICT(video_id,revision_id) DO UPDATE SET provider=$3,model=$4,status='processing',usage=NULL,error=NULL,updated_at=now()",[job.video_id,revisionId,stored.provider,stored.model]);
 });
 let apiKey:string|undefined;
 try{apiKey=stored.encryptedApiKey?decryptSecret(stored.encryptedApiKey):undefined;}catch{throw new PermanentError('AI credentials cannot be decrypted; update provider settings');}
 const config:AIConfig={...stored,apiKey};
 const text=transcript.timing==='none'?transcript.text:transcript.segments.map((s:Segment)=>`[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`).join('\n');
 const generated=await generateVideoAI(config,text,video.duration);
 await withLease(job,c=>recordAIUsage(c,job,generated));
 await withLease(job,async client=>{
 const current=(await client.query('SELECT * FROM videos WHERE id=$1 FOR UPDATE',[job.video_id])).rows[0];if(!current||current.deleted_at||current.status==='canceled'||current.published_revision_id!==revisionId)throw new PermanentError('AI revision superseded');
 const latest=(await client.query("SELECT updated_at::text AS transcript_version FROM transcripts WHERE revision_id=$1 AND status='ready' FOR SHARE",[revisionId])).rows[0];
 if(!latest||latest.transcript_version!==transcript.transcript_version)throw new Error('Transcript changed during AI generation');
 await client.query('INSERT INTO ai_results(video_id,revision_id) VALUES($1,$2) ON CONFLICT(video_id,revision_id) DO NOTHING',[job.video_id,revisionId]);
 const existing=(await client.query('SELECT user_edited FROM ai_results WHERE video_id=$1 AND revision_id=$2 FOR UPDATE',[job.video_id,revisionId])).rows[0];const edited:string[]=existing.user_edited??[];
 await client.query(`UPDATE ai_results SET title=CASE WHEN $2 THEN title ELSE $3 END,summary=CASE WHEN $4 THEN summary ELSE $5 END,
 chapters=CASE WHEN $6 THEN chapters ELSE $7::jsonb END,action_items=CASE WHEN $8 THEN action_items ELSE $9::jsonb END,
 provider=$10,model=$11,usage=$12,status='ready',error=NULL,updated_at=now() WHERE video_id=$1 AND revision_id=$13`,
 [job.video_id,edited.includes('title'),generated.result.title,edited.includes('summary'),generated.result.summary,edited.includes('chapters'),JSON.stringify(generated.result.chapters),edited.includes('actionItems'),JSON.stringify(generated.result.actionItems),config.provider,config.model,JSON.stringify(generated.usage),revisionId]);
 });
}
async function analyzeCleanupJob(job:Job){
 const video=await activeVideo(job);
 const [revision]=await query("SELECT * FROM revisions WHERE id=$1 AND video_id=$2 AND status='ready'",[job.revision_id,job.video_id]);
 const [analysis]=await query('SELECT * FROM cleanup_analyses WHERE id=$1 AND revision_id=$2 AND video_id=$3',[job.payload.analysisId,job.revision_id,job.video_id]);
 if(!revision||!analysis)throw new PermanentError('Cleanup analysis is unavailable');
 const duration=Number(revision.duration),limits=validateCaptureLimits(revision.edit?.limits??recordingLimits(video));
 if(!Number.isFinite(duration)||duration<=0||duration>limits.maxDurationSeconds)throw new PermanentError('Cleanup duration exceeds admission limits');
 const authorize=async()=>{
  const [held]=await query("SELECT 1 FROM jobs WHERE id=$1 AND locked_by=$2 AND status='running' AND locked_at>now()-interval '2 minutes'",[job.id,job.locked_by]);if(!held)throw new PermanentError('Cleanup job lease lost');
  const current=await activeVideo(job);if(current.published_revision_id!==job.revision_id)throw new PermanentError('Cleanup revision changed');
  const [actor]=await query('SELECT u.id,u.email,m.role FROM "user" u JOIN memberships m ON m.user_id=u.id AND m.workspace_id=$2 WHERE u.id=$1',[job.payload.requestedBy,video.workspace_id]);
  if(!actor||!canEditVideo({ownerId:current.owner_id,visibility:current.visibility},{user:{id:actor.id,email:actor.email,isAdmin:false},role:actor.role}))throw new PermanentError('Cleanup requester no longer has access');
  const transcript=await transcriptFor(job.revision_id);
  if((transcript?String(transcript.version):null)!==job.payload.transcriptVersion)throw new PermanentError('Cleanup transcript changed. Analyze again.');
 };
 await withLease(job,async client=>{await authorize();await client.query("UPDATE cleanup_analyses SET status='processing',error=NULL WHERE id=$1",[analysis.id]);});
 const transcript=await transcriptFor(job.revision_id),root=revisionRoot(job.video_id,job.revision_id);
 const suggestions=await analyzeCleanup({path:join(root,'playback.mp4'),wav:join(root,`cleanup.${job.locked_by}.wav`),duration,revisionId:job.revision_id,transcriptVersion:job.payload.transcriptVersion,language:analysis.language??undefined,segments:transcript?.segments??[],authorize},AbortSignal.timeout(65*60_000));
 let context:Record<string,unknown>={status:'not_requested'};
 if(job.payload.aiFingerprint){
  try{
   const checkConfig=async()=>{
    await authorize();const [setting]=await query<{value:AIConfig}>("SELECT value FROM settings WHERE key='ai'");
    if(!setting?.value.enabled||aiConfigurationFingerprint(setting.value)!==job.payload.aiFingerprint)throw new PermanentError('AI configuration changed. Analyze again to use the new setting.');
    return setting.value;
   };
   const stored=await checkConfig();context={status:'processing',provider:stored.provider,model:stored.model};
   let apiKey:string|undefined;try{apiKey=stored.encryptedApiKey?decryptSecret(stored.encryptedApiKey):undefined;}catch{throw new PermanentError('AI credentials cannot be decrypted');}
   const generated=await generateCleanupAI({...stored,apiKey},transcript.segments.flatMap((s:Segment)=>s.words??[]),{revisionId:job.revision_id,transcriptVersion:job.payload.transcriptVersion});
   await withLease(job,c=>recordAIUsage(c,job,{...generated,provider:stored.provider,model:stored.model}));
   context={...context,usage:generated.usage};await checkConfig();
   const unique=new Set(suggestions.map(s=>s.id));suggestions.push(...generated.suggestions.filter(s=>{if(unique.has(s.id))return false;unique.add(s.id);return true;}));
   context={...context,status:'ready'};
  }catch(error){context={...context,status:'failed',error:safeAIError(error)};}
 }
 await withLease(job,async client=>{
  await client.query('SELECT id FROM videos WHERE id=$1 FOR UPDATE',[job.video_id]);await authorize();
  await client.query("UPDATE cleanup_analyses SET status='ready',suggestions=$2,context=$3,error=NULL,updated_at=now() WHERE id=$1",[analysis.id,JSON.stringify(suggestions),JSON.stringify(context)]);
 });
}
async function cleanup(job:Job){
 await withLease(job,async client=>{
 const video=(await client.query('SELECT * FROM videos WHERE id=$1 FOR UPDATE',[job.video_id])).rows[0];
 if(!video)return;
 if(job.payload.deleteMedia===true){
 if(!video.deleted_at||new Date(video.deleted_at).getTime()>Date.now()-7*24*3600_000)throw new PermanentError('Media deletion requires a video deleted at least seven days ago');
 const active=(await client.query(`SELECT j.id FROM jobs j LEFT JOIN revisions r ON r.id=j.revision_id
 WHERE j.kind IN ('process','render') AND j.status IN ('queued','running') AND (
 j.video_id=$1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.edit->'clips')='array' THEN r.edit->'clips' ELSE '[]'::jsonb END) clip WHERE clip->>'videoId'=$1::text)) LIMIT 1`,[job.video_id])).rows;
 if(active.length)throw new Error('Media retained while an edit uses its source');
 await rm(videoRoot(job.video_id),{recursive:true,force:true});
 await rm(uploadRoot(job.video_id),{recursive:true,force:true});
 }else if(job.payload.uploadParts===true){
 if(video.status!=='ready'||video.deleted_at)throw new PermanentError('Upload cleanup requires a ready video');
 await rm(uploadRoot(job.video_id),{recursive:true,force:true});
 }
 });
}
export async function executeJob(job:Job){
 const timer=setInterval(()=>{void query("UPDATE jobs SET locked_at=now() WHERE id=$1 AND locked_by=$2 AND status='running'",[job.id,job.locked_by]).catch(()=>{});},20_000);timer.unref();
 try{
 switch(job.kind){case 'process':case 'render':await processMedia(job);break;case 'transcribe':await transcribe(job);break;case 'ai':await ai(job);break;case 'cleanup':await cleanup(job);break;case 'analyze_cleanup':await analyzeCleanupJob(job);break;case 'workflow':await generateWorkflow(job);break;case 'report':await buildReport(job);break;case 'delivery':await deliver(job);break;default:throw new PermanentError('Unknown job kind');}
 await query("UPDATE jobs SET status='done',locked_at=NULL,locked_by=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND locked_by=$2 AND status='running'",[job.id,job.locked_by]);
 }catch(error){
 const decision=failureDecision(error,job.attempts,job.max_attempts);
 const message=error instanceof PermanentError||error instanceof SpeechError?error.message:(job.kind==='ai'?'AI request failed; check provider configuration':'Job failed; retry available');
 await withLease(job,async client=>{
 await client.query("UPDATE jobs SET status=$3,available_at=now()+make_interval(secs=>$4),last_error=$5,locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=$1 AND locked_by=$2",[job.id,job.locked_by,decision.retry?'queued':'failed',decision.delaySeconds,message]);
 if(!decision.retry){
 if(job.kind==='process'||job.kind==='render'){
 await client.query("UPDATE revisions SET status='failed',error=$2 WHERE id=$1 AND status<>'ready'",[job.revision_id,message]);
 if(job.kind==='process')await client.query("UPDATE videos SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND deleted_at IS NULL AND published_revision_id IS NULL",[job.video_id,message]);
 }else if(job.kind==='transcribe')await client.query("UPDATE transcripts SET status='failed',error=$2 WHERE revision_id=$1 AND NOT user_edited AND status<>'ready'",[job.revision_id,message]);
 else if(job.kind==='analyze_cleanup')await client.query("UPDATE cleanup_analyses SET status='failed',error=$2,updated_at=now() WHERE id=$1",[job.payload.analysisId,message]);
 else if(job.kind==='report')await client.query("UPDATE report_exports SET status='failed',csv=NULL,error=$2 WHERE id=$1",[job.payload.exportId,message]);
 else if(job.kind==='workflow')await client.query("UPDATE workflow_artifacts SET status='failed',error=$2,updated_at=now() WHERE id=$1",[job.payload.artifactId,message]);
 else if(job.kind==='ai'&&job.revision_id)await client.query("INSERT INTO ai_results(video_id,revision_id,status,error) VALUES($1,$2,'failed',$3) ON CONFLICT(video_id,revision_id) DO UPDATE SET status='failed',error=$3",[job.video_id,job.revision_id,message]);
 }
 }).catch(()=>{});
 }finally{clearInterval(timer);}
}
export async function reapExpiredJobs(){
 await transaction(async client=>{
 const expired=(await client.query("UPDATE jobs SET status='failed',last_error='Worker lease expired after final attempt',locked_by=NULL,locked_at=NULL,updated_at=now() WHERE status='running' AND attempts>=max_attempts AND locked_at<now()-make_interval(secs=>$1) RETURNING *",[LEASE_SECONDS])).rows;
 for(const job of expired){
 const message='Worker lease expired after final attempt';
 if(job.kind==='process'||job.kind==='render'){
 await client.query("UPDATE revisions SET status='failed',error=$2 WHERE id=$1 AND status<>'ready'",[job.revision_id,message]);
 if(job.kind==='process')await client.query("UPDATE videos SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND deleted_at IS NULL AND published_revision_id IS NULL",[job.video_id,message]);
 }else if(job.kind==='transcribe')await client.query("UPDATE transcripts SET status='failed',error=$2 WHERE revision_id=$1 AND NOT user_edited AND status<>'ready'",[job.revision_id,message]);
 else if(job.kind==='analyze_cleanup')await client.query("UPDATE cleanup_analyses SET status='failed',error=$2,updated_at=now() WHERE id=$1",[job.payload.analysisId,message]);
 else if(job.kind==='report')await client.query("UPDATE report_exports SET status='failed',csv=NULL,error=$2 WHERE id=$1",[job.payload.exportId,message]);
 else if(job.kind==='workflow')await client.query("UPDATE workflow_artifacts SET status='failed',error=$2,updated_at=now() WHERE id=$1",[job.payload.artifactId,message]);
 else if(job.kind==='ai'&&job.revision_id)await client.query("INSERT INTO ai_results(video_id,revision_id,status,error) VALUES($1,$2,'failed',$3) ON CONFLICT(video_id,revision_id) DO UPDATE SET status='failed',error=$3",[job.video_id,job.revision_id,message]);
 }
 });
 await recoverDeliveries();
}
