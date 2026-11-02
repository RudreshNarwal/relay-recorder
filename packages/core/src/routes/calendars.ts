import {z} from 'zod';
import {requireActor,type Actor} from '../auth';
import {membership} from '../access';
import {query,transaction} from '../db';
import {body,json,uuid,fail,limit} from '../http';
export async function calendars(request:Request,parts:string[],actor:Actor|null){
 if(parts[0]!=='workspaces'||parts[2]!=='meetings')return null;
 const user=requireActor(actor),workspaceId=uuid(parts[1]);await membership(workspaceId,user);
 if(parts.length===3&&request.method==='GET'){
  const meetings=await query(`SELECT m.id,m.title,m.starts_at AS "startsAt",m.ends_at AS "endsAt",m.join_url AS "joinUrl",m.provider,m.all_day AS "allDay",m.canceled,m.generation,m.selected_generation AS "selectedGeneration",m.account_id AS "accountId",a.status AS "accountStatus"
   FROM meeting_instances m JOIN oauth_accounts a ON a.id=m.account_id WHERE a.workspace_id=$1 AND a.user_id=$2 ORDER BY m.starts_at DESC LIMIT 500`,[workspaceId,user.id]);
  const sync=await query(`SELECT a.id AS "accountId",a.kind,a.status,s.synced_at AS "syncedAt",s.next_at AS "nextAt",s.attempts,s.error FROM oauth_accounts a LEFT JOIN calendar_sync s ON s.account_id=a.id WHERE a.workspace_id=$1 AND a.user_id=$2 AND a.kind IN ('google_calendar','microsoft_calendar') ORDER BY a.created_at DESC LIMIT 100`,[workspaceId,user.id]);
  return json({meetings,sync,capabilities:{zoom:{available:false,reason:'RTMS runner setup required'},meet:{available:false,reason:'Meet Media API requires an already enrolled application; new enrollment is closed.'},teams:{available:false,reason:'Teams application-hosted media requires an authorized Azure Windows runner.'}}});
 }
 if(parts[3]==='sync'&&parts.length===4&&request.method==='POST'){
  const input=await body(request,z.object({accountId:z.uuid()}).strict());await limit('calendar-sync:'+user.id,20,3600);
  await transaction(async c=>{
   const account=(await c.query("SELECT id FROM oauth_accounts WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND kind IN ('google_calendar','microsoft_calendar') AND status='active' FOR SHARE",[input.accountId,workspaceId,user.id])).rows[0];if(!account)fail(404,'Connected calendar not found');
   await c.query('INSERT INTO calendar_sync(account_id) VALUES($1) ON CONFLICT(account_id) DO UPDATE SET next_at=now(),attempts=0,error=NULL',[input.accountId]);
  });return json({queued:true},202);
 }
 if(parts[4]==='select'&&parts.length===5&&request.method==='POST'){
  const id=uuid(parts[3]),input=await body(request,z.object({expectedGeneration:z.number().int().positive(),selected:z.boolean()}).strict());
  await transaction(async c=>{
   const row=(await c.query('SELECT m.*,a.status FROM meeting_instances m JOIN oauth_accounts a ON a.id=m.account_id WHERE m.id=$1 AND a.workspace_id=$2 AND a.user_id=$3 FOR UPDATE OF m FOR SHARE OF a',[id,workspaceId,user.id])).rows[0];if(!row)fail(404,'Meeting not found');
   if(row.generation!==input.expectedGeneration)fail(409,'Meeting changed. Reload and review the new occurrence.');
   if(input.selected&&(row.status!=='active'||row.canceled||!row.join_url||row.all_day||new Date(row.ends_at).getTime()<=Date.now()))fail(409,'This occurrence is not available for capture.');
   await c.query('UPDATE meeting_instances SET selected_generation=$2,updated_at=now() WHERE id=$1',[id,input.selected?row.generation:null]);
  });return json({ok:true});
 }
 return null;
}
