import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {command,extractAudioWindow} from '../services/worker/src/media';

test('analysis PCM keeps delayed audio at its video timestamp and pads the exact window tail',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-audio-clock-'));
 try{
  const source=join(root,'offset.mp4'),wav=join(root,'window.wav');
  await command('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=size=16x16:rate=10:duration=2','-itsoffset','0.4','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=0.4','-c:v','libx264','-preset','ultrafast','-c:a','aac',source]);
  for(const start of [0,.6]){
   const duration=start===0?2:1;await extractAudioWindow(source,wav,start,duration);
   const bytes=await command('ffmpeg',['-v','error','-i',wav,'-f','f32le','pipe:1']),samples=Array.from({length:bytes.length/4},(_,i)=>bytes.readFloatLE(i*4));
   assert.equal(samples.length,16000*duration);
   const first=samples.findIndex(x=>Math.abs(x)>.03)/16000,last=samples.findLastIndex(x=>Math.abs(x)>.03)/16000;
   assert.ok(Math.abs(first-(start===0?.4:0))<.02,`audio begins at ${first}`);
   assert.ok(Math.abs(last-(start===0?.8:.2))<.03,`audio ends at ${last}`);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
