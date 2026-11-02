import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeDatabase, query } from '../packages/core/src/db';
import { claimJob, reapExpiredJobs } from '../services/worker/src/jobs';
const enabled=!!process.env.TEST_DATABASE_URL;
test('parallel claims isolate jobs, stale leases recover, exhausted lease updates failed media', {skip:!enabled},async()=>{
 process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
 const userId=randomUUID();const workspaceId=randomUUID();const videoId=randomUUID();const revisionId=randomUUID();const jobId=randomUUID();
 try{
 await query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[userId,'Worker test',`${userId}@test.local`]);
 await query('INSERT INTO workspaces(id,name) VALUES($1,$2)',[workspaceId,'Worker test']);
 await query("INSERT INTO videos(id,client_id,workspace_id,owner_id,title,status) VALUES($1,$2,$3,$4,'Worker fixture','processing')",[videoId,randomUUID(),workspaceId,userId]);
 await query('INSERT INTO revisions(id,video_id) VALUES($1,$2)',[revisionId,videoId]);
 await query("INSERT INTO jobs(id,kind,video_id,revision_id) VALUES($1,'process',$2,$3)",[jobId,videoId,revisionId]);
 const claimed=await Promise.all([claimJob('worker-test-a'),claimJob('worker-test-b')]);
 assert.equal(claimed.filter(j=>j?.id===jobId).length,1);
 await query("UPDATE jobs SET locked_at=now()-interval '3 minutes' WHERE id=$1",[jobId]);
 const reclaimed=await claimJob('worker-test-recovery');assert.equal(reclaimed?.id,jobId);assert.equal(reclaimed?.attempts,2);
 await query("UPDATE jobs SET locked_at=now()-interval '3 minutes',attempts=max_attempts WHERE id=$1",[jobId]);
 await reapExpiredJobs();
 const [job]=await query('SELECT status FROM jobs WHERE id=$1',[jobId]);assert.equal(job.status,'failed');
 const [video]=await query('SELECT status FROM videos WHERE id=$1',[videoId]);assert.equal(video.status,'failed');
 const [revision]=await query('SELECT status FROM revisions WHERE id=$1',[revisionId]);assert.equal(revision.status,'failed');
 }finally{
 await query('DELETE FROM jobs WHERE video_id=$1',[videoId]).catch(()=>{});await query('DELETE FROM videos WHERE id=$1',[videoId]).catch(()=>{});
 await query('DELETE FROM workspaces WHERE id=$1',[workspaceId]).catch(()=>{});await query('DELETE FROM "user" WHERE id=$1',[userId]).catch(()=>{});await closeDatabase();
 }
});
