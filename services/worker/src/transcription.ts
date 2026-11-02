import {stat} from 'node:fs/promises';
import {openAsBlob} from 'node:fs';
import {speechCapabilities,SPEECH_MODELS,type SpeechProvider} from '@core/transcription';
import type {Segment} from '@core/policy';
import {deepgram} from './speech/deepgram';
import {assemblyai} from './speech/assemblyai';
import {openaiSpeech} from './speech/openai';
import {SpeechError,speechJSON,checkedSegments} from './speech/common';
export {SpeechError} from './speech/common';
export type SpeechCheckpoint={submissionStarted?:boolean;remoteJobId?:string};
export type SpeechRequest={path:string;duration:number;provider:SpeechProvider;model:string;region:string;apiKey?:string;configurationVersion:number;language?:string;speakers?:boolean;resume?:SpeechCheckpoint;checkpoint:(value:SpeechCheckpoint)=>Promise<void>;authorize:()=>Promise<void>};
export type SpeechResult={provider:SpeechProvider;model:string;segments:Segment[];text?:string;timing:'word'|'segment'|'none';language?:string;requestId?:string;usage?:unknown};

export async function transcribeAudio(request:SpeechRequest,signal:AbortSignal):Promise<SpeechResult>{
 let capabilities;try{capabilities=speechCapabilities(request.provider,request.model);}catch{throw new SpeechError('Unsupported speech model');}
 if(!SPEECH_MODELS[request.provider].regions.includes(request.region))throw new SpeechError('Unsupported speech region');
 if(!Number.isFinite(request.duration)||request.duration<=0||request.duration>capabilities.maxInputSeconds||(await stat(request.path)).size>capabilities.maxInputBytes)throw new SpeechError('Speech input exceeds configured limits');
 if(request.language&&!capabilities.languages.includes(request.language))throw new SpeechError('Unsupported speech language');
 if(request.provider!=='parakeet'&&!request.apiKey)throw new SpeechError('Speech provider credentials are missing');
 await request.authorize();signal.throwIfAborted();
 switch(request.provider){
  case 'deepgram':return deepgram(request,signal);
  case 'assemblyai':return assemblyai(request,signal);
  case 'openai':return openaiSpeech(request,signal);
  case 'parakeet':{
   const token=process.env.INTERNAL_API_TOKEN;if(!token)throw new SpeechError('INTERNAL_API_TOKEN is required');
   const form=new FormData();form.set('audio',await openAsBlob(request.path,{type:'audio/wav'}),'audio.wav');
   const data=await speechJSON(request,`${(process.env.ASR_URL??'http://127.0.0.1:8100').replace(/\/$/,'')}/transcribe`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:form},signal,3_600_000);
   const segments=checkedSegments(data.segments,request.duration);
   return {provider:'parakeet',model:request.model,segments,text:segments.map(s=>s.text).join(' '),timing:segments.every(s=>s.words?.length)?'word':'segment',language:typeof data.language==='string'?data.language:undefined};
  }
 }
}
