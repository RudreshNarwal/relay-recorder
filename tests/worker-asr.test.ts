import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,readFile,readdir,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { query,closeDatabase } from '../packages/core/src/db';
import { revisionRoot } from '../packages/core/src/storage';
import { executeJob,type Job } from '../services/worker/src/jobs';
import { command,probe } from '../services/worker/src/media';
const enabled=!!process.env.TEST_DATABASE_URL&&process.env.ASR_LIVE_TEST==='1';
test('worker converts media to private Parakeet HTTP, stores timed captions, and protects corrections',{skip:!enabled},async()=>{
 process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;const root=await mkdtemp(join(tmpdir(),'relay-asr-http-'));process.env.DATA_DIR=root;
 const user=randomUUID(),workspace=randomUUID(),video=randomUUID(),revision=randomUUID();
 const run=async()=>{const [job]=await query<Job>("INSERT INTO jobs(kind,video_id,revision_id,status,attempts,locked_at,locked_by) VALUES('transcribe',$1,$2,'running',1,now(),$3) RETURNING *",[video,revision,randomUUID()]);await executeJob(job);const [state]=await query('SELECT status,last_error FROM jobs WHERE id=$1',[job.id]);assert.equal(state.status,'done',state.last_error);};
 try{
 await query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'ASR test\',$2,true,now(),now())',[user,`${user}@test.local`]);
 await query('INSERT INTO workspaces(id,name) VALUES($1,\'ASR test\')',[workspace]);
 await query("INSERT INTO videos(id,client_id,workspace_id,owner_id,title,status,published_revision_id) VALUES($1,$2,$3,$4,'Speech fixture','ready',$5)",[video,randomUUID(),workspace,user,revision]);
 const directory=revisionRoot(video,revision);await mkdir(directory,{recursive:true});
 await command('ffmpeg',['-y','-f','lavfi','-i','color=blue:size=160x90:rate=24:duration=10','-i',process.env.ASR_TEST_WAV!,'-shortest','-c:v','libx264','-c:a','aac',join(directory,'playback.mp4')]);
 const info=await probe(join(directory,'playback.mp4'));
 await query("INSERT INTO revisions(id,video_id,status,duration) VALUES($1,$2,'ready',$3)",[revision,video,info.duration]);
 await run();const [transcript]=await query('SELECT * FROM transcripts WHERE revision_id=$1',[revision]);
 assert.equal(transcript.status,'ready');assert.match(transcript.segments.map((s:any)=>s.text).join(' '),/hello world/i);
 assert.ok(transcript.segments.every((s:any)=>s.words?.length&&s.start>=0&&s.end<=info.duration));
 assert.match(await readFile(join(directory,'captions.vtt'),'utf8'),/Hello world/i);
 assert.match(await readFile(join(directory,'captions.srt'),'utf8'),/00:00:00,/);
 assert.ok((await readdir(directory)).every(name=>!/^audio\..*\.wav$/.test(name)));
 await query("UPDATE transcripts SET segments='[{\"start\":0,\"end\":1,\"text\":\"Human correction\"}]',user_edited=true WHERE revision_id=$1",[revision]);
 await run();const [corrected]=await query('SELECT segments FROM transcripts WHERE revision_id=$1',[revision]);assert.equal(corrected.segments[0].text,'Human correction');
 }finally{
 await query('DELETE FROM jobs WHERE video_id=$1',[video]).catch(()=>{});await query('DELETE FROM videos WHERE id=$1',[video]).catch(()=>{});await query('DELETE FROM workspaces WHERE id=$1',[workspace]).catch(()=>{});await query('DELETE FROM "user" WHERE id=$1',[user]).catch(()=>{});await closeDatabase();await rm(root,{force:true,recursive:true});
 }
});
