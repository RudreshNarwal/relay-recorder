import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {query,closeDatabase} from '../packages/core/src/db';
import {revisionRoot} from '../packages/core/src/storage';
import {executeJob,type Job} from '../services/worker/src/jobs';
import {command} from '../services/worker/src/media';

test('rendered speech preserves source consent and correction ownership',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
 const data=await mkdtemp(join(tmpdir(),'relay-revision-speech-'));process.env.DATA_DIR=data;
 const user=randomUUID(),workspace=randomUUID(),a=randomUUID(),b=randomUUID(),ar=randomUUID(),br=randomUUID();
 const run=async(kind:Job['kind'],revision:string,payload:object={})=>{
  const [job]=await query<Job>("INSERT INTO jobs(kind,video_id,revision_id,payload,status,locked_by,locked_at,attempts) VALUES($1,$2,$3,$4,'running',$5,now(),1) RETURNING *",[kind,a,revision,JSON.stringify(payload),randomUUID()]);
  await executeJob(job);return(await query('SELECT * FROM jobs WHERE id=$1',[job.id]))[0];
 };
 const render=async(clips:object[])=>{
  const revision=randomUUID();await query('INSERT INTO revisions(id,video_id,edit) VALUES($1,$2,$3)',[revision,a,JSON.stringify({clips,expectedRevisionId:ar})]);
  const job=await run('render',revision,{expectedRevisionId:ar});assert.equal(job.status,'done',job.last_error);
  return {revision,transcript:(await query('SELECT * FROM transcripts WHERE revision_id=$1',[revision]))[0]};
 };
 try{
  await query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Speech revision test\',$2,true,now(),now())',[user,`${user}@test.local`]);
  await query("INSERT INTO workspaces(id,name) VALUES($1,'Speech revision test')",[workspace]);
  for(const [video,revision,mode] of [[a,ar,'server_api'],[b,br,'on_device']]){
   await query("INSERT INTO videos(id,client_id,workspace_id,owner_id,title,status,duration,initial_revision_id,published_revision_id,transcription_mode) VALUES($1,$2,$3,$4,'Speech fixture','ready',2,$5,$5,$6)",[video,randomUUID(),workspace,user,revision,mode]);
   await query("INSERT INTO revisions(id,video_id,status,duration) VALUES($1,$2,'ready',2)",[revision,video]);
   await mkdir(revisionRoot(video,revision),{recursive:true});
  }
  await query('UPDATE videos SET transcription=$2 WHERE id=$1',[a,JSON.stringify({execution:'server',provider:'deepgram',configurationId:randomUUID(),configurationVersion:1,model:'nova-3'})]);
  await command('ffmpeg',['-y','-f','lavfi','-i','color=size=160x90:duration=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-c:a','aac',join(revisionRoot(a,ar),'playback.mp4')]);
  await copyFile(join(revisionRoot(a,ar),'playback.mp4'),join(revisionRoot(b,br),'playback.mp4'));
  const segments=[{start:0,end:1,text:'Corrected name',words:[{start:0,end:.5,text:'Corrected'},{start:.5,end:1,text:'name'}]}];
  await query("INSERT INTO transcripts(video_id,revision_id,segments,text,timing,provider,model,status,user_edited) VALUES($1,$2,$3,'Corrected name','word','parakeet','v3','ready',true)",[a,ar,JSON.stringify(segments)]);
  const full=await render([{videoId:a,revisionId:ar,start:0,end:1}]);
  const partial=await render([{videoId:a,revisionId:ar,start:0,end:1},{videoId:b,revisionId:br,start:0,end:1}]);
  await t.test('edits keep corrected text, timing and provider metadata',()=>{
   assert.equal(full.transcript.user_edited,true);assert.equal(full.transcript.text,'Corrected name');
   assert.equal(full.transcript.timing,'word');assert.equal(full.transcript.provider,'parakeet');assert.equal(full.transcript.model,'v3');
  });
  await t.test('mixed local-only audio never inherits external transcription consent',async()=>{
   assert.equal((await query("SELECT * FROM jobs WHERE revision_id=$1 AND kind='transcribe'",[partial.revision])).length,0);
   assert.equal(partial.transcript.status,'failed');assert.match(partial.transcript.error,/explicit|correct/i);
  });
  await t.test('missing source speech does not erase corrected spans, even through another edit',async()=>{
   assert.deepEqual(partial.transcript.segments,segments);assert.equal(partial.transcript.user_edited,true);
   const next=await render([{videoId:a,revisionId:partial.revision,start:0,end:2}]);
   assert.deepEqual(next.transcript.segments,segments);assert.equal(next.transcript.user_edited,true);
  });
  await t.test('legacy queued derivative transcription without explicit selection cannot send audio',async()=>{
   await query('UPDATE transcripts SET user_edited=false WHERE revision_id=$1',[partial.revision]);
   await query("DELETE FROM jobs WHERE revision_id=$1 AND kind='transcribe'",[partial.revision]);
   const job=await run('transcribe',partial.revision);
   assert.equal(job.status,'failed');assert.match(job.last_error,/explicit.*revision/i);
   assert.equal((await query('SELECT * FROM transcription_attempts WHERE job_id=$1',[job.id])).length,0);
  });
  await query("UPDATE transcripts SET segments='[]',text='Untimed corrected secret',timing='none' WHERE revision_id=$1",[ar]);
  await t.test('untimed text survives a whole source but never leaks across a partial cut',async()=>{
   const whole=await render([{videoId:a,revisionId:ar,start:0,end:2}]);
   assert.equal(whole.transcript.status,'ready');assert.equal(whole.transcript.text,'Untimed corrected secret');assert.equal(whole.transcript.timing,'none');
   const cut=await render([{videoId:a,revisionId:ar,start:0,end:1}]);
   assert.equal(cut.transcript.text,'');assert.deepEqual(cut.transcript.segments,[]);assert.equal(cut.transcript.status,'failed');
  });
 }finally{await query('DELETE FROM workspaces WHERE id=$1',[workspace]);await query('DELETE FROM "user" WHERE id=$1',[user]);await closeDatabase();await rm(data,{recursive:true,force:true});}
});
