import {z} from 'zod';
import {requireActor,type Actor} from '../auth';
import {accessVideo,lockEditableVideo} from '../access';
import {query,transaction} from '../db';
import {body,json,uuid,fail,limit} from '../http';

export async function meetings(request:Request,parts:string[],actor:Actor|null){
 if(parts[0]!=='videos'||parts[2]!=='meeting-recap'||parts.length!==3)return null;
 const user=requireActor(actor),id=uuid(parts[1]);await accessVideo(request,id,user,true);
 if(request.method==='PUT'){
  const input=await body(request,z.object({enabled:z.boolean(),expectedVersion:z.number().int().nonnegative()}).strict());
  await limit('meeting-recap:'+user.id,30,3600);
  await transaction(async c=>{
   await lockEditableVideo(c,id,user);
   const old=(await c.query('SELECT * FROM meeting_recap_rules WHERE video_id=$1 FOR UPDATE',[id])).rows[0];
   if((old?.version??0)!==input.expectedVersion)fail(409,'Recap settings changed. Reload before saving.');
   await c.query(`INSERT INTO meeting_recap_rules(video_id,requested_by,enabled) VALUES($1,$2,$3)
    ON CONFLICT(video_id) DO UPDATE SET requested_by=$2,enabled=$3,version=meeting_recap_rules.version+1,updated_at=now()`,[id,user.id,input.enabled]);
  });
 }else if(request.method!=='GET')return null;
 const rule=(await query('SELECT enabled,version FROM meeting_recap_rules WHERE video_id=$1',[id]))[0];
 const [state]=await query(`SELECT v.published_revision_id,t.status AS transcript_status,t.text,
  (SELECT (value->>'enabled')::boolean FROM settings WHERE key='ai') AS ai_enabled,
  a.id AS artifact_id,a.status,a.error FROM videos v LEFT JOIN transcripts t ON t.revision_id=v.published_revision_id
  LEFT JOIN meeting_recap_runs r ON r.video_id=v.id AND r.revision_id=v.published_revision_id
  LEFT JOIN workflow_artifacts a ON a.id=r.artifact_id WHERE v.id=$1`,[id]);
 const waitingFor=rule?.enabled&&!state.artifact_id?(!state.ai_enabled?'Configure a cloud model to generate recaps.':state.transcript_status!=='ready'||!state.text?.trim()?'Waiting for a nonempty transcript.':'Waiting for the worker.'):null;
 return json({enabled:rule?.enabled??false,version:rule?.version??0,artifactId:state.artifact_id??null,status:state.status??null,error:state.error??null,waitingFor});
}
