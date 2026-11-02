import {z} from 'zod';
import {query,transaction} from '../db';
import {body,fail,json,uuid,limit} from '../http';
import {accessVideo} from '../access';
import {requireActor,type Actor} from '../auth';
import {hashToken,encryptSecret,decryptSecret,token} from '../secrets';
export async function collaboration(request:Request,parts:string[],user:Actor|null):Promise<Response|null>{
 const method=request.method;
 if(parts[0]==='notifications'){
  const u=requireActor(user);
  if(parts[1]==='preferences'){
   if(method==='PUT'){const input=await body(request,z.object({commentEmail:z.boolean(),viewEmail:z.boolean()}).strict());await query('INSERT INTO notification_preferences(user_id,comment_email,view_email) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET comment_email=$2,view_email=$3,updated_at=now()',[u.id,input.commentEmail,input.viewEmail]);}
   else if(method!=='GET')return null;
   const saved=(await query<{commentEmail:boolean;viewEmail:boolean}>('SELECT comment_email AS "commentEmail",view_email AS "viewEmail" FROM notification_preferences WHERE user_id=$1',[u.id]))[0];
   return json({preferences:saved??{commentEmail:true,viewEmail:true}});
  }
  if(method==='GET')return json({notifications:await query('SELECT id,video_id AS "videoId",body,read_at AS "readAt",created_at AS "createdAt" FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[u.id])});
  if(parts[2]==='read'&&method==='POST'){await query('UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2',[uuid(parts[1]),u.id]);return json({ok:true});}
 }
 if(parts[0]==='comments'&&['PATCH','DELETE'].includes(method)){
  const u=requireActor(user);const id=uuid(parts[1]);const row=(await query('SELECT * FROM comments WHERE id=$1',[id]))[0];if(!row)fail(404,'Comment not found');const access=await accessVideo(request,row.video_id,u);if(row.user_id!==u.id&&!access.editable)fail(403,'Cannot edit another person’s comment');
  if(method==='PATCH'){const input=await body(request,z.object({body:z.string().trim().min(1).max(10000)}));await query('UPDATE comments SET body=$2,updated_at=now() WHERE id=$1',[id,input.body]);}else await query('DELETE FROM comments WHERE id=$1',[id]);return json({ok:true});
 }
 if(parts[0]!=='videos'||parts.length<3)return null;const id=uuid(parts[1]);
 if(parts[2]==='comments'&&method==='POST'){
  const u=requireActor(user);const {row}=await accessVideo(request,id,u);await limit('comment:'+u.id,30,60);
  const input=await body(request,z.object({body:z.string().trim().min(1).max(10000),timestamp:z.number().finite().nonnegative().optional(),parentId:z.uuid().optional(),revisionId:z.uuid().optional()}));if(!row.published_revision_id)fail(409,'Video is still processing');const revision=input.revisionId||row.published_revision_id;if(revision!==row.published_revision_id)fail(409,'Video revision changed; reload before commenting');if(input.timestamp!==undefined&&input.timestamp>row.duration)fail(400,'Comment timestamp is outside video');
  const comment=await transaction(async c=>{if(input.parentId&&!(await c.query('SELECT 1 FROM comments c WHERE c.id=$1 AND c.video_id=$2 AND (c.revision_id=$3 OR EXISTS(SELECT 1 FROM revision_comment_anchors a WHERE a.comment_id=c.id AND a.revision_id=$3))',[input.parentId,id,revision])).rows.length)fail(400,'Reply parent is from another video or revision');const r=(await c.query('INSERT INTO comments(video_id,revision_id,user_id,body,timestamp,parent_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[id,revision,u.id,input.body,input.timestamp??null,input.parentId||null])).rows[0];const recipients=new Set<string>([row.owner_id]);if(input.parentId){const parent=(await c.query('SELECT user_id FROM comments WHERE id=$1',[input.parentId])).rows[0];recipients.add(parent.user_id);}recipients.delete(u.id);for(const recipient of recipients)await c.query("INSERT INTO notifications(user_id,video_id,body,kind,detail,email_state,email_next_at) VALUES($1,$2,$3,'comment',$4,'pending',now())",[recipient,id,`${u.name} ${input.parentId?'replied':'commented'} on ${row.title}`,input.body.slice(0,500)]);return r;});return json({comment},201);
 }
 if(parts[2]==='reactions'){
  const u=requireActor(user);await accessVideo(request,id,u);const allowed=['👍','❤️','🎉','😂','👏','👀'];
  if(method==='POST'){const input=await body(request,z.object({emoji:z.enum(allowed as [string,...string[]]),timestamp:z.number().finite().nonnegative().optional()}));await query('INSERT INTO reactions(video_id,user_id,emoji,timestamp) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id,u.id,input.emoji,input.timestamp??null]);return json({ok:true});}
  if(method==='DELETE'){await query('DELETE FROM reactions WHERE video_id=$1 AND user_id=$2 AND emoji=$3',[id,u.id,decodeURIComponent(parts[3]||'')]);return json({ok:true});}
 }
 if(parts[2]==='events'&&method==='POST'){
  const {row}=await accessVideo(request,id,user);const input=await body(request,z.object({sessionId:z.uuid(),event:z.enum(['play','progress','complete']),position:z.number().finite().nonnegative(),duration:z.number().finite().nonnegative(),revisionId:z.uuid().optional()}));const revision=input.revisionId||row.published_revision_id;if(!revision||revision!==row.published_revision_id)fail(409,'Video revision changed');if(input.position>row.duration+1)fail(400,'Playback event outside video');
  let anonymous:string|undefined;const cookie=request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('relay_viewer='))?.slice('relay_viewer='.length);if(cookie){try{const value=JSON.parse(decryptSecret(cookie));if(value.expires>Date.now())anonymous=value.id;}catch{}}
  const created=!anonymous;anonymous??=token();const viewer=hashToken(user?'user:'+user.id:'anonymous:'+anonymous);await limit('event:'+id+':'+viewer,2000,3600);
  await query('INSERT INTO view_events(video_id,revision_id,session_id,viewer_key,event,position,duration) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[id,revision,input.sessionId,viewer,input.event,input.position,row.duration]);
  const value=encryptSecret(JSON.stringify({id:anonymous,expires:Date.now()+30*86400000}));return json({ok:true},200,created?{'Set-Cookie':`relay_viewer=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${new URL(request.url).protocol==='https:'?'; Secure':''}`} :{});
 }
 if(parts[2]==='analytics'&&method==='GET'){
  const {row}=await accessVideo(request,id,user,true);const summary=(await query(`SELECT count(*) FILTER(WHERE event='play')::int AS views,count(DISTINCT viewer_key)::int AS "uniqueViewers",count(DISTINCT session_id) FILTER(WHERE event='complete')::float/NULLIF(count(DISTINCT session_id) FILTER(WHERE event='play'),0) AS "completionRate" FROM view_events WHERE video_id=$1 AND revision_id=$2`,[id,row.published_revision_id]))[0];const timeline=await query('SELECT floor(position)::int AS second,count(DISTINCT session_id)::int AS views FROM view_events WHERE video_id=$1 AND revision_id=$2 GROUP BY floor(position) ORDER BY second',[id,row.published_revision_id]);return json({...summary,measurement:'legacy-approximate',completionRate:Math.min(1,summary.completionRate||0),timeline});
 }
 return null;
}
