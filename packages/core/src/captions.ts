import type { Segment } from './policy';
function time(seconds:number,separator:string){const ms=Math.max(0,Math.round(seconds*1000));const h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60;return`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}${separator}${String(ms%1000).padStart(3,'0')}`;}
export function captions(segments:Segment[],format:'vtt'|'srt'){
 const separator=format==='vtt'?'.':',';const cues=segments.filter(s=>s.end>s.start).map((s,i)=>`${format==='srt'?`${i+1}\n`:''}${time(s.start,separator)} --> ${time(s.end,separator)}\n${s.text.replace(/-->/g,'→').replace(/[<>]/g,'').replace(/\r?\n/g,' ')}\n`).join('\n');return(format==='vtt'?'WEBVTT\n\n':'')+cues;
}
