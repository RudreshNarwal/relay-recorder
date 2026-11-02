'use client';
import {useEffect,useRef,useState} from 'react';
import {Pause,Play,RotateCcw,SkipForward} from 'lucide-react';
import {canvasSize,presentationSchema,type Presentation} from '@core/presentation';
import {remapSegments} from '@core/timeline';
import type {Segment} from '@core/policy';
import {api,Blur,Clip,media,time,Transcript,message} from './api';
import {ErrorNote,Modal} from './ui';
import {PresentationLayers} from './presentation-layers';
export function EditPreview({clips,blurs,presentation,onClose}:{clips:Clip[];blurs:Blur[];presentation?:Presentation;onClose:()=>void}){
 const ref=useRef<HTMLVideoElement>(null),shouldPlay=useRef(false);const [index,setIndex]=useState(0),[position,setPosition]=useState(0),[playing,setPlaying]=useState(false),[error,setError]=useState(''),[ended,setEnded]=useState(false),[after,setAfter]=useState(true),[dimensions,setDimensions]=useState({width:1920,height:1080}),[segments,setSegments]=useState<Segment[]>([]);
 const recipe=presentation??presentationSchema.parse({}),clip=clips[index],offset=clips.slice(0,index).reduce((n,c)=>n+c.end-c.start,0),total=clips.reduce((n,c)=>n+c.end-c.start,0);
 const output=canvasSize(dimensions.width,dimensions.height,after?recipe.canvas:'source'),scale=Math.min(output.width/dimensions.width,output.height/dimensions.height),w=dimensions.width*scale/output.width*100,h=dimensions.height*scale/output.height*100;
 useEffect(()=>{const el=ref.current;if(!el||!clip)return;el.src=media(clip.videoId,'playback.mp4')+(clip.revisionId?`?revision=${clip.revisionId}`:'');el.load();},[index,clip?.videoId,clip?.revisionId]);
 useEffect(()=>{if(!recipe.captions.burnIn)return;let live=true;
  const sources=new Map<string,Promise<Transcript|null>>();
  for(const c of clips){const key=`${c.videoId}:${c.revisionId??''}`;if(!sources.has(key))sources.set(key,api<{transcript:Transcript|null}>(`/videos/${c.videoId}/transcript${c.revisionId?`?revision=${c.revisionId}`:''}`).then(r=>r.transcript));}
  Promise.all([...sources].map(async([key,promise])=>[key,await promise] as const)).then(entries=>{
   const data=new Map(entries),mapped:Segment[]=[];let at=0;
   for(const c of clips){const t=data.get(`${c.videoId}:${c.revisionId??''}`);if(!t||t.status!=='ready'||t.timing==='none')throw new Error('Styled captions require ready timed transcripts for every source.');mapped.push(...remapSegments(t.segments,[c]).map(s=>({...s,start:s.start+at,end:s.end+at})));at+=c.end-c.start;}
   if(live)setSegments(mapped);
  }).catch(err=>{if(live)setError(message(err));});return()=>{live=false;};
 },[clips,recipe.captions.burnIn]);
 function next(){if(index>=clips.length-1){ref.current?.pause();setEnded(true);setPlaying(false);shouldPlay.current=false;setPosition(total);}else{shouldPlay.current=playing;setIndex(index+1);}}
 if(!clip)return null;
 return <Modal title="A preview of your story." onClose={onClose} wide><ErrorNote error={error}/><div className="presentation-stage" style={{aspectRatio:`${output.width}/${output.height}`,maxWidth:`${output.width/output.height*55}vh`,marginInline:'auto',background:after?recipe.background:'#000'}}><div className="presentation-source" style={{left:`${(100-w)/2}%`,top:`${(100-h)/2}%`,width:`${w}%`,height:`${h}%`}}><video ref={ref} playsInline onLoadedMetadata={e=>{if(index===0)setDimensions({width:e.currentTarget.videoWidth,height:e.currentTarget.videoHeight});e.currentTarget.currentTime=clip.start;setPosition(offset);if(shouldPlay.current)e.currentTarget.play().catch(()=>setError('Press play to continue the preview.'));}} onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onTimeUpdate={e=>{setPosition(offset+Math.min(clip.end,e.currentTarget.currentTime)-clip.start);if(e.currentTarget.currentTime>=clip.end-.025&&!ended)next();}} onEnded={next} onError={()=>setError('This source could not load. Confirm that the recording and revision are ready.')}/>{blurs.filter(b=>position>=b.start&&position<b.end).map((b,i)=><div className="blur-preview" key={i} style={{left:`${b.x*100}%`,top:`${b.y*100}%`,width:`${b.width*100}%`,height:`${b.height*100}%`}}/>)}</div>{after&&<PresentationLayers recipe={recipe} width={output.width} height={output.height} position={position} segments={segments}/>}</div><div className="row-between" style={{marginTop:17}}><div className="button-row"><button className="button primary" onClick={()=>{const el=ref.current;if(!el)return;if(ended){setEnded(false);shouldPlay.current=true;if(index===0){el.currentTime=clip.start;el.play();}else setIndex(0);}else if(el.paused)el.play().catch(()=>setError('Could not start preview. Try again.'));else el.pause();}}>{ended?<RotateCcw size={14}/>:playing?<Pause size={14}/>:<Play size={14}/>} {ended?'Replay':playing?'Pause':'Play edit'}</button><button className="button" onClick={next} disabled={ended}><SkipForward size={14}/>Next clip</button><button className="button" aria-pressed={after} onClick={()=>setAfter(!after)}>{after?'Show before presentation':'Show presentation'}</button></div><small>{time(position)} / {time(total)}</small></div><p className="help-note">Preview follows clip order, source blurs, canvas and timed layers. Rendering applies audio treatments and final server fonts; review the published version before sharing.</p></Modal>;
}
