'use client';
import { useEffect, useRef, useState } from 'react';
import { Captions, Maximize, Pause, Play, Volume2, VolumeX, Video as VideoIcon } from 'lucide-react';
import {defaultBrand,type BrandSettings,type Presentation} from '@core/branding';
import {brandStyle,PlayerActions} from './branding';
import { WatchCollector } from './watch-collector';
import { APIError, api, Blur, json, media, shareQuery, time, Video, Transcript } from './api';
export function Player({ video, transcript, token, videoRef, onTime, blurs = [], embedded = false, branding=defaultBrand, presentation }: {video:Video;transcript:Transcript|null;token?:string;videoRef:React.RefObject<HTMLVideoElement|null>;onTime?:(time:number)=>void;blurs?:Blur[];embedded?:boolean;branding?:BrandSettings;presentation?:Presentation}) {
  const root=useRef<HTMLDivElement>(null); const [playing,setPlaying]=useState(false); const [position,setPosition]=useState(0); const [duration,setDuration]=useState(video.duration||0); const [muted,setMuted]=useState(false); const [captions,setCaptions]=useState(false); const [error,setError]=useState('');
  const captionsAvailable=transcript?.status==='ready'&&transcript.revisionId===video.publishedRevisionId&&transcript.timing!=='none'&&transcript.segments.length>0;
  const captionSource=captionsAvailable?media(video.id,'captions.vtt',token,video.publishedRevisionId||undefined)+`&transcriptVersion=${encodeURIComponent(transcript.updatedAt??transcript.id)}`:undefined;
  useEffect(()=>{setCaptions(false);},[captionSource]);
  useEffect(()=>{
    const element=videoRef.current;if(!element||video.status!=='ready'||!video.publishedRevisionId)return;
    let queue=Promise.resolve(),pending=0,closed=false;
    const collector=new WatchCollector(video.publishedRevisionId,'playback',interval=>{
      if(pending>=6)return;pending++;
      queue=queue.then(async()=>{
        for(let attempt=0;attempt<3;attempt++){
          try{await api(shareQuery(`/videos/${video.id}/watch-intervals`,token),{...json('POST',interval),keepalive:true,signal:AbortSignal.timeout(10000)});return;}
          catch(error){if(error instanceof APIError&&error.status<500)break;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));}
        }
        if(!closed)collector.reset();
      }).finally(()=>{pending--;});
    });
    const sample=()=>collector.sample({position:element.currentTime,wall:performance.timeOrigin+performance.now(),rate:element.playbackRate,playing:!element.paused&&!element.ended,visible:document.visibilityState==='visible',seeking:element.seeking});
    const stop=()=>{sample();collector.stop();};
    const names=['playing','timeupdate','pause','ended','seeking','seeked','ratechange','waiting','stalled'] as const;
    for(const name of names)element.addEventListener(name,sample);
    document.addEventListener('visibilitychange',sample);window.addEventListener('pagehide',stop);
    return()=>{closed=true;stop();for(const name of names)element.removeEventListener(name,sample);document.removeEventListener('visibilitychange',sample);window.removeEventListener('pagehide',stop);};
  },[video.id,video.status,video.publishedRevisionId,token]);
  useEffect(()=>{
    const element=videoRef.current;if(!element||video.status!=='ready'||!video.publishedRevisionId)return;
    let destroyed=false; let dispose:(()=>void)|undefined;setError('');
    if(element.canPlayType('application/vnd.apple.mpegurl')) element.src=media(video.id,'hls/index.m3u8',token,video.publishedRevisionId||undefined);
    else import('hls.js').then(({default:Hls})=>{
      if(destroyed)return;
      if(Hls.isSupported()){const hls=new Hls({enableWorker:true});hls.loadSource(media(video.id,'hls/index.m3u8',token,video.publishedRevisionId||undefined));hls.attachMedia(element);hls.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal){hls.destroy();element.src=media(video.id,'playback.mp4',token,video.publishedRevisionId||undefined);}});dispose=()=>hls.destroy();}
      else element.src=media(video.id,'playback.mp4',token,video.publishedRevisionId||undefined);
    }).catch(()=>{element.src=media(video.id,'playback.mp4',token,video.publishedRevisionId||undefined);});
    return()=>{destroyed=true;dispose?.();};
  },[video.id,video.status,video.publishedRevisionId,token]);
  function seek(value:number){if(videoRef.current)videoRef.current.currentTime=value;setPosition(value);}
  function toggle(){const el=videoRef.current;if(!el)return;if(el.paused)el.play().catch(()=>setError('Playback could not start. Try again.'));else el.pause();}
  if(video.status!=='ready'||!video.publishedRevisionId)return <div className="player"><div className="player-placeholder"><VideoIcon size={40} strokeWidth={1}/>{video.status==='failed'?'This recording needs a little attention.':video.status==='uploading'?'Your recording is still uploading.':'We’re getting your recording ready.'}<br/><small>{video.error||'Playback appears here when processing is complete.'}</small></div></div>;
  return <div className="player" style={brandStyle(branding)} ref={root} tabIndex={0} onKeyDown={e=>{if(e.target!==e.currentTarget)return;if(e.key===' '||e.key==='k'){e.preventDefault();toggle();}if(e.key==='ArrowRight'){e.preventDefault();seek(Math.min(duration,position+5));}if(e.key==='ArrowLeft'){e.preventDefault();seek(Math.max(0,position-5));}}} aria-label="Recording player. Space to play, arrow keys to seek."><video ref={videoRef} playsInline preload="metadata" poster={video.thumbnailUrl||undefined} onClick={toggle} onLoadedMetadata={e=>setDuration(e.currentTarget.duration)} onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)} onTimeUpdate={e=>{const current=e.currentTarget.currentTime;setPosition(current);onTime?.(current);}} onError={e=>{const element=e.currentTarget;if(element.currentSrc.includes('.m3u8')){element.src=media(video.id,'playback.mp4',token,video.publishedRevisionId||undefined);return;}setError('This video could not load or a newer version was published. Reload to get the current version.');}} crossOrigin="use-credentials">{captionSource&&<track key={captionSource} kind="captions" src={captionSource} srcLang={transcript?.language||'und'} label="Transcript" />}</video>{video.mediaKind==='audio'&&<span className="badge" style={{position:'absolute',top:12,left:12,background:'#292138',color:'#e5d9ff'}}>Relay · Audio source</span>}{blurs.filter(b=>position>=b.start&&position<=b.end).map((b,i)=><div className="blur-preview" key={i} style={{left:`${b.x*100}%`,top:`${b.y*100}%`,width:`${b.width*100}%`,height:`${b.height*100}%`}}/>)}{error&&<div style={{position:'absolute',top:15,left:15,right:15,background:'#3e263fe6',padding:12,borderRadius:8,color:'#f0d7ec',fontSize:12}} role="alert">{error}</div>}{!playing&&position===0&&branding.thumbnailStyle==='branded'&&<span className="brand-poster-label">{branding.displayName}</span>}<PlayerActions key={`${video.id}:${video.publishedRevisionId}:${presentation?.version}`} videoId={video.id} token={token} position={position} presentation={presentation}/><div className="player-controls"><input type="range" aria-label="Seek video" min={0} max={duration||1} step="0.1" value={Math.min(position,duration||1)} onChange={e=>seek(Number(e.target.value))}/><div className="controls-row"><button onClick={toggle} aria-label={playing?'Pause':'Play'}>{playing?<Pause size={17}/>:<Play size={17}/>}</button><button aria-label={muted?'Unmute':'Mute'} onClick={()=>{if(videoRef.current)videoRef.current.muted=!muted;setMuted(!muted);}}>{muted?<VolumeX size={16}/>:<Volume2 size={16}/>}</button><span>{time(position)} / {time(duration)}</span><div className="flex-spacer"/><label className="visually-hidden" htmlFor={embedded?'embed-speed':'speed'}>Playback speed</label><select id={embedded?'embed-speed':'speed'} defaultValue="1" onChange={e=>{if(videoRef.current)videoRef.current.playbackRate=Number(e.target.value);}}>{[.5,.75,1,1.25,1.5,2].map(speed=><option key={speed} value={speed}>{speed}×</option>)}</select>{captionsAvailable&&<button aria-label="Toggle captions" aria-pressed={captions} onClick={()=>{const tracks=videoRef.current?.textTracks;if(tracks?.[0])tracks[0].mode=captions?'hidden':'showing';setCaptions(!captions);}}><Captions size={18} color={captions?'#c4a7ff':'currentColor'}/></button>}<button aria-label="Fullscreen" onClick={()=>{if(document.fullscreenElement)document.exitFullscreen();else root.current?.requestFullscreen();}}><Maximize size={17}/></button></div></div></div>;
}
