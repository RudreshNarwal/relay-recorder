import {z} from 'zod';
import {query} from './db';
import {membership} from './access';
import {requireActor,type Actor} from './auth';
import {fail} from './http';
import {speechCapabilities,type TranscriptionSelection,type SpeechProvider} from './transcription';

export const transcriptionSelectionSchema=z.object({execution:z.enum(['device','server']),provider:z.enum(['parakeet','deepgram','assemblyai','openai']),configurationId:z.uuid().optional(),configurationVersion:z.number().int().positive().optional(),language:z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).optional()});
export type SpeechConfiguration={id:string;version:number;provider:Exclude<SpeechProvider,'parakeet'>;model:string;region:string;encrypted_key:string;enabled:boolean;verified_version:number|null;workspace_ids:string[]};
export function speechConfigurationDTO(row:SpeechConfiguration){return{id:row.id,version:row.version,provider:row.provider,model:row.model,region:row.region,enabled:row.enabled,configured:!!row.encrypted_key,verified:row.verified_version===row.version,workspaceIds:row.workspace_ids,capabilities:speechCapabilities(row.provider,row.model)};}
export async function availableTranscription(actor:Actor|null,workspaceId?:string){
 const user=requireActor(actor);
 const base=[{execution:'device' as const,provider:'parakeet' as const,model:'parakeet-tdt-0.6b-v3-coreml',externalAudio:false,capabilities:speechCapabilities('parakeet','nemo-parakeet-tdt-0.6b-v3')},
 {execution:'server' as const,provider:'parakeet' as const,model:'nemo-parakeet-tdt-0.6b-v3',externalAudio:false,capabilities:speechCapabilities('parakeet','nemo-parakeet-tdt-0.6b-v3')}];
 if(!workspaceId)return base;
 await membership(workspaceId,user);
 const rows=await query<SpeechConfiguration>('SELECT * FROM transcription_configurations WHERE enabled AND verified_version=version AND $1=ANY(workspace_ids)',[workspaceId]);
 return [...base,...rows.map(row=>({execution:'server' as const,provider:row.provider,model:row.model,configurationId:row.id,configurationVersion:row.version,region:row.region,externalAudio:true,capabilities:speechCapabilities(row.provider,row.model)}))];
}
export async function resolveRecordingTranscription(input:{transcription?:TranscriptionSelection;transcriptionMode?:'on_device'|'server_api'},workspaceId:string,actor:Actor):Promise<TranscriptionSelection>{
 const requested=input.transcription??{execution:input.transcriptionMode==='on_device'?'device':'server',provider:'parakeet'};
 const legacy=requested.execution==='device'?'on_device':'server_api';
 if(input.transcriptionMode&&input.transcriptionMode!==legacy)fail(400,'Conflicting transcription selections');
 if(requested.execution==='device'&&requested.provider!=='parakeet')fail(400,'Only Parakeet runs on-device');
 const options=await availableTranscription(actor,workspaceId);
 const selected=options.find(s=>s.provider===requested.provider&&s.execution===requested.execution&&('configurationId' in s?s.configurationId:undefined)===requested.configurationId&&('configurationVersion' in s?s.configurationVersion:undefined)===requested.configurationVersion);
 if(!selected)fail(409,'Selected speech configuration is unavailable or changed. Choose it again explicitly.','SPEECH_CONFIGURATION_UNAVAILABLE');
 if(requested.language&&!selected.capabilities.languages.includes(requested.language))fail(400,'This language is not supported by the selected speech configuration');
 return {...requested,model:selected.model};
}
