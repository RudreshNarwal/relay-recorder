import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {command,probe,renderMedia} from '../services/worker/src/media';
import {DEFAULT_CAPTURE_LIMITS} from '../packages/core/src/capabilities';

test('AAC and Opus audio produce playable canvas, waveform, HLS and stitched video',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-audio-'));
 try{
  for(const [extension,codec] of [['mp4','aac'],['webm','libopus']]){
   const file=join(root,`audio.${extension}`);
   await command('ffmpeg',['-y','-f','lavfi','-i','sine=frequency=440:duration=2','-c:a',codec,file]);
   const info=await probe(file,DEFAULT_CAPTURE_LIMITS,'audio');
   assert.equal(info.kind,'audio');assert.equal(info.hasAudio,true);assert.ok(Math.abs(info.duration-2)<0.1);
   await assert.rejects(probe(file,DEFAULT_CAPTURE_LIMITS,'video'),/kind|video/i);
   await assert.rejects(probe(file,{...DEFAULT_CAPTURE_LIMITS,maxDurationSeconds:1},'audio'),/duration|exceeds/i);
   const output=join(root,extension);
   await renderMedia([{path:file,start:0.5,end:1.5}],output);
   const rendered=await probe(join(output,'playback.mp4'));assert.equal(rendered.kind,'video');assert.equal(rendered.hasAudio,true);
   assert.ok(Math.abs(rendered.duration-1)<0.1);assert.equal(rendered.width,1280);
   const waveform=JSON.parse(await readFile(join(output,'waveform.json'),'utf8'));assert.ok(waveform.peaks.some((v:number)=>v>0.01));
   assert.match(await readFile(join(output,'hls/index.m3u8'),'utf8'),/#EXT-X-ENDLIST/);
   const pcm=await command('ffmpeg',['-v','error','-i',join(output,'playback.mp4'),'-vn','-ac','1','-ar','16000','-f','s16le','pipe:1']);
   let crossings=0;for(let i=3200;i<12799;i++)if(pcm.readInt16LE(i*2)<=0&&pcm.readInt16LE((i+1)*2)>0)crossings++;
   assert.ok(Math.abs(crossings/0.6-440)<5,'canvas rendering must preserve captured audio');
  }
  const video=join(root,'video.mp4');await command('ffmpeg',['-y','-f','lavfi','-i','color=blue:size=160x90:duration=1','-c:v','libx264',video]);
  await assert.rejects(probe(video,DEFAULT_CAPTURE_LIMITS,'audio'),/kind|audio/i);
  await renderMedia([{path:join(root,'audio.mp4'),start:0,end:1},{path:video,start:0,end:1}],join(root,'stitched'));
  assert.ok(Math.abs((await probe(join(root,'stitched/playback.mp4'))).duration-2)<0.1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('audio ingestion rejects truncated media and unsupported containers',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-audio-invalid-'));
 try{
  const file=join(root,'source.mp4');await command('ffmpeg',['-y','-f','lavfi','-i','anullsrc=r=48000:cl=mono','-t','1','-c:a','aac',file]);
  const bytes=await readFile(file);await writeFile(file,bytes.subarray(0,64));
  await assert.rejects(probe(file,DEFAULT_CAPTURE_LIMITS,'audio'));
  await writeFile(file,'#EXTM3U\nhttp://127.0.0.1/private\n');await assert.rejects(probe(file,DEFAULT_CAPTURE_LIMITS,'audio'));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('cut audio edges fade briefly without shifting duration or the retained signal',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-audio-edge-'));
 try{
  const source=join(root,'source.mp4');await command('ffmpeg',['-y','-f','lavfi','-i','aevalsrc=0.5*cos(2*PI*440*t):s=48000:d=2','-c:a','aac',source]);
  await renderMedia([{path:source,start:1,end:1.5}],join(root,'out'));
  const path=join(root,'out/playback.mp4'),pcm=await command('ffmpeg',['-v','error','-i',path,'-vn','-ac','1','-ar','48000','-f','f32le','pipe:1']);
  const rms=(start:number,count:number)=>Math.sqrt(Array.from({length:count},(_,i)=>pcm.readFloatLE((start+i)*4)**2).reduce((a,b)=>a+b,0)/count);
  assert.ok(rms(0,32)<rms(960,960)*.25,'A hard cut must not begin at full waveform amplitude');
  assert.ok(Math.abs((await probe(path)).duration-.5)<.05,'Fades must not move the timeline');
  assert.ok(rms(960,960)>.2,'Retained speech amplitude must survive the short fade');
 }finally{await rm(root,{force:true,recursive:true});}
});
