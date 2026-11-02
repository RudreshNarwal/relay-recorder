import type {PoolClient} from 'pg';
import { query } from './db';
import { canEditVideo,canReadVideo } from './policy';
import { fail,origin } from './http';
import { decryptSecret,encryptSecret } from './secrets';
import type { Actor } from './auth';
export async function membership(workspaceId:string,user:Actor|null,manage=false){
 if(!user)fail(401,'Sign in to continue');
 const role=(await query<{role:string}>('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2',[workspaceId,user.id]))[0]?.role;
 if(!role||(manage&&!['owner','admin'].includes(role)))fail(403,'Workspace access denied');return role;
}
export function shareToken(request:Request){return request.headers.get('x-share-token')||new URL(request.url).searchParams.get('share');}
export function shareCookieName(id:string){return `relay_share_${id.replaceAll('-','')}`;}
export function shareCookie(id:string,version:number){const v=encryptSecret(JSON.stringify({id,version,expires:Date.now()+3600_000}));return `${shareCookieName(id)}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${origin().startsWith('https:')?'; Secure':''}`;}
function unlocked(request:Request,id:string,version:number){
 const cookies=request.headers.get('cookie')||'';const value=cookies.split(';').map(x=>x.trim()).find(x=>x.startsWith(shareCookieName(id)+'='))?.split('=').slice(1).join('=');
 if(!value)return false;try{const data=JSON.parse(decryptSecret(value));return data.id===id&&data.version===version&&data.expires>Date.now();}catch{return false;}
}
export async function accessVideo(request:Request,id:string,user:Actor|null,edit=false){
 const row=(await query(`SELECT v.*,m.role,b.favorite,b.watch_later,s.token AS share_token,s.password_hash,s.version AS share_version,s.allow_download,
 EXISTS(SELECT 1 FROM video_access a WHERE a.video_id=v.id AND a.email=$3) AS explicit_access
 FROM videos v LEFT JOIN memberships m ON m.workspace_id=v.workspace_id AND m.user_id=$2 LEFT JOIN shares s ON s.video_id=v.id
 LEFT JOIN bookmarks b ON b.video_id=v.id AND b.user_id=$2
 WHERE v.id=$1 AND v.deleted_at IS NULL`,[id,user?.id||null,user?.emailVerified?user.email.toLowerCase():null]))[0];
 if(!row)fail(404,'Video not found');
 const context={user,role:row.role,validShare:!!row.share_token&&row.share_token===shareToken(request),unlocked:unlocked(request,id,row.share_version),explicitAccess:row.explicit_access};
 const video={ownerId:row.owner_id,visibility:row.visibility};const editable=canEditVideo(video,context);
 if(edit?!editable:!canReadVideo(video,context))fail(user?403:401,row.visibility==='password'?'This video requires a password':'Video access denied',row.visibility==='password'?'PASSWORD_REQUIRED':'ACCESS_DENIED');
 return {row,editable};
}
export function videoDTO(row:Record<string,any>,share?:string|null){
 const params=new URLSearchParams();if(share)params.set('share',share);if(row.published_revision_id)params.set('version',row.published_revision_id);const suffix=params.size?'?'+params.toString():'';
 return {id:row.id,clientId:row.client_id,workspaceId:row.workspace_id,ownerId:row.owner_id,title:row.title,description:row.description,status:row.status,duration:row.duration,createdAt:row.created_at,updatedAt:row.updated_at,folderId:row.folder_id,archived:row.archived,favorite:row.favorite||false,watchLater:row.watch_later||false,publishedRevisionId:row.published_revision_id,initialRevisionId:row.initial_revision_id,transcriptionMode:row.transcription_mode,transcription:row.transcription,mediaKind:row.media_kind??'video',enhanceAudio:row.enhance_audio??false,visibility:row.visibility,error:row.error,thumbnailUrl:row.published_revision_id?`/api/v1/videos/${row.id}/media/thumbnail.jpg${suffix}`:null,playbackUrl:row.published_revision_id?`/api/v1/videos/${row.id}/media/playback.mp4${suffix}`:null};
}
export function revisionDTO(r:Record<string,any>){return{id:r.id,videoId:r.video_id,status:r.status,createdAt:r.created_at,duration:r.duration,edit:r.edit,error:r.error};}
export function transcriptDTO(r:Record<string,any>|undefined){return r?{id:r.id,videoId:r.video_id,revisionId:r.revision_id,updatedAt:r.updated_at,version:String(r.version??1),language:r.language,segments:r.segments,text:r.text||'',timing:r.timing||'segment',provider:r.provider,model:r.model,userEdited:r.user_edited??false,status:r.status,error:r.error}:null;}
export function aiDTO(r:Record<string,any>|undefined){return r?{revisionId:r.revision_id,title:r.title,summary:r.summary,chapters:r.chapters,actionItems:r.action_items,provider:r.provider,model:r.model,status:r.status,userEdited:r.user_edited,error:r.error,usage:r.usage}:null;}

/** Hold publication and membership stable through a content mutation. */
export async function lockEditableVideo(c:PoolClient,id:string,user:Actor|null){
 if(!user)fail(401,'Sign in to continue');
 const row=(await c.query('SELECT * FROM videos WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!row||row.deleted_at)fail(404,'Video not found');
 const role=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[row.workspace_id,user.id])).rows[0]?.role;
 if(!canEditVideo({ownerId:row.owner_id,visibility:row.visibility},{user,role}))fail(403,'Video access denied');
 return row;
}
