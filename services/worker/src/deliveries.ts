import {oauthAccessToken,lockOAuthAccount} from '@core/oauth';
import type {PoolClient} from 'pg';
import {query} from '@core/db';
import {canEditVideo} from '@core/policy';
import {deliveryAccessDigest} from '@core/outbox';
import {decryptSecret} from '@core/secrets';
import {audit} from '@core/audit';
import {withLease} from './lease';
import type {Job} from './jobs';
import {PermanentError} from './media';
import {sendIntegration,DeliveryError} from './integrations';

async function reviewed(c:PoolClient,id:string){
 const row=(await c.query('SELECT * FROM deliveries WHERE id=$1',[id])).rows[0];if(!row)return null;
 // Share/access mutations lock the video; disconnect locks the connection. Hold
 // those owners through the bounded request so revocation cannot race sending.
 const video=(await c.query('SELECT * FROM videos WHERE id=$1 FOR UPDATE',[row.video_id])).rows[0];
 const user=(await c.query('SELECT id,email FROM "user" WHERE id=$1 FOR SHARE',[row.actor_id])).rows[0];
 const role=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[row.workspace_id,row.actor_id])).rows[0]?.role;
 const artifact=(await c.query('SELECT * FROM workflow_artifacts WHERE id=$1 FOR SHARE',[row.artifact_id])).rows[0];
 const connection=(await c.query('SELECT * FROM connections WHERE id=$1 FOR SHARE',[row.connection_id])).rows[0];
 const current=(await c.query('SELECT * FROM deliveries WHERE id=$1 FOR UPDATE',[id])).rows[0];
 const valid=video&&!video.deleted_at&&video.status==='ready'&&video.published_revision_id===row.revision_id&&user&&
  canEditVideo({ownerId:video.owner_id,visibility:video.visibility},{user,role})&&artifact?.version===row.artifact_version&&
  connection?.status==='active'&&connection.workspace_id===row.workspace_id&&connection.version===row.connection_version&&
  await deliveryAccessDigest(c,video)===row.access_digest;
 return {row:current,connection,valid};
}
export async function deliver(job:Job){
 const id=job.payload.deliveryId;
 const start=await withLease(job,async c=>{
  const found=await reviewed(c,id);if(!found)return false;
  if(found.row.status==='sending'){
   await c.query("UPDATE deliveries SET status='uncertain',error='Worker stopped after sending began. Check the destination before reconciling.',updated_at=now() WHERE id=$1",[id]);return false;
  }
  if(found.row.status!=='queued')return false;
  if(!found.valid){await c.query("UPDATE deliveries SET status='canceled',error='Draft, permissions or connection changed. Review a new delivery.',updated_at=now() WHERE id=$1",[id]);return false;}
  await c.query("UPDATE deliveries SET status='sending',error=NULL,updated_at=now() WHERE id=$1",[id]);return found.connection;
 });
 if(!start)return;
 let grant:Awaited<ReturnType<typeof oauthAccessToken>>|undefined;
 if(start.oauth_account_id)try{grant=await oauthAccessToken(start.oauth_account_id);}catch{
  await withLease(job,async c=>{await c.query("UPDATE deliveries SET status='failed',error='Reconnect the provider account and review a new delivery.' WHERE id=$1 AND status='sending'",[id]);});throw new PermanentError('Provider authorization is unavailable.');
 }
 const outcome=await withLease(job,async c=>{
  const found=await reviewed(c,id);if(!found||found.row.status!=='sending')return 'done';
  if(!found.valid){await c.query("UPDATE deliveries SET status='canceled',error='Draft, permissions or connection changed. Review a new delivery.',updated_at=now() WHERE id=$1",[id]);return 'done';}
  let error:DeliveryError;
  try{
   let token:string;try{if(grant){await lockOAuthAccount(c,found.connection.oauth_account_id,grant.version);token=grant.token;}else token=decryptSecret(found.connection.encrypted_token);}catch{throw new DeliveryError('failed','Reconnect this destination to replace unreadable credentials.');}
   const result=await sendIntegration({provider:found.connection.provider,destination:found.connection.destination,oauth:!!grant,cloudId:found.connection.oauth_resource_id},token,found.row.draft,id);
   await c.query("UPDATE deliveries SET status='sent',external_id=$2,error=NULL,updated_at=now() WHERE id=$1",[id,result.externalId]);
   await audit(c,found.row.workspace_id,found.row.actor_id,'delivery.sent','delivery',id);return 'done';
  }catch(caught){error=caught instanceof DeliveryError?caught:new DeliveryError('uncertain','Delivery acknowledgement is unavailable. Check the destination.');}
  const retry=error.state==='retry'&&job.attempts<job.max_attempts;
  await c.query('UPDATE deliveries SET status=$2,error=$3,updated_at=now() WHERE id=$1',[id,retry?'queued':error.state==='uncertain'?'uncertain':'failed',error.message]);
  return retry?'retry':error.state==='uncertain'?'done':'failed';
 });
 if(outcome==='retry')throw new Error('Provider rate limited delivery');
 if(outcome==='failed')throw new PermanentError('Delivery failed. Check destination settings.');
}
/** A final-attempt crash cannot leave a misleading forever-sending status. */
export async function recoverDeliveries(){
 await query(`UPDATE deliveries d SET status=CASE WHEN status='sending' THEN 'uncertain' ELSE 'failed' END,
  error=CASE WHEN status='sending' THEN 'Worker stopped without acknowledgement. Check the destination before reconciling.' ELSE 'Delivery job exhausted retries.' END,updated_at=now()
  WHERE status IN ('sending','queued') AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.kind='delivery' AND j.resource_key=d.id::text AND j.status IN ('queued','running'))`);
}
