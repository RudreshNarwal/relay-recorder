import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {Actor} from '../auth';
import {requireActor} from '../auth';
import {accessVideo} from '../access';
import {query,transaction} from '../db';
import {body,fail,json,limit,uuid} from '../http';
import type {CleanupSuggestion} from '../cleanup';
import {aiConfigurationFingerprint,type AIConfig} from '../../../../services/worker/src/ai';

export const cleanupEditSchema=z.object({analysisId:z.uuid(),transcriptVersion:z.string().regex(/^\d+$/).nullable(),suggestionIds:z.array(z.string().max(100)).min(1).max(10000)});
export async function validateCleanupEdit(client:PoolClient,input:z.infer<typeof cleanupEditSchema>,videoId:string,revisionId:string){
 const analysis=(await client.query("SELECT * FROM cleanup_analyses WHERE id=$1 AND video_id=$2 AND revision_id=$3 AND status='ready'",[input.analysisId,videoId,revisionId])).rows[0];
 const transcript=(await client.query("SELECT version FROM transcripts WHERE revision_id=$1 AND status='ready'",[revisionId])).rows[0];
 const version=transcript?String(transcript.version):null;
 if(!analysis||analysis.transcript_version!==version||input.transcriptVersion!==version)fail(409,'Cleanup suggestions are stale. Analyze the current transcript again.');
 if(new Set(input.suggestionIds).size!==input.suggestionIds.length||input.suggestionIds.some(id=>!analysis.suggestions.some((s:CleanupSuggestion)=>s.id===id)))fail(400,'Unknown cleanup suggestion');
}
export async function cleanup(request:Request,parts:string[],actor:Actor|null):Promise<Response|null>{
 if(parts[0]!=='videos'||parts[2]!=='cleanup'||parts.length!==3)return null;
 const id=uuid(parts[1]),{row}=await accessVideo(request,id,actor,true);
 if(request.method==='GET'){
  const [analysis]=await query('SELECT * FROM cleanup_analyses WHERE video_id=$1 AND revision_id=$2 ORDER BY created_at DESC LIMIT 1',[id,row.published_revision_id]);
  return json({analysis:analysis?{id:analysis.id,revisionId:analysis.revision_id,transcriptVersion:analysis.transcript_version,language:analysis.language,status:analysis.status,suggestions:analysis.suggestions,context:analysis.context,error:analysis.error}:null});
 }
 if(request.method==='POST'){
  const user=requireActor(actor),input=await body(request,z.object({expectedRevisionId:z.uuid(),expectedTranscriptVersion:z.string().regex(/^\d+$/).nullable(),language:z.enum(['en']).nullable().optional(),contextual:z.boolean().default(false)}));
  await limit('cleanup:'+user.id,10,60);
  await transaction(async client=>{
   const current=(await client.query('SELECT published_revision_id,deleted_at,status FROM videos WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!current||current.deleted_at||current.status!=='ready'||current.published_revision_id!==input.expectedRevisionId)fail(409,'The published revision changed or is not ready');
   const transcript=(await client.query("SELECT version,language,segments,timing FROM transcripts WHERE revision_id=$1 AND status='ready'",[input.expectedRevisionId])).rows[0];
   const version=transcript?String(transcript.version):null;
   if(version!==input.expectedTranscriptVersion)fail(409,'Transcript changed. Reload before analysis.');
   let aiFingerprint:string|undefined;
   if(input.contextual){
    if(!transcript?.segments.length||transcript.segments.some((s:any)=>!s.words?.length)||transcript.segments.reduce((n:number,s:any)=>n+s.words.length,0)>10000)fail(409,'Contextual cleanup requires actual word timestamps for every segment, up to 10000 words.');
    const setting=(await client.query<{value:AIConfig}>("SELECT value FROM settings WHERE key='ai'")).rows[0];
    if(!setting?.value.enabled)fail(409,'Configure and enable a cloud language model first, or disable contextual suggestions.');
    aiFingerprint=aiConfigurationFingerprint(setting.value);
   }
   if((await client.query("SELECT 1 FROM jobs WHERE kind='analyze_cleanup' AND video_id=$1 AND revision_id=$2 AND status IN ('queued','running')",[id,input.expectedRevisionId])).rowCount)fail(409,'Cleanup analysis is already running');
   const analysis=(await client.query('INSERT INTO cleanup_analyses(video_id,revision_id,transcript_version,language) VALUES($1,$2,$3,$4) RETURNING id',[id,input.expectedRevisionId,version,input.language===undefined?transcript?.language??null:input.language])).rows[0];
   await client.query("INSERT INTO jobs(kind,video_id,revision_id,payload) VALUES('analyze_cleanup',$1,$2,$3)",[id,input.expectedRevisionId,JSON.stringify({analysisId:analysis.id,requestedBy:user.id,transcriptVersion:version,aiFingerprint})]);
  });return json({ok:true},202);
 }
 return null;
}
