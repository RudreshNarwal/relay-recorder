import {presentationCaptionCues,wrapPresentationText,type Presentation} from '@core/presentation';
import type {Segment} from '@core/policy';
const assColor=(hex:string)=>'&H00'+hex.slice(5,7)+hex.slice(3,5)+hex.slice(1,3);
const clock=(n:number)=>{const c=Math.round(n*100);return `${Math.floor(c/360000)}:${String(Math.floor(c/6000)%60).padStart(2,'0')}:${String(Math.floor(c/100)%60).padStart(2,'0')}.${String(c%100).padStart(2,'0')}`;};
// ASS has executable layout tags. Full-width punctuation preserves visible text
// without allowing transcript text to create tags, drawing commands or line escapes.
const text=(s:string)=>s.replaceAll('\\','＼').replaceAll('{','｛').replaceAll('}','｝').replace(/[\x00-\x1f]/g,' ');
export function presentationASS(recipe:Presentation,width:number,height:number,segments:Segment[]){
 const size=Math.round(height*recipe.captions.fontSize),margin=Math.round(height*.05);
 const lines=[`[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding`,
 `Style: Caption,Noto Sans,${size},${assColor(recipe.captions.color)},&H000000FF,${assColor(recipe.captions.background)},${assColor(recipe.captions.background)},0,0,0,0,100,100,0,0,3,4,0,${recipe.captions.position==='top'?8:2},${margin},${margin},${margin},1`,
 'Style: Overlay,Noto Sans,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
 '\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
 function event(layer:number,start:number,end:number,style:string,value:string){lines.push(`Dialogue: ${layer},${clock(start)},${clock(end)},${style},,0,0,0,,${value}`);}
 for(const o of recipe.overlays){
  const x=Math.round(o.x*width),y=Math.round(o.y*height),w=Math.round(o.width*width),h=Math.round(o.height*height),color=assColor(o.color);
  const tag=`{\\an7\\pos(${x},${y})\\c${color}\\bord0\\shad0`;
  if(o.kind==='text'){
   const font=Math.max(8,Math.round(Math.min(height*.05,h/2))),wrapped=wrapPresentationText(o.text,Math.max(4,Math.floor(w/(font*.6)))).slice(0,Math.max(1,Math.floor(h/(font*1.25))));
   event(1,o.start,o.end,'Overlay',`${tag}\\fs${font}}${wrapped.map(text).join('\\N')}`);
  }else if(o.kind==='box'){
   const t=Math.max(2,Math.round(height*.005));
   for(const [a,b,c,d] of [[0,0,w,t],[0,h-t,w,h],[0,t,t,h-t],[w-t,t,w,h-t]])event(1,o.start,o.end,'Overlay',`${tag}\\p1}m ${a} ${b} l ${c} ${b} ${c} ${d} ${a} ${d}{\\p0}`);
  }else{
   const t=Math.max(2,h*.12);
   event(1,o.start,o.end,'Overlay',`${tag}\\p1}m 0 ${h/2-t/2} l ${w*.65} ${h/2-t/2} ${w*.65} 0 ${w} ${h/2} ${w*.65} ${h} ${w*.65} ${h/2+t/2} 0 ${h/2+t/2}{\\p0}`);
  }
 }
 if(recipe.captions.burnIn){
  if(segments.length>10000)throw new Error('Burned captions exceed the 10000-segment rendering budget');
  for(const segment of presentationCaptionCues(segments)){const wrapped=wrapPresentationText(segment.text,Math.max(10,Math.floor(width*.85/(size*.6))));event(2,segment.start,segment.end,'Caption',wrapped.map(text).join('\\N'));}
 }
 return lines.join('\n')+'\n';
}
