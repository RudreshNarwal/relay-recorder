import {oauthAccessToken,lockOAuthAccount} from '../oauth';
import {oauthJSON} from '../oauth-providers';
import {z} from 'zod';
import {requireActor,type Actor} from '../auth';
import {accessVideo,membership,lockEditableVideo} from '../access';
import {query,transaction} from '../db';
import {body,json,fail,uuid,limit} from '../http';
import {connectionSchema,connectionDTO,deliveryDTO} from '../connections';
import {encryptSecret} from '../secrets';
import {deliveryAccessDigest} from '../outbox';
import {workflowMarkdown} from '../workflows';
import {audit} from '../audit';

export async function connections(request:Request,parts:string[],actor:Actor|null){
 if(parts[0]==='workspaces'&&parts[2]==='deliveries'&&parts.length===3&&request.method==='GET'){
  const user=requireActor(actor),workspaceId=uuid(parts[1]),role=await membership(workspaceId,user);
  const rows=await query(`SELECT d.* FROM deliveries d JOIN videos v ON v.id=d.video_id WHERE d.workspace_id=$1 AND v.deleted_at IS NULL
   AND (v.owner_id=$2 OR $3) ORDER BY d.created_at DESC LIMIT 100`,[workspaceId,user.id,['owner','admin'].includes(role)]);
  return json({deliveries:rows.map(deliveryDTO)});
 }
 if(parts[0]==='workspaces'&&parts[2]==='connections'){
  const user=requireActor(actor),workspaceId=uuid(parts[1]);const manage=request.method!=='GET';await membership(workspaceId,user,manage);
  if(request.method==='GET'&&parts.length===3)return json({connections:(await query('SELECT * FROM connections WHERE workspace_id=$1 ORDER BY (status=\'active\') DESC,created_at DESC LIMIT 100',[workspaceId])).map(connectionDTO)});
  if(request.method==='POST'&&parts.length===3){
   const input=await body(request,connectionSchema);await limit('connections:'+user.id,20,3600);
   let grant:Awaited<ReturnType<typeof oauthAccessToken>>|undefined,resourceId:string|null=null;
   if(input.oauthAccountId){
    const account=(await query('SELECT * FROM oauth_accounts WHERE id=$1 AND workspace_id=$2',[input.oauthAccountId,workspaceId]))[0];
    if(!account||account.kind!==input.provider)fail(403,'Choose an authorized account for this workspace and provider.');
    grant=await oauthAccessToken(account.id);
    if(input.provider==='jira'||input.provider==='confluence'){
     const resources=await oauthJSON('https://api.atlassian.com/oauth/token/accessible-resources',{headers:{Authorization:`Bearer ${grant.token}`}});
     const destinationSite=input.destination.site;
     const resource=Array.isArray(resources)?resources.find(r=>r.url===`https://${destinationSite}.atlassian.net`):null;
     if(!resource||!z.uuid().safeParse(resource.id).success)fail(403,'This OAuth grant cannot access the selected Atlassian site.');resourceId=resource.id;
    }
   }
   const connection=await transaction(async c=>{
    await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId]);
    const role=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[workspaceId,user.id])).rows[0]?.role;
    if(!['owner','admin'].includes(role))fail(403,'Workspace access denied');
    if((await c.query("SELECT count(*)::int AS count FROM connections WHERE workspace_id=$1 AND status='active'",[workspaceId])).rows[0].count>=100)fail(409,'Disconnect an unused destination before adding another');
    if(input.oauthAccountId)await lockOAuthAccount(c,input.oauthAccountId,grant!.version);
    const row=(await c.query('INSERT INTO connections(workspace_id,provider,name,audience,destination,encrypted_token,oauth_account_id,oauth_resource_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[workspaceId,input.provider,input.name,input.audience,JSON.stringify(input.destination),input.token?encryptSecret(input.token):'',input.oauthAccountId??null,resourceId])).rows[0];
    await audit(c,workspaceId,user.id,'connection.created','connection',row.id);return row;
   });return json({connection:connectionDTO(connection)},201);
  }
  if(request.method==='DELETE'&&parts.length===4){
   const id=uuid(parts[3]);await transaction(async c=>{
    const role=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[workspaceId,user.id])).rows[0]?.role;
    if(!['owner','admin'].includes(role))fail(403,'Workspace access denied');
    const changed=await c.query("UPDATE connections SET status='disconnected',encrypted_token='',version=version+1 WHERE id=$1 AND workspace_id=$2 RETURNING id",[id,workspaceId]);if(!changed.rowCount)fail(404,'Connection not found');
    await c.query("UPDATE deliveries SET status='canceled',error='Connection disconnected',updated_at=now() WHERE connection_id=$1 AND status='queued'",[id]);
    await audit(c,workspaceId,user.id,'connection.disconnected','connection',id);
   });return json({ok:true});
  }return null;
 }
 if(parts[0]!=='videos'||parts[2]!=='workflows'||parts[4]!=='deliveries')return null;
 const user=requireActor(actor),videoId=uuid(parts[1]),artifactId=uuid(parts[3]);const {row}=await accessVideo(request,videoId,user,true);
 const artifact=(await query('SELECT * FROM workflow_artifacts WHERE id=$1 AND video_id=$2',[artifactId,videoId]))[0];
 if(!artifact)fail(404,'Workflow not found');
 if(request.method==='GET'&&parts.length===5)return json({deliveries:(await query('SELECT * FROM deliveries WHERE artifact_id=$1 ORDER BY created_at DESC LIMIT 50',[artifactId])).map(deliveryDTO)});
 if(request.method==='POST'&&parts.length===5){
  if(artifact.revision_id!==row.published_revision_id)fail(409,'This workflow is not from the published revision');
  const input=await body(request,z.object({connectionId:z.uuid(),expectedRevisionId:z.uuid(),expectedVersion:z.number().int().positive(),idempotencyKey:z.uuid(),confirmed:z.literal(true)}).strict());
  await limit('delivery:'+user.id,30,3600);
  const delivery=await transaction(async c=>{
   const video=await lockEditableVideo(c,videoId,user);
   const current=(await c.query('SELECT * FROM workflow_artifacts WHERE id=$1 FOR UPDATE',[artifactId])).rows[0];
   if(video.published_revision_id!==input.expectedRevisionId||current.revision_id!==video.published_revision_id||current.version!==input.expectedVersion)fail(409,'Draft or revision changed. Review again.');
   if(!['ready','proposed'].includes(current.status)||!current.draft.sections.some((s:{body:string})=>s.body.trim()))fail(409,'Save a nonempty draft before delivery');
   if(workflowMarkdown(current.draft).length>30000)fail(400,'Shorten the draft to 30000 characters before delivery');
   const connection=(await c.query("SELECT * FROM connections WHERE id=$1 AND workspace_id=$2 AND status='active' FOR SHARE",[input.connectionId,video.workspace_id])).rows[0];if(!connection)fail(403,'Destination is unavailable in this workspace');
   const existing=(await c.query('SELECT * FROM deliveries WHERE workspace_id=$1 AND idempotency_key=$2',[video.workspace_id,input.idempotencyKey])).rows[0];
   if(existing){if(existing.actor_id!==user.id||existing.artifact_id!==artifactId||existing.artifact_version!==current.version||existing.connection_id!==connection.id||existing.connection_version!==connection.version)fail(409,'Idempotency key belongs to another delivery');return existing;}
   const entry=(await c.query(`INSERT INTO deliveries(workspace_id,video_id,revision_id,artifact_id,artifact_version,connection_id,connection_version,actor_id,idempotency_key,access_digest,draft)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[video.workspace_id,videoId,current.revision_id,artifactId,current.version,connection.id,connection.version,user.id,input.idempotencyKey,await deliveryAccessDigest(c,video),JSON.stringify(current.draft)])).rows[0];
   await c.query("INSERT INTO jobs(kind,video_id,revision_id,resource_key,payload) VALUES('delivery',$1,$2,$3,$4)",[videoId,current.revision_id,entry.id,JSON.stringify({deliveryId:entry.id})]);
   await audit(c,video.workspace_id,user.id,'delivery.queued','delivery',entry.id);return entry;
  });return json({delivery:deliveryDTO(delivery)},202);
 }
 if(request.method==='POST'&&parts.length===7&&parts[6]==='reconcile'){
  const id=uuid(parts[5]);const input=await body(request,z.discriminatedUnion('outcome',[
   z.object({outcome:z.literal('sent'),externalId:z.string().trim().min(1).max(500),confirmed:z.literal(true)}).strict(),
   z.object({outcome:z.literal('not_sent'),confirmed:z.literal(true)}).strict(),
  ]));
  const entry=await transaction(async c=>{
   await lockEditableVideo(c,videoId,user);
   const row=(await c.query('SELECT * FROM deliveries WHERE id=$1 AND artifact_id=$2 FOR UPDATE',[id,artifactId])).rows[0];if(!row)fail(404,'Delivery not found');
   if(row.status!=='uncertain')fail(409,'Only uncertain deliveries require reconciliation');
   if((await c.query("SELECT 1 FROM jobs WHERE kind='delivery' AND resource_key=$1 AND status IN ('queued','running')",[id])).rowCount)fail(409,'Wait for the delivery job to finish');
   await c.query("UPDATE deliveries SET status=$2,external_id=$3,error=NULL,updated_at=now() WHERE id=$1",[id,input.outcome==='sent'?'sent':'queued',input.outcome==='sent'?input.externalId:null]);
   if(input.outcome==='not_sent')await c.query("INSERT INTO jobs(kind,video_id,revision_id,resource_key,payload) VALUES('delivery',$1,$2,$3,$4)",[videoId,row.revision_id,id,JSON.stringify({deliveryId:id})]);
   await audit(c,row.workspace_id,user.id,'delivery.reconciled','delivery',id);
   return(await c.query('SELECT * FROM deliveries WHERE id=$1',[id])).rows[0];
  });return json({delivery:deliveryDTO(entry)});
 }return null;
}
