import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {getMigrations} from 'better-auth/db/migration';
import {dispatch} from '../packages/core/src/api';
import {query,closeDatabase} from '../packages/core/src/db';
import {authOptions} from '../packages/core/src/auth';
import {hashToken} from '../packages/core/src/secrets';
import {atomicWrite,revisionRoot,videoRoot} from '../packages/core/src/storage';
import type {Job} from '../services/worker/src/jobs';
const run=!!process.env.DATABASE_URL;
let root='',workspace='',otherWorkspace='',owner='',other='',outsider='';
const ownerToken=randomUUID(),otherToken=randomUUID(),outsiderToken=randomUUID();
async function request(method:string,path:string,body?:unknown,token:string=ownerToken,extra:Record<string,string>={}){
 const headers:Record<string,string>={origin:'http://localhost:3000',...extra};if(token)headers.authorization='Bearer '+token;if(body!==undefined&&!(body instanceof Uint8Array))headers['content-type']='application/json';
 return dispatch(new Request('http://localhost:3000/api/v1'+path,{method,headers,...(body!==undefined?{body:body instanceof Uint8Array?new Blob([Buffer.from(body)]):JSON.stringify(body)}:{})}));
}
async function recording(){const response=await request('POST','/recordings',{clientId:randomUUID(),workspaceId:workspace,title:'Test capture',transcriptionMode:'on_device'});assert.equal(response.status,201);return(await response.json()).video;}

test('branding logos and timed CTAs follow workspace and revoked-share policy',{skip:!run},async()=>{
 const {v,revision}=await workflowFixture(),path=`/workspaces/${workspace}/branding`;
 const response=await request('GET',path);assert.equal(response.status,200);const current=await response.json();
 assert.equal((await request('PUT',path,{expectedVersion:current.version,settings:{...current.settings,displayName:'Example team'}},otherToken)).status,403);
 const {default:sharp}=await import('sharp');const logo=await sharp({create:{width:20,height:20,channels:3,background:'red'}}).png().toBuffer();
 const asset=await request('POST',path+'/assets',logo);assert.equal(asset.status,201);const assetId=(await asset.json()).assetId;
 assert.equal((await request('PUT',path,{expectedVersion:current.version,settings:{...current.settings,displayName:'Example team',logoAssetId:assetId}})).status,200);
 assert.equal((await request('PUT',`/workspaces/${otherWorkspace}/branding`,{expectedVersion:0,settings:{...current.settings,logoAssetId:assetId}},outsiderToken)).status,400);
 const editor=await request('PUT',`/videos/${v.id}/presentation`,{expectedVersion:0,expectedRevisionId:revision,ctas:[{id:randomUUID(),label:'Read guide',url:'https://example.test/guide',start:0,end:5}]});assert.equal(editor.status,200);const {presentation}=await editor.json();
 const share=await(await request('POST',`/videos/${v.id}/share`,{visibility:'unlisted'})).json();const shareToken=share.share.token;
 assert.equal((await request('GET',`/videos/${v.id}/brand/logo?share=${shareToken}`,undefined,'')).status,200);
 assert.equal((await request('GET',`/videos/${v.id}/brand/logo`,undefined,otherToken)).status,403);
 const event={eventId:randomUUID(),sessionId:randomUUID(),revisionId:revision,presentationVersion:presentation.version,ctaId:presentation.ctas[0].id,kind:'impression',position:2};
 const telemetry=`/videos/${v.id}/cta-events?share=${shareToken}`;
 const first=await request('POST',telemetry,event,'');assert.equal(first.status,200);const cookie=first.headers.get('set-cookie')!.split(';')[0];
 assert.equal((await request('POST',telemetry,event,'',{cookie})).status,200);
 assert.equal((await request('POST',telemetry,{...event,position:3},'',{cookie})).status,409);
 const clicks=await Promise.all([1,2].map(()=>request('POST',telemetry,{...event,eventId:randomUUID(),kind:'click'},'',{cookie})));assert.ok(clicks.every(r=>r.status===200));
 assert.equal((await request('POST',`/videos/${v.id}/cta-events`,{...event,eventId:randomUUID()})).status,200);
 const detail=await(await request('GET',`/videos/${v.id}`)).json();assert.equal(detail.branding.displayName,'Example team');
 const insights=await(await request('GET',`/videos/${v.id}/engagement`)).json();assert.equal(insights.actions[0].impressions,1);assert.equal(insights.actions[0].clicks,1);
 await request('DELETE',`/videos/${v.id}/share`);
 assert.equal((await request('GET',`/videos/${v.id}/brand/logo?share=${shareToken}`,undefined,'')).status,401);
 assert.equal((await request('POST',telemetry,{...event,eventId:randomUUID()},'',{cookie})).status,401);
 const next=randomUUID();await query("INSERT INTO revisions(id,video_id,status,duration) VALUES($1,$2,'ready',5)",[next,v.id]);await query('UPDATE videos SET published_revision_id=$2 WHERE id=$1',[v.id,next]);
 assert.deepEqual((await(await request('GET',`/videos/${v.id}`)).json()).presentation.ctas,[]);
});

test('workspace reports protect private data and exports recheck access and expiry',{skip:!run},async()=>{
 const {v}=await workflowFixture();await query('UPDATE videos SET title=$2 WHERE id=$1',[v.id,'=HYPERLINK("bad")']);
 const path=`/workspaces/${workspace}/reports`,range={kind:'content',from:new Date(Date.now()-86400000).toISOString(),to:new Date(Date.now()+1000).toISOString()};
 assert.equal((await request('GET',path+'?'+new URLSearchParams(range),undefined,otherToken)).status,403);
 assert.equal((await request('GET',path+'?'+new URLSearchParams(range),undefined,outsiderToken)).status,403);
 const page=await request('GET',path+'?'+new URLSearchParams({...range,limit:'1'}));assert.equal(page.status,200);assert.equal((await page.json()).rows.length,1);
 const response=await request('POST',path+'/exports',range);assert.equal(response.status,202);const {export:exp}=await response.json();
 const [job]=await query<Job>("UPDATE jobs SET status='running',locked_at=now(),locked_by=$2,attempts=1 WHERE resource_key=$1 AND kind='report' RETURNING *",[exp.id,randomUUID()]);
 const {executeJob}=await import('../services/worker/src/jobs');await executeJob(job);
 let download=await request('GET',path+`/exports/${exp.id}/download`);assert.equal(download.status,200);assert.match(await download.text(),/"'=HYPERLINK/);
 assert.equal((await request('GET',path+`/exports/${exp.id}/download`,undefined,otherToken)).status,403);
 await query("UPDATE memberships SET role='member' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);
 try{assert.equal((await request('GET',path+`/exports/${exp.id}/download`)).status,403);}finally{await query("UPDATE memberships SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);}
 await query('UPDATE videos SET deleted_at=now() WHERE id=$1',[v.id]);
 assert.equal((await request('GET',path+`/exports/${exp.id}/download`)).status,409);
 await query('UPDATE videos SET deleted_at=NULL WHERE id=$1',[v.id]);await query("UPDATE report_exports SET expires_at=now()-interval '1 second' WHERE id=$1",[exp.id]);
 assert.equal((await request('GET',path+`/exports/${exp.id}/download`)).status,410);
 const audit=await(await request('GET',path+'/audit')).json();assert.ok(audit.events.some((e:any)=>e.action==='report.requested'));assert.doesNotMatch(JSON.stringify(audit),/HYPERLINK|token_hash|encrypted/);
});

test('workspace report kinds paginate and engagement matches revision metrics',{skip:!run},async()=>{
 const {v,revision}=await workflowFixture(),path=`/workspaces/${workspace}/reports`,now=Date.now();
 const range={from:new Date(now-86400000).toISOString(),to:new Date(now+1000).toISOString()};
 const sessionId=randomUUID(),summary={sessionId,viewerKey:'known-report-viewer',userId:other,userName:'Old name',kind:'playback',covered:[[0,5]],wall:[[now-5000,now]],mediaSeconds:5,lastPosition:5,startedAt:new Date(now).toISOString(),lastSeenAt:new Date(now).toISOString()};
 await query("INSERT INTO watch_sessions(id,video_id,revision_id,viewer_key,user_id,kind,summary) VALUES($1,$2,$3,$4,$5,'playback',$6)",[sessionId,v.id,revision,'known-report-viewer',other,JSON.stringify(summary)]);
 for(const kind of ['content','users','operations','provider_usage','engagement']){
  const response=await request('GET',path+'?'+new URLSearchParams({...range,kind,limit:'1',...(kind==='engagement'?{videoId:v.id}:{})}));assert.equal(response.status,200,await response.clone().text());
  const data=await response.json();assert.ok(data.rows.length<=1);assert.ok(data.columns.length);
  if(data.nextCursor){const next=await(await request('GET',path+'?'+new URLSearchParams({...range,kind,limit:'1',cursor:data.nextCursor}))).json();assert.notDeepEqual(next.rows,data.rows);}
  if(kind==='engagement'){assert.equal(data.rows[0].views,1);assert.equal(data.rows[0].watchSeconds,5);assert.equal(data.rows[0].completionRate,1);assert.equal(data.rows[0].revisionId,revision);}
 }
});

test('queued reports cannot run after membership revocation and deleted users invalidate CSV',{skip:!run},async()=>{
 const path=`/workspaces/${workspace}/reports`,range={kind:'users',from:new Date(Date.now()-86400000).toISOString(),to:new Date(Date.now()+1000).toISOString()};
 const {executeJob}=await import('../services/worker/src/jobs');
 const create=async()=>{
  const response=await request('POST',path+'/exports',range);assert.equal(response.status,202);const exp=(await response.json()).export;
  const [job]=await query<Job>("UPDATE jobs SET status='running',locked_at=now(),locked_by=$2,attempts=1 WHERE resource_key=$1 AND kind='report' RETURNING *",[exp.id,randomUUID()]);return {exp,job};
 };
 const first=await create();await query("UPDATE memberships SET role='member' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);
 try{await executeJob(first.job);assert.equal((await query('SELECT status,csv FROM report_exports WHERE id=$1',[first.exp.id]))[0].status,'failed');}
 finally{await query("UPDATE memberships SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);}
 const deleted=randomUUID();await query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[deleted,'Deleted reporter',deleted+'@example.test']);
 await query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",[workspace,deleted]);
 const second=await create();await executeJob(second.job);
 assert.equal((await request('GET',path+`/exports/${second.exp.id}/download`)).status,200);
 await query('DELETE FROM "user" WHERE id=$1',[deleted]);
 assert.equal((await request('GET',path+`/exports/${second.exp.id}/download`)).status,409);
});

test('analytics retention removes only expired events, summaries and CSV bytes',{skip:!run},async()=>{
 const {v,revision}=await workflowFixture(),sessions=[randomUUID(),randomUUID(),randomUUID()];
 for(let i=0;i<sessions.length;i++)await query("INSERT INTO watch_sessions(id,video_id,revision_id,viewer_key,kind,summary,started_at) VALUES($1::uuid,$2,$3,$1::text,'playback','{}',now()-make_interval(months=>$4))",[sessions[i],v.id,revision,i===2?14:4]);
 const oldEvent=randomUUID(),recentEvent=randomUUID();
 for(const [event,session,days] of [[oldEvent,sessions[0],91],[recentEvent,sessions[1],89]])await query("INSERT INTO watch_intervals(event_id,session_id,video_id,sequence,digest,interval,created_at) VALUES($1,$2,$3,0,'digest','{}',now()-make_interval(days=>$4))",[event,session,v.id,days]);
 const [expired]=await query("INSERT INTO report_exports(workspace_id,requested_by,request,status,csv,expires_at) VALUES($1,$2,'{}','ready','private snapshot',now()-interval '1 minute') RETURNING id",[workspace,owner]);
 const {retainAnalytics}=await import('../services/worker/src/analytics');await retainAnalytics();
 assert.equal((await query('SELECT 1 FROM watch_intervals WHERE event_id=$1',[oldEvent])).length,0);
 assert.equal((await query('SELECT 1 FROM watch_intervals WHERE event_id=$1',[recentEvent])).length,1);
 assert.equal((await query('SELECT 1 FROM watch_sessions WHERE id=ANY($1::uuid[])',[sessions])).length,2);
 const [exp]=await query('SELECT status,csv FROM report_exports WHERE id=$1',[expired.id]);assert.equal(exp.status,'expired');assert.equal(exp.csv,null);
 assert.equal((await query('SELECT status FROM revisions WHERE id=$1',[revision]))[0].status,'ready');
 assert.equal((await query('SELECT deleted_at FROM videos WHERE id=$1',[v.id]))[0].deleted_at,null);
});
const digest=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');

test('workflow drafts preserve human edits, fence revisions and enforce access',{skip:!run},async()=>{
 const v=await recording(),base=`/videos/${v.id}/workflows`,revision=v.initialRevisionId;
 await query("UPDATE revisions SET status='ready',duration=5 WHERE id=$1",[revision]);
 await query("UPDATE videos SET status='ready',duration=5,published_revision_id=$2 WHERE id=$1",[v.id,revision]);
 await query("INSERT INTO transcripts(video_id,revision_id,status,text,segments,timing) VALUES($1,$2,'ready','Explain deployment steps','[]','none')",[v.id,revision]);
 const templatesResponse=await request('GET',`/workspaces/${workspace}/workflow-templates`);assert.equal(templatesResponse.status,200);
 const {templates}=await templatesResponse.json();assert.ok(templates.some((t:any)=>t.id==='sop'));
 const created=await request('POST',base,{expectedRevisionId:revision,templateId:'sop',templateVersion:1});assert.equal(created.status,201);
 let {artifact}=await created.json();const id=artifact.id;
 assert.equal((await request('GET',base,undefined,outsiderToken)).status,403);
 assert.equal((await request('GET',`${base}/${id}/export`,undefined,otherToken)).status,403);
 const manual={...artifact.draft,title:'Human title'};
 let response=await request('PATCH',`${base}/${id}`,{expectedVersion:1,draft:manual});assert.equal(response.status,200);artifact=(await response.json()).artifact;
 assert.equal(artifact.version,2);assert.equal((await request('PATCH',`${base}/${id}`,{expectedVersion:1,draft:manual})).status,409);
 const {encryptSecret}=await import('../packages/core/src/secrets');
 const previous=(await query("SELECT value FROM settings WHERE key='ai'"))[0];
 const originalFetch=globalThis.fetch;
 try{
  await query("INSERT INTO settings(key,value) VALUES('ai',$1) ON CONFLICT(key) DO UPDATE SET value=$1",[JSON.stringify({provider:'openai',model:'test',enabled:true,encryptedApiKey:encryptSecret('workflow-secret')})]);
  assert.equal((await request('POST',`${base}/${id}/generate`,{expectedVersion:2,expectedRevisionId:revision})).status,202);
  assert.equal((await request('POST',`${base}/${id}/generate`,{expectedVersion:2,expectedRevisionId:revision})).status,409);
  // Two independent artifacts for this revision can generate concurrently.
  const second=await request('POST',base,{expectedRevisionId:revision,templateId:'qa',templateVersion:1,generate:true});assert.equal(second.status,201);
  // A startup migration must preserve concurrent artifact-owned jobs.
  await query(await readFile(new URL('../packages/core/schema.sql',import.meta.url),'utf8'));
  assert.equal((await query("SELECT count(*)::int AS n FROM jobs WHERE video_id=$1 AND kind='workflow' AND status='queued'",[v.id]))[0].n,2);
  globalThis.fetch=async()=>new Response(JSON.stringify({id:'chat',object:'chat.completion',created:123,model:'test',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({...manual,title:'AI proposal'})},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:5,total_tokens:8}}),{headers:{'content-type':'application/json'}});
  const {executeJob}=await import('../services/worker/src/jobs');
  const [job]=await query<Job>("UPDATE jobs SET status='running',locked_at=now(),locked_by=$2,attempts=1 WHERE kind='workflow' AND resource_key=$1 RETURNING *",[id,randomUUID()]);
  await executeJob(job);assert.equal((await query('SELECT status,last_error FROM jobs WHERE id=$1',[job.id]))[0].status,'done');
  let list=await(await request('GET',base)).json();artifact=list.artifacts.find((a:any)=>a.id===id);
  assert.equal(artifact.draft.title,'Human title');assert.equal(artifact.proposal.title,'AI proposal');assert.ok(artifact.usage);assert.equal(artifact.cost,null);
  response=await request('PATCH',`${base}/${id}`,{expectedVersion:artifact.version,acceptProposal:true});assert.equal(response.status,200);assert.equal((await response.json()).artifact.draft.title,'AI proposal');
  response=await request('GET',`${base}/${id}/export?format=markdown`);assert.equal(response.status,200);assert.match(await response.text(),/# AI proposal/);
  const replacement=(await request('POST',base,{expectedRevisionId:revision,templateId:'bug',templateVersion:1,generate:true}));assert.equal(replacement.status,201);
  const replacementId=(await replacement.json()).artifact.id;
  await query("UPDATE transcripts SET text='Corrected transcript' WHERE revision_id=$1",[revision]);
  const [changed]=await query<Job>("UPDATE jobs SET status='running',locked_at=now(),locked_by=$2,attempts=1 WHERE kind='workflow' AND resource_key=$1 RETURNING *",[replacementId,randomUUID()]);await executeJob(changed);
  assert.equal((await query('SELECT status FROM jobs WHERE id=$1',[changed.id]))[0].status,'failed');
  const next=randomUUID();await query("INSERT INTO revisions(id,video_id,status,duration) VALUES($1,$2,'ready',5)",[next,v.id]);await query('UPDATE videos SET published_revision_id=$2 WHERE id=$1',[v.id,next]);
  assert.equal((await request('GET',`${base}/${id}/export`)).status,409);
  list=await(await request('GET',base)).json();assert.deepEqual(list.artifacts,[]);
 }finally{globalThis.fetch=originalFetch;if(previous)await query("UPDATE settings SET value=$1 WHERE key='ai'",[previous.value]);else await query("DELETE FROM settings WHERE key='ai'");}
});

async function workflowFixture(){
 const v=await recording(),revision=v.initialRevisionId,base=`/videos/${v.id}/workflows`;
 await query("UPDATE revisions SET status='ready',duration=5 WHERE id=$1",[revision]);
 await query("UPDATE videos SET status='ready',duration=5,published_revision_id=$2 WHERE id=$1",[v.id,revision]);
 await query("INSERT INTO transcripts(video_id,revision_id,status,text,timing) VALUES($1,$2,'ready','Deploy after tests pass.','none')",[v.id,revision]);
 return {v,revision,base};
}
async function withWorkflowAI(action:()=>Promise<void>){
 const {encryptSecret}=await import('../packages/core/src/secrets'),previous=(await query("SELECT value FROM settings WHERE key='ai'"))[0],originalFetch=globalThis.fetch;
 try{
  await query("INSERT INTO settings(key,value) VALUES('ai',$1) ON CONFLICT(key) DO UPDATE SET value=$1",[JSON.stringify({provider:'openai',model:'test',enabled:true,encryptedApiKey:encryptSecret('workflow-secret')})]);
  await action();
 }finally{globalThis.fetch=originalFetch;if(previous)await query("UPDATE settings SET value=$1 WHERE key='ai'",[previous.value]);else await query("DELETE FROM settings WHERE key='ai'");}
}
function workflowResponse(draft:unknown){return new Response(JSON.stringify({id:'chat',object:'chat.completion',created:123,model:'test',choices:[{index:0,message:{role:'assistant',content:JSON.stringify(draft)},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:5,total_tokens:8}}),{headers:{'content-type':'application/json'}});}
async function claimWorkflow(id:string){return(await query<Job>("UPDATE jobs SET status='running',locked_at=now(),locked_by=$2,attempts=attempts+1 WHERE kind='workflow' AND resource_key=$1 AND status='queued' RETURNING *",[id,randomUUID()]))[0];}

test('workflow publication completes its lease before outer acknowledgement',{skip:!run},async()=>withWorkflowAI(async()=>{
 const {base,revision}=await workflowFixture();
 const {artifact}=await(await request('POST',base,{expectedRevisionId:revision,templateId:'sop',templateVersion:1,generate:true})).json();
 const job=await claimWorkflow(artifact.id);let calls=0;
 globalThis.fetch=async()=>{calls++;return workflowResponse({...artifact.draft,title:'Completed once'});};
 const {generateWorkflow}=await import('../services/worker/src/workflows');
 // Simulate process exit before executeJob can acknowledge completion.
 await generateWorkflow(job);
 const saved=(await query('SELECT * FROM workflow_artifacts WHERE id=$1',[artifact.id]))[0];
 const stored=(await query('SELECT * FROM jobs WHERE id=$1',[job.id]))[0];
 assert.equal(stored.status,'done');assert.equal(stored.locked_by,null);assert.equal(stored.locked_at,null);
 assert.ok(stored.payload.aiUsage);assert.equal(saved.draft.title,'Completed once');
 await assert.rejects(generateWorkflow(job),/lease lost/);
 assert.equal(calls,1);assert.deepEqual((await query('SELECT * FROM workflow_artifacts WHERE id=$1',[artifact.id]))[0],saved);
}));

test('workflow creation consumes the generation budget before queuing paid work',{skip:!run},async()=>withWorkflowAI(async()=>{
 const {base,revision}=await workflowFixture(),key='workflow-workspace:'+workspace;
 const previous=(await query('SELECT * FROM rate_limits WHERE key=$1',[key]))[0];
 try{
  await query("INSERT INTO rate_limits(key,count,expires_at) VALUES($1,100,now()+interval '1 hour') ON CONFLICT(key) DO UPDATE SET count=100,expires_at=excluded.expires_at",[key]);
  assert.equal((await request('POST',base,{expectedRevisionId:revision,templateId:'sop',templateVersion:1,generate:true})).status,429);
  assert.equal((await request('POST',base,{expectedRevisionId:revision,templateId:'sop',templateVersion:1})).status,201,'Manual work is independent of AI quota');
 }finally{if(previous)await query('UPDATE rate_limits SET count=$2,expires_at=$3 WHERE key=$1',[key,previous.count,previous.expires_at]);else await query('DELETE FROM rate_limits WHERE key=$1',[key]);}
}));

test('workflow templates are immutable versions and manual drafts work with AI disabled',{skip:!run},async()=>{
 const {base,revision}=await workflowFixture(),path=`/workspaces/${workspace}/workflow-templates`;
 const input={name:'Release note',instructions:'Summarize verified changes.',sections:['Changes','Validation']};
 assert.equal((await request('PUT',path,input,otherToken)).status,403);
 let response=await request('PUT',path,input);assert.equal(response.status,200);const first=(await response.json()).template;
 assert.equal(first.outputSchema.type,'object');assert.equal(first.outputSchema.additionalProperties,false);
 const create={expectedRevisionId:revision,templateId:first.id,templateVersion:1};
 response=await request('POST',base,create);assert.equal(response.status,201);const artifact=(await response.json()).artifact;
 response=await request('PUT',path,{...input,id:first.id,expectedVersion:1,sections:['Changes','Verification']});assert.equal(response.status,200);assert.equal((await response.json()).template.version,2);
 assert.equal((await request('PUT',path,{...input,id:first.id,expectedVersion:1})).status,409);
 assert.equal((await request('POST',base,create)).status,409);
 const list=await(await request('GET',base)).json();assert.equal(list.artifacts[0].template.version,1);assert.equal(list.artifacts[0].draft.sections[1].heading,'Validation');
 const previous=(await query("SELECT value FROM settings WHERE key='ai'"))[0];
 try{
  await query("DELETE FROM settings WHERE key='ai'");
  assert.equal((await(await request('GET',base)).json()).generationEnabled,false);
  assert.equal((await request('POST',`${base}/${artifact.id}/generate`,{expectedVersion:1,expectedRevisionId:revision})).status,409);
  assert.equal((await request('PATCH',`${base}/${artifact.id}`,{expectedVersion:1,draft:{...artifact.draft,title:'Reviewed release note'}})).status,200);
 }finally{if(previous)await query("INSERT INTO settings(key,value) VALUES('ai',$1)",[previous.value]);}
});

test('workflow writes recheck membership after reading a slow request body',{skip:!run},async()=>{
 const {base,revision}=await workflowFixture();
 const stream=new ReadableStream<Uint8Array>({async pull(controller){
  await query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2',[workspace,owner]);
  controller.enqueue(new TextEncoder().encode(JSON.stringify({expectedRevisionId:revision,templateId:'sop',templateVersion:1})));controller.close();
 }},{highWaterMark:0});
 try{
  const response=await dispatch(new Request('http://localhost:3000/api/v1'+base,{method:'POST',headers:{authorization:'Bearer '+ownerToken,origin:'http://localhost:3000','content-type':'application/json'},body:stream,duplex:'half'} as RequestInit));
  assert.equal(response.status,403);
 }finally{await query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING",[workspace,owner]);}
});

test('workflow publication preserves edits made while a provider is running',{skip:!run},async()=>withWorkflowAI(async()=>{
 const {base,revision}=await workflowFixture();
 const {artifact}=await(await request('POST',base,{expectedRevisionId:revision,templateId:'sop',templateVersion:1,generate:true})).json();
 globalThis.fetch=async()=>{
  const save=await request('PATCH',`${base}/${artifact.id}`,{expectedVersion:1,draft:{...artifact.draft,title:'Written during generation'}});assert.equal(save.status,200);
  return workflowResponse({...artifact.draft,title:'Generated title'});
 };
 const {executeJob}=await import('../services/worker/src/jobs');await executeJob(await claimWorkflow(artifact.id));
 const saved=(await(await request('GET',base)).json()).artifacts[0];
 assert.equal(saved.status,'proposed');assert.equal(saved.draft.title,'Written during generation');assert.equal(saved.proposal.title,'Generated title');assert.equal(saved.version,3);
}));

for(const change of ['access','configuration','revision','transcript'] as const)test(`workflow publication rejects in-flight ${change} changes`,{skip:!run},async()=>withWorkflowAI(async()=>{
 const {base,revision,v}=await workflowFixture();
 const {artifact}=await(await request('POST',base,{expectedRevisionId:revision,templateId:'sop',templateVersion:1,generate:true})).json();
 globalThis.fetch=async()=>{
  if(change==='access')await query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2',[workspace,owner]);
  if(change==='configuration')await query("UPDATE settings SET value=jsonb_set(value,'{model}','\"changed\"') WHERE key='ai'");
  if(change==='transcript')await query("UPDATE transcripts SET text='New correction' WHERE revision_id=$1",[revision]);
  if(change==='revision'){const next=randomUUID();await query("INSERT INTO revisions(id,video_id,status) VALUES($1,$2,'ready')",[next,v.id]);await query('UPDATE videos SET published_revision_id=$2 WHERE id=$1',[v.id,next]);}
  return workflowResponse({...artifact.draft,title:'Must not publish'});
 };
 try{
  const {executeJob}=await import('../services/worker/src/jobs'),job=await claimWorkflow(artifact.id);await executeJob(job);
  const saved=(await query('SELECT * FROM workflow_artifacts WHERE id=$1',[artifact.id]))[0];assert.equal(saved.status,'failed');assert.equal(saved.draft.title,'Standard operating procedure');assert.equal(saved.proposal,null);
  assert.equal((await query('SELECT payload FROM jobs WHERE id=$1',[job.id]))[0].payload.aiUsage.totalTokens,8,'Available usage survives rejected publication');
  assert.equal((await query('SELECT status FROM videos WHERE id=$1',[v.id]))[0].status,'ready');
 }finally{if(change==='access')await query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner]);}
}));

test('workflow retries are bounded, pinned to settings, and keep safe error messages',{skip:!run},async()=>withWorkflowAI(async()=>{
 const {base,revision}=await workflowFixture();
 const {artifact}=await(await request('POST',base,{expectedRevisionId:revision,templateId:'sop',templateVersion:1,generate:true})).json();
 const {executeJob}=await import('../services/worker/src/jobs');let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{message:'workflow-secret private response'}}),{status:429,headers:{'content-type':'application/json'}});};
 let job=await claimWorkflow(artifact.id);await executeJob(job);
 let stored=(await query('SELECT * FROM jobs WHERE id=$1',[job.id]))[0];assert.equal(stored.status,'queued');assert.doesNotMatch(stored.last_error,/workflow-secret/);
 await query("UPDATE settings SET value=jsonb_set(value,'{model}','\"changed\"') WHERE key='ai'");
 job=await claimWorkflow(artifact.id);await executeJob(job);assert.equal(calls,1);assert.equal((await query('SELECT status FROM jobs WHERE id=$1',[job.id]))[0].status,'failed');
 const {artifact:bad}=await(await request('POST',base,{expectedRevisionId:revision,templateId:'qa',templateVersion:1,generate:true})).json();
 globalThis.fetch=async()=>workflowResponse({title:'Injected',execute:'curl private-host',sections:[]});
 job=await claimWorkflow(bad.id);await executeJob(job);stored=(await query('SELECT * FROM jobs WHERE id=$1',[job.id]))[0];assert.equal(stored.status,'failed');assert.equal(stored.attempts,1);
 assert.equal((await query('SELECT proposal FROM workflow_artifacts WHERE id=$1',[bad.id]))[0].proposal,null);
}));

test('engagement intervals are idempotent, permission-scoped and exclude owner previews',{skip:!run},async()=>{
 const {v,revision}=await workflowFixture();
 await query("UPDATE videos SET duration=100,visibility='workspace' WHERE id=$1",[v.id]);await query('UPDATE revisions SET duration=100 WHERE id=$1',[revision]);
 const base=`/videos/${v.id}`,sessionId=randomUUID(),now=Date.now();
 const first={eventId:randomUUID(),sessionId,revisionId:revision,sequence:0,start:0,end:10,wallStart:now-20000,wallEnd:now-10000,playbackRate:1,visible:true,kind:'playback'};
 let response=await request('POST',base+'/watch-intervals',first,otherToken);assert.equal(response.status,200);
 assert.equal((await request('POST',base+'/watch-intervals',first,otherToken)).status,200);
 assert.equal((await request('POST',base+'/watch-intervals',{...first,end:9},otherToken)).status,409);
 const ending={...first,eventId:randomUUID(),sequence:1,start:90,end:100,wallStart:now-10000,wallEnd:now};
 assert.equal((await request('POST',base+'/watch-intervals',ending,otherToken)).status,200);
 const summary=await request('GET',base+'/engagement');assert.equal(summary.status,200);let report=await summary.json();
 assert.equal(report.measurement,'intervals');assert.equal(report.views,1);assert.equal(report.watchSeconds,20);assert.equal(report.uniqueWatchedSeconds,20);assert.equal(report.completionRate,0);assert.equal(report.viewers[0].userId,other);
 assert.equal((await request('GET',base+'/engagement',undefined,otherToken)).status,403);
 assert.equal((await request('GET',base+'/engagement',undefined,outsiderToken)).status,403);
 assert.equal((await request('POST',base+'/watch-intervals',{...first,eventId:randomUUID(),sessionId:randomUUID()},outsiderToken)).status,403);
 assert.equal((await request('POST',base+'/watch-intervals',{...first,eventId:randomUUID(),sessionId:randomUUID()},ownerToken)).status,200);
 report=await(await request('GET',base+'/engagement')).json();assert.equal(report.views,1,'Owner playback is always a preview');
 assert.equal((await request('POST',base+'/watch-intervals',{...first,eventId:randomUUID(),sequence:2,start:0,end:100,wallStart:now,wallEnd:now+1000},otherToken)).status,400);
 await query("UPDATE videos SET visibility='private' WHERE id=$1",[v.id]);
 assert.equal((await request('POST',base+'/watch-intervals',{...ending,eventId:randomUUID(),sequence:2},otherToken)).status,403);
 const next=randomUUID();await query("INSERT INTO revisions(id,video_id,status,duration) VALUES($1,$2,'ready',100)",[next,v.id]);await query('UPDATE videos SET published_revision_id=$2 WHERE id=$1',[v.id,next]);
 assert.equal((await request('POST',base+'/watch-intervals',{...first,eventId:randomUUID(),sessionId:randomUUID()},ownerToken)).status,409);
 report=await(await request('GET',base+'/engagement')).json();assert.equal(report.views,0);
 report=await(await request('GET',base+`/engagement?revisionId=${revision}`)).json();assert.equal(report.views,1);
 assert.equal((await query('SELECT count(*)::int AS n FROM watch_intervals WHERE video_id=$1',[v.id]))[0].n,3);
});

test('capabilities require login and recording limits survive operator changes',{skip:!run},async()=>{
 const oldBytes=process.env.RELAY_MAX_UPLOAD_BYTES,oldDuration=process.env.RELAY_MAX_DURATION_SECONDS;
 try{
  process.env.RELAY_MAX_UPLOAD_BYTES='1048576';process.env.RELAY_MAX_DURATION_SECONDS='10';
  assert.equal((await request('GET','/capabilities',undefined,'')).status,401);
  const response=await request('GET','/capabilities');assert.equal(response.status,200);
  const caps=await response.json();assert.equal(caps.maxUploadBytes,1048576);assert.equal(caps.maxDurationSeconds,10);
  assert.doesNotMatch(JSON.stringify(caps),/apiKey|encrypted|DATABASE_URL|INTERNAL_API_TOKEN/);
  const v=await recording();
  process.env.RELAY_MAX_UPLOAD_BYTES='5';process.env.RELAY_MAX_DURATION_SECONDS='1';
  const newer=await recording(),bytes=Buffer.from('123456'),sha256=digest(bytes);
  assert.equal((await request('PUT',`/recordings/${v.id}/parts/0`,bytes,ownerToken,{'x-content-sha256':sha256})).status,200);
  assert.equal((await request('PUT',`/recordings/${newer.id}/parts/0`,bytes,ownerToken,{'x-content-sha256':sha256})).status,413);
  const manifest={parts:[{index:0,size:6,sha256}],duration:2,mimeType:'video/mp4'};
  assert.equal((await request('POST',`/recordings/${v.id}/finalize`,manifest)).status,202);
  const oldSession=await(await request('GET',`/recordings/${v.id}`)).json();
  assert.equal(oldSession.upload.maxUploadBytes,1048576);assert.equal(oldSession.upload.maxDurationSeconds,10);
  assert.equal((await request('POST',`/recordings/${newer.id}/finalize`,manifest)).status,400);
 }finally{
  if(oldBytes===undefined)delete process.env.RELAY_MAX_UPLOAD_BYTES;else process.env.RELAY_MAX_UPLOAD_BYTES=oldBytes;
  if(oldDuration===undefined)delete process.env.RELAY_MAX_DURATION_SECONDS;else process.env.RELAY_MAX_DURATION_SECONDS=oldDuration;
 }
});

test('capacity migration upgrades legacy recordings and can be reapplied',{skip:!run},async()=>{
 const v=await recording();
 await query('ALTER TABLE videos DROP COLUMN capture_limits');
 await query('DELETE FROM schema_migrations WHERE version=3');
 const schema=await readFile(new URL('../packages/core/schema.sql',import.meta.url),'utf8');
 await query(schema);
 const upgraded=(await query('SELECT capture_limits FROM videos WHERE id=$1',[v.id]))[0];
 assert.deepEqual(upgraded.capture_limits,{maxUploadBytes:34359738368,maxDurationSeconds:21600});
 await query("UPDATE videos SET capture_limits='{\"maxUploadBytes\":1000,\"maxDurationSeconds\":100}' WHERE id=$1",[v.id]);
 await query(schema);
 assert.deepEqual((await query('SELECT capture_limits FROM videos WHERE id=$1',[v.id]))[0].capture_limits,{maxUploadBytes:1000,maxDurationSeconds:100});
});

test('speech configuration is owner-only, encrypted, versioned and scoped to allowed workspaces',{skip:!run},async()=>{
 assert.equal((await request('GET','/admin/transcription',undefined,otherToken)).status,403);
 const input={provider:'deepgram',model:'nova-3',apiKey:'speech-private-key',enabled:false,workspaceIds:[workspace],region:'us'};
 const response=await request('PUT','/admin/transcription',input);assert.equal(response.status,200);
 const {configuration}=await response.json();assert.ok(configuration.id);assert.equal(configuration.version,1);assert.equal(configuration.configured,true);
 assert.doesNotMatch(JSON.stringify(configuration),/speech-private-key|encryptedKey/);
 const rows=await query('SELECT encrypted_key FROM transcription_configurations WHERE id=$1',[configuration.id]);assert.notEqual(rows[0].encrypted_key,input.apiKey);assert.ok(rows[0].encrypted_key.length>20);
 assert.equal((await request('PUT','/admin/transcription',{...input,id:configuration.id,expectedVersion:0})).status,409);
 assert.equal((await request('GET',`/capabilities?workspaceId=${workspace}`,undefined,outsiderToken)).status,403);
 // Disabled or untested external settings cannot receive a recording's audio.
 let caps=await(await request('GET',`/capabilities?workspaceId=${workspace}`)).json();assert.ok(caps.transcription.every((s:any)=>s.provider==='parakeet'));
 const requested={execution:'server',provider:'deepgram',configurationId:configuration.id,configurationVersion:1};
 assert.equal((await request('POST','/recordings',{clientId:randomUUID(),workspaceId:workspace,title:'Explicit external',transcription:requested})).status,409);
 // Simulate a successful connection test for this exact immutable configuration version.
 await query('UPDATE transcription_configurations SET enabled=true,verified_version=version WHERE id=$1',[configuration.id]);
 caps=await(await request('GET',`/capabilities?workspaceId=${workspace}`)).json();assert.ok(caps.transcription.some((s:any)=>s.configurationId===configuration.id));assert.doesNotMatch(JSON.stringify(caps),/speech-private-key|encrypted_key/);
 const otherCaps=await(await request('GET',`/capabilities?workspaceId=${otherWorkspace}`,undefined,outsiderToken)).json();assert.ok(otherCaps.transcription.every((s:any)=>s.provider==='parakeet'));
 const clientId=randomUUID(),create={clientId,workspaceId:workspace,title:'Explicit external',transcription:requested};
 const accepted=await request('POST','/recordings',create);assert.equal(accepted.status,201);const v=(await accepted.json()).video;assert.equal(v.transcription.configurationVersion,1);
 assert.equal((await request('POST','/recordings',{...create,clientId:randomUUID(),transcriptionMode:'on_device'})).status,400);
 const changed=await request('PUT','/admin/transcription',{...input,id:configuration.id,expectedVersion:1});assert.equal(changed.status,200);assert.equal((await changed.json()).configuration.version,2);
 assert.equal((await request('POST','/recordings',create)).status,201,'Media resume survives speech configuration revocation');
 assert.equal((await request('POST','/recordings',{...create,clientId:randomUUID()})).status,409);
 const selfHosted=await request('POST','/recordings',{clientId:randomUUID(),workspaceId:workspace,title:'Default Parakeet'});assert.equal(selfHosted.status,201);assert.equal((await selfHosted.json()).video.transcription.provider,'parakeet');
});

test('worker honors selected speech provider, preserves untimed text and blocks revoked configurations',{skip:!run},async()=>{
 const {executeJob}=await import('../services/worker/src/jobs'),{command}=await import('../services/worker/src/media');
 const {configuration}=await(await request('PUT','/admin/transcription',{provider:'openai',model:'gpt-4o-transcribe',region:'provider-default',apiKey:'external-test-key',enabled:true,workspaceIds:[workspace]})).json();
 await query('UPDATE transcription_configurations SET verified_version=version WHERE id=$1',[configuration.id]);
 const file=join(root,'external-speech.mp4');await command('ffmpeg',['-y','-f','lavfi','-i','color=blue:size=160x90:duration=2','-f','lavfi','-i','sine=frequency=440:duration=2','-shortest','-c:v','libx264','-c:a','aac',file]);
 const prepare=async()=>{
  const creation=await request('POST','/recordings',{clientId:randomUUID(),workspaceId:workspace,title:'External speech',transcription:{execution:'server',provider:'openai',configurationId:configuration.id,configurationVersion:1}});assert.equal(creation.status,201);const v=(await creation.json()).video;
  const bytes=await readFile(file),sha256=digest(bytes);await request('PUT',`/recordings/${v.id}/parts/0`,bytes,ownerToken,{'x-content-sha256':sha256});await request('POST',`/recordings/${v.id}/finalize`,{parts:[{index:0,sha256,size:bytes.length}],mimeType:'video/mp4'});
  const [job]=await query<Job>("UPDATE jobs SET status='running',attempts=1,locked_at=now(),locked_by=$2 WHERE video_id=$1 AND kind='process' RETURNING *",[v.id,randomUUID()]);await executeJob(job);return v;
 };
 const runSpeech=async(id:string)=>{const [job]=await query<Job>("UPDATE jobs SET status='running',attempts=1,locked_at=now(),locked_by=$2 WHERE video_id=$1 AND kind='transcribe' RETURNING *",[id,randomUUID()]);await executeJob(job);return(await query('SELECT * FROM jobs WHERE id=$1',[job.id]))[0];};
 const v=await prepare(),revoked=await prepare(),corrected=await prepare(),changed=await prepare();
 const savedFetch=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async(input,options)=>{calls++;assert.equal(new URL(String(input)).hostname,'api.openai.com');assert.equal(new Headers(options?.headers).get('authorization'),'Bearer external-test-key');return Response.json({text:'Words without invented timing',usage:{type:'duration',seconds:2}});};
  assert.equal((await runSpeech(v.id)).status,'done');assert.equal(calls,1);
  let transcript=(await(await request('GET',`/videos/${v.id}/transcript`)).json()).transcript;assert.equal(transcript.text,'Words without invented timing');assert.equal(transcript.timing,'none');assert.deepEqual(transcript.segments,[]);assert.equal(transcript.provider,'openai');
  assert.equal((await request('GET',`/videos/${v.id}/media/captions.vtt`)).status,409);
  assert.equal((await request('PUT',`/videos/${v.id}/transcript`,{revisionId:v.initialRevisionId,segments:[],text:'My corrected words',timing:'none'})).status,200);
  transcript=(await(await request('GET',`/videos/${v.id}/transcript`)).json()).transcript;assert.equal(transcript.text,'My corrected words');
  assert.equal((await request('POST',`/videos/${v.id}/transcribe`,{mode:'server_api'})).status,409);
  // A stale worker must not turn a completed transcript back into processing.
  const [stale]=await query<Job>('SELECT * FROM jobs WHERE video_id=$1 AND kind=\'transcribe\'',[v.id]);
  await query('UPDATE transcripts SET user_edited=false WHERE revision_id=$1',[v.initialRevisionId]);
  await executeJob({...stale,locked_by:randomUUID()});
  assert.equal((await query('SELECT status FROM transcripts WHERE revision_id=$1',[v.initialRevisionId]))[0].status,'ready');
  globalThis.fetch=async()=>{calls++;assert.equal((await request('PUT',`/videos/${corrected.id}/transcript`,{revisionId:corrected.initialRevisionId,segments:[],text:'Correction while provider runs',timing:'none'})).status,200);return Response.json({text:'Late automatic text'});};
  assert.equal((await runSpeech(corrected.id)).status,'done');
  assert.equal((await query('SELECT text FROM transcripts WHERE revision_id=$1',[corrected.initialRevisionId]))[0].text,'Correction while provider runs');
  assert.equal((await query('SELECT status FROM transcription_attempts WHERE video_id=$1',[corrected.id]))[0].status,'superseded');
  globalThis.fetch=async()=>{calls++;await query('UPDATE transcription_configurations SET version=version+1 WHERE id=$1',[configuration.id]);return Response.json({text:'Result after configuration changed'});};
  assert.equal((await runSpeech(changed.id)).status,'failed');
  assert.equal((await query('SELECT status FROM transcripts WHERE revision_id=$1',[changed.initialRevisionId]))[0].status,'failed');
  await query('UPDATE transcription_configurations SET enabled=false WHERE id=$1',[configuration.id]);
  const result=await runSpeech(revoked.id);assert.equal(result.status,'failed');assert.equal(calls,3);
  assert.equal((await request('GET',`/videos/${revoked.id}/media/playback.mp4`)).status,200);
  const attempts=await query('SELECT provider,model,status,usage FROM transcription_attempts WHERE video_id=$1',[v.id]);assert.equal(attempts[0].provider,'openai');assert.equal(attempts[0].status,'ready');assert.ok(attempts[0].usage);
 }finally{globalThis.fetch=savedFetch;}
});

test('saved speech connection tests redact failures and enable only the tested version',{skip:!run},async()=>{
 const created=await request('PUT','/admin/transcription',{provider:'openai',model:'gpt-4o-transcribe',region:'provider-default',apiKey:'connection-private-key',enabled:true,workspaceIds:[workspace]});const {configuration}=await created.json();
 assert.equal((await request('POST','/admin/transcription/test',{id:configuration.id,expectedVersion:1},otherToken)).status,403);
 const savedFetch=globalThis.fetch;
 try{
  globalThis.fetch=async()=>new Response('connection-private-key',{status:401});
  const rejected=await request('POST','/admin/transcription/test',{id:configuration.id,expectedVersion:1});assert.equal(rejected.status,200);const failure=await rejected.json();assert.equal(failure.ok,false);assert.doesNotMatch(JSON.stringify(failure),/connection-private-key/);
  globalThis.fetch=async(_input,options)=>{const file=(options?.body as FormData).get('file') as Blob;assert.ok(file.size>32000);return Response.json({text:'Hello world. This is a transcription test.'});};
  const success=await request('POST','/admin/transcription/test',{id:configuration.id,expectedVersion:1});assert.equal(success.status,200);assert.equal((await success.json()).ok,true);
  assert.equal((await query('SELECT verified_version FROM transcription_configurations WHERE id=$1',[configuration.id]))[0].verified_version,1);
  const changed=await request('PUT','/admin/transcription',{id:configuration.id,expectedVersion:1,provider:'openai',model:'gpt-4o-transcribe',region:'provider-default',enabled:false,workspaceIds:[workspace]});assert.equal(changed.status,200);
  assert.equal((await request('POST','/admin/transcription/test',{id:configuration.id,expectedVersion:1})).status,409);
 }finally{globalThis.fetch=savedFetch;}
});

test('late device transcripts never overwrite corrections or another revision',{skip:!run},async()=>{
 const v=await recording();
 await query("UPDATE revisions SET status='ready',duration=10 WHERE id=$1",[v.initialRevisionId]);
 await query("UPDATE videos SET published_revision_id=$2,duration=10,status='ready' WHERE id=$1",[v.id,v.initialRevisionId]);
 const local={revisionId:v.initialRevisionId,source:'on_device',segments:[{start:0,end:2,text:'Device words'}]};
 assert.equal((await request('PUT',`/videos/${v.id}/transcript`,local)).status,200);
 assert.equal((await request('PUT',`/videos/${v.id}/transcript`,local)).status,200);
 assert.equal((await request('PUT',`/videos/${v.id}/transcript`,{revisionId:v.initialRevisionId,segments:[{start:0,end:2,text:'Corrected words'}]})).status,200);
 assert.equal((await request('PUT',`/videos/${v.id}/transcript`,local)).status,409);
 assert.equal((await(await request('GET',`/videos/${v.id}/transcript`)).json()).transcript.segments[0].text,'Corrected words');
 const edited=(await query("INSERT INTO revisions(video_id,status,duration) VALUES($1,'ready',5) RETURNING id",[v.id]))[0].id;
 await query('UPDATE videos SET published_revision_id=$2,duration=5 WHERE id=$1',[v.id,edited]);
 assert.equal((await request('PUT',`/videos/${v.id}/transcript`,{...local,revisionId:edited})).status,409);
 assert.equal((await query('SELECT * FROM transcripts WHERE revision_id=$1',[edited])).length,0);
});

test('transcript corrections use the edited revision admission limit',{skip:!run},async()=>{
 const v=await recording(),edited=randomUUID();
 await query("UPDATE videos SET capture_limits=jsonb_set(capture_limits,'{maxDurationSeconds}','10'),status='ready',published_revision_id=$2,duration=20 WHERE id=$1",[v.id,edited]);
 await query("INSERT INTO revisions(id,video_id,status,duration,edit) VALUES($1,$2,'ready',20,$3)",[edited,v.id,JSON.stringify({limits:{partSize:8388608,maxUploadBytes:34359738368,maxDurationSeconds:20}})]);
 const response=await request('PUT',`/videos/${v.id}/transcript`,{revisionId:edited,segments:[{start:15,end:19,text:'Stitched second clip'}]});assert.equal(response.status,200,await response.text());
 assert.equal((await request('PUT',`/videos/${v.id}/transcript`,{revisionId:edited,segments:[{start:19,end:21,text:'Beyond admitted limit'}]})).status,400);
});

test('acoustic cleanup is editor-only, revision-fenced and stale suggestions cannot be applied',{skip:!run},async()=>{
 const {executeJob}=await import('../services/worker/src/jobs'),{command}=await import('../services/worker/src/media');
 const v=await recording();await query("UPDATE revisions SET status='ready',duration=6 WHERE id=$1",[v.initialRevisionId]);await query("UPDATE videos SET status='ready',published_revision_id=$2,duration=6 WHERE id=$1",[v.id,v.initialRevisionId]);
 await atomicWrite(join(revisionRoot(v.id,v.initialRevisionId),'placeholder'),'');
 await command('ffmpeg',['-y','-f','lavfi','-i','color=blue:size=160x90:duration=6','-f','lavfi','-i','anullsrc=r=16000:cl=mono','-t','6','-c:v','libx264','-c:a','aac',join(revisionRoot(v.id,v.initialRevisionId),'playback.mp4')]);
 const path=`/videos/${v.id}/cleanup`,input={expectedRevisionId:v.initialRevisionId,expectedTranscriptVersion:null,language:'en'};
 assert.equal((await request('POST',path,input,otherToken)).status,403);
 assert.equal((await request('POST',path,{...input,expectedRevisionId:randomUUID()})).status,409);
 const accepted=await request('POST',path,input);assert.equal(accepted.status,202,await accepted.text());
 assert.equal((await request('POST',path,input)).status,409);
 const original=globalThis.fetch;
 try{
  globalThis.fetch=async input=>{assert.ok(String(input).endsWith('/analyze'));return Response.json({speech:[{start:0,end:1},{start:3,end:6}],audible:[]});};
  const [job]=await query<Job>("UPDATE jobs SET status='running',attempts=1,locked_at=now(),locked_by=$2 WHERE video_id=$1 AND kind='analyze_cleanup' RETURNING *",[v.id,randomUUID()]);await executeJob(job);
  const {analysis}=await(await request('GET',path)).json();assert.equal(analysis.status,'ready');assert.equal(analysis.suggestions.length,1);
  const cut=analysis.suggestions[0],edit={expectedRevisionId:v.initialRevisionId,clips:[{videoId:v.id,revisionId:v.initialRevisionId,start:0,end:cut.start},{videoId:v.id,revisionId:v.initialRevisionId,start:cut.end,end:6}],cleanup:{analysisId:analysis.id,transcriptVersion:null,suggestionIds:[cut.id]}};
  assert.equal((await request('POST',`/videos/${v.id}/revisions`,edit)).status,202);
  const correction=await request('PUT',`/videos/${v.id}/transcript`,{revisionId:v.initialRevisionId,segments:[{start:1,end:3,text:'Previously omitted speech'}]});assert.equal(correction.status,200);
  const corrected=(await correction.json()).transcript;assert.ok(corrected.version);
  assert.equal((await request('POST',`/videos/${v.id}/revisions`,edit)).status,409);
  assert.equal((await request('POST',path,input)).status,409);
  const wordCorrection=await request('PUT',`/videos/${v.id}/transcript`,{revisionId:v.initialRevisionId,segments:[{start:1,end:3,text:'Word timing',words:[{start:1,end:2,text:'Word'},{start:2,end:3,text:'timing'}]}]});
  const wordVersion=(await wordCorrection.json()).transcript.version;
  await request('PUT','/admin/ai',{provider:'openai',model:'test-model',apiKey:'context-secret-key',enabled:true});
  assert.equal((await request('POST',path,{...input,expectedTranscriptVersion:wordVersion,contextual:true})).status,202);
  globalThis.fetch=async input=>String(input).endsWith('/analyze')?Response.json({speech:[{start:0,end:1},{start:3,end:6}],audible:[]}):Response.json({error:{message:'context-secret-key',type:'authentication_error'}},{status:401});
  const [contextJob]=await query<Job>("UPDATE jobs SET status='running',attempts=1,locked_at=now(),locked_by=$2 WHERE video_id=$1 AND kind='analyze_cleanup' AND status='queued' RETURNING *",[v.id,randomUUID()]);await executeJob(contextJob);
  const result=(await(await request('GET',path)).json()).analysis;assert.equal(result.status,'ready');assert.equal(result.context.status,'failed');assert.doesNotMatch(JSON.stringify(result),/context-secret-key/);
  assert.equal((await request('GET',`/videos/${v.id}/media/playback.mp4`)).status,200);
 }finally{globalThis.fetch=original;}
});

test('repeated edits map comments and complete chapters without exposing removed discussion',{skip:!run},async()=>{
 const {executeJob}=await import('../services/worker/src/jobs'),{command}=await import('../services/worker/src/media');
 const v=await recording();await query("UPDATE revisions SET status='ready',duration=2 WHERE id=$1",[v.initialRevisionId]);await query("UPDATE videos SET status='ready',published_revision_id=$2,duration=2 WHERE id=$1",[v.id,v.initialRevisionId]);
 await atomicWrite(join(revisionRoot(v.id,v.initialRevisionId),'placeholder'),'');
 await command('ffmpeg',['-y','-f','lavfi','-i','color=blue:size=160x90:duration=2','-f','lavfi','-i','sine=frequency=440:duration=2','-t','2','-c:v','libx264','-c:a','aac',join(revisionRoot(v.id,v.initialRevisionId),'playback.mp4')]);
 const {comment}=await(await request('POST',`/videos/${v.id}/comments`,{body:'Retained discussion',timestamp:.25})).json();
 await request('POST',`/videos/${v.id}/comments`,{body:'Reply retained',parentId:comment.id});
 await request('POST',`/videos/${v.id}/comments`,{body:'Removed discussion',timestamp:1.25});
 await query("INSERT INTO ai_results(video_id,revision_id,status,chapters,user_edited) VALUES($1,$2,'ready',$3,'[\"chapters\"]')",[v.id,v.initialRevisionId,JSON.stringify([{start:0,title:'Retained chapter'},{start:1,title:'Removed chapter'}])]);
 await request('PUT',`/videos/${v.id}/transcript`,{revisionId:v.initialRevisionId,segments:[{start:0,end:1,text:'retained'},{start:1,end:2,text:'removed'}]});
 const edit=await request('POST',`/videos/${v.id}/revisions`,{expectedRevisionId:v.initialRevisionId,clips:[{videoId:v.id,revisionId:v.initialRevisionId,start:0,end:1},{videoId:v.id,revisionId:v.initialRevisionId,start:0,end:1}]});assert.equal(edit.status,202);
 const revision=(await edit.json()).revision;
 const [job]=await query<Job>("UPDATE jobs SET status='running',attempts=1,locked_at=now(),locked_by=$2 WHERE revision_id=$1 AND kind='render' RETURNING *",[revision.id,randomUUID()]);await executeJob(job);
 const detail=await(await request('GET',`/videos/${v.id}`)).json();assert.equal(detail.video.publishedRevisionId,revision.id);
 assert.deepEqual(detail.comments.map((c:any)=>c.body),['Retained discussion','Reply retained']);
 assert.deepEqual(detail.comments[0].timestamps,[.25,1.25]);
 assert.deepEqual(detail.ai.chapters,[{start:0,title:'Retained chapter'},{start:1,title:'Retained chapter'}]);
 assert.equal((await request('POST',`/videos/${v.id}/comments`,{body:'Reply on edited recording',parentId:comment.id,revisionId:revision.id})).status,201);
 assert.equal((await query('SELECT count(*)::int AS n FROM comments WHERE revision_id=$1',[v.initialRevisionId]))[0].n,3);
});
test('late speech attaches only to the original revision and canceled videos reject it',{skip:!run},async()=>{
 const v=await recording();
 await query("UPDATE revisions SET status='ready',duration=10 WHERE id=$1",[v.initialRevisionId]);
 const edited=(await query("INSERT INTO revisions(video_id,status,duration) VALUES($1,'ready',2) RETURNING id",[v.id]))[0].id;
 await query("UPDATE videos SET published_revision_id=$2,duration=2,status='ready' WHERE id=$1",[v.id,edited]);
 const local={revisionId:v.initialRevisionId,source:'on_device',segments:[{start:5,end:9,text:'Removed source speech'}]};
 assert.equal((await request('PUT',`/videos/${v.id}/transcript`,local)).status,200);
 assert.equal((await(await request('GET',`/videos/${v.id}/transcript`)).json()).transcript,null);
 const canceled=await recording();
 await request('DELETE',`/recordings/${canceled.id}`);
 assert.equal((await request('PUT',`/videos/${canceled.id}/transcript`,{...local,revisionId:canceled.initialRevisionId})).status,409);
 await request('DELETE',`/videos/${v.id}`);
 assert.equal((await request('PUT',`/videos/${v.id}/transcript`,local)).status,404);
});
test('on-device media publishes before speech and late captions become playable',{skip:!run},async()=>{
 const {command}=await import('../services/worker/src/media');
 const {executeJob}=await import('../services/worker/src/jobs');
 const file=join(root,'pending-speech.mp4');
 await command('ffmpeg',['-y','-f','lavfi','-i','color=blue:size=160x90:rate=30:duration=2','-f','lavfi','-i','sine=frequency=440:duration=2','-shortest','-c:v','libx264','-c:a','aac',file]);
 const v=await recording(),bytes=await readFile(file),sha256=digest(bytes);
 assert.equal((await request('PUT',`/recordings/${v.id}/parts/0`,bytes,ownerToken,{'x-content-sha256':sha256})).status,200);
 assert.equal((await request('POST',`/recordings/${v.id}/finalize`,{parts:[{index:0,sha256,size:bytes.length}],mimeType:'video/mp4'})).status,202);
 const job=(await query<Job>("UPDATE jobs SET status='running',attempts=1,locked_at=now(),locked_by=$2 WHERE video_id=$1 AND kind='process' RETURNING *",[v.id,randomUUID()]))[0];
 await executeJob(job);
 assert.equal((await query('SELECT status FROM videos WHERE id=$1',[v.id]))[0].status,'ready');
 assert.equal((await request('GET',`/videos/${v.id}/media/playback.mp4`)).status,200);
 assert.equal((await request('GET',`/videos/${v.id}/media/captions.vtt`)).status,404);
 assert.equal((await query("SELECT id FROM jobs WHERE video_id=$1 AND kind='transcribe'",[v.id])).length,0);
 assert.equal((await request('PUT',`/videos/${v.id}/transcript`,{revisionId:v.initialRevisionId,source:'on_device',segments:[{start:0,end:1,text:'Late captions'}]})).status,200);
 assert.match(await(await request('GET',`/videos/${v.id}/media/captions.vtt`)).text(),/Late captions/);
});

test('audio recordings preserve originals, publish edits, and obey sharing permissions',{skip:!run},async()=>{
 const {command,probe}=await import('../services/worker/src/media'),{executeJob}=await import('../services/worker/src/jobs');
 const file=join(root,'audio-only.mp4');await command('ffmpeg',['-y','-f','lavfi','-i','sine=frequency=440:duration=3','-c:a','aac',file]);
 const clientId=randomUUID(),input={clientId,workspaceId:workspace,title:'Voice note',mediaKind:'audio',transcriptionMode:'on_device',mimeType:'audio/mp4'};
 const creation=await request('POST','/recordings',input);assert.equal(creation.status,201);
 const v=(await creation.json()).video;assert.equal(v.mediaKind,'audio');
 assert.equal((await request('POST','/recordings',{...input,mediaKind:'video',mimeType:'video/mp4'})).status,409);
 const bytes=await readFile(file),sha256=digest(bytes),manifest={parts:[{index:0,size:bytes.length,sha256}],mimeType:'audio/mp4'};
 assert.equal((await request('PUT',`/recordings/${v.id}/parts/0`,bytes,ownerToken,{'x-content-sha256':sha256})).status,200);
 assert.equal((await request('POST',`/recordings/${v.id}/finalize`,{...manifest,mimeType:'video/mp4'})).status,400);
 assert.equal((await request('POST',`/recordings/${v.id}/finalize`,manifest)).status,202);
 assert.equal((await request('POST',`/recordings/${v.id}/finalize`,manifest)).status,202);
 const run=async(kind:string,revision:string)=>{const jobs=await query<Job>("UPDATE jobs SET status='running',attempts=1,locked_at=now(),locked_by=$3 WHERE video_id=$1 AND revision_id=$2 AND kind=$4 RETURNING *",[v.id,revision,randomUUID(),kind]);assert.equal(jobs.length,1);await executeJob(jobs[0]);assert.equal((await query('SELECT status,last_error FROM jobs WHERE id=$1',[jobs[0].id]))[0].status,'done');};
 await run('process',v.initialRevisionId);
 assert.equal(digest(await readFile(join(videoRoot(v.id),'original/source.mp4'))),sha256);
 assert.equal((await request('GET',`/videos/${v.id}/media/playback.mp4`,undefined,outsiderToken)).status,403);
 assert.equal((await request('GET',`/videos/${v.id}/media/source.mp4`)).status,404);
 assert.equal((await request('PUT',`/videos/${v.id}/transcript`,{revisionId:v.initialRevisionId,segments:[{start:1,end:2,text:'Voice note'}]})).status,200);
 const edit=await request('POST',`/videos/${v.id}/revisions`,{expectedRevisionId:v.initialRevisionId,clips:[{videoId:v.id,revisionId:v.initialRevisionId,start:1,end:2}]});assert.equal(edit.status,202);
 const revision=(await edit.json()).revision;await run('render',revision.id);
 const detail=await(await request('GET',`/videos/${v.id}`)).json();assert.equal(detail.video.mediaKind,'audio');assert.equal(detail.video.publishedRevisionId,revision.id);
 assert.match(await(await request('GET',`/videos/${v.id}/media/captions.vtt`)).text(),/00:00:00\.000 --> 00:00:01\.000\nVoice note/);
 assert.equal((await request('GET',`/videos/${v.id}/export`)).status,200);
 assert.ok(Math.abs((await probe(join(revisionRoot(v.id,revision.id),'playback.mp4'))).duration-1)<0.1);
 const share=(await(await request('POST',`/videos/${v.id}/share`,{visibility:'password',password:'secret-123'})).json()).share;
 assert.equal((await request('GET',`/videos/${v.id}/media/playback.mp4?share=${share.token}`,undefined,'')).status,401);
 const unlocked=await request('POST',`/shares/${share.token}/unlock`,{password:'secret-123'},'');assert.equal(unlocked.status,200);
 const cookie=unlocked.headers.get('set-cookie')!.split(';')[0];
 assert.equal((await request('GET',`/videos/${v.id}/media/playback.mp4?share=${share.token}`,undefined,'',{cookie})).status,200);
 assert.equal((await request('GET',`/videos/${v.id}/media/playback.mp4?share=${share.token}&revision=${v.initialRevisionId}`,undefined,'',{cookie})).status,403);
});

test('audio-only speech and silence pass through real self-hosted Parakeet',{skip:!run||process.env.ASR_LIVE_TEST!=='1'},async()=>{
 const {executeJob}=await import('../services/worker/src/jobs');
 for(const name of ['speech','silence']){
  const bytes=await readFile(join(process.env.ASR_FIXTURE_DIR!,`${name}.m4a`)),sha256=digest(bytes);
  const created=await request('POST','/recordings',{clientId:randomUUID(),workspaceId:workspace,title:'Audio ASR fixture',mediaKind:'audio',transcriptionMode:'server_api',mimeType:'audio/mp4'});assert.equal(created.status,201);
  const v=(await created.json()).video;
  assert.equal((await request('PUT',`/recordings/${v.id}/parts/0`,bytes,ownerToken,{'x-content-sha256':sha256})).status,200);
  assert.equal((await request('POST',`/recordings/${v.id}/finalize`,{parts:[{index:0,size:bytes.length,sha256}],mimeType:'audio/mp4'})).status,202);
  for(const kind of ['process','transcribe']){
   const [job]=await query<Job>("UPDATE jobs SET status='running',attempts=1,locked_at=now(),locked_by=$3 WHERE video_id=$1 AND kind=$2 RETURNING *",[v.id,kind,randomUUID()]);assert.ok(job);await executeJob(job);
   const [status]=await query('SELECT status,last_error FROM jobs WHERE id=$1',[job.id]);assert.equal(status.status,'done',status.last_error);
  }
  const {transcript}=await(await request('GET',`/videos/${v.id}/transcript`)).json();assert.equal(transcript.status,'ready');
  if(name==='silence')assert.deepEqual(transcript.segments,[]);
  else{assert.match(transcript.segments.map((s:any)=>s.text).join(' '),/hello world/i);assert.ok(transcript.segments.every((s:any)=>s.words?.length));}
  assert.equal((await request('GET',`/videos/${v.id}/media/captions.vtt`)).status,200);
  assert.equal((await request('POST',`/videos/${v.id}/cleanup`,{expectedRevisionId:v.initialRevisionId,expectedTranscriptVersion:transcript.version,language:null})).status,202);
  const [cleanupJob]=await query<Job>("UPDATE jobs SET status='running',attempts=1,locked_at=now(),locked_by=$2 WHERE video_id=$1 AND kind='analyze_cleanup' RETURNING *",[v.id,randomUUID()]);await executeJob(cleanupJob);
  const {analysis}=await(await request('GET',`/videos/${v.id}/cleanup`)).json();assert.equal(analysis.status,'ready',analysis.error);
  if(name==='silence')assert.ok(analysis.suggestions.some((s:any)=>s.kind==='silence'));
  else for(const cut of analysis.suggestions)for(const segment of transcript.segments)assert.ok(cut.end<=segment.start||cut.start>=segment.end,'No acoustic cut may remove recognized speech');
 }
});
before(async()=>{
 if(!run)return;const url=new URL(process.env.DATABASE_URL!);url.pathname='/relay_api_test';const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});try{if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='relay_api_test'")).rows.length)await admin.query('CREATE DATABASE relay_api_test');}finally{await admin.end();}
 process.env.DATABASE_URL=url.toString();process.env.BETTER_AUTH_URL='http://localhost:3000';process.env.BETTER_AUTH_SECRET='test-secret-'.repeat(5);process.env.ENCRYPTION_KEY='ab'.repeat(32);root=await mkdtemp(join(tmpdir(),'relay-api-'));process.env.DATA_DIR=root;
 await(await getMigrations(authOptions())).runMigrations();await query(await readFile(new URL('../packages/core/schema.sql',import.meta.url),'utf8'));await query('TRUNCATE "user" CASCADE');await query("DELETE FROM settings WHERE key LIKE 'oauth:%'");
 [owner,other,outsider]=[randomUUID(),randomUUID(),randomUUID()];for(const [id,email,tok] of [[owner,'owner@test.invalid',ownerToken],[other,'member@test.invalid',otherToken],[outsider,'outsider@test.invalid',outsiderToken]]){await query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[id,email,email]);await query('INSERT INTO device_tokens(token_hash,user_id) VALUES($1,$2)',[hashToken(tok),id]);}
 await query('INSERT INTO instance_admins(user_id) VALUES($1)',[owner]);workspace=(await(await request('POST','/workspaces',{name:'Team'})).json()).workspace.id;otherWorkspace=(await(await request('POST','/workspaces',{name:'Other'},outsiderToken)).json()).workspace.id;await query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",[workspace,other]);
});
after(async()=>{if(run){await closeDatabase();if(root)await rm(root,{recursive:true,force:true});}});
test('cross-workspace upload and private metadata are denied',{skip:!run},async()=>{
 const v=await recording();assert.equal((await request('GET','/videos/'+v.id,undefined,otherToken)).status,403);assert.equal((await request('GET','/videos/'+v.id,undefined,outsiderToken)).status,403);
 assert.equal((await request('POST','/recordings',{clientId:randomUUID(),workspaceId:otherWorkspace,title:'x',transcriptionMode:'server_api'})).status,403);
});
test('video library returns accessible results and filters other workspace data',{skip:!run},async()=>{
 const v=await recording();let response=await request('GET',`/videos?workspaceId=${workspace}`);assert.equal(response.status,200);assert.ok((await response.json()).videos.some((x:any)=>x.id===v.id));
 response=await request('GET',`/videos?workspaceId=${workspace}`,undefined,otherToken);assert.equal(response.status,200);assert.ok(!(await response.json()).videos.some((x:any)=>x.id===v.id));
 assert.equal((await request('GET',`/videos?workspaceId=${workspace}`,undefined,outsiderToken)).status,403);
});
test('upload digest, idempotency and completion barrier survive repeat requests',{skip:!run},async()=>{
 const v=await recording(),bytes=Buffer.from('immutable uploaded bytes'),sha256=digest(bytes);const path=`/recordings/${v.id}/parts/0`;
 assert.equal((await request('PUT',path,bytes,ownerToken,{'x-content-sha256':'a'.repeat(64)})).status,422);
 assert.equal((await request('PUT',path,bytes,ownerToken,{'x-content-sha256':sha256})).status,200);
 assert.equal((await request('PUT',path,bytes,ownerToken,{'x-content-sha256':sha256})).status,200);
 const alternate=Buffer.from('different');assert.equal((await request('PUT',path,alternate,ownerToken,{'x-content-sha256':digest(alternate)})).status,409);
 const body={parts:[{index:0,size:bytes.length,sha256}],mimeType:'video/mp4'};
 assert.equal((await request('POST',`/recordings/${v.id}/finalize`,body)).status,202);
 assert.equal((await request('POST',`/recordings/${v.id}/finalize`,body)).status,202);
 assert.equal((await query('SELECT * FROM jobs WHERE video_id=$1',[v.id])).length,1);
 assert.equal((await request('PUT',`/recordings/${v.id}/parts/1`,bytes,ownerToken,{'x-content-sha256':sha256})).status,409);
});
test('incomplete finalization remains retryable and cancellation rejects late uploads',{skip:!run},async()=>{
 const v=await recording();assert.equal((await request('POST',`/recordings/${v.id}/finalize`,{parts:[{index:0,sha256:'a'.repeat(64),size:12}],mimeType:'video/mp4'})).status,409);
 assert.equal((await query('SELECT status FROM videos WHERE id=$1',[v.id]))[0].status,'uploading');
 await request('DELETE',`/recordings/${v.id}`);const bytes=Buffer.from('later');assert.equal((await request('PUT',`/recordings/${v.id}/parts/0`,bytes,ownerToken,{'x-content-sha256':digest(bytes)})).status,409);
});
test('published media supports ranges and revoked share cannot read earlier revision',{skip:!run},async()=>{
 const v=await recording();await query("UPDATE revisions SET status='ready',duration=10 WHERE id=$1",[v.initialRevisionId]);await query("UPDATE videos SET status='ready',published_revision_id=$2,duration=10 WHERE id=$1",[v.id,v.initialRevisionId]);await atomicWrite(join(revisionRoot(v.id,v.initialRevisionId),'playback.mp4'),Buffer.from('0123456789'));
 const share=(await(await request('POST',`/videos/${v.id}/share`,{visibility:'unlisted'})).json()).share;
 let response=await request('GET',`/videos/${v.id}/media/playback.mp4?share=${share.token}`,undefined,'',{range:'bytes=2-5'});assert.equal(response.status,206);assert.equal(await response.text(),'2345');
 response=await request('GET',`/videos/${v.id}/media/playback.mp4?share=${share.token}&revision=${v.initialRevisionId}`,undefined,'');assert.equal(response.status,403);
 await request('DELETE',`/videos/${v.id}/share`);assert.equal((await request('GET',`/videos/${v.id}/media/playback.mp4?share=${share.token}`,undefined,'')).status,401);
});
test('password unlock cookie expires when sharing is changed',{skip:!run},async()=>{
 const v=await recording();const s=(await(await request('POST',`/videos/${v.id}/share`,{visibility:'password',password:'secret-password'})).json()).share;
 assert.equal((await request('GET',`/shares/${s.token}`,undefined,'')).status,401);
 const unlock=await request('POST',`/shares/${s.token}/unlock`,{password:'secret-password'},'');assert.equal(unlock.status,200);const cookie=unlock.headers.get('set-cookie')!.split(';')[0];
 assert.equal((await request('GET',`/shares/${s.token}`,undefined,'',{cookie})).status,200);
 const changed=(await(await request('POST',`/videos/${v.id}/share`,{visibility:'password',password:'another-password'})).json()).share;
 assert.equal((await request('GET',`/shares/${changed.token}`,undefined,'',{cookie})).status,401);
});
test('native login verifier binds approval and exchange is single-use',{skip:!run},async()=>{
 const verifier='x'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');const start=await request('POST','/device/start',{challenge},'');assert.equal(start.status,201);const login=await start.json();
 assert.equal((await request('POST','/device/exchange',{id:login.id,verifier},'')).status,202);
 await request('POST','/device/approve',{id:login.id});assert.equal((await request('POST','/device/exchange',{id:login.id,verifier:'y'.repeat(64)},'')).status,403);
 const success=await request('POST','/device/exchange',{id:login.id,verifier},'');assert.equal(success.status,200);const session=await success.json();assert.equal((await request('GET','/me',undefined,session.token)).status,200);
 assert.equal((await request('POST','/device/exchange',{id:login.id,verifier},'')).status,410);
 await request('DELETE','/device/session',undefined,session.token);
 assert.equal((await request('GET','/me',undefined,session.token)).status,401);
 const expired=await(await request('POST','/device/start',{challenge},'')).json();
 await query("UPDATE device_logins SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);
 assert.equal((await request('POST','/device/approve',{id:expired.id})).status,409);
 assert.equal((await request('POST','/device/exchange',{id:expired.id,verifier},'')).status,410);
});
test('AI settings conceal stored credentials and non-admin cannot read them',{skip:!run},async()=>{
 assert.equal((await request('PUT','/admin/ai',{provider:'openai',model:'test-model',apiKey:'sensitive-test-key',enabled:true})).status,200);
 const settings=await(await request('GET','/admin/ai')).json();assert.equal(settings.settings.configured,true);assert.ok(!JSON.stringify(settings).includes('sensitive-test-key'));assert.ok(!JSON.stringify(settings).includes('encryptedApiKey'));
 assert.equal((await request('GET','/admin/ai',undefined,otherToken)).status,403);
});
test('detail bookmark toggles round-trip and stay scoped to each viewer',{skip:!run},async()=>{
 const v=await recording();
 let response=await request('PATCH',`/videos/${v.id}`,{favorite:true,watchLater:true});
 assert.equal(response.status,200);let detail=await response.json();assert.equal(detail.video.favorite,true);assert.equal(detail.video.watchLater,true);
 detail=await(await request('GET',`/videos/${v.id}`)).json();assert.equal(detail.video.favorite,true);
 await request('POST',`/videos/${v.id}/share`,{visibility:'workspace'});
 detail=await(await request('GET',`/videos/${v.id}`,undefined,otherToken)).json();assert.equal(detail.video.favorite,false);assert.equal(detail.video.watchLater,false);
 detail=await(await request('PATCH',`/videos/${v.id}`,{favorite:false})).json();assert.equal(detail.video.favorite,false);assert.equal(detail.video.watchLater,true);
});
test('HLS segments pin published revision and reject stale playback after publication',{skip:!run},async()=>{
 const v=await recording();await query("UPDATE revisions SET status='ready',duration=10 WHERE id=$1",[v.initialRevisionId]);await query("UPDATE videos SET status='ready',published_revision_id=$2,duration=10 WHERE id=$1",[v.id,v.initialRevisionId]);
 await atomicWrite(join(revisionRoot(v.id,v.initialRevisionId),'hls/index.m3u8'),'#EXTM3U\n#EXTINF:10,\nsegment000.ts\n#EXT-X-ENDLIST');
 await atomicWrite(join(revisionRoot(v.id,v.initialRevisionId),'hls/segment000.ts'),Buffer.from('first revision'));
 const share=(await(await request('POST',`/videos/${v.id}/share`,{visibility:'unlisted'})).json()).share;
 const manifest=await request('GET',`/videos/${v.id}/media/hls/index.m3u8?share=${share.token}`,undefined,'');assert.equal(manifest.status,200);
 const segment=(await manifest.text()).split('\n').find(line=>line.startsWith('segment'))!;assert.ok(segment.includes(`version=${v.initialRevisionId}`));
 const path=`/videos/${v.id}/media/hls/${segment}`;assert.equal((await request('GET',path,undefined,'')).status,200);
 const newer=randomUUID();await query("INSERT INTO revisions(id,video_id,status,duration) VALUES($1,$2,'ready',5)",[newer,v.id]);await query('UPDATE videos SET published_revision_id=$2 WHERE id=$1',[v.id,newer]);await atomicWrite(join(revisionRoot(v.id,newer),'hls/segment000.ts'),Buffer.from('newer revision'));
 assert.equal((await request('GET',path,undefined,'')).status,409);
 assert.equal((await request('GET',`/videos/${v.id}/media/playback.mp4?share=${share.token}&version=${v.initialRevisionId}`,undefined,'')).status,409);
});
test('unpublished on-device speech stays private until its revision is published',{skip:!run},async()=>{
 const v=await recording();
 const response=await request('PUT',`/videos/${v.id}/transcript`,{revisionId:v.initialRevisionId,segments:[{start:0,end:3,text:'Unpublished private speech'}]});assert.equal(response.status,200);
 const share=(await(await request('POST',`/videos/${v.id}/share`,{visibility:'unlisted'})).json()).share;
 assert.equal((await(await request('GET',`/videos/${v.id}`)).json()).transcript.segments[0].text,'Unpublished private speech');
 for(const path of [`/shares/${share.token}`,`/videos/${v.id}/transcript?share=${share.token}`]){
  const result=await request('GET',path,undefined,'');assert.equal(result.status,200);assert.equal((await result.json()).transcript,null);
 }
 await query("UPDATE revisions SET status='ready',duration=3 WHERE id=$1",[v.initialRevisionId]);await query("UPDATE videos SET status='ready',published_revision_id=$2,duration=3 WHERE id=$1",[v.id,v.initialRevisionId]);
 assert.equal((await(await request('GET',`/shares/${share.token}`,undefined,'')).json()).transcript.segments[0].text,'Unpublished private speech');
});

test('meeting recap automation deduplicates drafts and cancellation fences publication',{skip:!run},async()=>withWorkflowAI(async()=>{
 const {v,revision,base}=await workflowFixture(),path=`/videos/${v.id}/meeting-recap`;
 assert.equal((await request('PUT',path,{enabled:true,expectedVersion:0},otherToken)).status,403);
 const enabled=await request('PUT',path,{enabled:true,expectedVersion:0});assert.equal(enabled.status,200);
 const {queueMeetingRecaps}=await import('../services/worker/src/meeting-recap');
 await Promise.all([queueMeetingRecaps(),queueMeetingRecaps()]);
 const artifacts=(await(await request('GET',base)).json()).artifacts;assert.equal(artifacts.length,1);assert.equal(artifacts[0].templateId,'meeting_recap');
 assert.equal((await request('PUT',path,{enabled:false,expectedVersion:0})).status,409);
 const {executeJob}=await import('../services/worker/src/jobs');
 globalThis.fetch=async()=>{
  assert.equal((await request('PUT',path,{enabled:false,expectedVersion:1})).status,200);
  return workflowResponse({...artifacts[0].draft,title:'Canceled recap'});
 };
 await executeJob(await claimWorkflow(artifacts[0].id));
 const saved=(await query('SELECT status,draft FROM workflow_artifacts WHERE id=$1',[artifacts[0].id]))[0];assert.equal(saved.status,'failed');assert.notEqual(saved.draft.title,'Canceled recap');
 assert.equal((await query('SELECT status,published_revision_id FROM videos WHERE id=$1',[v.id]))[0].published_revision_id,revision);
 await queueMeetingRecaps();assert.equal((await query('SELECT 1 FROM workflow_artifacts WHERE video_id=$1',[v.id])).length,1);
}));

test('meeting automation waits for AI and transcript without blocking playback',{skip:!run},async()=>{
 const {v,base}=await workflowFixture(),path=`/videos/${v.id}/meeting-recap`;
 const previous=(await query("SELECT value FROM settings WHERE key='ai'"))[0];
 try{
  await query("DELETE FROM settings WHERE key='ai'");
  assert.equal((await request('PUT',path,{enabled:true,expectedVersion:0})).status,200);
  const {queueMeetingRecaps}=await import('../services/worker/src/meeting-recap');await queueMeetingRecaps();
  const state=await(await request('GET',path)).json();assert.equal(state.enabled,true);assert.match(state.waitingFor,/cloud model/i);
  assert.equal((await(await request('GET',base)).json()).artifacts.length,0);
  assert.equal((await request('GET',path,undefined,outsiderToken)).status,403);
  assert.equal((await request('PUT',path,{enabled:false,expectedVersion:1})).status,200);
 }finally{if(previous)await query("INSERT INTO settings(key,value) VALUES('ai',$1)",[previous.value]);}
});

async function deliveryFixture(){
 const {v,revision,base}=await workflowFixture();
 const {artifact}=await(await request('POST',base,{expectedRevisionId:revision,templateId:'agent_prompt',templateVersion:1})).json();
 const saved=await(await request('PATCH',`${base}/${artifact.id}`,{expectedVersion:1,draft:{...artifact.draft,title:'Reviewed handoff',sections:artifact.draft.sections.map((s:any)=>({...s,body:'Reviewed facts'}))}})).json();
 const input={provider:'github',name:'Engineering',audience:'Repository collaborators',destination:{repository:'example/project'},token:'connector-private-token'};
 const response=await request('POST',`/workspaces/${workspace}/connections`,input);assert.equal(response.status,201);const connection=(await response.json()).connection;
 return {v,revision,base,artifact:saved.artifact,connection,input};
}
async function claimDelivery(id:string){return(await query<Job>("UPDATE jobs SET status='running',locked_at=now(),locked_by=$2,attempts=attempts+1 WHERE kind='delivery' AND resource_key=$1 RETURNING *",[id,randomUUID()]))[0];}

test('reviewed deliveries are scoped, idempotent, encrypted and fenced at send time',{skip:!run},async()=>{
 const {v,revision,base,artifact,connection,input}=await deliveryFixture(),path=`${base}/${artifact.id}/deliveries`;
 assert.equal((await request('POST',`/workspaces/${workspace}/connections`,input,otherToken)).status,403);
 assert.doesNotMatch(JSON.stringify(await(await request('GET',`/workspaces/${workspace}/connections`)).json()),/connector-private-token|encrypted_token/);
 assert.notEqual((await query('SELECT encrypted_token FROM connections WHERE id=$1',[connection.id]))[0].encrypted_token,input.token);
 const payload={connectionId:connection.id,expectedVersion:artifact.version,expectedRevisionId:revision,idempotencyKey:randomUUID(),confirmed:true};
 assert.equal((await request('POST',path,payload,outsiderToken)).status,403);
 const first=await request('POST',path,payload);assert.equal(first.status,202);const delivery=(await first.json()).delivery;
 const duplicate=await(await request('POST',path,payload)).json();assert.equal(duplicate.delivery.id,delivery.id);
 assert.equal((await query("SELECT 1 FROM jobs WHERE kind='delivery' AND resource_key=$1",[delivery.id])).length,1);
 await request('PATCH',`${base}/${artifact.id}`,{expectedVersion:artifact.version,draft:{...artifact.draft,title:'Changed after review'}});
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({number:1});};
 try{const {executeJob}=await import('../services/worker/src/jobs');await executeJob(await claimDelivery(delivery.id));assert.equal(calls,0);assert.equal((await query('SELECT status FROM deliveries WHERE id=$1',[delivery.id]))[0].status,'canceled');}
 finally{globalThis.fetch=original;}
 assert.equal((await query('SELECT status FROM videos WHERE id=$1',[v.id]))[0].status,'ready');
});

test('lost delivery acknowledgements and worker crashes require deliberate reconciliation',{skip:!run},async()=>{
 const {base,artifact,revision,connection}=await deliveryFixture(),path=`${base}/${artifact.id}/deliveries`;
 const payload={connectionId:connection.id,expectedVersion:artifact.version,expectedRevisionId:revision,idempotencyKey:randomUUID(),confirmed:true};
 const {delivery}=await(await request('POST',path,payload)).json();
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('connector-private-token network loss');};
 const {executeJob}=await import('../services/worker/src/jobs');
 try{
  await executeJob(await claimDelivery(delivery.id));let row=(await query('SELECT * FROM deliveries WHERE id=$1',[delivery.id]))[0];assert.equal(row.status,'uncertain');assert.doesNotMatch(row.error,/connector-private-token/);
  await executeJob(await claimDelivery(delivery.id));assert.equal(calls,1,'Uncertain delivery must never be sent automatically again');
  const confirmed=await request('POST',`${path}/${delivery.id}/reconcile`,{outcome:'sent',externalId:'22',confirmed:true});assert.equal(confirmed.status,200);
  row=(await query('SELECT * FROM deliveries WHERE id=$1',[delivery.id]))[0];assert.equal(row.status,'sent');assert.equal(row.external_id,'22');
  const second=(await(await request('POST',path,{...payload,idempotencyKey:randomUUID()})).json()).delivery;
  await query("UPDATE deliveries SET status='sending' WHERE id=$1",[second.id]);
  await executeJob(await claimDelivery(second.id));assert.equal(calls,1);assert.equal((await query('SELECT status FROM deliveries WHERE id=$1',[second.id]))[0].status,'uncertain');
 }finally{globalThis.fetch=original;}
});

for(const revoked of ['none','share','connection','membership'])test(`delivery rechecks ${revoked} changes and records acknowledged sends`,{skip:!run},async()=>{
 const {v,base,artifact,revision,connection}=await deliveryFixture(),path=`${base}/${artifact.id}/deliveries`;
 await request('POST',`/videos/${v.id}/share`,{visibility:'unlisted'});
 const {delivery}=await(await request('POST',path,{connectionId:connection.id,expectedVersion:artifact.version,expectedRevisionId:revision,idempotencyKey:randomUUID(),confirmed:true})).json();
 if(revoked==='share')await request('DELETE',`/videos/${v.id}/share`);
 if(revoked==='connection')await request('DELETE',`/workspaces/${workspace}/connections/${connection.id}`);
 if(revoked==='membership')await query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2',[workspace,owner]);
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({number:17});};
 try{
  const {executeJob}=await import('../services/worker/src/jobs');await executeJob(await claimDelivery(delivery.id));
  const row=(await query('SELECT status,external_id FROM deliveries WHERE id=$1',[delivery.id]))[0];assert.equal(calls,revoked==='none'?1:0);assert.equal(row.status,revoked==='none'?'sent':'canceled');if(revoked==='none')assert.equal(row.external_id,'17');
  await query(await readFile(new URL('../packages/core/schema.sql',import.meta.url),'utf8'));
  assert.equal((await query('SELECT status FROM deliveries WHERE id=$1',[delivery.id]))[0].status,row.status,'Reapplying additive migration preserves outbox state');
 }finally{globalThis.fetch=original;if(revoked==='membership')await query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner]);}
});

test('presentation previews read historical transcripts only for authorized editors',{skip:!run},async()=>{
 const {v,revision}=await workflowFixture(),next=randomUUID();
 await query("INSERT INTO revisions(id,video_id,status,duration) VALUES($1,$2,'ready',5)",[next,v.id]);await query('UPDATE videos SET published_revision_id=$2,visibility=\'workspace\' WHERE id=$1',[v.id,next]);
 const path=`/videos/${v.id}/transcript?revision=${revision}`;
 const allowed=await request('GET',path);assert.equal(allowed.status,200);assert.equal((await allowed.json()).transcript.revisionId,revision);
 assert.equal((await request('GET',path,undefined,otherToken)).status,403);
});

test('automatic meeting recaps share the workspace AI generation budget',{skip:!run},async()=>withWorkflowAI(async()=>{
 const {v}=await workflowFixture(),key='workflow-workspace:'+workspace;
 await request('PUT',`/videos/${v.id}/meeting-recap`,{enabled:true,expectedVersion:0});
 const old=(await query('SELECT * FROM rate_limits WHERE key=$1',[key]))[0];
 await query("INSERT INTO rate_limits(key,count,expires_at) VALUES($1,100,now()+interval '1 hour') ON CONFLICT(key) DO UPDATE SET count=100,expires_at=EXCLUDED.expires_at",[key]);
 try{const {queueMeetingRecaps}=await import('../services/worker/src/meeting-recap');await queueMeetingRecaps();assert.equal((await query('SELECT 1 FROM meeting_recap_runs WHERE video_id=$1',[v.id])).length,0);}
 finally{if(old)await query('UPDATE rate_limits SET count=$2,expires_at=$3 WHERE key=$1',[key,old.count,old.expires_at]);else await query('DELETE FROM rate_limits WHERE key=$1',[key]);await request('PUT',`/videos/${v.id}/meeting-recap`,{enabled:false,expectedVersion:1});}
}));

test('historical uncertain deliveries remain visible and reconcilable after a new publication',{skip:!run},async()=>{
 const {v,base,artifact,revision,connection}=await deliveryFixture(),path=`${base}/${artifact.id}/deliveries`;
 const {delivery}=await(await request('POST',path,{connectionId:connection.id,expectedVersion:artifact.version,expectedRevisionId:revision,idempotencyKey:randomUUID(),confirmed:true})).json();
 await query("UPDATE deliveries SET status='uncertain' WHERE id=$1",[delivery.id]);await query("UPDATE jobs SET status='done' WHERE resource_key=$1",[delivery.id]);
 const next=randomUUID();await query("INSERT INTO revisions(id,video_id,status,duration) VALUES($1,$2,'ready',5)",[next,v.id]);await query('UPDATE videos SET published_revision_id=$2 WHERE id=$1',[v.id,next]);
 assert.equal((await request('GET',path)).status,200);
 const history=await request('GET',`/workspaces/${workspace}/deliveries`);assert.equal(history.status,200);assert.ok((await history.json()).deliveries.some((d:any)=>d.id===delivery.id));
 assert.equal((await request('GET',`/workspaces/${workspace}/deliveries`,undefined,outsiderToken)).status,403);
 assert.equal((await request('POST',`${path}/${delivery.id}/reconcile`,{outcome:'sent',externalId:'confirmed-22',confirmed:true})).status,200);
 assert.equal((await request('POST',path,{connectionId:connection.id,expectedVersion:artifact.version,expectedRevisionId:revision,idempotencyKey:randomUUID(),confirmed:true})).status,409);
});

test('exhausted recap workspaces do not starve later eligible meetings',{skip:!run},async()=>withWorkflowAI(async()=>{
 const key='workflow-workspace:'+workspace,old=(await query('SELECT * FROM rate_limits WHERE key=$1',[key]))[0];
 await query("INSERT INTO rate_limits(key,count,expires_at) VALUES($1,100,now()+interval '1 hour') ON CONFLICT(key) DO UPDATE SET count=100,expires_at=EXCLUDED.expires_at",[key]);
 const ids:string[]=[];
 try{
  for(let i=0;i<25;i++){const {v}=await workflowFixture();ids.push(v.id);await query("INSERT INTO meeting_recap_rules(video_id,requested_by,enabled,updated_at) VALUES($1,$2,true,now()-interval '1 day')",[v.id,owner]);}
  const created=await request('POST','/recordings',{clientId:randomUUID(),workspaceId:otherWorkspace,title:'Eligible meeting',transcriptionMode:'on_device'},outsiderToken);assert.equal(created.status,201);const {video}=await created.json();
  await query("UPDATE videos SET status='ready',published_revision_id=initial_revision_id,duration=5 WHERE id=$1",[video.id]);await query("UPDATE revisions SET status='ready',duration=5 WHERE id=$1",[video.initialRevisionId]);
  await query("INSERT INTO transcripts(video_id,revision_id,status,text,segments,timing) VALUES($1,$2,'ready','Meeting notes','[]','none')",[video.id,video.initialRevisionId]);await query('INSERT INTO meeting_recap_rules(video_id,requested_by,enabled) VALUES($1,$2,true)',[video.id,outsider]);
  const {queueMeetingRecaps}=await import('../services/worker/src/meeting-recap');await queueMeetingRecaps();
  assert.equal((await query('SELECT 1 FROM meeting_recap_runs WHERE video_id=$1',[video.id])).length,1);
  assert.equal((await query('SELECT 1 FROM meeting_recap_runs WHERE video_id=ANY($1::uuid[])',[ids])).length,0);
 }finally{await query('UPDATE meeting_recap_rules SET enabled=false WHERE video_id=ANY($1::uuid[])',[ids]);if(old)await query('UPDATE rate_limits SET count=$2,expires_at=$3 WHERE key=$1',[key,old.count,old.expires_at]);else await query('DELETE FROM rate_limits WHERE key=$1',[key]);}
}));

test('OAuth attempts bind actor, workspace and browser; expire and consume exactly once',{skip:!run},async()=>{
 const app=await request('PUT','/admin/oauth/google',{clientId:'test-client',clientSecret:'oauth-private-secret',enabled:true,expectedVersion:0});assert.equal(app.status,200);
 const path=`/workspaces/${workspace}/oauth/google_calendar/start`;
 assert.equal((await request('POST',path,{},outsiderToken)).status,403);
 const start=await request('POST',path,{});assert.equal(start.status,200);const cookie=start.headers.get('set-cookie')!.split(';')[0];
 const url=new URL((await start.json()).authorizationUrl),state=url.searchParams.get('state')!;
 assert.equal(url.searchParams.get('redirect_uri'),'http://localhost:3000/api/v1/oauth/callback/google_calendar');
 const callback=`/oauth/callback/google_calendar?state=${state}&code=provider-code`;let calls=0,original=globalThis.fetch;
 globalThis.fetch=async()=>{calls++;return Response.json({access_token:'oauth-private-access',refresh_token:'oauth-private-refresh',expires_in:3600,token_type:'Bearer'});};
 try{
  assert.equal((await request('GET',callback,undefined,otherToken,{cookie})).status,403);
  assert.equal((await request('GET',callback)).status,403);assert.equal(calls,0);
  assert.equal((await request('GET',callback,undefined,ownerToken,{cookie})).status,303);assert.equal(calls,1);
  assert.equal((await request('GET',callback,undefined,ownerToken,{cookie})).status,410);assert.equal(calls,1);
  const list=await request('GET',`/workspaces/${workspace}/oauth/accounts`);assert.doesNotMatch(JSON.stringify(await list.json()),/oauth-private|encrypted/);
  const [account]=await query("SELECT * FROM oauth_accounts WHERE workspace_id=$1 AND kind='google_calendar'",[workspace]);assert.ok(account);assert.notEqual(account.encrypted_access_token,'oauth-private-access');
  const next=await request('POST',path,{}),nextCookie=next.headers.get('set-cookie')!.split(';')[0],nextState=new URL((await next.json()).authorizationUrl).searchParams.get('state');
  await query("UPDATE oauth_attempts SET expires_at=now()-interval '1 second' WHERE state_hash=$1",[hashToken(nextState!)]);
  assert.equal((await request('GET',`/oauth/callback/google_calendar?state=${nextState}&code=late`,undefined,ownerToken,{cookie:nextCookie})).status,410);
 }finally{globalThis.fetch=original;}
});

test('OAuth refresh serializes rotating tokens and disconnect prevents further use',{skip:!run},async()=>{
 const {encryptSecret}=await import('../packages/core/src/secrets');
 const [configured]=await query("SELECT value FROM settings WHERE key='oauth:google'");
 if(!configured)await request('PUT','/admin/oauth/google',{clientId:'test-client',clientSecret:'secret',enabled:true,expectedVersion:0});
 const [app]=await query("SELECT value FROM settings WHERE key='oauth:google'");
 const [account]=await query("INSERT INTO oauth_accounts(workspace_id,user_id,kind,app_version,encrypted_access_token,encrypted_refresh_token,scopes) VALUES($1,$2,'google_calendar',$3,$4,$5,'[]') RETURNING *",[workspace,owner,app.value.version,encryptSecret('old'),encryptSecret('refresh')]);
 await query("UPDATE oauth_accounts SET expires_at=now()-interval '1 second' WHERE id=$1",[account.id]);
 const {oauthAccessToken}=await import('../packages/core/src/oauth');let calls=0;const original=globalThis.fetch;
 globalThis.fetch=async()=>{calls++;await new Promise(r=>setTimeout(r,15));return Response.json({access_token:'new-private-access',refresh_token:'new-private-refresh',expires_in:3600,token_type:'Bearer'});};
 try{
  const tokens=await Promise.all([oauthAccessToken(account.id),oauthAccessToken(account.id)]);assert.deepEqual(tokens.map(t=>t.token),['new-private-access','new-private-access']);assert.equal(calls,1);
  assert.equal((await request('DELETE',`/workspaces/${workspace}/oauth/accounts/${account.id}`,undefined,otherToken)).status,403);
  assert.equal((await request('DELETE',`/workspaces/${workspace}/oauth/accounts/${account.id}`)).status,200);
  await assert.rejects(oauthAccessToken(account.id));assert.equal(calls,1);
 }finally{globalThis.fetch=original;}
});

async function calendarFixture(){
 const {encryptSecret}=await import('../packages/core/src/secrets');
 const current=(await query("SELECT value FROM settings WHERE key='oauth:google'"))[0]?.value;
 if(!current)assert.equal((await request('PUT','/admin/oauth/google',{clientId:'calendar-client',clientSecret:'calendar-secret',enabled:true,expectedVersion:0})).status,200);
 const [app]=await query("SELECT value FROM settings WHERE key='oauth:google'");
 return (await query("INSERT INTO oauth_accounts(workspace_id,user_id,kind,app_version,encrypted_access_token,scopes) VALUES($1,$2,'google_calendar',$3,$4,'[]') RETURNING *",[workspace,owner,app.value.version,encryptSecret('calendar-token')]))[0];
}
test('calendar sync publishes only complete pages, keeps events private and invalidates rescheduled capture',{skip:!run},async()=>{
 const account=await calendarFixture(),path=`/workspaces/${workspace}/meetings`;
 assert.equal((await request('POST',path+'/sync',{accountId:account.id},otherToken)).status,404);
 assert.equal((await request('POST',path+'/sync',{accountId:account.id})).status,202);
 const {syncCalendar}=await import('../services/worker/src/calendars');const original=globalThis.fetch;
 const event={id:'occurrence-one',summary:'Private calendar event',start:{dateTime:new Date(Date.now()+3600000).toISOString()},end:{dateTime:new Date(Date.now()+7200000).toISOString()},location:'https://zoom.us/j/123456789'};
 globalThis.fetch=async()=>Response.json({items:[event],nextSyncToken:'checkpoint-one'});
 try{
  await syncCalendar(account.id);
  const list=await(await request('GET',path)).json();assert.equal(list.meetings.length,1);const meeting=list.meetings[0];assert.equal(meeting.title,event.summary);assert.equal(meeting.generation,1);
  assert.equal((await(await request('GET',path,undefined,otherToken)).json()).meetings.length,0);
  assert.equal((await request('POST',path+`/${meeting.id}/select`,{expectedGeneration:1,selected:true},otherToken)).status,404);
  assert.equal((await request('POST',path+`/${meeting.id}/select`,{expectedGeneration:1,selected:true})).status,200);
  let calls=0;globalThis.fetch=async()=>++calls===1?Response.json({items:[{...event,start:{dateTime:new Date(Date.now()+4000000).toISOString()}}],nextPageToken:'page-two'}):new Response(null,{status:503});
  await assert.rejects(syncCalendar(account.id));
  const [unchanged]=await query('SELECT * FROM meeting_instances WHERE id=$1',[meeting.id]);assert.equal(unchanged.generation,1);assert.equal(unchanged.selected_generation,1);
  globalThis.fetch=async()=>Response.json({items:[{...event,start:{dateTime:new Date(Date.now()+4000000).toISOString()}}],nextSyncToken:'checkpoint-two'});await syncCalendar(account.id);
  const [changed]=await query('SELECT * FROM meeting_instances WHERE id=$1',[meeting.id]);assert.equal(changed.generation,2);assert.equal(changed.selected_generation,null);
  assert.equal((await request('POST',path+`/${meeting.id}/select`,{expectedGeneration:1,selected:true})).status,409);
  globalThis.fetch=async()=>Response.json({items:[{id:event.id,status:'cancelled'}],nextSyncToken:'checkpoint-three'});await syncCalendar(account.id);
  const [canceled]=await query('SELECT * FROM meeting_instances WHERE id=$1',[meeting.id]);assert.equal(canceled.canceled,true);assert.equal(canceled.generation,3);
  assert.equal((await request('POST',path+`/${meeting.id}/select`,{expectedGeneration:3,selected:true})).status,409);
 }finally{globalThis.fetch=original;}
});

test('calendar expired checkpoint resets safely and disconnect fences publication',{skip:!run},async()=>{
 const account=await calendarFixture(),{syncCalendar}=await import('../services/worker/src/calendars'),original=globalThis.fetch;
 await request('POST',`/workspaces/${workspace}/meetings/sync`,{accountId:account.id});
 await query("UPDATE calendar_sync SET cursor=$2,full_synced_at=now() WHERE account_id=$1",[account.id,JSON.stringify({cursor:'expired'})]);let calls=0;
 globalThis.fetch=async input=>{calls++;if(String(input).includes('syncToken='))return new Response(null,{status:410});return Response.json({items:[],nextSyncToken:'reset'});};
 try{
  await syncCalendar(account.id);assert.equal(calls,2);assert.equal((await query('SELECT cursor FROM calendar_sync WHERE account_id=$1',[account.id]))[0].cursor.cursor,'reset');
  globalThis.fetch=async()=>{await request('DELETE',`/workspaces/${workspace}/oauth/accounts/${account.id}`);return Response.json({items:[],nextSyncToken:'stale'});};
  await assert.rejects(syncCalendar(account.id));assert.equal((await query('SELECT cursor FROM calendar_sync WHERE account_id=$1',[account.id]))[0].cursor.cursor,'reset');
 }finally{globalThis.fetch=original;}
});

test('new recordings enhance voice by default and the recorder can opt out',{skip:!run},async()=>{
 assert.equal((await recording()).enhanceAudio,true);
 const response=await request('POST','/recordings',{clientId:randomUUID(),workspaceId:workspace,title:'Studio mic',enhanceAudio:false});assert.equal(response.status,201);
 assert.equal((await response.json()).video.enhanceAudio,false);
});

test('view and comment emails go through Resend once per viewer and honor preferences and access',{skip:!run},async()=>{
 const {v,revision}=await workflowFixture();const {deliverNotificationEmails}=await import('../services/worker/src/notifications');
 await query("UPDATE videos SET duration=100,visibility='workspace' WHERE id=$1",[v.id]);await query('UPDATE revisions SET duration=100 WHERE id=$1',[revision]);
 const original=globalThis.fetch,env={...process.env},sent:{headers:Record<string,string>;body:{to:string[];subject:string;text:string}}[]=[];let status=200;
 Object.assign(process.env,{MAIL_PROVIDER:'resend',RESEND_API_KEY:'re_test'});
 globalThis.fetch=(async(_url:string,init:RequestInit)=>{const body=JSON.parse(String(init.body));if(body.text.includes(v.id))sent.push({headers:init.headers as Record<string,string>,body});return new Response('{}',{status});}) as typeof fetch;
 const deliver=async()=>{while(await deliverNotificationEmails()>0);};
 const watch=(token:string,kind='playback')=>request('POST',`/videos/${v.id}/watch-intervals`,{eventId:randomUUID(),sessionId:randomUUID(),revisionId:revision,sequence:0,start:0,end:10,wallStart:Date.now()-20000,wallEnd:Date.now()-10000,playbackRate:1,visible:true,kind},token);
 const states=async()=>(await query("SELECT kind,email_state AS state,email_error AS error FROM notifications WHERE video_id=$1 ORDER BY created_at",[v.id]));
 try{
  assert.equal((await watch(otherToken)).status,200);assert.equal((await watch(otherToken)).status,200);assert.equal((await watch(ownerToken)).status,200);
  const comment=await request('POST',`/videos/${v.id}/comments`,{body:'Looks great',timestamp:3},otherToken);assert.equal(comment.status,201);
  assert.deepEqual((await states()).map(n=>n.kind),['view','comment'],'One view per viewer; owner previews never notify');
  await deliver();
  assert.deepEqual(sent.map(m=>m.body.subject).sort(),[`member@test.invalid commented on Test capture`,`member@test.invalid viewed Test capture`]);
  assert.ok(sent.every(m=>m.body.to[0]==='owner@test.invalid'&&/^relay-notification\/[0-9a-f-]{36}$/.test(m.headers['idempotency-key'])));assert.ok(sent.some(m=>/“Looks great”/.test(m.body.text)));
  // A reply to someone who has since lost access must not leak the reply by email.
  const parentId=(await comment.json()).comment.id;
  assert.equal((await request('POST',`/videos/${v.id}/comments`,{body:'Thanks',parentId})).status,201);
  await query("UPDATE videos SET visibility='private' WHERE id=$1",[v.id]);await deliver();
  assert.equal((await states())[2].error,'Recipient can no longer open this video');
  await query("UPDATE videos SET visibility='workspace' WHERE id=$1",[v.id]);
  const saved=await request('PUT','/notifications/preferences',{commentEmail:false,viewEmail:true});assert.equal(saved.status,200);
  assert.deepEqual((await (await request('GET','/notifications/preferences')).json()).preferences,{commentEmail:false,viewEmail:true});
  assert.equal((await request('POST',`/videos/${v.id}/comments`,{body:'Muted'},otherToken)).status,201);await deliver();
  assert.equal((await states())[3].state,'skipped');
  await request('PUT','/notifications/preferences',{commentEmail:true,viewEmail:true});
  status=500;assert.equal((await request('POST',`/videos/${v.id}/comments`,{body:'Retry me'},otherToken)).status,201);await deliver();
  const [retry]=await query("SELECT email_state,email_attempts,email_next_at>now() AS later FROM notifications WHERE video_id=$1 ORDER BY created_at DESC LIMIT 1",[v.id]);
  assert.deepEqual({...retry},{email_state:'pending',email_attempts:1,later:true},'Transient provider errors back off and retry');
  status=422;await query("UPDATE notifications SET email_next_at=now() WHERE video_id=$1 AND email_state='pending'",[v.id]);await deliver();
  assert.equal((await states())[4].state,'failed','Permanent provider rejections stop retrying');
  assert.equal(sent.length,2+2,'Muted and access-revoked notifications never reached the provider');
 }finally{globalThis.fetch=original;process.env=env;}
});
