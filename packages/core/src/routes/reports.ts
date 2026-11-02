import {requireActor,requireAdmin,type Actor} from '../auth';
import {query,transaction} from '../db';
import {body,fail,json,limit,uuid} from '../http';
import {reportAccess,reportInput,reportPage,retentionSchema,defaultRetention} from '../reports';
import {audit} from '../audit';

export async function reports(request:Request,parts:string[],actor:Actor|null):Promise<Response|null>{
 const url=new URL(request.url);
 if(parts[0]==='admin'&&parts[1]==='analytics-retention'&&parts.length===2){
  const user=requireAdmin(actor);
  if(request.method==='GET')return json({retention:(await query("SELECT value FROM settings WHERE key='analytics-retention'"))[0]?.value??defaultRetention});
  if(request.method==='PUT'){
   const input=await body(request,retentionSchema);
   await transaction(async c=>{
    if(!(await c.query('SELECT user_id FROM instance_admins WHERE user_id=$1 FOR SHARE',[user.id])).rowCount)fail(403,'Instance owner required');
    await c.query("INSERT INTO settings(key,value) VALUES('analytics-retention',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()",[JSON.stringify(input)]);
    await audit(c,null,user.id,'analytics.retention_changed','analytics','retention');
   });return json({retention:input});
  }return null;
 }
 if(parts[0]!=='workspaces'||parts[2]!=='reports')return null;
 const user=requireActor(actor),workspaceId=uuid(parts[1]);
 if(parts.length===3&&request.method==='GET'){
  const input=reportInput.safeParse(Object.fromEntries(url.searchParams));if(!input.success)fail(400,'Choose a report kind, UTC range (at most 90 days), and bounded page size');
  return transaction(async c=>{
   await reportAccess(c,workspaceId,user.id);
   const {videoIds,userIds,...page}=await reportPage(c,workspaceId,input.data);
   return json({...page,kind:input.data.kind,from:input.data.from,to:input.data.to,timeZone:'UTC',basis:input.data.kind==='engagement'?'sessions-started-in-range':'records-created-in-range',scope:'current-workspace-admin-permissions'});
  });
 }
 if(parts[3]==='audit'&&parts.length===4&&request.method==='GET'){
  const cursor=url.searchParams.get('cursor');if(cursor&&!/^\d{1,19}$/.test(cursor))fail(400,'Invalid audit cursor');
  return transaction(async c=>{
   await reportAccess(c,workspaceId,user.id);
   const events=(await c.query('SELECT id::text,actor_id AS "actorId",action,object_type AS "objectType",object_id AS "objectId",result,created_at AS "createdAt" FROM audit_events WHERE workspace_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 101',[workspaceId,cursor])).rows;
   return json({events:events.slice(0,100),nextCursor:events.length>100?events[99].id:null});
  });
 }
 if(parts[3]!=='exports')return null;
 if(parts.length===4&&request.method==='POST'){
  const input=await body(request,reportInput);if(input.cursor)fail(400,'Exports start from the first row');
  await limit('report-export:'+user.id,10,3600);
  return transaction(async c=>{
   await reportAccess(c,workspaceId,user.id);
   if((await c.query("SELECT count(*)::int AS n FROM report_exports WHERE workspace_id=$1 AND requested_by=$2 AND status='queued' AND expires_at>now()",[workspaceId,user.id])).rows[0].n>=3)fail(429,'Wait for existing exports to finish');
   const exp=(await c.query('INSERT INTO report_exports(workspace_id,requested_by,request) VALUES($1,$2,$3) RETURNING id,status,created_at AS "createdAt",expires_at AS "expiresAt"',[workspaceId,user.id,JSON.stringify({...input,limit:100})])).rows[0];
   await c.query("INSERT INTO jobs(kind,resource_key,payload) VALUES('report',$1,$2)",[exp.id,JSON.stringify({exportId:exp.id})]);
   await audit(c,workspaceId,user.id,'report.requested','report',exp.id);return json({export:exp},202);
  });
 }
 if(parts.length===4&&request.method==='GET')return transaction(async c=>{
  await reportAccess(c,workspaceId,user.id);
  const exports=(await c.query(`SELECT id,CASE WHEN expires_at<=now() THEN 'expired' ELSE status END AS status,request->>'kind' AS kind,row_count AS "rowCount",error,created_at AS "createdAt",expires_at AS "expiresAt"
   FROM report_exports WHERE workspace_id=$1 AND requested_by=$2 ORDER BY created_at DESC LIMIT 100`,[workspaceId,user.id])).rows;
  return json({exports});
 });
 if(parts.length===6&&parts[5]==='download'&&request.method==='GET'){
  const id=uuid(parts[4]);
  return transaction(async c=>{
   await reportAccess(c,workspaceId,user.id);
   const exp=(await c.query('SELECT * FROM report_exports WHERE id=$1 AND workspace_id=$2 AND requested_by=$3 FOR SHARE',[id,workspaceId,user.id])).rows[0];
   if(!exp)fail(404,'Export not found');if(new Date(exp.expires_at).getTime()<=Date.now()||exp.status==='expired')fail(410,'Export expired. Request a new report.');
   if(exp.status!=='ready'||exp.csv===null)fail(409,'Export is not ready');
   const videos=(await c.query('SELECT id FROM videos WHERE id=ANY($1::uuid[]) AND workspace_id=$2 AND deleted_at IS NULL FOR SHARE',[exp.video_ids,workspaceId])).rows;
   const users=(await c.query('SELECT user_id FROM memberships WHERE user_id=ANY($1::text[]) AND workspace_id=$2 FOR SHARE',[exp.user_ids,workspaceId])).rows;
   if(videos.length!==exp.video_ids.length||users.length!==exp.user_ids.length)fail(409,'Report access changed. Request a fresh export.');
   await audit(c,workspaceId,user.id,'report.downloaded','report',id);
   return new Response(exp.csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="relay-${exp.request.kind}-${id}.csv"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  });
 }
 return null;
}
