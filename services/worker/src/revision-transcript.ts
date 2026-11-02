import {remapSegments} from '@core/timeline';
import type {Segment} from '@core/policy';

type SourceTranscript={status:string;segments:Segment[];text:string;timing:'word'|'segment'|'none';user_edited:boolean;language:string|null;provider:string|null;model:string|null};
export type TranscriptSource={start:number;end:number;duration:number;transcript?:SourceTranscript};

// Derivatives inherit text and correction protection, never consent to send new
// audio to a provider. Missing speech is explicit and does not erase known text.
export function deriveTranscript(sources:TranscriptSource[]){
 const segments:Segment[]=[],texts:string[]=[],contributors:SourceTranscript[]=[];
 let complete=true,userEdited=false,offset=0,timing:'word'|'segment'|'none'='word';
 for(const source of sources){
  const t=source.transcript;
  if(!t||t.status!=='ready')complete=false;
  if(t){
   contributors.push(t);userEdited ||= t.user_edited;
   if(t.timing==='none'){
    // Untimed text cannot be safely assigned to a retained subsection.
    if(source.start===0&&source.end>=source.duration){texts.push(t.text);if(t.text)timing='none';}
    else if(t.text)complete=false;
   }else{
    const mapped=remapSegments(t.segments,[source]).map(s=>({...s,start:s.start+offset,end:s.end+offset,...(s.words?{words:s.words.map(w=>({...w,start:w.start+offset,end:w.end+offset}))}:{})}));
    segments.push(...mapped);texts.push(mapped.map(s=>s.text).join(' '));
    if(timing==='word'&&t.timing==='segment')timing='segment';
   }
  }
  offset+=source.end-source.start;
 }
 const shared=(field:'language'|'provider'|'model')=>contributors.length&&contributors.every(t=>t[field]===contributors[0][field])?contributors[0][field]:null;
 return {segments,text:texts.filter(Boolean).join(' '),timing,userEdited,language:shared('language'),provider:shared('provider'),model:shared('model'),status:complete?'ready':'failed',error:complete?null:userEdited?'A source transcript is unavailable or lacks cut timestamps. Retained corrections are protected. Complete the source transcripts and render again, or supply a complete corrected transcript.':'A source transcript is unavailable or lacks cut timestamps. Select transcription explicitly for this revision, or complete the source transcripts and render again.'};
}

export type CaptionTranscript=SourceTranscript&{version:string|number};
/** Repeated occurrences must burn the same snapshot; a later correction invalidates every occurrence. */
export async function captureCaptionSources(sources:(Omit<TranscriptSource,'transcript'>&{revisionId:string})[],read:(revisionId:string)=>Promise<CaptionTranscript|undefined>){
 const snapshots=new Map<string,CaptionTranscript>(),versions=new Map<string,string>();
 for(const source of sources)if(!snapshots.has(source.revisionId)){
  const transcript=await read(source.revisionId);
  if(!transcript||transcript.status!=='ready'||transcript.timing==='none')throw new Error('Burned captions require ready timed transcripts for every source');
  snapshots.set(source.revisionId,transcript);versions.set(source.revisionId,String(transcript.version));
 }
 return {versions,sources:sources.map(source=>({...source,transcript:snapshots.get(source.revisionId)!}))};
}
