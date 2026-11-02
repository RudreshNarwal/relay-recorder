import {z} from 'zod';
import {captureLimits,recordingLimits,type CaptureLimits} from '../capabilities';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {readFile,stat} from 'node:fs/promises';
import {query,transaction} from '../db';
import {body,fail,json,uuid} from '../http';
import {membership,videoDTO} from '../access';
import {requireActor,type Actor} from '../auth';
import {PART_SIZE,MAX_PARTS,uploadRoot,atomicWrite} from '../storage';
import {resolveRecordingTranscription,transcriptionSelectionSchema} from '../transcription-config';
export const partSchema=z.object({index:z.number().int().min(0).max(MAX_PARTS-1),sha256:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().min(1).max(PART_SIZE)});
export function validateManifest(parts:z.infer<typeof partSchema>[],limits:CaptureLimits=captureLimits()){if(!parts.length)fail(400,'Recording has no media');if(parts.length>Math.ceil(limits.maxUploadBytes/PART_SIZE)||parts.reduce((n,p)=>n+p.size,0)>limits.maxUploadBytes)fail(400,'Recording exceeds its upload limit');for(let i=0;i<parts.length;i++)if(parts[i].index!==i||(i<parts.length-1&&parts[i].size!==PART_SIZE))fail(400,'Upload parts must be contiguous; only the final part may be smaller');}
async function own(id:string,user:Actor){const v=(await query('SELECT * FROM videos WHERE id=$1 AND deleted_at IS NULL',[id]))[0];if(!v)fail(404,'Recording not found');await membership(v.workspace_id,user);if(v.owner_id!==user.id)fail(403,'Only the recording owner may upload');return v;}
async function state(id:string,row:Record<string,any>){const received=await query<{part_index:number}>('SELECT part_index FROM upload_parts WHERE video_id=$1 ORDER BY part_index',[id]);return{video:videoDTO(row),upload:{id,partSize:PART_SIZE,...recordingLimits(row),receivedParts:received.map(x=>x.part_index)}};}
export async function recordings(request:Request,parts:string[],actor:Actor|null):Promise<Response|null>{
 if(parts[0]!=='recordings')return null;const user=requireActor(actor);const method=request.method;
 if(parts.length===1&&method==='POST'){
  const input=await body(request,z.object({clientId:z.uuid(),workspaceId:z.uuid(),title:z.string().trim().min(1).max(300),transcriptionMode:z.enum(['on_device','server_api']).optional(),transcription:transcriptionSelectionSchema.optional(),mimeType:z.enum(['video/mp4','video/quicktime','video/webm','audio/mp4','audio/webm']).optional(),mediaKind:z.enum(['video','audio']).default('video'),enhanceAudio:z.boolean().default(true)}));
  await membership(input.workspaceId,user);
  if(input.mimeType&&!input.mimeType.startsWith(input.mediaKind+'/'))fail(400,'MIME type does not match media kind');
  if(input.transcription&&input.transcriptionMode&&input.transcriptionMode!==(input.transcription.execution==='device'?'on_device':'server_api'))fail(400,'Conflicting transcription selections');
  function resume(existing:Record<string,any>){
   if(existing.workspace_id!==input.workspaceId||existing.media_kind!==input.mediaKind||existing.deleted_at||existing.status==='canceled')fail(409,'Client recording identifier has already been used');
   if(input.transcription&&Object.entries(input.transcription).some(([key,value])=>existing.transcription[key]!==value))fail(409,'Recording transcription selection is already fixed');
   return existing;
  }
  const row=await transaction(async c=>{
   const existing=(await c.query('SELECT * FROM videos WHERE owner_id=$1 AND client_id=$2 FOR UPDATE',[user.id,input.clientId])).rows[0];
   // Media recovery must survive revoked or changed speech settings.
   if(existing)return resume(existing);
   const selected=await resolveRecordingTranscription(input,input.workspaceId,user),initial=randomUUID();
   const result=await c.query(`INSERT INTO videos(client_id,workspace_id,owner_id,title,transcription_mode,mime_type,initial_revision_id,capture_limits,media_kind,transcription,enhance_audio) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(owner_id,client_id) DO NOTHING RETURNING *`,[input.clientId,input.workspaceId,user.id,input.title,selected.execution==='device'?'on_device':'server_api',input.mimeType||null,initial,JSON.stringify(captureLimits()),input.mediaKind,JSON.stringify(selected),input.enhanceAudio]);
   if(result.rows[0]){await c.query('INSERT INTO revisions(id,video_id) VALUES($1,$2)',[initial,result.rows[0].id]);return result.rows[0];}
   return resume((await c.query('SELECT * FROM videos WHERE owner_id=$1 AND client_id=$2',[user.id,input.clientId])).rows[0]);
  });return json(await state(row.id,row),201);
 }
 const id=uuid(parts[1]);const video=await own(id,user);const limits=recordingLimits(video);
 if(parts.length===2&&method==='GET')return json(await state(id,video));
 if(parts[2]==='parts'&&method==='PUT'){
  const index=Number(parts[3]);if(!Number.isInteger(index)||index<0||index>=Math.ceil(limits.maxUploadBytes/PART_SIZE))fail(400,'Invalid part index');const digest=request.headers.get('x-content-sha256');if(!digest||!/^[a-f0-9]{64}$/.test(digest))fail(400,'X-Content-SHA256 is required');
  const length=Number(request.headers.get('content-length'));if(length>PART_SIZE)fail(413,'Upload part exceeds 8 MiB');
  const reader=request.body?.getReader();if(!reader)fail(400,'Missing upload body');const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>PART_SIZE){await reader.cancel();fail(413,'Upload part exceeds 8 MiB');}chunks.push(value);}}finally{reader.releaseLock();}
  if(!size)fail(400,'Empty upload part');if(index*PART_SIZE+size>limits.maxUploadBytes)fail(413,'Recording exceeds its upload limit');const bytes=Buffer.concat(chunks);if(createHash('sha256').update(bytes).digest('hex')!==digest)fail(422,'Upload checksum mismatch');
  await transaction(async c=>{const row=(await c.query('SELECT status,deleted_at FROM videos WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row||row.deleted_at||row.status==='canceled')fail(409,'Recording is canceled');const old=(await c.query('SELECT * FROM upload_parts WHERE video_id=$1 AND part_index=$2',[id,index])).rows[0];if(old){if(old.sha256!==digest||old.size!==size)fail(409,'Upload part already exists with different bytes');return;}if(row.status!=='uploading')fail(409,'Recording has already been finalized');await atomicWrite(join(uploadRoot(id),`${index}.part`),bytes);await c.query('INSERT INTO upload_parts(video_id,part_index,sha256,size) VALUES($1,$2,$3,$4)',[id,index,digest,size]);});return json({index,sha256:digest,size});
 }
 if(parts[2]==='finalize'&&method==='POST'){
  const input=await body(request,z.object({parts:z.array(partSchema).min(1).max(MAX_PARTS),duration:z.number().finite().min(0).max(limits.maxDurationSeconds).optional(),mimeType:z.enum(['video/mp4','video/quicktime','video/webm','audio/mp4','audio/webm'])}),4_000_000);validateManifest(input.parts,limits);if(!input.mimeType.startsWith(video.media_kind+'/'))fail(400,'MIME type does not match media kind');
  const manifest=JSON.stringify({parts:input.parts,mimeType:input.mimeType});
  const row=await transaction(async c=>{const v=(await c.query('SELECT * FROM videos WHERE id=$1 FOR UPDATE',[id])).rows[0];if(v.deleted_at||v.status==='canceled')fail(409,'Recording is canceled');if(v.finalized_manifest){if((v.finalized_manifest.parts.length!==input.parts.length||input.parts.some((p,i)=>{const old=v.finalized_manifest.parts[i];return old.index!==p.index||old.sha256!==p.sha256||old.size!==p.size;}))||v.finalized_manifest.mimeType!==input.mimeType)fail(409,'Recording was finalized with a different manifest');return v;}
   const actual=(await c.query('SELECT part_index,sha256,size FROM upload_parts WHERE video_id=$1 ORDER BY part_index',[id])).rows;if(actual.length!==input.parts.length)fail(409,'Upload is incomplete');for(let i=0;i<actual.length;i++){const expected=input.parts[i],a=actual[i];if(a.part_index!==expected.index||a.sha256!==expected.sha256||a.size!==expected.size)fail(409,'Upload manifest mismatch');const s=await stat(join(uploadRoot(id),`${i}.part`)).catch(()=>null);if(!s||s.size!==a.size)fail(409,'Uploaded media is missing; upload this recording again');}
   await c.query(`UPDATE videos SET finalized_manifest=$2,mime_type=$3,duration=$4,status='processing',updated_at=now() WHERE id=$1`,[id,manifest,input.mimeType,input.duration||0]);await c.query(`INSERT INTO jobs(kind,video_id,revision_id,payload) VALUES('process',$1,$2,$3)`,[id,v.initial_revision_id,JSON.stringify({...input,expectedRevisionId:null})]);return(await c.query('SELECT * FROM videos WHERE id=$1',[id])).rows[0];});return json({video:videoDTO(row)},202);
 }
 if(parts.length===2&&method==='DELETE'){await transaction(async c=>{const v=(await c.query('SELECT status FROM videos WHERE id=$1 FOR UPDATE',[id])).rows[0];if(v.status==='ready')fail(409,'Use the library to delete a completed video');await c.query("UPDATE videos SET status='canceled',updated_at=now() WHERE id=$1",[id]);await c.query("UPDATE jobs SET status='failed',last_error='Recording canceled',updated_at=now() WHERE video_id=$1 AND status IN ('queued','running')",[id]);});return json({ok:true});}
 return null;
}
