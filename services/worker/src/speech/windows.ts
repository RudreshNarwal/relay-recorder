import type {Segment} from '@core/policy';
import {SpeechError} from './common';

export function speechWindows(duration:number,maximum:number,timing:'word'|'segment'|'none'){
 if(!Number.isFinite(duration)||duration<=0||!Number.isFinite(maximum)||maximum<=2)throw new SpeechError('Invalid speech window duration');
 const overlap=timing==='word'?2:0,windows:{start:number;duration:number}[]=[];
 for(let start=0;start<duration;start+=maximum-overlap){
  const seconds=Math.min(maximum,duration-start);windows.push({start,duration:seconds});
  if(start+seconds>=duration)break;
 }
 return windows;
}

export function mergeSpeechOverlap(previous:Segment[],incoming:Segment[],start:number,end:number):Segment[]{
 const middle=(start+end)/2;
 for(const segment of [...previous,...incoming]){
  if(segment.start<end&&segment.end>start&&!segment.words?.length)throw new SpeechError('Overlapping speech requires word timestamps. Choose a word-timed model explicitly to retry.');
 }
 const words=(segments:Segment[])=>segments.flatMap(s=>s.words??[]);
 const left=words(previous),right=words(incoming);
 const normalized=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
 let match:{left:number;right:number;distance:number}|undefined;
 // Match only the same word at the same acoustic position. Identical words at
 // different positions ("very very") must survive. Prefer an anchor before the seam.
 for(let i=0;i<left.length;i++){
  const a=left[i],center=(a.start+a.end)/2;if(center<start||center>end)continue;
  for(let j=0;j<right.length;j++){
   const b=right[j];if(Math.abs(a.start-b.start)>.35||Math.abs(a.end-b.end)>.35||!normalized(a.text)||normalized(a.text)!==normalized(b.text))continue;
   const distance=Math.abs(center-middle)+(center>middle?end-start:0);
   if(!match||distance<match.distance)match={left:i,right:j,distance};
  }
 }
 const retained=(segments:Segment[],side:'left'|'right')=>{
  let index=0;
  return segments.flatMap(s=>{
   if(!s.words?.length)return side==='left'?(s.end<=middle?[s]:[]):(s.start>=middle?[s]:[]);
   const kept=s.words.filter(w=>{const at=index++;return match?(side==='left'?at<=match.left:at>match.right):(side==='left'?(w.start+w.end)/2<middle:(w.start+w.end)/2>=middle);});
   if(!kept.length)return [];if(kept.length===s.words.length)return [s];
   return [{...s,start:kept[0].start,end:kept.at(-1)!.end,text:kept.map(w=>w.text).join(' '),words:kept}];
  });
 };
 return [...retained(previous,'left'),...retained(incoming,'right')];
}
