import test from 'node:test';
import assert from 'node:assert/strict';

test('presentation rejects out-of-frame layers, invalid timing and unbounded recipes',async()=>{
 const {presentationSchema,validatePresentation,canvasSize}=await import('../packages/core/src/presentation');
 const recipe=presentationSchema.parse({overlays:[{kind:'text',start:1,end:2,x:.1,y:.2,width:.5,height:.2,text:'Review',color:'#ffffff'}]});
 assert.doesNotThrow(()=>validatePresentation(recipe,3));
 assert.throws(()=>validatePresentation({...recipe,overlays:[{...recipe.overlays[0],end:4}]},3));
 assert.throws(()=>presentationSchema.parse({...recipe,background:'red:movie=/etc/passwd'}));
 assert.throws(()=>presentationSchema.parse({...recipe,overlays:[{...recipe.overlays[0],x:.9}]}));
 assert.deepEqual(canvasSize(1920,1080,'portrait'),{width:1080,height:1920});
 assert.deepEqual(canvasSize(1920,1080,'square'),{width:1080,height:1080});
});

test('presentation captions and overlays escape ASS commands and keep timestamps',async()=>{
 const {presentationSchema}=await import('../packages/core/src/presentation');
 const {presentationASS}=await import('../services/worker/src/presentation');
 const recipe=presentationSchema.parse({captions:{burnIn:true,color:'#ffffff',background:'#000000',fontSize:.05,position:'bottom'},overlays:[{kind:'text',start:1,end:2,x:.1,y:.2,width:.5,height:.2,text:'Hello {\\p1} /path',color:'#ff0000'}]});
 const ass=presentationASS(recipe,320,180,[{start:0,end:1,text:'Caption {\\pos(0,0)}'}]);
 assert.match(ass,/0:00:01.00,0:00:02.00/);assert.match(ass,/Hello/);assert.doesNotMatch(ass,/Hello \{\\p1\}/);assert.doesNotMatch(ass,/Caption \{\\pos/);
});

test('timed presentation layers follow a retained clip occurrence after trim and reorder',async()=>{
 const {changeTimeline}=await import('../apps/web/components/editing');
 const clip={videoId:'video',revisionId:'revision',start:0,end:10};
 const overlay={start:8,end:12,kind:'text',text:'Evidence',x:.1,y:.1,width:.5,height:.1,color:'#ffffff'};
 const changed=changeTimeline([clip,clip],[overlay],0,[{clip:{...clip,start:1,end:4},from:1},{clip,from:0}]);
 assert.deepEqual(changed.blurs.map(o=>({start:o.start,end:o.end,text:o.text})),[{start:0,end:1,text:'Evidence'},{start:11,end:13,text:'Evidence'}]);
});

test('presentation renders a portrait canvas, preserves duration and creates a bounded animated thumbnail',async()=>{
 const {mkdtemp,rm,readFile}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {command,renderMedia,probe}=await import('../services/worker/src/media');const {presentationSchema}=await import('../packages/core/src/presentation');
 const root=await mkdtemp(join(tmpdir(),'relay-presentation-'));
 try{
  const source=join(root,'source.mp4'),out=join(root,'out');await command('ffmpeg',['-y','-f','lavfi','-i','color=blue:size=320x180:duration=2','-c:v','libx264',source]);
  await renderMedia([{path:source,start:0,end:2}],out,[],0,undefined,{recipe:presentationSchema.parse({canvas:'portrait',background:'#ff0000',audio:{denoise:true,normalize:true},animatedThumbnail:true}),segments:[]});
  const info=await probe(join(out,'playback.mp4'));assert.equal(info.width,180);assert.equal(info.height,320);assert.ok(Math.abs(info.duration-2)<.1);assert.match((await readFile(join(out,'thumbnail.gif'))).subarray(0,6).toString(),/^GIF89a$/);
  const pixels=await command('ffmpeg',['-v','error','-i',join(out,'playback.mp4'),'-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);assert.ok(pixels[0]>pixels[2],'Red canvas surrounds fitted blue source');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('production FFmpeg burns timed overlays and captions into published media',{skip:process.env.RELAY_PRESENTATION_RENDER!=='1'},async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {command,renderMedia}=await import('../services/worker/src/media');const {presentationSchema}=await import('../packages/core/src/presentation');
 const root=await mkdtemp(join(tmpdir(),'relay-styled-'));
 try{
  const source=join(root,'source.mp4'),out=join(root,'out');await command('ffmpeg',['-y','-f','lavfi','-i','color=black:size=320x180:duration=2','-c:v','libx264',source]);
  await renderMedia([{path:source,start:0,end:2}],out,[],0,undefined,{recipe:presentationSchema.parse({overlays:[{kind:'box',start:.5,end:1.5,x:.1,y:.1,width:.8,height:.7,color:'#ff0000'},{kind:'text',start:.5,end:1.5,x:.2,y:.2,width:.6,height:.3,text:'Café Привет',color:'#ffffff'}],captions:{burnIn:true}}),segments:[{start:.5,end:1.5,text:'Timed caption'}]});
  const frame=async(at:number)=>await command('ffmpeg',['-v','error','-ss',String(at),'-i',join(out,'playback.mp4'),'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
  const dark=await frame(.2),bright=await frame(1),after=await frame(1.8);const count=(b:Buffer)=>Array.from(b).filter(x=>x>90).length;
  assert.ok(count(bright)>count(dark)+1000);assert.ok(count(after)<count(bright)/5,'Timed layers disappear after their end');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('overlapping speech uses identical nonoverlapping presentation cues',async()=>{
 const {presentationCaptionCues}=await import('../packages/core/src/presentation');
 assert.deepEqual(presentationCaptionCues([{start:0,end:2,text:'First speaker'},{start:1,end:3,text:'Second speaker'}]),[
  {start:0,end:1,text:'First speaker'},{start:1,end:2,text:'First speaker\nSecond speaker'},{start:2,end:3,text:'Second speaker'},
 ]);
});

test('repeated clips share one transcript snapshot before burned-caption rendering',async()=>{
 const {captureCaptionSources}=await import('../services/worker/src/revision-transcript');let reads=0;
 const source={revisionId:'same',start:0,end:2,duration:2};
 const snapshot=await captureCaptionSources([source,source],async()=>{reads++;return {status:'ready',version:reads,segments:[{start:0,end:1,text:reads===1?'First snapshot':'Correction'}],text:'Speech',timing:'segment',user_edited:true,language:null,provider:null,model:null};});
 assert.equal(reads,1);assert.equal(snapshot.versions.get('same'),'1');
 assert.deepEqual(snapshot.sources.map(s=>s.transcript?.segments[0].text),['First snapshot','First snapshot']);
});

test('voice enhancement removes broadband noise with the vendored RNNoise model',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {command,renderMedia}=await import('../services/worker/src/media');
 const root=await mkdtemp(join(tmpdir(),'relay-voice-'));
 try{
  const source=join(root,'source.mp4');await command('ffmpeg',['-y','-f','lavfi','-i','color=black:size=160x90:duration=3','-f','lavfi','-i','anoisesrc=c=pink:a=0.2:d=3:r=48000','-shortest','-c:v','libx264','-c:a','aac',source]);
  const rms=async(out:string)=>{const pcm=await command('ffmpeg',['-v','error','-ss','1','-i',join(out,'playback.mp4'),'-vn','-ac','1','-f','f32le','pipe:1']);let sum=0;for(let i=0;i+4<=pcm.length;i+=4)sum+=pcm.readFloatLE(i)**2;return Math.sqrt(sum/(pcm.length/4));};
  await renderMedia([{path:source,start:0,end:3}],join(root,'raw'));
  await renderMedia([{path:source,start:0,end:3}],join(root,'clean'),[],0,undefined,undefined,{denoise:true,normalize:false});
  const raw=await rms(join(root,'raw')),clean=await rms(join(root,'clean'));
  assert.ok(raw>.02,'Fixture contains audible noise');
  assert.ok(clean<raw/4,`Enhancement should cut noise by 12 dB or more (raw ${raw.toFixed(4)}, clean ${clean.toFixed(4)})`);
 }finally{await rm(root,{recursive:true,force:true});}
});
