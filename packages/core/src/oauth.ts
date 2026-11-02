import type {PoolClient} from 'pg';
import {transaction} from './db';
import {decryptSecret,encryptSecret} from './secrets';
import {fail} from './http';
import {oauthKinds,exchangeGrant,OAuthError,type OAuthKind,type OAuthFamily} from './oauth-providers';
export const isCalendar=(kind:string)=>kind==='google_calendar'||kind==='microsoft_calendar';
export const callbackPath=(kind:string)=>`/api/v1/oauth/callback/${kind}`;
export async function oauthApp(c:PoolClient,family:OAuthFamily){
 const row=(await c.query('SELECT value FROM settings WHERE key=$1 FOR SHARE',['oauth:'+family])).rows[0]?.value;
 if(!row?.enabled)fail(409,'The server owner must enable this OAuth application.');
 return {...row,clientSecret:decryptSecret(row.encryptedClientSecret)};
}
export function oauthAccountDTO(row:Record<string,any>){return {id:row.id,kind:row.kind,userId:row.user_id,version:row.version,status:row.status,scopes:row.scopes,error:row.error,createdAt:row.created_at};}
/** Account lock serializes rotating refresh tokens; credential rotation does not change review identity. */
export async function oauthAccessToken(id:string){
 const result=await transaction(async c=>{
  const row=(await c.query('SELECT * FROM oauth_accounts WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!row||row.status!=='active')fail(409,'Reconnect the provider account.');
  const role=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[row.workspace_id,row.user_id])).rows[0]?.role;
  if(!role||(!isCalendar(row.kind)&&!['owner','admin'].includes(role)))fail(403,'The account owner no longer has workspace permission.');
  const app=await oauthApp(c,oauthKinds[row.kind as OAuthKind].family);
  if(row.app_version!==app.version)fail(409,'OAuth application changed. Reconnect the account.');
  if(!row.expires_at||new Date(row.expires_at).getTime()>Date.now()+60000)return {token:decryptSecret(row.encrypted_access_token),version:row.version,kind:row.kind as OAuthKind};
  if(!row.encrypted_refresh_token){await c.query("UPDATE oauth_accounts SET status='reconnect_required',error='Access token expired. Reconnect the account.' WHERE id=$1",[id]);return {error:'Access token expired. Reconnect the account.'};}
  try{
   const grant=await exchangeGrant(row.kind,app,{refreshToken:decryptSecret(row.encrypted_refresh_token)});
   await c.query('UPDATE oauth_accounts SET encrypted_access_token=$2,encrypted_refresh_token=$3,expires_at=$4,scopes=$5,error=NULL,updated_at=now() WHERE id=$1',[id,encryptSecret(grant.accessToken),grant.refreshToken?encryptSecret(grant.refreshToken):row.encrypted_refresh_token,grant.expiresIn?new Date(Date.now()+grant.expiresIn*1000):null,JSON.stringify(grant.scopes)]);
   return {token:grant.accessToken,version:row.version,kind:row.kind as OAuthKind};
  }catch(error){
   const safe=error instanceof OAuthError?error:new OAuthError('Provider credentials are unavailable. Reconnect the account.');
   if(safe.reconnect)await c.query("UPDATE oauth_accounts SET status='reconnect_required',error=$2,updated_at=now() WHERE id=$1",[id,safe.message]);
   return {error:safe.message};
  }
 });
 if('error' in result)fail(409,result.error!);return result;
}
/** Recheck under a shared lock immediately before a provider request. */
export async function lockOAuthAccount(c:PoolClient,id:string,version:number){
 const row=(await c.query('SELECT * FROM oauth_accounts WHERE id=$1 FOR SHARE',[id])).rows[0];
 if(!row||row.status!=='active'||row.version!==version)fail(409,'Provider authorization changed.');
 const role=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[row.workspace_id,row.user_id])).rows[0]?.role;
 if(!role||(!isCalendar(row.kind)&&!['owner','admin'].includes(role)))fail(403,'Provider authorization is unavailable.');
 const app=await oauthApp(c,oauthKinds[row.kind as OAuthKind].family);if(app.version!==row.app_version)fail(409,'OAuth application changed.');
 return row;
}
