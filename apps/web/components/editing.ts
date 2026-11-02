import type { Blur, Clip } from './api';
import {mapRangeToOutput,mapSourceRangeToOutput} from '../../../packages/core/src/timeline';
export function remapEditEffects(blurs:Blur[],thumbnail:number,kept:{start:number;end:number}[]){
 return {blurs:blurs.flatMap(blur=>mapRangeToOutput(kept,blur.start,blur.end).map(range=>({...blur,start:range.start,end:range.end}))),thumbnail:mapRangeToOutput(kept,thumbnail,thumbnail)[0]?.start??0};
}
// Each new clip identifies its previous occurrence. Matching only source IDs would
// transfer a private-detail mask to the wrong copy when a source appears twice.
export type TimelineChange={clip:Clip;from?:number};
export function changeTimeline<T extends {start:number;end:number}>(previous:Clip[],blurs:T[],thumbnail:number,next:TimelineChange[]){
 const offsets:number[]=[];let total=0;
 for(const clip of previous){offsets.push(total);total+=clip.end-clip.start;}
 let offset=0;let mappedThumbnail:number|undefined;const mappedBlurs:T[]=[];
 for(const {clip,from} of next){
  const old=from===undefined?undefined:previous[from];
  if(old&&old.videoId===clip.videoId&&old.revisionId===clip.revisionId){
   const start=Math.max(old.start,clip.start),end=Math.min(old.end,clip.end);
   const oldStart=offsets[from!]+start-old.start,oldEnd=offsets[from!]+end-old.start;
   const shift=offset+start-clip.start-oldStart;
   if(end>start){
    for(const blur of blurs){const a=Math.max(blur.start,oldStart),b=Math.min(blur.end,oldEnd);if(b>a)mappedBlurs.push({...blur,start:a+shift,end:b+shift});}
    if(mappedThumbnail===undefined&&thumbnail>=oldStart&&thumbnail<oldEnd)mappedThumbnail=thumbnail+shift;
   }
  }
  offset+=clip.end-clip.start;
 }
 return {clips:next.map(item=>item.clip),blurs:mappedBlurs,thumbnail:mappedThumbnail??0};
}
export function validClips(clips:Clip[]):boolean{return clips.length>0&&clips.every(clip=>!!clip.videoId&&Number.isFinite(clip.start)&&Number.isFinite(clip.end)&&clip.start>=0&&clip.end>clip.start);}

export function sourceToEditTime(clips:Clip[],videoId:string,position:number,revisionId?:string):number|null{
 return mapSourceRangeToOutput(clips,videoId,revisionId,position,position)[0]?.start??null;
}
