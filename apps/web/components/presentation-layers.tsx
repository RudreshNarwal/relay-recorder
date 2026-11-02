'use client';
import {useMemo} from 'react';
import {presentationCaptionCues,wrapPresentationText,type Presentation} from '@core/presentation';
import type {Segment} from '@core/policy';
export function PresentationLayers({recipe,width,height,position,segments}:{recipe:Presentation;width:number;height:number;position:number;segments:Segment[]}){
 const cues=useMemo(()=>presentationCaptionCues(segments),[segments]);
 const caption=recipe.captions.burnIn?cues.find(s=>position>=s.start&&position<s.end):null,size=Math.round(height*recipe.captions.fontSize);
 const lines=caption?wrapPresentationText(caption.text,Math.max(10,Math.floor(width*.85/(size*.6)))):[];
 const captionY=recipe.captions.position==='top'?height*.05:height*.95-lines.length*size*1.3;
 return <svg className="presentation-layers" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Presentation preview layers" style={{fontFamily:'Noto Sans, sans-serif'}}>
 {recipe.overlays.filter(o=>position>=o.start&&position<o.end).map((o,i)=>{
  const x=o.x*width,y=o.y*height,w=o.width*width,h=o.height*height;
  if(o.kind==='box')return <rect key={i} x={x} y={y} width={w} height={h} fill="none" stroke={o.color} strokeWidth={Math.max(2,height*.005)}/>;
  if(o.kind==='arrow'){const t=Math.max(2,h*.12);return <path key={i} transform={`translate(${x},${y})`} fill={o.color} d={`M0 ${h/2-t/2} L${w*.65} ${h/2-t/2} L${w*.65} 0 L${w} ${h/2} L${w*.65} ${h} L${w*.65} ${h/2+t/2} L0 ${h/2+t/2} Z`}/>;}
  const font=Math.max(8,Math.round(Math.min(height*.05,h/2))),wrapped=wrapPresentationText(o.text,Math.max(4,Math.floor(w/(font*.6)))).slice(0,Math.max(1,Math.floor(h/(font*1.25))));
  return <text key={i} x={x} y={y+font} fill={o.color} fontSize={font}>{wrapped.map((line,j)=><tspan key={j} x={x} dy={j?font*1.25:0}>{line}</tspan>)}</text>;
 })}
 {!!lines.length&&<g><rect x={width*.05} y={captionY-4} width={width*.9} height={lines.length*size*1.3+8} fill={recipe.captions.background}/><text x={width/2} y={captionY+size} textAnchor="middle" fontSize={size} fill={recipe.captions.color}>{lines.map((line,i)=><tspan key={i} x={width/2} dy={i?size*1.3:0}>{line}</tspan>)}</text></g>}
 </svg>;
}
