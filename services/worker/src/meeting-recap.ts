import {HttpError,fail} from '@core/http';
import {query,transaction} from '@core/db';
import {canEditVideo} from '@core/policy';
import {queueWorkflow} from '@core/workflow-queue';
import {workflowTemplates,emptyWorkflow} from '@core/workflows';

/** Each explicitly enabled recording produces one private draft per published revision. */
export async function queueMeetingRecaps(){
 const candidates=await query(`SELECT v.id FROM videos v JOIN meeting_recap_rules r ON r.video_id=v.id AND r.enabled
  JOIN transcripts t ON t.revision_id=v.published_revision_id AND t.status='ready' AND length(trim(t.text)) BETWEEN 1 AND 100000
  WHERE v.deleted_at IS NULL AND v.status='ready'
  AND EXISTS(SELECT 1 FROM settings WHERE key='ai' AND value->>'enabled'='true')
  AND NOT EXISTS(SELECT 1 FROM meeting_recap_runs run WHERE run.video_id=v.id AND run.revision_id=v.published_revision_id)
  AND NOT EXISTS(SELECT 1 FROM rate_limits l WHERE l.expires_at>now() AND
   ((l.key='workflow-generate:'||r.requested_by AND l.count>=20) OR (l.key='workflow-workspace:'||v.workspace_id::text AND l.count>=100)))
  ORDER BY r.updated_at LIMIT 25`);
 for(const {id} of candidates)try{await transaction(async c=>{
  const video=(await c.query('SELECT * FROM videos WHERE id=$1 FOR UPDATE',[id])).rows[0];
  const rule=(await c.query('SELECT * FROM meeting_recap_rules WHERE video_id=$1 FOR UPDATE',[id])).rows[0];
  if(!video||video.deleted_at||video.status!=='ready'||!rule?.enabled)return;
  if((await c.query('SELECT 1 FROM meeting_recap_runs WHERE video_id=$1 AND revision_id=$2',[id,video.published_revision_id])).rowCount)return;
  const user=(await c.query('SELECT id,email,name FROM "user" WHERE id=$1',[rule.requested_by])).rows[0];
  const role=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[video.workspace_id,rule.requested_by])).rows[0]?.role;
  if(!user||!canEditVideo({ownerId:video.owner_id,visibility:video.visibility},{user,role})){await c.query('UPDATE meeting_recap_rules SET enabled=false,version=version+1 WHERE video_id=$1',[id]);return;}
  for(const [key,max] of [[`workflow-generate:${user.id}`,20],[`workflow-workspace:${video.workspace_id}`,100]] as const){
   const reserved=(await c.query(`INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '1 hour')
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.expires_at<now() THEN 1 ELSE rate_limits.count+1 END,
    expires_at=CASE WHEN rate_limits.expires_at<now() THEN now()+interval '1 hour' ELSE rate_limits.expires_at END RETURNING count`,[key])).rows[0].count;
   if(reserved>max)fail(429,'Meeting recap generation budget reached');
  }
  const template=workflowTemplates.find(t=>t.id==='meeting_recap')!;
  const artifact=(await c.query('INSERT INTO workflow_artifacts(video_id,revision_id,requested_by,template,draft) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,video.published_revision_id,user.id,JSON.stringify(template),JSON.stringify(emptyWorkflow(template))])).rows[0];
  await queueWorkflow(c,artifact,{...user,isAdmin:false},rule.version);
  await c.query('INSERT INTO meeting_recap_runs(video_id,revision_id,artifact_id) VALUES($1,$2,$3)',[id,video.published_revision_id,artifact.id]);
 });}catch(error){if(!(error instanceof HttpError&&[409,429].includes(error.status)))throw error;}
}
