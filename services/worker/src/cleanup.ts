import {openAsBlob} from 'node:fs';
import {rm} from 'node:fs/promises';
import {extractAudioWindow,PermanentError} from './media';
import {speechJSON} from './speech/common';
import {cleanupSuggestions,type Interval} from '@core/cleanup';
import type {Segment} from '@core/policy';

export async function analyzeCleanup(input:{path:string;wav:string;duration:number;revisionId:string;transcriptVersion:string|null;segments:Segment[];language?:string;authorize:()=>Promise<void>},signal:AbortSignal){
 const token=process.env.INTERNAL_API_TOKEN;if(!token)throw new PermanentError('INTERNAL_API_TOKEN is required for acoustic cleanup');
 const speech:Interval[]=[],audible:Interval[]=[];
 try{
  for(let start=0;start<input.duration;start+=1800){
   await input.authorize();signal.throwIfAborted();const seconds=Math.min(1800,input.duration-start);
   await extractAudioWindow(input.path,input.wav,start,seconds);
   const form=new FormData();form.set('audio',await openAsBlob(input.wav,{type:'audio/wav'}),'audio.wav');
   const result=await speechJSON({authorize:input.authorize},`${(process.env.ASR_URL??'http://127.0.0.1:8100').replace(/\/$/,'')}/analyze`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:form},signal);
   for(const [source,target] of [[result.speech,speech],[result.audible,audible]] as [unknown,Interval[]][]){
    if(!Array.isArray(source)||source.length>100000)throw new PermanentError('Invalid acoustic evidence');
    for(const r of source){if(!r||!Number.isFinite(r.start)||!Number.isFinite(r.end)||r.start<0||r.end<=r.start||r.end>seconds)throw new PermanentError('Invalid acoustic timing');target.push({start:start+r.start,end:start+r.end});}
   }
  }
  return cleanupSuggestions({...input,speech,audible});
 }finally{await rm(input.wav,{force:true});}
}
