import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,access,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { query,closeDatabase } from '../packages/core/src/db';
import { videoRoot } from '../packages/core/src/storage';
import { executeJob,type Job } from '../services/worker/src/jobs';
test('cleanup requires explicit deletion, seven-day retention, and no active edit referencing original',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;const root=await mkdtemp(join(tmpdir(),'relay-cleanup-'));process.env.DATA_DIR=root;
 const user=randomUUID(),workspace=randomUUID(),source=randomUUID(),target=randomUUID(),revision=randomUUID();
 const run=async(payload:object)=>{const [job]=await query<Job>("INSERT INTO jobs(kind,video_id,payload,status,attempts,locked_at,locked_by) VALUES('cleanup',$1,$2,'running',1,now(),$3) RETURNING *",[source,JSON.stringify(payload),randomUUID()]);await executeJob(job);return(await query('SELECT status FROM jobs WHERE id=$1',[job.id]))[0].status;};
 try{
 await query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Cleanup\',$2,true,now(),now())',[user,`${user}@test.local`]);
 await query('INSERT INTO workspaces(id,name) VALUES($1,\'Cleanup\')',[workspace]);
 for(const id of [source,target])await query("INSERT INTO videos(id,client_id,workspace_id,owner_id,title,status) VALUES($1,$2,$3,$4,'Cleanup','ready')",[id,randomUUID(),workspace,user]);
 const original=join(videoRoot(source),'original/source.mp4');await mkdir(join(videoRoot(source),'original'),{recursive:true});await writeFile(original,'retained-original');
 assert.equal(await run({}),'done');await access(original);
 await query('UPDATE videos SET deleted_at=now() WHERE id=$1',[source]);
 assert.equal(await run({deleteMedia:true}),'failed');await access(original);
 await query("UPDATE videos SET deleted_at=now()-interval '8 days' WHERE id=$1",[source]);
 assert.equal(await run({}),'done');await access(original);
 await query('INSERT INTO revisions(id,video_id,edit) VALUES($1,$2,$3)',[revision,target,JSON.stringify({clips:[{videoId:source,start:0,end:1}],blurs:[]})]);
 await query("INSERT INTO jobs(kind,video_id,revision_id) VALUES('render',$1,$2)",[target,revision]);
 assert.equal(await run({deleteMedia:true}),'queued');await access(original);
 await query("UPDATE jobs SET status='failed' WHERE video_id=$1 AND kind='render'",[target]);
 assert.equal(await run({deleteMedia:true}),'done');await assert.rejects(access(original));
 }finally{
 await query('DELETE FROM jobs WHERE video_id=ANY($1::uuid[])',[[source,target]]).catch(()=>{});await query('DELETE FROM videos WHERE id=ANY($1::uuid[])',[[source,target]]).catch(()=>{});await query('DELETE FROM workspaces WHERE id=$1',[workspace]).catch(()=>{});await query('DELETE FROM "user" WHERE id=$1',[user]).catch(()=>{});await closeDatabase();await rm(root,{force:true,recursive:true});
 }
});
