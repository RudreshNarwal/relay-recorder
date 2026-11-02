import {audit} from '../audit';
import {z} from 'zod';
import {query,transaction} from '../db';
import {body,fail,json,uuid,origin,limit} from '../http';
import {accessVideo,shareCookie,lockEditableVideo} from '../access';
import {type Actor} from '../auth';
import {token,hashPassword,verifyPassword} from '../secrets';
import {videoDetail} from './videos';
export async function sharing(request:Request,parts:string[],user:Actor|null):Promise<Response|null>{
 const method=request.method;
 if(parts[0]==='videos'&&parts[2]==='share'){
  const id=uuid(parts[1]);await accessVideo(request,id,user,true);
  if(method==='POST'){
   const input=await body(request,z.object({visibility:z.enum(['private','workspace','unlisted','password','shared']),password:z.string().min(8).max(200).optional(),emails:z.array(z.email()).max(100).optional(),allowDownload:z.boolean().default(true)}));
   if(input.visibility==='password'&&!input.password)fail(400,'Supply a password with at least 8 characters');if(input.visibility==='shared'&&!input.emails?.length)fail(400,'Add at least one recipient');
   const password=input.password?await hashPassword(input.password):null;
   const share=await transaction(async c=>{const current=await lockEditableVideo(c,id,user);await c.query('UPDATE videos SET visibility=$2,updated_at=now() WHERE id=$1',[id,input.visibility]);const s=(await c.query(`INSERT INTO shares(video_id,token,password_hash,allow_download) VALUES($1,$2,$3,$4) ON CONFLICT(video_id) DO UPDATE SET token=EXCLUDED.token,password_hash=EXCLUDED.password_hash,allow_download=EXCLUDED.allow_download,version=shares.version+1 RETURNING *`,[id,token(),password,input.allowDownload])).rows[0];await c.query('DELETE FROM video_access WHERE video_id=$1',[id]);for(const email of new Set(input.emails?.map(x=>x.toLowerCase())||[]))await c.query('INSERT INTO video_access(video_id,email) VALUES($1,$2)',[id,email]);await audit(c,current.workspace_id,user!.id,'share.updated','video',id);return s;});return json({share:{token:share.token,url:`${origin()}/share/${share.token}`,visibility:input.visibility,allowDownload:input.allowDownload,emails:input.emails||[]}});
  }
  if(method==='DELETE'){await transaction(async c=>{const current=await lockEditableVideo(c,id,user);await audit(c,current.workspace_id,user!.id,'share.revoked','video',id);await c.query("UPDATE videos SET visibility='private',updated_at=now() WHERE id=$1",[id]);await c.query('DELETE FROM shares WHERE video_id=$1',[id]);await c.query('DELETE FROM video_access WHERE video_id=$1',[id]);});return json({ok:true});}
 }
 if(parts[0]==='shares'&&parts[1]){
  if(parts[1].length>100)fail(404,'Share not found');const share=(await query('SELECT s.*,v.visibility,v.deleted_at FROM shares s JOIN videos v ON v.id=s.video_id WHERE token=$1',[parts[1]]))[0];if(!share||share.deleted_at||share.visibility==='private')fail(404,'Share not found');
  if(parts[2]==='unlock'&&method==='POST'){
   await limit('share-password:'+share.video_id,20,900);const input=await body(request,z.object({password:z.string().max(200)}));if(share.visibility!=='password'||!share.password_hash||!await verifyPassword(input.password,share.password_hash))fail(403,'Incorrect password');return json({ok:true},200,{'Set-Cookie':shareCookie(share.video_id,share.version)});
  }
  if(parts.length===2&&method==='GET'){const headers=new Headers(request.headers);headers.set('x-share-token',parts[1]);return json(await videoDetail(new Request(request.url,{headers}),share.video_id,user));}
 }
 return null;
}
