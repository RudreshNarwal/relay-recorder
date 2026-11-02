import {z} from 'zod';
import {requireActor,requireAdmin,type Actor} from '../auth';
import {membership} from '../access';
import {query,transaction} from '../db';
import {body,json,fail,uuid,origin,limit} from '../http';
import {token,hashToken,encryptSecret,decryptSecret,constantEqual} from '../secrets';
import {oauthKinds,oauthEndpoints,authorizationURL,exchangeGrant,OAuthError,type OAuthKind,type OAuthFamily} from '../oauth-providers';
import {isCalendar,oauthApp,oauthAccountDTO,callbackPath} from '../oauth';
function kind(value:string):OAuthKind{if(!(Object.hasOwn(oauthKinds,value)))fail(400,'Unsupported OAuth purpose');return value as OAuthKind;}
const cookieName=(state:string)=>'relay_oauth_'+hashToken(state).slice(0,24);
function cookie(state:string,browser:string,age:number){return `${cookieName(state)}=${browser}; Path=/api/v1/oauth/callback; HttpOnly; SameSite=Lax; Max-Age=${age}${origin().startsWith('https:')?'; Secure':''}`;}
export async function oauth(request:Request,parts:string[],actor:Actor|null){
 if(parts[0]==='admin'&&parts[1]==='oauth'){
  requireAdmin(actor);
  if(request.method==='GET'&&parts.length===2){const apps=await query("SELECT key,value FROM settings WHERE key LIKE 'oauth:%'");return json({apps:apps.map(r=>({family:r.key.slice(6),clientId:r.value.clientId,enabled:r.value.enabled,version:r.value.version,hasSecret:!!r.value.encryptedClientSecret}))});}
  const family=parts[2] as OAuthFamily;if(!(Object.hasOwn(oauthEndpoints,family)))fail(400,'Unsupported OAuth application');
  if(request.method==='PUT'&&parts.length===3){
   const input=await body(request,z.object({clientId:z.string().trim().min(1).max(500),clientSecret:z.string().min(1).max(8000).optional(),enabled:z.boolean(),expectedVersion:z.number().int().nonnegative()}).strict());
   const version=await transaction(async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['oauth:'+family]);
    const old=(await c.query('SELECT value FROM settings WHERE key=$1 FOR UPDATE',['oauth:'+family])).rows[0]?.value;
    if((old?.version??0)!==input.expectedVersion)fail(409,'OAuth application changed. Reload before saving.');
    if(!input.clientSecret&&(!old?.encryptedClientSecret||old.clientId!==input.clientId))fail(400,'Client secret is required for this application.');
    const value={clientId:input.clientId,encryptedClientSecret:input.clientSecret?encryptSecret(input.clientSecret):old.encryptedClientSecret,enabled:input.enabled,version:input.expectedVersion+1};
    await c.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',['oauth:'+family,JSON.stringify(value)]);return value.version;
   });return json({version});
  }return null;
 }
 if(parts[0]==='oauth'&&parts[1]==='catalog'&&request.method==='GET'){
  requireActor(actor);const configured=await query("SELECT key,value->>'enabled' AS enabled FROM settings WHERE key LIKE 'oauth:%'");
  return json({providers:Object.entries(oauthKinds).map(([kind,v])=>({kind,...v,configured:configured.some(r=>r.key==='oauth:'+v.family&&r.enabled==='true'),redirectURI:origin()+callbackPath(kind)}))});
 }
 if(parts[0]==='oauth'&&parts[1]==='callback'&&parts.length===3&&request.method==='GET'){
  const user=requireActor(actor),purpose=kind(parts[2]),url=new URL(request.url),state=url.searchParams.get('state')??'';
  if(!/^[A-Za-z0-9_-]{43}$/.test(state))fail(400,'Invalid OAuth state');
  const browser=(request.headers.get('cookie')??'').split(';').map(c=>c.trim()).find(c=>c.startsWith(cookieName(state)+'='))?.slice(cookieName(state).length+1)??'';
  const attempt=await transaction(async c=>{
   const row=(await c.query('SELECT * FROM oauth_attempts WHERE state_hash=$1 FOR UPDATE',[hashToken(state)])).rows[0];
   if(!row||row.consumed_at||new Date(row.expires_at).getTime()<=Date.now())fail(410,'OAuth request expired or was already used.');
   if(row.user_id!==user.id||row.kind!==purpose||!constantEqual(row.browser_hash,hashToken(browser)))fail(403,'OAuth request belongs to another login or browser.');
   const role=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[row.workspace_id,user.id])).rows[0]?.role;
   if(!role||(!isCalendar(purpose)&&!['owner','admin'].includes(role)))fail(403,'Workspace access denied');
   await c.query('UPDATE oauth_attempts SET consumed_at=now() WHERE state_hash=$1',[hashToken(state)]);return row;
  });
  if(url.searchParams.has('error'))return new Response(null,{status:303,headers:{Location:`${origin()}/connections?workspace=${attempt.workspace_id}&oauth=denied`,'Set-Cookie':cookie(state,'',0),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  const code=url.searchParams.get('code');if(!code||code.length>8000)fail(400,'Provider authorization code is missing.');
  const app=await transaction(c=>oauthApp(c,oauthKinds[purpose].family));if(app.version!==attempt.app_version)fail(409,'OAuth application changed. Start again.');
  let grant;try{grant=await exchangeGrant(purpose,app,{code,verifier:decryptSecret(attempt.encrypted_verifier),redirectURI:origin()+callbackPath(purpose)});}catch(error){fail(409,error instanceof OAuthError?error.message:'OAuth exchange failed. Start again.');}
  await transaction(async c=>{
   const current=await oauthApp(c,oauthKinds[purpose].family);if(current.version!==attempt.app_version)fail(409,'OAuth application changed. Start again.');
   const role=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[attempt.workspace_id,user.id])).rows[0]?.role;
   if(!role||(!isCalendar(purpose)&&!['owner','admin'].includes(role)))fail(403,'Workspace access denied');
   await c.query('INSERT INTO oauth_accounts(workspace_id,user_id,kind,app_version,encrypted_access_token,encrypted_refresh_token,expires_at,scopes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[attempt.workspace_id,user.id,purpose,attempt.app_version,encryptSecret(grant.accessToken),grant.refreshToken?encryptSecret(grant.refreshToken):null,grant.expiresIn?new Date(Date.now()+grant.expiresIn*1000):null,JSON.stringify(grant.scopes)]);
  });
  return new Response(null,{status:303,headers:{Location:`${origin()}/${isCalendar(purpose)?'meetings':'connections'}?workspace=${attempt.workspace_id}&oauth=connected`,'Set-Cookie':cookie(state,'',0),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
 }
 if(parts[0]!=='workspaces'||parts[2]!=='oauth')return null;
 const user=requireActor(actor),workspaceId=uuid(parts[1]);await membership(workspaceId,user);
 if(parts[3]==='accounts'){
  if(parts.length===4&&request.method==='GET')return json({accounts:(await query("SELECT * FROM oauth_accounts WHERE workspace_id=$1 AND (user_id=$2 OR kind NOT IN ('google_calendar','microsoft_calendar')) ORDER BY (status='active') DESC,created_at DESC LIMIT 100",[workspaceId,user.id])).map(oauthAccountDTO)});
  if(parts.length===5&&request.method==='DELETE'){
   const id=uuid(parts[4]);await transaction(async c=>{
    // Delivery holds connection before account, so disconnect uses the same order.
    await c.query('SELECT id FROM connections WHERE oauth_account_id=$1 ORDER BY id FOR UPDATE',[id]);
    const account=(await c.query('SELECT * FROM oauth_accounts WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[id,workspaceId])).rows[0];if(!account)fail(404,'OAuth account not found');
    const role=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[workspaceId,user.id])).rows[0]?.role;
    if(!role||(account.user_id!==user.id&&(isCalendar(account.kind)||!['owner','admin'].includes(role))))fail(403,'Account access denied');
    await c.query("UPDATE oauth_accounts SET status='disconnected',encrypted_access_token='',encrypted_refresh_token=NULL,version=version+1,updated_at=now() WHERE id=$1",[id]);
    await c.query("UPDATE connections SET status='disconnected',version=version+1 WHERE oauth_account_id=$1",[id]);
    await c.query("UPDATE deliveries SET status='canceled',error='Provider account disconnected' WHERE connection_id IN (SELECT id FROM connections WHERE oauth_account_id=$1) AND status='queued'",[id]);
   });return json({ok:true});
  }
 }
 if(parts.length===5&&parts[4]==='start'&&request.method==='POST'){
  const purpose=kind(parts[3]);await membership(workspaceId,user,!isCalendar(purpose));await limit('oauth-start:'+user.id,20,3600);
  const state=token(),browser=token(),verifier=token()+token();
  const app=await transaction(async c=>{
   const app=await oauthApp(c,oauthKinds[purpose].family);
   await c.query('DELETE FROM oauth_attempts WHERE expires_at<now()');
   await c.query("INSERT INTO oauth_attempts(state_hash,workspace_id,user_id,kind,app_version,browser_hash,encrypted_verifier,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')",[hashToken(state),workspaceId,user.id,purpose,app.version,hashToken(browser),encryptSecret(verifier)]);return app;
  });return json({authorizationUrl:authorizationURL(purpose,app,state,verifier,origin()+callbackPath(purpose))},200,{'Set-Cookie':cookie(state,browser,600)});
 }
 return null;
}
