import {canvasSize,presentationSchema,validatePresentation,type Presentation} from '@core/presentation';
import {presentationASS} from './presentation';
import {captureLimits,HARD_CAPTURE_LIMITS,durationLimitMessage,renderTimeout,type CaptureLimits} from '@core/capabilities';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, open, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Segment } from '@core/policy';
export type { Word, Segment } from '@core/policy';

export class PermanentError extends Error {}
const filterPath=(path:string)=>`'${path.replaceAll('\\','\\\\').replaceAll(':','\\:').replaceAll("'", "'\\''")}'`;
const RNNOISE_MODEL=fileURLToPath(new URL('../models/rnnoise-cb.rnnn',import.meta.url));
export type AudioTreatments={denoise:boolean;normalize:boolean};
/** Voice enhancement: rumble cut plus RNNoise for keyboard, fan and room noise; speech-friendly leveling. */
export function audioTreatments(audio?:AudioTreatments){
 return [...(audio?.denoise?['highpass=f=80',`arnndn=m=${filterPath(RNNOISE_MODEL)}`]:[]),...(audio?.normalize?['dynaudnorm=f=500:g=31:p=0.95:m=10']:[])];
}
export async function command(binary:string,args:string[],options:{timeout?:number}={}):Promise<Buffer> {
 return new Promise((resolve,reject)=>{
 const child=spawn(binary,args,{stdio:['ignore','pipe','pipe']});
 const output:Buffer[]=[]; let stderr=''; let size=0; let timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},options.timeout??30*60_000);
 child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>64*1024*1024){child.kill('SIGKILL');}else output.push(chunk);});
 child.stderr.on('data',(chunk:Buffer)=>{stderr=(stderr+chunk.toString()).slice(-4000);});
 child.on('error',error=>{clearTimeout(timer);reject(error);});
 child.on('close',code=>{clearTimeout(timer);code===0?resolve(Buffer.concat(output)):reject(new PermanentError(timedOut?'Media command timed out':`${binary} failed (${code}): ${stderr}`));});
 });
}
/** Preserve the media clock across AAC priming, stream offsets and silent tails. */
export async function extractAudioWindow(path:string,wav:string,start:number,duration:number){
 if(!Number.isFinite(start)||start<0||!Number.isFinite(duration)||duration<=0||duration>1800)throw new PermanentError('Invalid audio analysis window');
 await command('ffmpeg',['-y','-ss',String(start),'-protocol_whitelist','file,pipe','-format_whitelist','mov','-i',path,'-t',String(duration),'-vn','-af','aresample=async=1:first_pts=0,apad','-ac','1','-ar','16000','-c:a','pcm_s16le',wav]);
}
export type MediaKind='video'|'audio';
export type MediaInfo={kind:'video';duration:number;width:number;height:number;hasAudio:boolean}|{kind:'audio';duration:number;width:1280;height:720;hasAudio:true};
export async function probe(path:string,limits:CaptureLimits=captureLimits(),expectedKind?:MediaKind):Promise<MediaInfo> {
 const info=JSON.parse((await command('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm','-show_streams','-show_format','-of','json',path])).toString());
 const video=info.streams.find((s:any)=>s.codec_type==='video'&&!s.disposition?.attached_pic);
 const audio=info.streams.find((s:any)=>s.codec_type==='audio');
 const duration=Number(info.format.duration);
 if(!Number.isFinite(duration)||duration<=0||duration>limits.maxDurationSeconds)throw new PermanentError('Invalid media duration. '+durationLimitMessage(limits.maxDurationSeconds));
 const kind=video?'video':'audio';
 if(expectedKind&&kind!==expectedKind)throw new PermanentError('Declared media kind does not match the captured streams');
 if(!video){
  if(!audio||!['aac','opus'].includes(audio.codec_name)||!Number.isInteger(audio.channels)||audio.channels<1||audio.channels>8||!Number.isFinite(Number(audio.sample_rate))||Number(audio.sample_rate)<=0||Number(audio.sample_rate)>192000)throw new PermanentError('Audio recording requires a supported AAC or Opus audio stream');
  return {kind:'audio',duration,width:1280,height:720,hasAudio:true};
 }
 if(!Number.isInteger(video.width)||!Number.isInteger(video.height)||video.width<2||video.height<2||video.width>7680||video.height>7680||video.width*video.height>33177600)throw new PermanentError('Video dimensions exceed supported limits');
 return {kind:'video',duration,width:Number(video.width),height:Number(video.height),hasAudio:!!audio};
}
export type Clip={path:string;start:number;end:number};
export type Blur={start:number;end:number;x:number;y:number;width:number;height:number};
export function normalizeSegments(value:unknown,duration:number):Segment[]{
 if(!Array.isArray(value)||value.length>100000)throw new PermanentError('Invalid transcript');
 return value.map((s:any)=>{
 if(!s||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<=s.start||s.end>duration+0.25||typeof s.text!=='string'||s.text.length>20000)throw new PermanentError('Invalid transcript timestamps');
 const result:Segment={start:s.start,end:Math.min(s.end,duration),text:s.text};
 if(s.words)result.words=normalizeSegments(s.words,duration).map(w=>({start:w.start,end:w.end,text:w.text}));
 return result;
 }).sort((a,b)=>a.start-b.start);
}
export { remapSegments } from '@core/policy';
export { captions } from '@core/captions';
export async function assembleParts(uploadRoot:string,destination:string,parts:{index:number;size:number;sha256:string}[],limits:CaptureLimits=captureLimits()){
 if(!Array.isArray(parts)||!parts.length||parts.length>Math.ceil(limits.maxUploadBytes/8388608)||parts.reduce((n,p)=>n+p.size,0)>limits.maxUploadBytes)throw new PermanentError('Invalid upload parts');
 await mkdir(dirname(destination),{recursive:true});const temporary=destination+`.${randomUUID()}.tmp`;
 const file=await open(temporary,'wx');
 try{for(let i=0;i<parts.length;i++){
 const part=parts[i];if(part.index!==i||!Number.isInteger(part.size)||part.size<=0||part.size>8388608||!/^[a-f0-9]{64}$/.test(part.sha256))throw new PermanentError('Invalid part manifest');
 let bytes:Buffer;try{bytes=await readFile(join(uploadRoot,`${i}.part`));}catch{throw new PermanentError(`Missing upload part ${i}`);}
 if(bytes.length!==part.size||createHash('sha256').update(bytes).digest('hex')!==part.sha256)throw new PermanentError(`Corrupt upload part ${i}`);
 await file.write(bytes);
 }await file.sync();await file.close();
 // Completed sources are immutable. Retries validate parts but do not replace an existing source.
 try{await stat(destination);await rm(temporary);}catch{await rename(temporary,destination);const directory=await open(dirname(destination),'r');try{await directory.sync();}finally{await directory.close();}}
 }catch(error){await file.close().catch(()=>{});await rm(temporary,{force:true});throw error;}
}
export async function renderMedia(clips:Clip[],output:string,blurs:Blur[]=[],thumbnailTime=0,limits:CaptureLimits=captureLimits(),presentation?:{recipe:Presentation;segments:Segment[]},audio=presentation?.recipe.audio){
 if(!clips.length||clips.length>100||blurs.length>100)throw new PermanentError('Invalid edit');
 await mkdir(output,{recursive:true});
 const inspected=new Map<string,Awaited<ReturnType<typeof probe>>>();
 for(const clip of clips)if(!inspected.has(clip.path))inspected.set(clip.path,await probe(clip.path,HARD_CAPTURE_LIMITS));
 const infos=clips.map(clip=>inspected.get(clip.path)!);
 const scale=Math.min(1,3840/infos[0].width,3840/infos[0].height);
 const width=Math.max(2,Math.floor(infos[0].width*scale/2)*2);const height=Math.max(2,Math.floor(infos[0].height*scale/2)*2);
 const inputs:string[]=[];const filters:string[]=[];
 clips.forEach((clip,i)=>{
 if(!Number.isFinite(clip.start)||!Number.isFinite(clip.end)||clip.start<0||clip.end<=clip.start||clip.end>infos[i].duration+0.1)throw new PermanentError('Clip exceeds source duration');
 inputs.push('-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm','-i',clip.path);
 const d=clip.end-clip.start;
 const fade=Math.min(.005,d/2);
 const edges=(clip.start>0?`,afade=t=in:d=${fade}`:'')+(clip.end<infos[i].duration-.001?`,afade=t=out:st=${d-fade}:d=${fade}`:'');
 filters.push(infos[i].hasAudio?`[${i}:a:0]atrim=start=${clip.start}:end=${clip.end},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${d}${edges}[sound${i}]`:`anullsrc=r=48000:cl=stereo,atrim=duration=${d}[sound${i}]`);
 if(infos[i].kind==='audio'){
  filters.push(`[sound${i}]asplit[a${i}][waveaudio${i}]`);
  filters.push(`[waveaudio${i}]showwaves=s=${width}x${height}:mode=line:rate=30:colors=0xbca7e8,format=yuva420p[wave${i}]`);
  filters.push(`color=c=0x191526:s=${width}x${height}:r=30:d=${d}[canvas${i}]`);
  filters.push(`[canvas${i}][wave${i}]overlay=shortest=1,setsar=1,format=yuv420p[v${i}]`);
 }else{
  filters.push(`[sound${i}]anull[a${i}]`);
  filters.push(`[${i}:V:0]trim=start=${clip.start}:end=${clip.end},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`);
 }
 });
 filters.push(`${clips.map((_,i)=>`[v${i}][a${i}]`).join('')}concat=n=${clips.length}:v=1:a=1[video0][audio]`);
 const duration=clips.reduce((sum,c)=>sum+c.end-c.start,0);
 if(duration>limits.maxDurationSeconds)throw new PermanentError(durationLimitMessage(limits.maxDurationSeconds));
 const budget={timeout:renderTimeout(duration)};
 blurs.forEach((b,i)=>{
 if(Object.values(b).some(n=>!Number.isFinite(n))||b.start<0||b.end<=b.start||b.end>duration+0.1||b.x<0||b.y<0||b.width<=0||b.height<=0||b.x+b.width>1||b.y+b.height>1)throw new PermanentError('Invalid blur rectangle');
 const x=Math.floor(b.x*width/2)*2,y=Math.floor(b.y*height/2)*2,w=Math.max(2,Math.floor(b.width*width/2)*2),h=Math.max(2,Math.floor(b.height*height/2)*2);
 filters.push(`[video${i}]split[base${i}][crop${i}]`);
 filters.push(`[crop${i}]crop=${w}:${h}:${x}:${y},boxblur=luma_radius=${Math.min(10,Math.floor(Math.min(w,h)/2)-1)}:luma_power=3[blur${i}]`);
 filters.push(`[base${i}][blur${i}]overlay=${x}:${y}:enable='between(t,${b.start},${b.end})'[video${i+1}]`);
 });
 let videoLabel=`video${blurs.length}`,audioLabel='audio',dimensions={width,height};
 if(presentation){
  const recipe=presentationSchema.parse(presentation.recipe);validatePresentation(recipe,duration);dimensions=canvasSize(width,height,recipe.canvas);
  filters.push(`[${videoLabel}]scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease,pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2:color=0x${recipe.background.slice(1)},setsar=1[canvas]`);videoLabel='canvas';
  if(recipe.overlays.length||(recipe.captions.burnIn&&presentation.segments.length)){
   const script=join(output,'presentation.ass');await writeFile(script,presentationASS(recipe,dimensions.width,dimensions.height,presentation.segments));
   filters.push(`[${videoLabel}]ass=filename=${filterPath(script)}[styled]`);videoLabel='styled';
  }
 }
 const treatments=audioTreatments(audio);
 if(treatments.length){filters.push(`[audio]${treatments.join(',')}[treated]`);audioLabel='treated';}
 await command('ffmpeg',['-y',...inputs,'-filter_complex_threads','1','-filter_complex',filters.join(';'),'-map',`[${videoLabel}]`,'-map',`[${audioLabel}]`,'-c:v','libx264','-preset','veryfast','-crf','22','-c:a','aac','-b:a','128k','-movflags','+faststart','-g','60',join(output,'playback.mp4')],budget);
 await mkdir(join(output,'hls'),{recursive:true});
 await command('ffmpeg',['-y','-i',join(output,'playback.mp4'),'-c','copy','-hls_time','4','-hls_playlist_type','vod','-hls_segment_filename',join(output,'hls','segment-%05d.ts'),join(output,'hls/index.m3u8')],budget);
 if(!Number.isFinite(thumbnailTime)||thumbnailTime<0||thumbnailTime>=duration)throw new PermanentError('Invalid thumbnail time');
 await command('ffmpeg',['-y','-ss',String(thumbnailTime),'-i',join(output,'playback.mp4'),'-frames:v','1','-q:v','3',join(output,'thumbnail.jpg')]);
 if(presentation?.recipe.animatedThumbnail)await command('ffmpeg',['-y','-ss',String(thumbnailTime),'-i',join(output,'playback.mp4'),'-t',String(Math.min(3,duration-thumbnailTime)),'-vf','fps=8,scale=320:-2:flags=lanczos','-loop','0',join(output,'thumbnail.gif')]);
 const pcm=await command('ffmpeg',['-v','error','-i',join(output,'playback.mp4'),'-vn','-af','aformat=channel_layouts=mono,aeval=abs(val(0)),aresample=100','-ac','1','-ar','100','-f','f32le','pipe:1'],budget);
 const peaks:number[]=[];for(let i=0;i+4<=pcm.length;i+=4)peaks.push(Math.min(1,Math.abs(pcm.readFloatLE(i))));
 await writeFile(join(output,'waveform.json'),JSON.stringify({duration,samplesPerSecond:100,peaks}));
 return {duration,...dimensions};
}
