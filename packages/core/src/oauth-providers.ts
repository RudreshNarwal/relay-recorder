import {createHash} from 'node:crypto';

export const oauthKinds = {
 github: {family:'github',scopes:['repo'],pkce:true},
 slack: {family:'slack',scopes:['chat:write'],pkce:false},
 jira: {family:'atlassian',scopes:['write:jira-work','offline_access'],pkce:false},
 confluence: {family:'atlassian',scopes:['write:page:confluence','offline_access'],pkce:false},
 linear: {family:'linear',scopes:['read','issues:create'],pkce:true},
 notion: {family:'notion',scopes:[],pkce:false},
 gmail: {family:'google',scopes:['https://www.googleapis.com/auth/gmail.compose'],pkce:true},
 outlook: {family:'microsoft',scopes:['offline_access','Mail.ReadWrite'],pkce:true},
 teams: {family:'microsoft',scopes:['offline_access','ChannelMessage.Send'],pkce:true},
 google_calendar: {family:'google',scopes:['https://www.googleapis.com/auth/calendar.events.readonly'],pkce:true},
 microsoft_calendar: {family:'microsoft',scopes:['offline_access','Calendars.Read'],pkce:true},
 zoom: {family:'zoom',scopes:['meeting:read:meeting','meeting:update:rtms'],pkce:true},
} as const;
export type OAuthKind=keyof typeof oauthKinds;
export type OAuthFamily=typeof oauthKinds[OAuthKind]['family'];
export type OAuthApp={clientId:string;clientSecret:string};
export const oauthEndpoints:Record<OAuthFamily,{authorize:string;token:string;json?:boolean;basic?:boolean}>={
 google:{authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token'},
 microsoft:{authorize:'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',token:'https://login.microsoftonline.com/common/oauth2/v2.0/token'},
 github:{authorize:'https://github.com/login/oauth/authorize',token:'https://github.com/login/oauth/access_token'},
 slack:{authorize:'https://slack.com/oauth/v2/authorize',token:'https://slack.com/api/oauth.v2.access'},
 atlassian:{authorize:'https://auth.atlassian.com/authorize',token:'https://auth.atlassian.com/oauth/token',json:true},
 linear:{authorize:'https://linear.app/oauth/authorize',token:'https://api.linear.app/oauth/token'},
 notion:{authorize:'https://api.notion.com/v1/oauth/authorize',token:'https://api.notion.com/v1/oauth/token',json:true,basic:true},
 zoom:{authorize:'https://zoom.us/oauth/authorize',token:'https://zoom.us/oauth/token',basic:true},
};
export class OAuthError extends Error {
 constructor(message:string,public reconnect=true,public status?:number){super(message);}
}
export function authorizationURL(kind:OAuthKind,app:OAuthApp,state:string,verifier:string,redirect:string){
 const config=oauthKinds[kind],url=new URL(oauthEndpoints[config.family].authorize);
 const params:Record<string,string>={client_id:app.clientId,redirect_uri:redirect,response_type:'code',state};
 if(config.scopes.length)params.scope=config.scopes.join(['linear','slack'].includes(config.family)?',':' ');
 if(config.pkce){params.code_challenge=createHash('sha256').update(verifier).digest('base64url');params.code_challenge_method='S256';}
 if(config.family==='google'){params.access_type='offline';params.prompt='consent';}
 if(config.family==='atlassian'){params.audience='api.atlassian.com';params.prompt='consent';}
 if(config.family==='notion')params.owner='user';
 url.search=new URLSearchParams(params).toString();return url.toString();
}
/** No raw remote errors, redirects or unbounded responses cross the credential boundary. */
export async function oauthJSON(url:string,init:RequestInit={},fetcher:typeof fetch=fetch):Promise<any>{
 let response:Response;
 try{response=await fetcher(url,{...init,redirect:'error',signal:AbortSignal.timeout(15000)});}
 catch{throw new OAuthError('Provider acknowledgement was lost. Reconnect the account.');}
 if(!response.ok){await response.body?.cancel();throw new OAuthError(`Provider request failed (HTTP ${response.status}).`,![429,500,502,503,504].includes(response.status),response.status);}
 const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let count=0;
 try{if(reader)while(true){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>2*1024*1024){await reader.cancel();throw new Error();}chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString());}
 catch{throw new OAuthError('Provider acknowledgement was invalid. Reconnect the account.');}
 finally{reader?.releaseLock();}
}
export async function exchangeGrant(kind:OAuthKind,app:OAuthApp,grant:{code?:string;verifier?:string;redirectURI?:string;refreshToken?:string},fetcher:typeof fetch=fetch){
 const config=oauthKinds[kind],endpoint=oauthEndpoints[config.family];
 const params:Record<string,string>=grant.refreshToken?{grant_type:'refresh_token',refresh_token:grant.refreshToken}:{grant_type:'authorization_code',code:grant.code!,redirect_uri:grant.redirectURI!};
 if(grant.verifier&&config.pkce)params.code_verifier=grant.verifier;
 const headers:Record<string,string>={Accept:'application/json','Content-Type':endpoint.json?'application/json':'application/x-www-form-urlencoded'};
 if(endpoint.basic)headers.Authorization='Basic '+Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64');
 else {params.client_id=app.clientId;params.client_secret=app.clientSecret;}
 if(config.family==='notion')headers['Notion-Version']='2022-06-28';
 const data=await oauthJSON(endpoint.token,{method:'POST',headers,body:endpoint.json?JSON.stringify(params):new URLSearchParams(params).toString()},fetcher);
 if(data.error||data.ok===false||typeof data.access_token!=='string'||!data.access_token||data.access_token.length>8000||/[\s\x00-\x20]/.test(data.access_token))throw new OAuthError('Provider did not grant a valid access token.');
 if(data.token_type&&String(data.token_type).toLowerCase()!=='bearer')throw new OAuthError('Provider returned an unsupported token type.');
 const scopes=typeof data.scope==='string'?data.scope.split(/[ ,]+/).filter(Boolean):Array.isArray(data.scope)?data.scope:[...config.scopes];
 // offline_access may be represented by a refresh token instead of a scope in responses.
 if(config.scopes.some(s=>s!=='offline_access'&&!scopes.includes(s)))throw new OAuthError('Provider did not grant the required scopes.');
 const expires=data.expires_in===undefined?null:Number(data.expires_in);
 if(expires!==null&&(!Number.isFinite(expires)||expires<=0||expires>366*86400))throw new OAuthError('Provider returned invalid token expiry.');
 if(data.refresh_token!==undefined&&(typeof data.refresh_token!=='string'||!data.refresh_token||data.refresh_token.length>8000))throw new OAuthError('Provider returned an invalid refresh token.');
 return {accessToken:data.access_token as string,refreshToken:data.refresh_token as string|undefined,expiresIn:expires,scopes};
}
