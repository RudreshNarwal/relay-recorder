import {z} from 'zod';
import type {PoolClient} from 'pg';
import {fail} from './http';
import {summarizeEngagement,type WatchSession} from './analytics';

export const reportInput=z.object({
 kind:z.enum(['engagement','users','content','operations','provider_usage']),
 from:z.iso.datetime({offset:true}),to:z.iso.datetime({offset:true}),
 cursor:z.string().min(1).max(200).optional(),limit:z.coerce.number().int().min(1).max(100).default(50),
 videoId:z.uuid().optional(),revisionId:z.uuid().optional(),
}).strict().refine(v=>Date.parse(v.to)>Date.parse(v.from)&&Date.parse(v.to)-Date.parse(v.from)<=90*86400000&&Date.parse(v.to)<=Date.now()+60000,'Choose a UTC range of at most 90 days');
export type ReportInput=z.infer<typeof reportInput>;
export const retentionSchema=z.object({rawDays:z.number().int().min(1).max(365),aggregateMonths:z.number().int().min(1).max(36)}).strict().refine(v=>v.aggregateMonths*28>=v.rawDays,'Aggregate retention must cover raw retention');
export const defaultRetention={rawDays:90,aggregateMonths:13};
export async function reportAccess(c:PoolClient,workspaceId:string,userId:string){
 const role=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[workspaceId,userId])).rows[0]?.role;
 if(!['owner','admin'].includes(role))fail(403,'Workspace reports require owner or admin membership');
}
export function csvCell(value:unknown){
 let text=value==null?'':String(value);
 if(typeof value==='string'&&/^(?:\s*[=+@-]|[\t\r\n])/.test(text))text="'"+text;
 return '"'+text.replaceAll('"','""')+'"';
}
export type ReportRow=Record<string,string|number|boolean|null>;
export type ReportPage={columns:string[];rows:ReportRow[];nextCursor:string|null;videoIds:string[];userIds:string[]};
const seconds=(usage:any):number|null=>{
 const values=(Array.isArray(usage)?usage:[usage]).flatMap(v=>typeof v?.audioSeconds==='number'?[v.audioSeconds]:typeof v?.seconds==='number'?[v.seconds]:[]);
 return values.length?values.reduce((a,b)=>a+b,0):null;
};
export async function reportPage(c:PoolClient,workspaceId:string,input:ReportInput):Promise<ReportPage>{
 const {kind,from,to,cursor,limit,videoId,revisionId}=input;
 let rows:ReportRow[]=[],columns:string[]=[],ids:string[]=[],videoIds:string[]=[],userIds:string[]=[];
 const p=[workspaceId,from,to,cursor??'',limit+1,videoId??null];
 if(kind==='content'){
  const result=(await c.query(`SELECT v.id,v.title,v.owner_id,v.status,v.visibility,v.duration,v.created_at,v.published_revision_id,
   COALESCE((SELECT sum(p.size) FROM upload_parts p WHERE p.video_id=v.id),0)::text AS bytes
   FROM videos v WHERE v.workspace_id=$1 AND v.deleted_at IS NULL AND v.created_at>=$2 AND v.created_at<$3 AND ($4='' OR v.id>NULLIF($4,'')::uuid)
   AND ($6::uuid IS NULL OR v.id=$6) ORDER BY v.id LIMIT $5 FOR SHARE OF v`,p)).rows;
  ids=result.map(r=>r.id);videoIds=ids.slice(0,limit);
  columns=['videoId','title','ownerId','status','visibility','durationSeconds','sourceBytes','createdAt','publishedRevisionId'];
  rows=result.map(r=>({videoId:r.id,title:r.title,ownerId:r.owner_id,status:r.status,visibility:r.visibility,durationSeconds:r.duration,sourceBytes:r.bytes,createdAt:r.created_at.toISOString(),publishedRevisionId:r.published_revision_id}));
 }else if(kind==='users'){
  const result=(await c.query(`SELECT u.id,u.name,u.email,m.role,m.created_at,
   (SELECT count(*)::int FROM videos v WHERE v.workspace_id=$1 AND v.owner_id=u.id AND v.deleted_at IS NULL AND v.created_at>=$2 AND v.created_at<$3) AS created,
   (SELECT count(*)::int FROM watch_sessions s JOIN videos v ON v.id=s.video_id WHERE v.workspace_id=$1 AND v.deleted_at IS NULL AND s.user_id=u.id AND s.kind='playback' AND jsonb_array_length(s.summary->'covered')>0 AND s.started_at>=$2 AND s.started_at<$3) AS watched
   FROM memberships m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 AND u.id>$4 ORDER BY u.id LIMIT $5 FOR SHARE OF m,u`,p.slice(0,5))).rows;
  ids=result.map(r=>r.id);userIds=ids.slice(0,limit);
  columns=['userId','name','email','role','joinedAt','recordingsCreated','playbackSessions','active'];
  rows=result.map(r=>({userId:r.id,name:r.name,email:r.email,role:r.role,joinedAt:r.created_at.toISOString(),recordingsCreated:r.created,playbackSessions:r.watched,active:r.created>0||r.watched>0}));
 }else if(kind==='engagement'){
  const revisions=(await c.query(`SELECT r.id,r.video_id,r.duration,v.title,r.id=v.published_revision_id AS published
   FROM revisions r JOIN videos v ON v.id=r.video_id WHERE v.workspace_id=$1 AND v.deleted_at IS NULL AND r.status='ready' AND r.duration>0 AND ($4='' OR r.id>NULLIF($4,'')::uuid)
   AND ($6::uuid IS NULL OR v.id=$6) AND ($7::uuid IS NULL OR r.id=$7)
   AND (r.id=v.published_revision_id OR EXISTS(SELECT 1 FROM watch_sessions s WHERE s.revision_id=r.id AND s.started_at>=$2 AND s.started_at<$3))
   ORDER BY r.id LIMIT $5 FOR SHARE OF v`,[...p,revisionId??null])).rows;
  ids=revisions.map(r=>r.id);const selected=revisions.slice(0,limit);videoIds=selected.map(r=>r.video_id);
  const sessions=(await c.query(`SELECT s.revision_id,s.summary,s.user_id,u.name FROM watch_sessions s LEFT JOIN "user" u ON u.id=s.user_id
   WHERE s.revision_id=ANY($1::uuid[]) AND s.started_at>=$2 AND s.started_at<$3 ORDER BY s.revision_id,s.started_at LIMIT 10001`,[selected.map(r=>r.id),from,to])).rows;
  if(sessions.length>10000)fail(409,'Narrow the report date range or page size to at most 10000 sessions per page');
  columns=['videoId','title','revisionId','published','views','uniqueViewers','knownViewers','anonymousViewers','watchSeconds','uniqueWatchedSeconds','rewatchedMediaSeconds','completionRate'];
  rows=selected.map(r=>{
   const source:WatchSession[]=sessions.filter(s=>s.revision_id===r.id).map(s=>({...s.summary,userId:s.user_id,userName:s.name??null}));
   const {bins,viewers,...metrics}=summarizeEngagement(source,r.duration);
   return {videoId:r.video_id,title:r.title,revisionId:r.id,published:r.published,...metrics};
  });
 }else if(kind==='operations'){
  const result=(await c.query(`SELECT j.id,j.kind,j.status,j.attempts,j.max_attempts,j.video_id,v.title,j.created_at,j.updated_at,
   EXISTS(SELECT 1 FROM jobs active WHERE active.id=j.id AND active.status='running' AND active.locked_at<now()-interval '2 minutes') AS lease_expired
   FROM jobs j JOIN videos v ON v.id=j.video_id WHERE v.workspace_id=$1 AND v.deleted_at IS NULL AND j.created_at>=$2 AND j.created_at<$3 AND ($4='' OR j.id>NULLIF($4,'')::uuid)
   AND ($6::uuid IS NULL OR v.id=$6) ORDER BY j.id LIMIT $5 FOR SHARE OF v`,p)).rows;
  ids=result.map(r=>r.id);videoIds=result.slice(0,limit).map(r=>r.video_id);
  columns=['jobId','videoId','title','kind','status','attempts','maxAttempts','leaseExpired','createdAt','updatedAt'];
  rows=result.map(r=>({jobId:r.id,videoId:r.video_id,title:r.title,kind:r.kind,status:r.status,attempts:r.attempts,maxAttempts:r.max_attempts,leaseExpired:r.lease_expired,createdAt:r.created_at.toISOString(),updatedAt:r.updated_at.toISOString()}));
 }else{
  const result=(await c.query(`SELECT a.* FROM (
   SELECT id,video_id,'language_model' AS kind,provider,model,usage,'returned' AS status,created_at FROM ai_usage
   UNION ALL SELECT id,video_id,'speech',provider,model,usage,status,created_at FROM transcription_attempts
   ) a JOIN videos v ON v.id=a.video_id WHERE v.workspace_id=$1 AND v.deleted_at IS NULL AND a.created_at>=$2 AND a.created_at<$3 AND ($4='' OR a.id>NULLIF($4,'')::uuid)
   AND ($6::uuid IS NULL OR v.id=$6) ORDER BY a.id LIMIT $5`,p)).rows;
  ids=result.map(r=>r.id);videoIds=result.slice(0,limit).map(r=>r.video_id);
  columns=['usageId','videoId','kind','provider','model','status','inputTokens','outputTokens','totalTokens','audioSeconds','cost','createdAt'];
  rows=result.map(r=>({usageId:r.id,videoId:r.video_id,kind:r.kind,provider:r.provider,model:r.model,status:r.status,inputTokens:r.usage?.inputTokens??null,outputTokens:r.usage?.outputTokens??null,totalTokens:r.usage?.totalTokens??null,audioSeconds:seconds(r.usage),cost:null,createdAt:r.created_at.toISOString()}));
 }
 return {columns,rows:rows.slice(0,limit),nextCursor:ids.length>limit?ids[limit-1]:null,videoIds:[...new Set(videoIds)],userIds};
}
