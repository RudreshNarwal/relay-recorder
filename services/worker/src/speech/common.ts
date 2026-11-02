import {setTimeout as delay} from 'node:timers/promises';
import type {Segment,Word} from '@core/policy';
import type {SpeechRequest,SpeechResult} from '../transcription';

export class SpeechError extends Error {
 constructor(message:string,public retryable=false,public retryAfterSeconds=0){super(message);}
}
export async function speechJSON(request:Pick<SpeechRequest,'authorize'>,url:string,init:RequestInit,signal:AbortSignal,timeout=600_000):Promise<any>{
 await request.authorize();
 signal.throwIfAborted();
 let response:Response;
 try{response=await fetch(url,{...init,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(timeout)])});}
 catch{throw new SpeechError('Speech provider connection failed or timed out',!signal.aborted);}
 if(!response.ok){
  const retryable=response.status===429||response.status>=500;
  const value=response.headers.get('retry-after');const seconds=value&&/^\d+$/.test(value)?Number(value):value?Math.ceil((Date.parse(value)-Date.now())/1000):0;
  await response.body?.cancel();
  throw new SpeechError(`Speech provider rejected the request (${response.status})`,retryable,Number.isFinite(seconds)?Math.max(0,Math.min(300,seconds)):0);
 }
 const reader=response.body?.getReader();if(!reader)throw new SpeechError('Speech provider returned an empty response');
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024**2){await reader.cancel();throw new SpeechError('Speech provider response exceeds limit');}chunks.push(value);}}
 catch(error){if(error instanceof SpeechError)throw error;throw new SpeechError('Speech provider response interrupted',true);}
 finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw new SpeechError('Speech provider returned malformed JSON');}
}
export async function pollDelay(signal:AbortSignal){try{await delay(3000,undefined,{signal});}catch{throw new SpeechError('Speech request canceled');}}
export function transcriptText(value:unknown):string{
 if(typeof value!=='string'||value.length>1_000_000)throw new SpeechError('Speech provider returned invalid text');return value.trim();
}
function speaker(value:unknown):string|undefined{return typeof value==='string'||typeof value==='number'?String(value).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,64)||undefined:undefined;}
export function checkedWords(raw:unknown,duration:number,milliseconds=false):Word[]{
 if(!Array.isArray(raw)||raw.length>100000)throw new SpeechError('Speech provider returned invalid words');
 let previous=0;
 return raw.map(w=>{
  if(!w||typeof w.start!=='number'||typeof w.end!=='number')throw new SpeechError('Speech provider returned invalid timestamps');
  const start=w.start/(milliseconds?1000:1),end=w.end/(milliseconds?1000:1);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<previous||start>=duration||end<=start||end>duration+0.25)throw new SpeechError('Speech provider returned invalid timestamps');previous=start;
  return {start,end:Math.min(end,duration),text:transcriptText(w.text??w.word),...(speaker(w.speaker)?{speaker:speaker(w.speaker)}:{})};
 });
}
export function wordsToSegments(words:Word[]):Segment[]{
 const segments:Segment[]=[];let group:Word[]=[];
 const flush=()=>{if(!group.length)return;segments.push({start:group[0].start,end:Math.max(...group.map(w=>w.end)),text:group.map(w=>w.text).join(' '),words:group,...(group[0].speaker?{speaker:group[0].speaker}:{})});group=[];};
 for(const word of words){if(group.length===12||group.length&&group[0].speaker!==word.speaker)flush();group.push(word);}flush();return segments;
}
export function wordResult(request:SpeechRequest,raw:unknown,text:unknown,milliseconds=false):SpeechResult{
 const words=checkedWords(raw,request.duration,milliseconds),content=transcriptText(text);
 return {provider:request.provider,model:request.model,segments:wordsToSegments(words),text:content,timing:words.length||!content?'word':'none'};
}
export function checkedSegments(raw:unknown,duration:number):Segment[]{
 if(!Array.isArray(raw)||raw.length>100000)throw new SpeechError('Speech provider returned invalid segments');
 return raw.map(s=>{
  const [segment]=checkedWords([{start:s?.start,end:s?.end,text:s?.text,speaker:s?.speaker}],duration);
  const words=s.words?checkedWords(s.words,duration):undefined;
  if(words?.some(w=>w.start<segment.start||w.end>segment.end))throw new SpeechError('Speech provider returned words outside their segment');
  return {...segment,...(words?{words}:{})};
 }).sort((a,b)=>a.start-b.start);
}
