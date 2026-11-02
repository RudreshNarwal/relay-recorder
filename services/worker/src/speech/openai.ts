import {openAsBlob} from 'node:fs';
import type {SpeechRequest,SpeechResult} from '../transcription';
import {speechJSON,transcriptText,checkedSegments} from './common';
export async function openaiSpeech(request:SpeechRequest,signal:AbortSignal):Promise<SpeechResult>{
 const diarized=request.model==='gpt-4o-transcribe-diarize';
 const form=new FormData();form.set('file',await openAsBlob(request.path,{type:'audio/wav'}),'audio.wav');form.set('model',request.model);form.set('response_format',diarized?'diarized_json':'json');
 if(diarized)form.set('chunking_strategy','auto');if(request.language)form.set('language',request.language);
 const data=await speechJSON(request,'https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{authorization:`Bearer ${request.apiKey}`},body:form},signal);
 return {provider:request.provider,model:request.model,text:transcriptText(data.text),segments:diarized?checkedSegments(data.segments,request.duration):[],timing:diarized?'segment':'none',usage:data.usage,requestId:typeof data.id==='string'?data.id:undefined};
}
