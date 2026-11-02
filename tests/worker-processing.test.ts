import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { query, closeDatabase } from '../packages/core/src/db';
import { revisionRoot, videoRoot, uploadRoot } from '../packages/core/src/storage';
import { encryptSecret } from '../packages/core/src/secrets';
import { executeJob, type Job } from '../services/worker/src/jobs';
import { command } from '../services/worker/src/media';

test('real worker publishes media, remaps edits, fences stale render, and preserves manually edited AI fields',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
 const data=await mkdtemp(join(tmpdir(),'relay-worker-pipeline-'));process.env.DATA_DIR=data;
 const userId=randomUUID(),workspaceId=randomUUID(),videoId=randomUUID(),initial=randomUUID(),edited=randomUUID(),stale=randomUUID();
 const originalFetch=globalThis.fetch;
 const run=async(kind:Job['kind'],revisionId:string,payload:object={})=>{
 const [job]=await query<Job>("INSERT INTO jobs(kind,video_id,revision_id,payload,status,locked_by,locked_at,attempts) VALUES($1,$2,$3,$4,'running',$5,now(),1) RETURNING *",[kind,videoId,revisionId,JSON.stringify(payload),randomUUID()]);
 await executeJob(job);
 const [result]=await query('SELECT * FROM jobs WHERE id=$1',[job.id]);assert.equal(result.status,'done',result.last_error);
 };
 try{
 await query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[userId,'Pipeline test',`${userId}@test.local`]);
 await query('INSERT INTO workspaces(id,name) VALUES($1,$2)',[workspaceId,'Worker pipeline']);
 await query("INSERT INTO videos(id,client_id,workspace_id,owner_id,title,status,transcription_mode,initial_revision_id) VALUES($1,$2,$3,$4,'Fixture','processing','on_device',$5)",[videoId,randomUUID(),workspaceId,userId,initial]);
 await query('INSERT INTO revisions(id,video_id) VALUES($1,$2)',[initial,videoId]);
 const segments=[{start:0,end:4,text:'one two three four',words:[{start:0,end:1,text:'one'},{start:1,end:2,text:'two'},{start:2,end:3,text:'three'},{start:3,end:4,text:'four'}]}];
 await query("INSERT INTO transcripts(video_id,revision_id,segments,status,user_edited) VALUES($1,$2,$3,'ready',true)",[videoId,initial,JSON.stringify(segments)]);
 const fixture=join(data,'fixture.mp4');
 await command('ffmpeg',['-y','-f','lavfi','-i','testsrc2=size=160x90:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libx264','-c:a','aac',fixture]);
 const bytes=await readFile(fixture),digest=createHash('sha256').update(bytes).digest('hex');await mkdir(uploadRoot(videoId),{recursive:true});await writeFile(join(uploadRoot(videoId),'0.part'),bytes);
 await run('process',initial,{parts:[{index:0,size:bytes.length,sha256:digest}],mimeType:'video/mp4',expectedRevisionId:null});
 let [video]=await query('SELECT * FROM videos WHERE id=$1',[videoId]);assert.equal(video.status,'ready');assert.equal(video.published_revision_id,initial);
 const original=join(videoRoot(videoId),'original/source.mp4');assert.equal(createHash('sha256').update(await readFile(original)).digest('hex'),digest);
 const edit={clips:[{videoId,revisionId:initial,start:1,end:2},{videoId,revisionId:initial,start:3,end:4}],blurs:[],expectedRevisionId:initial};
 await query('INSERT INTO revisions(id,video_id,edit) VALUES($1,$2,$3)',[edited,videoId,JSON.stringify(edit)]);await run('render',edited,{expectedRevisionId:initial});
 [video]=await query('SELECT * FROM videos WHERE id=$1',[videoId]);assert.equal(video.published_revision_id,edited);assert.ok(Math.abs(video.duration-2)<0.1);
 const [transcript]=await query('SELECT segments FROM transcripts WHERE revision_id=$1',[edited]);assert.equal(transcript.segments.map((s:any)=>s.text).join(' '),'two four');
 assert.match(await readFile(join(revisionRoot(videoId,edited),'captions.vtt'),'utf8'),/00:00:01\.000 --> 00:00:02\.000\nfour/);
 await query('INSERT INTO revisions(id,video_id,edit) VALUES($1,$2,$3)',[stale,videoId,JSON.stringify(edit)]);await run('render',stale,{expectedRevisionId:initial});
 [video]=await query('SELECT * FROM videos WHERE id=$1',[videoId]);assert.equal(video.published_revision_id,edited);
 assert.equal(createHash('sha256').update(await readFile(original)).digest('hex'),digest);
 await query("INSERT INTO settings(key,value) VALUES('ai',$1) ON CONFLICT(key) DO UPDATE SET value=$1",[JSON.stringify({provider:'openai',model:'test',enabled:true,encryptedApiKey:encryptSecret('integration-private-key')})]);
 await query("INSERT INTO ai_results(video_id,revision_id,title,action_items,user_edited) VALUES($1,$2,'My edited title','[\"My task\"]','[\"title\",\"actionItems\"]')",[videoId,edited]);
 globalThis.fetch=async()=>new Response(JSON.stringify({id:'chat1',object:'chat.completion',created:123,model:'test',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({title:'Generated title',summary:'Generated summary',chapters:[{start:0,title:'Start'}],actionItems:['Generated task']})},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:5,total_tokens:8}}),{headers:{'content-type':'application/json'}});
 await run('ai',edited);
 const [ai]=await query('SELECT * FROM ai_results WHERE video_id=$1',[videoId]);assert.equal(ai.title,'My edited title');assert.equal(ai.summary,'Generated summary');assert.deepEqual(ai.action_items,['My task']);assert.equal(ai.provider,'openai');assert.ok(ai.usage);

 const originalCut=randomUUID();await query('INSERT INTO revisions(id,video_id,edit) VALUES($1,$2,$3)',[originalCut,videoId,JSON.stringify({clips:[{videoId,start:2,end:3}],blurs:[],expectedRevisionId:edited})]);await run('render',originalCut,{expectedRevisionId:edited});
 const [originalTimeline]=await query('SELECT segments FROM transcripts WHERE revision_id=$1',[originalCut]);assert.equal(originalTimeline.segments[0].text,'three');assert.equal(originalTimeline.segments[0].start,0);assert.equal(originalTimeline.segments[0].end,1);
 const missing=randomUUID();await query("INSERT INTO revisions(id,video_id,status,duration) VALUES($1,$2,'ready',4)",[missing,videoId]);await mkdir(revisionRoot(videoId,missing),{recursive:true});await copyFile(join(revisionRoot(videoId,initial),'playback.mp4'),join(revisionRoot(videoId,missing),'playback.mp4'));
 const partialClips=[{videoId,revisionId:initial,start:0,end:1},{videoId,revisionId:missing,start:1,end:2}];
 const onDevicePartial=randomUUID();await query('INSERT INTO revisions(id,video_id,edit) VALUES($1,$2,$3)',[onDevicePartial,videoId,JSON.stringify({clips:partialClips,blurs:[],expectedRevisionId:originalCut})]);await run('render',onDevicePartial,{expectedRevisionId:originalCut});
 const [incomplete]=await query('SELECT * FROM transcripts WHERE revision_id=$1',[onDevicePartial]);assert.equal(incomplete.status,'failed');assert.match(incomplete.error,/source transcript/i);assert.equal(incomplete.segments[0].text,'one');assert.equal(incomplete.user_edited,true);assert.equal((await query("SELECT * FROM jobs WHERE revision_id=$1 AND kind='transcribe'",[onDevicePartial])).length,0);
 await query("UPDATE videos SET transcription_mode='server_api' WHERE id=$1",[videoId]);
 const serverPartial=randomUUID();await query('INSERT INTO revisions(id,video_id,edit) VALUES($1,$2,$3)',[serverPartial,videoId,JSON.stringify({clips:partialClips,blurs:[],expectedRevisionId:onDevicePartial})]);await run('render',serverPartial,{expectedRevisionId:onDevicePartial});
 const [queuedTranscript]=await query('SELECT * FROM transcripts WHERE revision_id=$1',[serverPartial]);assert.equal(queuedTranscript.status,'failed');assert.equal(queuedTranscript.segments[0].text,'one');assert.equal(queuedTranscript.user_edited,true);assert.equal((await query("SELECT * FROM jobs WHERE revision_id=$1 AND kind='transcribe' AND status='queued'",[serverPartial])).length,0);
 await query("UPDATE transcripts SET segments='[]' WHERE revision_id=$1",[initial]);await query("INSERT INTO transcripts(video_id,revision_id,status,segments) VALUES($1,$2,'ready','[]')",[videoId,missing]);
 const silence=randomUUID();await query('INSERT INTO revisions(id,video_id,edit) VALUES($1,$2,$3)',[silence,videoId,JSON.stringify({clips:partialClips,blurs:[],expectedRevisionId:serverPartial})]);await run('render',silence,{expectedRevisionId:serverPartial});
 const [silentTranscript]=await query('SELECT * FROM transcripts WHERE revision_id=$1',[silence]);assert.equal(silentTranscript.status,'ready');assert.deepEqual(silentTranscript.segments,[]);assert.equal((await query("SELECT * FROM jobs WHERE revision_id=$1 AND kind='transcribe'",[silence])).length,0);

 }finally{
 globalThis.fetch=originalFetch;
 await query('DELETE FROM jobs WHERE video_id=$1',[videoId]).catch(()=>{});await query('DELETE FROM videos WHERE id=$1',[videoId]).catch(()=>{});
 await query('DELETE FROM workspaces WHERE id=$1',[workspaceId]).catch(()=>{});await query('DELETE FROM "user" WHERE id=$1',[userId]).catch(()=>{});await query("DELETE FROM settings WHERE key='ai'").catch(()=>{});
 await closeDatabase();await rm(data,{recursive:true,force:true});
 }
});
