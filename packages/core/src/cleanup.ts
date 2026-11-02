import type {Clip,Segment} from './policy';
import {removeSourceRange} from './timeline';
export type Interval={start:number;end:number};
export type CleanupSuggestion=Interval&{id:string;revisionId:string;transcriptVersion:string|null;kind:'silence'|'filler'|'repeat'|'ramble';confidence:'acoustic-and-energy'|'word-rule'|'model-proposal';reason:string};
export const BALANCED_CLEANUP={minimumSilence:0.6,retainedGap:0.25,speechPadding:0.1};
export function cleanupSuggestions(input:{revisionId:string;transcriptVersion:string|null;duration:number;speech:Interval[];audible:Interval[];segments:Segment[];language?:string}):CleanupSuggestion[]{
 const {duration,speech,audible,segments,revisionId,transcriptVersion}=input;
 if(!Number.isFinite(duration)||duration<=0||!Array.isArray(speech)||!Array.isArray(audible)||speech.length+audible.length>200000)throw new Error('Invalid acoustic evidence');
 const ranges=[...speech,...audible,...segments];
 if(ranges.some(r=>!Number.isFinite(r.start)||!Number.isFinite(r.end)||r.start<0||r.end<=r.start||r.end>duration+0.25))throw new Error('Invalid acoustic timing');
 const protectedRanges:Interval[]=[];
 for(const r of ranges.sort((a,b)=>a.start-b.start)){
  const start=Math.max(0,r.start-BALANCED_CLEANUP.speechPadding),end=Math.min(duration,r.end+BALANCED_CLEANUP.speechPadding),previous=protectedRanges.at(-1);
  if(previous&&start<=previous.end)previous.end=Math.max(previous.end,end);else protectedRanges.push({start,end});
 }
 const suggestions:CleanupSuggestion[]=[];
 const add=(start:number,end:number,kind:CleanupSuggestion['kind'],confidence:CleanupSuggestion['confidence'],reason:string)=>{
  if(end<=start)return;
  suggestions.push({id:`${kind}:${start.toFixed(6)}:${end.toFixed(6)}`,revisionId,transcriptVersion,start,end,kind,confidence,reason});
 };
 let end=0;
 for(const next of [...protectedRanges,{start:duration,end:duration}]){
  if(next.start-end>=BALANCED_CLEANUP.minimumSilence)add(end+BALANCED_CLEANUP.retainedGap/2,next.start-BALANCED_CLEANUP.retainedGap/2,'silence','acoustic-and-energy','No VAD speech, audible signal, or transcript in this gap; retain 250 ms and protect speech edges.');
  end=Math.max(end,next.end);
 }
 // Conservative English candidates only. Contextual repetitions are never treated as fillers.
 if(input.language==='en'){
  const words=segments.flatMap(s=>s.words??[]);
  for(const word of words){
   if(!/^(um+|uh+|erm+)[,.!?]?$/i.test(word.text.trim()))continue;
   if(words.some(other=>other!==word&&other.start<word.end&&other.end>word.start))continue;
   if(segments.some(s=>!s.words?.length&&s.start<word.end&&s.end>word.start))continue;
   add(word.start,word.end,'filler','word-rule','English hesitation with actual word timestamps. Listen before accepting.');
  }
 }
 return suggestions.sort((a,b)=>a.start-b.start).slice(0,10000);
}
export function applyCleanup(clips:Clip[],videoId:string,suggestions:CleanupSuggestion[]):Clip[]{
 return cleanupTimeline(clips,videoId,suggestions).clips;
}
export function cleanupTimeline(clips:Clip[],videoId:string,suggestions:CleanupSuggestion[]):{clips:Clip[];kept:Interval[]}{
 const result:Clip[]=[],kept:Interval[]=[];let offset=0;
 for(const clip of clips){
  const pieces=suggestions.reduce((current,s)=>removeSourceRange(current,videoId,s.revisionId,s.start,s.end),[clip]);
  result.push(...pieces);kept.push(...pieces.map(p=>({start:offset+p.start-clip.start,end:offset+p.end-clip.start})));offset+=clip.end-clip.start;
 }
 return {clips:result,kept};
}
