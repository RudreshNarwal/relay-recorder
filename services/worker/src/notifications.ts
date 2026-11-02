import {query} from '@core/db';
import {origin} from '@core/http';
import {MailError,sendMail} from '@core/mail';
import {canReadVideo} from '@core/policy';
const MAX_ATTEMPTS=5;
/** Claim due notification emails with a 5-minute lease; a crashed send retries after the lease (Resend dedupes by id). */
export async function deliverNotificationEmails(batch=20){
 const due=await query<{id:string;user_id:string;video_id:string;body:string;detail:string|null;kind:'comment'|'view';email_attempts:number}>(`UPDATE notifications SET email_attempts=email_attempts+1,email_next_at=now()+interval '5 minutes'
  WHERE id IN (SELECT id FROM notifications WHERE email_state='pending' AND email_next_at<=now() ORDER BY email_next_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING id,user_id,video_id,body,detail,kind,email_attempts`,[batch]);
 for(const n of due){
  try{
   const skip=await skipReason(n);
   if(skip){await query("UPDATE notifications SET email_state='skipped',email_error=$2 WHERE id=$1",[n.id,skip]);continue;}
   const [{email}]=await query<{email:string}>('SELECT email FROM "user" WHERE id=$1',[n.user_id]);
   const text=[n.body+'.',n.detail?`\n“${n.detail}”`:'',`\nOpen the video: ${origin()}/videos/${n.video_id}`,`\nTurn these emails off in Settings → Notifications: ${origin()}/settings`].join('\n');
   await sendMail({to:email,subject:n.body,text,idempotencyKey:`relay-notification/${n.id}`});
   await query("UPDATE notifications SET email_state='sent',email_error=NULL WHERE id=$1",[n.id]);
  }catch(error){
   const final=(error instanceof MailError&&error.permanent)||n.email_attempts>=MAX_ATTEMPTS;
   await query(`UPDATE notifications SET email_state=$2,email_error=$3,email_next_at=now()+make_interval(secs=>$4) WHERE id=$1`,[n.id,final?'failed':'pending',(error as Error).message.slice(0,500),60*2**n.email_attempts]);
  }
 }
 return due.length;
}
/** Preferences and access are checked at send time, so a revoked viewer or a later opt-out is honored. */
async function skipReason(n:{user_id:string;video_id:string;kind:'comment'|'view'}){
 const [r]=await query(`SELECT u.id,u.email,u."emailVerified",v.owner_id,v.visibility,v.deleted_at,m.role,
  EXISTS(SELECT 1 FROM video_access a WHERE a.video_id=v.id AND a.email=lower(u.email)) AS explicit,
  COALESCE(p.comment_email,true) AS comment_email,COALESCE(p.view_email,true) AS view_email
  FROM "user" u JOIN videos v ON v.id=$2 LEFT JOIN memberships m ON m.workspace_id=v.workspace_id AND m.user_id=u.id LEFT JOIN notification_preferences p ON p.user_id=u.id WHERE u.id=$1`,[n.user_id,n.video_id]);
 if(!r)return 'Recipient or video no longer exists';
 if(!(n.kind==='view'?r.view_email:r.comment_email))return 'Recipient turned these emails off';
 if(!r.emailVerified)return 'Recipient email is not verified';
 if(!canReadVideo({ownerId:r.owner_id,visibility:r.visibility,deletedAt:r.deleted_at},{user:{id:r.id,email:r.email,isAdmin:false},role:r.role,validShare:false,unlocked:false,explicitAccess:r.explicit}))return 'Recipient can no longer open this video';
 return null;
}
