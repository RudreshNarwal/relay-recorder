import {calendars} from './routes/calendars';
import {oauth} from './routes/oauth';
import {connections} from './routes/connections';
import {branding} from './routes/branding';
import {meetings} from './routes/meetings';
import {mkdir,access,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {actor,enforceOrigin,requireAdmin} from './auth';
import {HttpError,fail,json,uuid} from './http';
import {query,transaction} from './db';
import {dataRoot} from './storage';
import {workspaces} from './routes/workspaces';
import {recordings} from './routes/recordings';
import {videos} from './routes/videos';
import {sharing} from './routes/sharing';
import {media} from './routes/media';
import {collaboration} from './routes/collaboration';
import {device} from './routes/device';
import {ai} from './routes/ai';
import {getServerCapabilities} from './capabilities';
import {transcription} from './routes/transcription';
import {cleanup} from './routes/cleanup';
import {workflows} from './routes/workflows';
import {reports} from './routes/reports';
import {analytics} from './routes/analytics';
export async function dispatch(request:Request):Promise<Response>{
 try{
  const pathname=new URL(request.url).pathname;const parts=pathname.replace(/^\/api\/v1\/?/,'').split('/').filter(Boolean).map(decodeURIComponent);
  if(parts[0]==='health'){
   let database=false,storage=false;try{await query('SELECT 1');database=true;}catch{}try{await mkdir(dataRoot(),{recursive:true});await access(dataRoot(),constants.W_OK);storage=true;}catch{}return json({ok:database&&storage,database,storage},database&&storage?200:503);
  }
  if(parts[0]==='downloads'&&request.method==='GET'){const root=process.env.APP_ROOT||process.cwd();const locations=[join(root,'apps/web/public/downloads/Relay.dmg'),join(root,'public/downloads/Relay.dmg')];let available=false;for(const p of locations)if(await stat(/* turbopackIgnore: true */ p).then(s=>s.isFile()).catch(()=>false)){available=true;break;}return json({macAvailable:available,url:available?'/downloads/Relay.dmg':null});}
  if(!(parts[0]==='device'&&['start','exchange'].includes(parts[1])))enforceOrigin(request);
  const user=await actor(request);
  if(parts[0]==='capabilities'&&parts.length===1&&request.method==='GET'){const workspaceId=new URL(request.url).searchParams.get('workspaceId');return json(await getServerCapabilities(user,workspaceId?uuid(workspaceId):undefined));}
  if(parts[0]==='admin'&&parts[1]==='jobs'){
   requireAdmin(user);
   if(request.method==='GET')return json({jobs:await query('SELECT id,kind,video_id AS "videoId",revision_id AS "revisionId",status,attempts,max_attempts AS "maxAttempts",last_error AS "lastError",created_at AS "createdAt",updated_at AS "updatedAt" FROM jobs ORDER BY created_at DESC LIMIT 100')});
   if(parts[3]==='retry'&&request.method==='POST'){const id=uuid(parts[2]);await transaction(async c=>{const job=(await c.query('SELECT j.*,v.deleted_at,v.status AS video_status FROM jobs j LEFT JOIN videos v ON v.id=j.video_id WHERE j.id=$1 FOR UPDATE OF j',[id])).rows[0];if(!job)fail(404,'Job not found');if(job.status!=='failed')fail(409,'Only failed jobs can be retried');if(job.deleted_at||job.video_status==='canceled')fail(409,'Video has been deleted or canceled');await c.query("UPDATE jobs SET status='queued',attempts=0,available_at=now(),locked_at=NULL,locked_by=NULL,last_error=NULL,updated_at=now() WHERE id=$1",[id]);if(job.kind==='process')await c.query("UPDATE videos SET status='processing',error=NULL WHERE id=$1",[job.video_id]);if(['process','render'].includes(job.kind))await c.query("UPDATE revisions SET status='queued',error=NULL WHERE id=$1",[job.revision_id]);});return json({ok:true});}
  }
  for(const handler of [device,oauth,calendars,connections,meetings,workflows,analytics,reports,branding,workspaces,recordings,sharing,media,collaboration,ai,transcription,cleanup,videos]){const response=await handler(request,parts,user);if(response)return response;}
  return json({error:'Endpoint not found'},404);
 }catch(error){
  if(error instanceof HttpError)return json({error:error.message,...(error.code?{code:error.code}:{})},error.status,error.status===429?{'Retry-After':'60'}:{});
  if(error instanceof URIError)return json({error:'Invalid URL'},400);
  const code=(error as {code?:string})?.code;
  if(code==='23505')return json({error:'This operation conflicts with an existing record'},409);
  if(code==='23503')return json({error:'A referenced record is no longer available'},409);
  if(code==='22P02'||code==='23514')return json({error:'Invalid request data'},400);
  console.error('[relay-api] request failed',{path:new URL(request.url).pathname,code:code||'internal'});
  return json({error:'Request failed. Check server health and try again.'},500);
 }
}
