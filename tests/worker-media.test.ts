import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { probe, command, renderMedia, remapSegments, captions, assembleParts } from '../services/worker/src/media';

test('clip removal shifts timed words and excludes removed speech', () => {
 const segments=[{start:0,end:4,text:'one two three four',words:[{start:0,end:1,text:'one'},{start:1,end:2,text:'two'},{start:2,end:3,text:'three'},{start:3,end:4,text:'four'}]}];
 assert.deepEqual(remapSegments(segments,[{start:1,end:2},{start:3,end:4}]),[
 {start:0,end:1,text:'two',words:[{start:0,end:1,text:'two'}]},
 {start:1,end:2,text:'four',words:[{start:1,end:2,text:'four'}]}]);
 assert.match(captions([{start:1.25,end:2.5,text:'a --> b <script>'}],'vtt'),/00:00:01\.250 --> 00:00:02\.500/);
 assert.doesNotMatch(captions([{start:0,end:1,text:'<script>'}],'vtt'),/<script>/);
});

test('FFmpeg trims and stitches AV, applies timed blur, emits seekable playback and HLS',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-media-'));
 try {
 const source=join(root,'source.mp4');
 await command('ffmpeg',['-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=4','-f','lavfi','-i','aevalsrc=sin(2*PI*if(lt(t\\,2)\\,440\\,880)*t):s=48000:d=4','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',source]);
 const output=join(root,'revision');
 await renderMedia([{path:source,start:0,end:1},{path:source,start:3,end:4}],output,[{start:0,end:1,x:0.2,y:0.2,width:0.4,height:0.4}],0.5);
 const info=await probe(join(output,'playback.mp4'));
 assert.ok(Math.abs(info.duration-2)<0.15,`duration ${info.duration}`);
 assert.ok(info.hasAudio); assert.equal(info.width,320);
 const pcm=await command('ffmpeg',['-v','error','-i',join(output,'playback.mp4'),'-vn','-ac','1','-ar','16000','-f','s16le','pipe:1']);
 const frequency=(start:number,end:number)=>{let crossings=0;for(let i=Math.floor(start*16000);i<Math.floor(end*16000)-1;i++)if(pcm.readInt16LE(i*2)<=0&&pcm.readInt16LE((i+1)*2)>0)crossings++;return crossings/(end-start);};
 assert.ok(Math.abs(frequency(0.2,0.8)-440)<5);
 assert.ok(Math.abs(frequency(1.2,1.8)-880)<5);
 assert.match(await readFile(join(output,'hls/index.m3u8'),'utf8'),/#EXT-X-ENDLIST/);
 assert.ok((await readFile(join(output,'thumbnail.jpg'))).length>1000);
 const waveform=JSON.parse(await readFile(join(output,'waveform.json'),'utf8'));
 assert.ok(waveform.peaks.length>=2); assert.ok(waveform.peaks.filter((p:number)=>p>0.25).length>waveform.peaks.length*0.8,'audible tone must produce visible waveform energy');
 } finally {await rm(root,{recursive:true,force:true});}
});

test('assembly rejects corrupt upload bytes before creating original',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-parts-'));
 try {
 await writeFile(join(root,'0.part'),'bad');
 await assert.rejects(assembleParts(root,join(root,'original.mp4'),[{index:0,size:3,sha256:createHash('sha256').update('abc').digest('hex')}]),/part/i);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('probe, assembly and render respect an admitted capacity snapshot',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-capacity-'));
 const limits={maxUploadBytes:1000000,maxDurationSeconds:1};
 try{
  const source=join(root,'source.mp4');await command('ffmpeg',['-y','-f','lavfi','-i','color=blue:size=32x32:duration=2','-c:v','libx264',source]);
  await assert.rejects(probe(source,limits),/exceeds 1 seconds/);
  await assert.rejects(renderMedia([{path:source,start:0,end:2}],join(root,'too-long'),[],0,limits),/exceeds 1 seconds/);
  assert.equal((await renderMedia([{path:source,start:0,end:1}],join(root,'accepted'),[],0,limits)).duration,1);
  await writeFile(join(root,'0.part'),'123456');
  await assert.rejects(assembleParts(root,join(root,'original'),[{index:0,size:6,sha256:createHash('sha256').update('123456').digest('hex')}],{...limits,maxUploadBytes:5}),/Invalid upload parts/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('cut through untimed segment or timed word never leaks removed speech',()=>{
 assert.deepEqual(remapSegments([{start:0,end:3,text:'private secret'}],[{start:1,end:2}]),[]);
 assert.deepEqual(remapSegments([{start:0,end:3,text:'private public',words:[{start:0,end:1.5,text:'private'},{start:1.5,end:2,text:'public'}]}],[{start:1,end:2}]),[{start:0,end:1,text:'public',words:[{start:0.5,end:1,text:'public'}]}]);
});
test('hostile playlist disguised as MP4 cannot contact network',async()=>{
 const {createServer}=await import('node:http');let requests=0;
 const server=createServer((_request,response)=>{requests++;response.writeHead(500);response.end('denied');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const root=await mkdtemp(join(tmpdir(),'relay-hostile-'));
 try{const port=(server.address() as {port:number}).port;const file=join(root,'source.mp4');
 await writeFile(file,`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${port}/secret.ts\n#EXT-X-ENDLIST\n`);
 await assert.rejects(probe(file));assert.equal(requests,0);
 }finally{await rm(root,{recursive:true,force:true});await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('4K output keeps captured detail and source duration over six hours is rejected',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-4k-'));
 try{
 const source=join(root,'4k.mp4');await command('ffmpeg',['-y','-f','lavfi','-i','color=blue:size=3840x2160:rate=5:duration=0.2','-c:v','libx264','-preset','ultrafast',source]);
 await renderMedia([{path:source,start:0,end:0.2}],join(root,'out'));
 const info=await probe(join(root,'out/playback.mp4'));assert.equal(info.width,3840);assert.equal(info.height,2160);
 const long=join(root,'long.mp4');await command('ffmpeg',['-y','-f','lavfi','-i','color=blue:size=16x16:rate=1/21601:duration=21601','-frames:v','1','-c:v','libx264',long]);
 await assert.rejects(probe(long),/six hours/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('disguised concat playlist cannot open another local video',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-local-playlist-'));
 try{
 const privateFile=join(root,'private.mp4');await command('ffmpeg',['-y','-f','lavfi','-i','color=red:size=16x16:duration=1','-c:v','libx264',privateFile]);
 const playlist=join(root,'source.mp4');await writeFile(playlist,`ffconcat version 1.0\nfile 'private.mp4'\nduration 1\n`);
 await assert.rejects(probe(playlist),/format|Protocol|Invalid|ffprobe/i);
 }finally{await rm(root,{recursive:true,force:true});}
});
