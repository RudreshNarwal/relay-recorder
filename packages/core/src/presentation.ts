import {z} from 'zod';
export const colorSchema=z.string().regex(/^#[0-9a-f]{6}$/i);
export const overlaySchema=z.object({kind:z.enum(['text','arrow','box']),start:z.number().finite().nonnegative(),end:z.number().finite().positive(),x:z.number().min(0).max(1),y:z.number().min(0).max(1),width:z.number().positive().max(1),height:z.number().positive().max(1),text:z.string().max(400).default(''),color:colorSchema.default('#ffffff')}).strict().refine(o=>o.x+o.width<=1.000001&&o.y+o.height<=1.000001&&o.end>o.start,'Overlay must fit inside the frame and have positive duration');
export const presentationSchema=z.object({version:z.literal(1).default(1),canvas:z.enum(['source','landscape','portrait','square']).default('source'),background:colorSchema.default('#17141f'),overlays:z.array(overlaySchema).max(30).default([]),captions:z.object({burnIn:z.boolean().default(false),color:colorSchema.default('#ffffff'),background:colorSchema.default('#17141f'),fontSize:z.number().min(.025).max(.09).default(.045),position:z.enum(['top','bottom']).default('bottom')}).strict().default({burnIn:false,color:'#ffffff',background:'#17141f',fontSize:.045,position:'bottom'}),audio:z.object({denoise:z.boolean().default(false),normalize:z.boolean().default(false)}).strict().default({denoise:false,normalize:false}),animatedThumbnail:z.boolean().default(false)}).strict();
export type Presentation=z.infer<typeof presentationSchema>;
export type PresentationOverlay=z.infer<typeof overlaySchema>;
export function validatePresentation(recipe:Presentation,duration:number){
 if(recipe.overlays.some(o=>o.end>duration+.001))throw new Error('An overlay is outside the edited timeline');
}
export function canvasSize(width:number,height:number,canvas:Presentation['canvas']){
 const even=(n:number)=>Math.max(2,Math.floor(n/2)*2),short=Math.min(width,height);
 if(canvas==='square')return {width:even(short),height:even(short)};
 if(canvas==='portrait')return {width:even(short),height:even(short*16/9)};
 if(canvas==='landscape')return {width:even(short*16/9),height:even(short)};
 return {width:even(width),height:even(height)};
}
export function wrapPresentationText(text:string,columns:number){
 return text.replaceAll('\r','').split('\n').flatMap(line=>{
  const chars=Array.from(line),lines:string[]=[];while(chars.length){let end=Math.min(columns,chars.length);if(end<chars.length){const space=chars.slice(0,end).lastIndexOf(' ');if(space>columns/2)end=space+1;}lines.push(chars.splice(0,end).join('').trimEnd());}return lines.length?lines:[''];
 });
}

/** Split overlaps once so preview and libass render the same visible text at every timestamp. */
export function presentationCaptionCues(segments:{start:number;end:number;text:string}[]){
 if(segments.length>10000)throw new Error('Burned captions exceed the 10000-segment rendering budget');
 const events=segments.flatMap((s,index)=>[{at:s.start,index,start:true},{at:s.end,index,start:false}]).sort((a,b)=>a.at-b.at);
 const active=new Set<number>(),cues:{start:number;end:number;text:string}[]=[];
 for(let i=0;i<events.length;){
  const at=events[i].at;
  while(i<events.length&&events[i].at===at){const event=events[i++];if(event.start)active.add(event.index);else active.delete(event.index);}
  if(active.size>20)throw new Error('More than 20 simultaneous caption segments cannot be presented legibly');
  const next=events[i]?.at;
  if(active.size&&next>at)cues.push({start:at,end:next,text:[...active].sort((a,b)=>a-b).map(index=>segments[index].text).join('\n')});
 }
 return cues;
}
