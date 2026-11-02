import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {query,transaction} from '../db';
import {body,fail,json,limit} from '../http';
import {requireAdmin,type Actor} from '../auth';
import {encryptSecret,decryptSecret} from '../secrets';
import {join} from 'node:path';
import {transcribeAudio,SpeechError,type SpeechCheckpoint} from '../../../../services/worker/src/transcription';
import {SPEECH_MODELS} from '../transcription';
import {speechConfigurationDTO,type SpeechConfiguration} from '../transcription-config';

export async function transcription(request:Request,parts:string[],actor:Actor|null):Promise<Response|null>{
 if(parts[0]!=='admin'||parts[1]!=='transcription')return null;
 const user=requireAdmin(actor);
 if(parts.length===2&&request.method==='GET')return json({configurations:(await query<SpeechConfiguration>('SELECT * FROM transcription_configurations ORDER BY created_at')).map(speechConfigurationDTO),models:SPEECH_MODELS});
 if(parts.length===3&&parts[2]==='test'&&request.method==='POST'){
  const input=await body(request,z.object({id:z.uuid(),expectedVersion:z.number().int().positive()}));await limit('speech-test:'+user.id,5,60);
  const lease=randomUUID();
  const [config]=await query<SpeechConfiguration&{test_state:SpeechCheckpoint}>("UPDATE transcription_configurations SET test_lease=$3,test_running_until=now()+interval '75 seconds' WHERE id=$1 AND version=$2 AND (test_running_until IS NULL OR test_running_until<now()) RETURNING *",[input.id,input.expectedVersion,lease]);
  if(!config)fail(409,'Configuration changed or a connection test is still running');
  const authorize=async()=>{
   const [held]=await query('SELECT 1 FROM transcription_configurations WHERE id=$1 AND version=$2 AND test_lease=$3 AND test_running_until>now()',[input.id,input.expectedVersion,lease]);
   if(!held||!(await query('SELECT 1 FROM instance_admins WHERE user_id=$1',[user.id])).length)throw new SpeechError('Connection test configuration or permission changed');
  };
  try{
   const result=await transcribeAudio({path:join(process.env.APP_ROOT??process.cwd(),'services/worker/fixtures/connection.wav'),duration:3.094,provider:config.provider,model:config.model,region:config.region,apiKey:decryptSecret(config.encrypted_key),configurationVersion:config.version,language:'en',resume:config.test_state,authorize,checkpoint:async value=>{await authorize();await query('UPDATE transcription_configurations SET test_state=test_state||$4::jsonb WHERE id=$1 AND version=$2 AND test_lease=$3',[input.id,input.expectedVersion,lease,JSON.stringify(value)]);}},AbortSignal.timeout(65_000));
   if(!/hello world/i.test(result.text??result.segments.map(s=>s.text).join(' ')))throw new SpeechError('Provider connected, but the known English test phrase was not recognized');
   await authorize();
   await query("UPDATE transcription_configurations SET verified_version=version,test_state='{}' WHERE id=$1 AND version=$2 AND test_lease=$3",[input.id,input.expectedVersion,lease]);
   return json({ok:true,message:'Connection verified with the disclosed English speech fixture.'});
  }catch(error){return json({ok:false,message:error instanceof SpeechError?error.message:'Speech connection test failed. Check the configured credentials.'});}
  finally{await query('UPDATE transcription_configurations SET test_lease=NULL,test_running_until=NULL WHERE id=$1 AND test_lease=$2',[input.id,lease]);}
 }
 if(parts.length===2&&request.method==='PUT'){
  const input=await body(request,z.object({id:z.uuid().optional(),expectedVersion:z.number().int().nonnegative().optional(),provider:z.enum(['deepgram','assemblyai','openai']),model:z.string().max(100),region:z.string().max(30),apiKey:z.string().max(10000).optional(),enabled:z.boolean(),workspaceIds:z.array(z.uuid()).max(100)}));
  const descriptor=SPEECH_MODELS[input.provider];
  if(!descriptor.models.includes(input.model)||!descriptor.regions.includes(input.region))fail(400,'Unsupported speech model or region');
  const workspaces=await query('SELECT id FROM workspaces WHERE id=ANY($1::uuid[])',[input.workspaceIds]);if(workspaces.length!==new Set(input.workspaceIds).size)fail(400,'Unknown workspace');
  const result=await transaction(async client=>{
   const existing=input.id?(await client.query<SpeechConfiguration>('SELECT * FROM transcription_configurations WHERE id=$1 FOR UPDATE',[input.id])).rows[0]:undefined;
   if(input.id&&!existing)fail(404,'Speech configuration not found');
   if(existing&&input.expectedVersion!==existing.version)fail(409,'Speech configuration changed. Reload before saving.');
   if(existing&&existing.provider!==input.provider)fail(400,'Create a separate configuration for another provider');
   const encrypted=input.apiKey?encryptSecret(input.apiKey):existing?.encrypted_key;
   if(!encrypted)fail(400,'A speech API key is required');
   if(input.enabled&&!input.workspaceIds.length)fail(400,'Choose at least one workspace');
   // Every save invalidates the connectivity result; testing must pin this exact version.
   return(await client.query<SpeechConfiguration>(`INSERT INTO transcription_configurations(id,version,provider,model,region,encrypted_key,enabled,workspace_ids)
    VALUES($1,1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET version=transcription_configurations.version+1,model=$3,region=$4,encrypted_key=$5,enabled=$6,workspace_ids=$7,verified_version=NULL,test_state='{}',test_lease=NULL,test_running_until=NULL,updated_at=now() RETURNING *`,[existing?.id??randomUUID(),input.provider,input.model,input.region,encrypted,input.enabled,[...new Set(input.workspaceIds)]])).rows[0];
  });return json({configuration:speechConfigurationDTO(result)});
 }
 return null;
}
