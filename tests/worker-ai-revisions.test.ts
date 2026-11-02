import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {db,query,closeDatabase} from '../packages/core/src/db';
import {dispatch} from '../packages/core/src/api';
import {encryptSecret,hashToken} from '../packages/core/src/secrets';
import {executeJob,reapExpiredJobs,type Job} from '../services/worker/src/jobs';
const enabled=!!process.env.TEST_DATABASE_URL;

test('AI migration quarantines ambiguous legacy rows and preserves revision edits when reapplied',{skip:!enabled},async()=>{
 process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
 const client=await db().connect();const namespace='ai_migration_'+randomUUID().replaceAll('-','');
 const schema=await readFile(new URL('../packages/core/schema.sql',import.meta.url),'utf8');
 try{
 await client.query(`CREATE SCHEMA ${namespace}`);await client.query(`SET search_path TO ${namespace},public`);
 await client.query('CREATE TABLE "user"(id text PRIMARY KEY)');await client.query(schema);
 await client.query('DROP TABLE ai_results');
 await client.query("CREATE TABLE ai_results(video_id uuid PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,revision_id uuid REFERENCES revisions(id),title text,summary text,chapters jsonb NOT NULL DEFAULT '[]',action_items jsonb NOT NULL DEFAULT '[]',user_edited jsonb NOT NULL DEFAULT '[]',provider text,model text,status text NOT NULL DEFAULT 'queued',error text,usage jsonb,updated_at timestamptz NOT NULL DEFAULT now())");
 const user=randomUUID(),workspace=randomUUID(),video=randomUUID(),revision=randomUUID();
 await client.query('INSERT INTO "user"(id) VALUES($1)',[user]);await client.query("INSERT INTO workspaces(id,name) VALUES($1,'Migration')",[workspace]);
 await client.query("INSERT INTO videos(id,client_id,workspace_id,owner_id,title) VALUES($1,$2,$3,$4,'Migration')",[video,randomUUID(),workspace,user]);
 await client.query('INSERT INTO revisions(id,video_id) VALUES($1,$2)',[revision,video]);
 await client.query("INSERT INTO ai_results(video_id,revision_id,title,user_edited) VALUES($1,$2,'Ambiguous legacy text','[\"title\"]')",[video,revision]);
 const unowned=randomUUID();await client.query("INSERT INTO videos(id,client_id,workspace_id,owner_id,title) VALUES($1,$2,$3,$4,'Unowned legacy')",[unowned,randomUUID(),workspace,user]);await client.query("INSERT INTO ai_results(video_id,title) VALUES($1,'Unowned legacy text')",[unowned]);
 await client.query(schema);
 assert.equal((await client.query('SELECT * FROM ai_results')).rowCount,0);
 assert.equal((await client.query('SELECT record FROM ai_results_legacy WHERE video_id=$1',[unowned])).rows[0].record.revision_id,null);
 const archived=(await client.query('SELECT record FROM ai_results_legacy WHERE video_id=$1',[video])).rows[0];assert.equal(archived.record.title,'Ambiguous legacy text');assert.deepEqual(archived.record.user_edited,['title']);
 await client.query("INSERT INTO ai_results(video_id,revision_id,title,user_edited) VALUES($1,$2,'Revision-owned human title','[\"title\"]')",[video,revision]);
 await client.query(schema);await client.query(schema);
 const current=(await client.query('SELECT * FROM ai_results WHERE video_id=$1 AND revision_id=$2',[video,revision])).rows[0];assert.equal(current.title,'Revision-owned human title');assert.deepEqual(current.user_edited,['title']);assert.equal((await client.query('SELECT * FROM ai_results_legacy')).rowCount,2);
 }finally{await client.query('SET search_path TO public');await client.query(`DROP SCHEMA ${namespace} CASCADE`);client.release();await closeDatabase();}
});

test('AI regeneration and edits remain owned by revision, preserve history, and reject stale callers',{skip:!enabled},async()=>{
 process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;const schema=await readFile(new URL('../packages/core/schema.sql',import.meta.url),'utf8');await query(schema);
 const user=randomUUID(),workspace=randomUUID(),video=randomUUID(),first=randomUUID(),second=randomUUID(),token=randomUUID();const originalFetch=globalThis.fetch;
 const request=(method:string,path:string,payload?:object)=>dispatch(new Request('http://localhost:3000/api/v1'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})}));
 const base='/videos/'+video;
 const generate=async(revision:string,summary:string)=>{
 globalThis.fetch=async()=>{const attempt=(await query('SELECT provider,model,status FROM ai_results WHERE video_id=$1 AND revision_id=$2',[video,revision]))[0];assert.equal(attempt.provider,'openai');assert.equal(attempt.model,'test');assert.equal(attempt.status,'processing');return new Response(JSON.stringify({id:'chat1',object:'chat.completion',created:123,model:'test',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({title:'Generated',summary,chapters:[{start:0,title:'Start'}],actionItems:['Task']})},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:5,total_tokens:8}}),{headers:{'content-type':'application/json'}});};
 const [job]=await query<Job>("UPDATE jobs SET status='running',locked_at=now(),locked_by=$3,attempts=attempts+1 WHERE video_id=$1 AND revision_id=$2 AND kind='ai' AND status='queued' RETURNING *",[video,revision,randomUUID()]);assert.ok(job);await executeJob(job);assert.equal((await query('SELECT status FROM jobs WHERE id=$1',[job.id]))[0].status,'done');
 };
 try{
 await query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'AI revision test\',$2,true,now(),now())',[user,`${user}@test.local`]);await query('INSERT INTO device_tokens(token_hash,user_id) VALUES($1,$2)',[hashToken(token),user]);await query("INSERT INTO workspaces(id,name) VALUES($1,'AI revisions')",[workspace]);await query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,user]);
 await query("INSERT INTO videos(id,client_id,workspace_id,owner_id,title,status,duration,initial_revision_id,published_revision_id) VALUES($1,$2,$3,$4,'AI fixture','ready',10,$5,$5)",[video,randomUUID(),workspace,user,first]);
 for(const revision of [first,second]){await query("INSERT INTO revisions(id,video_id,status,duration) VALUES($1,$2,'ready',10)",[revision,video]);await query("INSERT INTO transcripts(video_id,revision_id,status,segments) VALUES($1,$2,'ready',$3)",[video,revision,JSON.stringify([{start:0,end:1,text:revision===first?'removed secret':'safe current content'}])]);}
 await query("INSERT INTO settings(key,value) VALUES('ai',$1) ON CONFLICT(key) DO UPDATE SET value=$1",[JSON.stringify({provider:'openai',model:'test',enabled:true,encryptedApiKey:encryptSecret('test-private-key')})]);
 assert.equal((await request('POST',base+'/ai',{expectedRevisionId:first})).status,202);await generate(first,'Removed secret summary');
 assert.equal((await request('PATCH',base+'/ai',{expectedRevisionId:first,title:'Human secret title'})).status,200);
 assert.equal((await request('POST',base+'/ai',{expectedRevisionId:first,regenerate:true})).status,202);await generate(first,'Regenerated first');
 let detail=await(await request('GET',base)).json();assert.equal(detail.ai.title,'Human secret title');assert.equal(detail.ai.revisionId,first);assert.deepEqual(detail.ai.userEdited,['title']);
 await query('UPDATE videos SET published_revision_id=$2 WHERE id=$1',[video,second]);
 detail=await(await request('GET',base)).json();assert.equal(detail.ai,null);
 assert.equal((await request('POST',base+'/ai',{expectedRevisionId:second})).status,202);
 const queued=(await query('SELECT * FROM ai_results WHERE video_id=$1 AND revision_id=$2',[video,second]))[0];assert.equal(queued.title,null);assert.deepEqual(queued.user_edited,[]);
 assert.equal((await request('PATCH',base+'/ai',{expectedRevisionId:first,summary:'Stale secret'})).status,409);
 assert.equal((await request('PATCH',base+'/ai',{summary:'Unversioned secret'})).status,428);
 await generate(second,'Current safe summary');detail=await(await request('GET',base)).json();assert.equal(detail.ai.summary,'Current safe summary');assert.equal(detail.ai.revisionId,second);assert.doesNotMatch(JSON.stringify(detail.ai),/secret|first/);
 const historical=(await query('SELECT * FROM ai_results WHERE video_id=$1 AND revision_id=$2',[video,first]))[0];assert.equal(historical.title,'Human secret title');assert.equal(historical.summary,'Regenerated first');

 const [superseded]=await query<Job>("INSERT INTO jobs(kind,video_id,revision_id,status,locked_at,locked_by,attempts) VALUES('ai',$1,$2,'running',now(),$3,1) RETURNING *",[video,first,randomUUID()]);await executeJob(superseded);
 const [stillCurrent]=await query('SELECT status,summary FROM ai_results WHERE video_id=$1 AND revision_id=$2',[video,second]);assert.equal(stillCurrent.status,'ready');assert.equal(stillCurrent.summary,'Current safe summary');
 await query("INSERT INTO jobs(kind,video_id,revision_id,status,locked_at,locked_by,attempts) VALUES('ai',$1,$2,'running',now()-interval '3 minutes',$3,3)",[video,first,randomUUID()]);await reapExpiredJobs();assert.equal((await query('SELECT status FROM ai_results WHERE video_id=$1 AND revision_id=$2',[video,second]))[0].status,'ready');
 assert.equal((await request('POST',base+'/ai',{expectedRevisionId:second,regenerate:true})).status,202);
 globalThis.fetch=async()=>{await query("UPDATE transcripts SET segments='[{\"start\":0,\"end\":1,\"text\":\"Corrected source\"}]',updated_at=now() WHERE revision_id=$1",[second]);return new Response(JSON.stringify({id:'chat2',object:'chat.completion',created:123,model:'test',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({title:'Stale generation',summary:'Outdated transcript result',chapters:[],actionItems:[]})},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});};
 const [inFlight]=await query<Job>("UPDATE jobs SET status='running',locked_at=now(),locked_by=$3,attempts=1 WHERE video_id=$1 AND revision_id=$2 AND status='queued' RETURNING *",[video,second,randomUUID()]);await executeJob(inFlight);
 assert.equal((await query('SELECT status FROM jobs WHERE id=$1',[inFlight.id]))[0].status,'queued');assert.equal((await query('SELECT summary FROM ai_results WHERE video_id=$1 AND revision_id=$2',[video,second]))[0].summary,'Current safe summary');

 await query("UPDATE settings SET value=$1 WHERE key='ai'",[JSON.stringify({provider:'anthropic',model:'different-model',enabled:true,encryptedApiKey:encryptSecret('new-provider-key')})]);
 let changedProviderCalled=false;globalThis.fetch=async()=>{changedProviderCalled=true;throw new Error('Must not request changed provider');};
 const [retry]=await query<Job>("UPDATE jobs SET status='running',locked_at=now(),locked_by=$2,attempts=2 WHERE id=$1 RETURNING *",[inFlight.id,randomUUID()]);await executeJob(retry);
 const [configurationFailure]=await query('SELECT status,last_error FROM jobs WHERE id=$1',[retry.id]);assert.equal(configurationFailure.status,'failed');assert.match(configurationFailure.last_error,/configuration changed/i);assert.equal(changedProviderCalled,false);
 const [attempted]=await query('SELECT provider,model FROM ai_results WHERE video_id=$1 AND revision_id=$2',[video,second]);assert.equal(attempted.provider,'openai');assert.equal(attempted.model,'test');
 await query("UPDATE settings SET value=$1 WHERE key='ai'",[JSON.stringify({provider:'openai',model:'failed-model',enabled:true,encryptedApiKey:encryptSecret('bad-key')})]);assert.equal((await request('POST',base+'/ai',{expectedRevisionId:second})).status,202);
 globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'do-not-leak-key',type:'invalid_request_error',code:'invalid_api_key'}}),{status:401,headers:{'content-type':'application/json'}});
 const [authJob]=await query<Job>("UPDATE jobs SET status='running',locked_at=now(),locked_by=$3,attempts=1 WHERE video_id=$1 AND revision_id=$2 AND status='queued' RETURNING *",[video,second,randomUUID()]);await executeJob(authJob);
 const [authFailure]=await query('SELECT * FROM ai_results WHERE video_id=$1 AND revision_id=$2',[video,second]);assert.equal(authFailure.status,'failed');assert.equal(authFailure.provider,'openai');assert.equal(authFailure.model,'failed-model');assert.equal(authFailure.usage,null);assert.doesNotMatch(authFailure.error,/do-not-leak-key/);
 await query('UPDATE videos SET published_revision_id=$2 WHERE id=$1',[video,first]);detail=await(await request('GET',base)).json();assert.equal(detail.ai.title,'Human secret title');assert.equal(detail.ai.revisionId,first);
 }finally{globalThis.fetch=originalFetch;await query('DELETE FROM jobs WHERE video_id=$1',[video]).catch(()=>{});await query('DELETE FROM videos WHERE id=$1',[video]).catch(()=>{});await query('DELETE FROM workspaces WHERE id=$1',[workspace]).catch(()=>{});await query('DELETE FROM "user" WHERE id=$1',[user]).catch(()=>{});await query("DELETE FROM settings WHERE key='ai'").catch(()=>{});await closeDatabase();}
});
