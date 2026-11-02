import type {Clip,Segment} from './policy';

export function mapSourceRangeToOutput(clips:Clip[],sourceVideoId:string,sourceRevisionId:string|undefined,start:number,end:number):Array<{start:number;end:number;clipIndex:number}>{
 return mapRangeToOutput(clips,start,end).filter(range=>clips[range.clipIndex].videoId===sourceVideoId&&clips[range.clipIndex].revisionId===sourceRevisionId);
}
export function mapRangeToOutput(clips:{start:number;end:number}[],start:number,end:number):Array<{start:number;end:number;clipIndex:number}>{
 const result:Array<{start:number;end:number;clipIndex:number}>=[];let offset=0;
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)return result;
 clips.forEach((clip,clipIndex)=>{
   const from=Math.max(start,clip.start),to=Math.min(end,clip.end);
   if(to>from||(start===end&&start>=clip.start&&start<clip.end))result.push({start:offset+from-clip.start,end:offset+to-clip.start,clipIndex});
  offset+=clip.end-clip.start;
 });return result;
}

export function removeSourceRange(clips:Clip[],videoId:string,revisionId:string|undefined,start:number,end:number):Clip[]{
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return clips;
 return clips.flatMap(clip=>{
  if(clip.videoId!==videoId||clip.revisionId!==revisionId||end<=clip.start||start>=clip.end)return [clip];
  const result:Clip[]=[];
  if(start>clip.start)result.push({...clip,end:Math.min(start,clip.end)});
  if(end<clip.end)result.push({...clip,start:Math.max(end,clip.start)});
  return result;
 });
}

export function remapSegments(segments:Segment[],clips:{start:number;end:number}[]):Segment[]{
 const output:Segment[]=[];let offset=0;
 for(const clip of clips){for(const s of segments){const start=Math.max(s.start,clip.start),end=Math.min(s.end,clip.end);if(end<=start)continue;
 const words=s.words?.filter(w=>w.start>=clip.start&&w.end<=clip.end).map(w=>({...w,start:w.start-clip.start+offset,end:w.end-clip.start+offset}));
 // Without word timing, omit partially cut segments rather than leaking removed speech.
 if(!words&&(s.start<clip.start||s.end>clip.end))continue;if(words&&!words.length)continue;
 output.push({...s,start:start-clip.start+offset,end:end-clip.start+offset,text:words?words.map(w=>w.text).join(' '):s.text,...(words?{words}:{})});
 }offset+=clip.end-clip.start;}return output;
}
