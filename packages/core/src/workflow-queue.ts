import type {PoolClient} from 'pg';
import type {Actor} from './auth';
import {fail} from './http';
import {aiConfigurationFingerprint,type AIConfig} from '../../../services/worker/src/ai';

export async function queueWorkflow(client:PoolClient,artifact:Record<string,any>,user:Actor,recapPolicyVersion?:number){
 if((await client.query("SELECT 1 FROM jobs WHERE kind='workflow' AND resource_key=$1 AND status IN ('queued','running')",[artifact.id])).rowCount)fail(409,'This workflow is already generating');
 const config=(await client.query<{value:AIConfig}>("SELECT value FROM settings WHERE key='ai' FOR SHARE")).rows[0]?.value;
 if(!config?.enabled)fail(409,'Enable a cloud model to generate. Manual drafts remain available.');
 const transcript=(await client.query("SELECT version,text,segments FROM transcripts WHERE revision_id=$1 AND status='ready' FOR SHARE",[artifact.revision_id])).rows[0];
 const text=transcript?.text||transcript?.segments.map((s:any)=>s.text).join(' ');
 if(!text?.trim()||text.length>100000)fail(409,'Workflow generation requires a ready, nonempty transcript of at most 100000 characters');
 await client.query("UPDATE workflow_artifacts SET status='queued',error=NULL,proposal=NULL,transcript_version=$2,requested_by=$3,ai_fingerprint=$4,provider=$5,model=$6,updated_at=now() WHERE id=$1",[artifact.id,String(transcript.version),user.id,aiConfigurationFingerprint(config),config.provider,config.model]);
 await client.query("INSERT INTO jobs(kind,video_id,revision_id,resource_key,payload) VALUES('workflow',$1,$2,$3,$4)",[artifact.video_id,artifact.revision_id,artifact.id,JSON.stringify({artifactId:artifact.id,baseVersion:artifact.version,...(recapPolicyVersion!==undefined?{recapPolicyVersion}:{})})]);
}
