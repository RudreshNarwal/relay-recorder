import {openAsBlob} from 'node:fs';
import type {SpeechRequest} from '../transcription';
import {speechJSON,SpeechError,wordResult} from './common';
export async function deepgram(request:SpeechRequest,signal:AbortSignal){
 const url=new URL('https://api.deepgram.com/v1/listen');
 url.searchParams.set('model',request.model);url.searchParams.set('filler_words','true');url.searchParams.set('punctuate','true');
 if(request.language)url.searchParams.set('language',request.language);else url.searchParams.set('detect_language','true');
 if(request.speakers)url.searchParams.set('diarize','true');
 const data=await speechJSON(request,url.toString(),{method:'POST',headers:{authorization:`Token ${request.apiKey}`,'content-type':'audio/wav'},body:await openAsBlob(request.path,{type:'audio/wav'})},signal);
 const channel=data.results?.channels?.[0],alternative=channel?.alternatives?.[0];if(!alternative)throw new SpeechError('Deepgram returned no transcript result');
 return {...wordResult(request,alternative.words??[],alternative.transcript),language:channel.detected_language,requestId:typeof data.metadata?.request_id==='string'?data.metadata.request_id:undefined,usage:{audioSeconds:request.duration}};
}
