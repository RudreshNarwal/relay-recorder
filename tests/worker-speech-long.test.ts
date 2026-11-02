import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,copyFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {query,closeDatabase} from '../packages/core/src/db';
import {encryptSecret} from '../packages/core/src/secrets';
import {revisionRoot} from '../packages/core/src/storage';
import {executeJob,type Job} from '../services/worker/src/jobs';
import {command} from '../services/worker/src/media';

test('long speech jobs reconcile actual FFmpeg windows and resume legacy remote IDs without resubmitting',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;const root=await mkdtemp(join(tmpdir(),'relay-long-speech-'));process.env.DATA_DIR=root;process.env.ENCRYPTION_KEY='cd'.repeat(32);
 const user=randomUUID(),workspace=randomUUID(),configuration=randomUUID(),videos:string[]=[],originalFetch=globalThis.fetch;
 try{
  await query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Long speech\',$2,true,now(),now())',[user,`${user}@test.local`]);
  await query("INSERT INTO workspaces(id,name) VALUES($1,'Long speech')",[workspace]);await query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,user]);
  await query("INSERT INTO transcription_configurations(id,provider,model,region,encrypted_key,enabled,verified_version,workspace_ids) VALUES($1,'assemblyai','universal-3-5-pro','us',$2,true,1,$3)",[configuration,encryptSecret('long-window-test'),[workspace]]);
  const source=join(root,'long.mp4');
  // Actual 30-minute boundary and tail, with inexpensive 1 fps video and AAC silence.
  await command('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=blue:size=16x16:rate=1:duration=1802','-f','lavfi','-i','anullsrc=r=16000:cl=mono','-t','1802','-c:v','libx264','-preset','ultrafast','-c:a','aac',source]);
  for(const legacy of [false,true]){
   const video=randomUUID(),revision=randomUUID();videos.push(video);
   const selection={execution:'server',provider:'assemblyai',configurationId:configuration,configurationVersion:1};
   await query("INSERT INTO videos(id,client_id,workspace_id,owner_id,title,status,published_revision_id,transcription) VALUES($1,$2,$3,$4,'Long fixture','ready',$5,$6)",[video,randomUUID(),workspace,user,revision,JSON.stringify(selection)]);
   await query("INSERT INTO revisions(id,video_id,status,duration) VALUES($1,$2,'ready',1802)",[revision,video]);
   const dir=revisionRoot(video,revision);await mkdir(dir,{recursive:true});await copyFile(source,join(dir,'playback.mp4'));
   const uploads:number[]=[],polled:string[]=[];let submissions=0;
   globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input));assert.equal(url.hostname,'api.assemblyai.com');assert.equal(new Headers(init?.headers).get('authorization'),'long-window-test');
    if(url.pathname==='/v2/upload'){assert.equal(legacy,false,'Legacy remote IDs must never upload again');uploads.push((init!.body as Blob).size);return Response.json({upload_url:'https://cdn.assemblyai.com/upload/fixture'});}
    if(url.pathname==='/v2/transcript'){assert.equal(legacy,false);submissions++;return Response.json({id:`new-${submissions}`});}
    const remote=url.pathname.split('/').at(-1)!;polled.push(remote);
    const first=remote.endsWith('1'),words=first?[[1797500,1797800,'Well'],[1798100,1798400,'very'],[1798600,1798900,'very'],[1799100,1799400,'useful']]:legacy?[[1000,1500,'indeed']]:[[150,450,'very'],[650,950,'very'],[1150,1450,'useful'],[3000,3500,'indeed']];
    return Response.json({id:remote,status:'completed',text:words.map(w=>w[2]).join(' '),language_code:'en',audio_duration:first?1800:legacy?2:4,words:words.map(([start,end,text])=>({start,end,text,speaker:'A'}))});
   };
   const payload=legacy?{speechWindows:{'0':{remoteJobId:'legacy-1',submissionStarted:true},'1800':{remoteJobId:'legacy-2',submissionStarted:true}}}:{};
   const [job]=await query<Job>("INSERT INTO jobs(kind,video_id,revision_id,payload,status,attempts,locked_at,locked_by) VALUES('transcribe',$1,$2,$3,'running',1,now(),$4) RETURNING *",[video,revision,JSON.stringify(payload),randomUUID()]);
   await executeJob(job);
   const state=(await query('SELECT * FROM jobs WHERE id=$1',[job.id]))[0];assert.equal(state.status,'done',state.last_error);assert.equal(state.payload.speechWindowVersion,legacy?1:2);
   const transcript=(await query('SELECT * FROM transcripts WHERE revision_id=$1',[revision]))[0];assert.equal(transcript.text,'Well very very useful indeed');assert.equal(transcript.timing,'word');
   const words=transcript.segments.flatMap((s:any)=>s.words);assert.deepEqual(words.map((w:any)=>w.start),[1797.5,1798.1,1798.6,legacy?1799.1:1799.15,1801]);
   assert.equal(words.at(-1).end,1801.5);assert.equal(words.at(-1).speaker,`${legacy?1800:1798}:A`);
   assert.match(await readFile(join(dir,'captions.vtt'),'utf8'),/00:30:01\.500/);
   if(legacy){assert.deepEqual(polled,['legacy-1','legacy-2']);assert.equal(submissions,0);}
   else{assert.deepEqual(polled,['new-1','new-2']);assert.equal(uploads.length,2);assert.ok(Math.abs(uploads[0]/32000-1800)<.01,`First WAV bytes: ${uploads[0]}`);assert.ok(Math.abs(uploads[1]/32000-4)<.01,`Tail WAV bytes: ${uploads[1]}`);}
  }
 }finally{
  globalThis.fetch=originalFetch;
  await query('DELETE FROM jobs WHERE video_id=ANY($1::uuid[])',[videos]);await query('DELETE FROM videos WHERE id=ANY($1::uuid[])',[videos]);await query('DELETE FROM transcription_configurations WHERE id=$1',[configuration]);await query('DELETE FROM workspaces WHERE id=$1',[workspace]);await query('DELETE FROM "user" WHERE id=$1',[user]);await closeDatabase();await rm(root,{recursive:true,force:true});
 }
});
