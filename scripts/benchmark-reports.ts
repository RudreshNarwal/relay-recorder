/** Opt-in, isolated benchmark. Creates and drops only its own randomly named database. */
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import {db,closeDatabase} from '../packages/core/src/db';
import {reportPage} from '../packages/core/src/reports';
if(process.env.RELAY_REPORT_PERF!=='1')throw new Error('Set RELAY_REPORT_PERF=1 to create the isolated million-event benchmark');
const admin=new pg.Pool({connectionString:process.env.DATABASE_URL}),name='relay_report_bench_'+randomUUID().replaceAll('-','');let created=false;
try{
 await admin.query(`CREATE DATABASE ${name}`);created=true;
 const url=new URL(process.env.DATABASE_URL!);url.pathname='/'+name;process.env.DATABASE_URL=url.toString();
 const c=await db().connect();
 try{
  await c.query('CREATE TABLE "user"(id text PRIMARY KEY,name text,email text)');
  await c.query(await readFile(new URL('../packages/core/schema.sql',import.meta.url),'utf8'));
  await c.query("INSERT INTO \"user\" VALUES('owner','Benchmark owner','owner@example.test')");
  const workspace=(await c.query("INSERT INTO workspaces(name) VALUES('Isolated benchmark') RETURNING id")).rows[0].id;
  const video=(await c.query("INSERT INTO videos(client_id,workspace_id,owner_id,title,status,duration) VALUES(gen_random_uuid(),$1,'owner','Synthetic benchmark','ready',20000) RETURNING id",[workspace])).rows[0].id;
  const revision=(await c.query("INSERT INTO revisions(video_id,status,duration) VALUES($1,'ready',20000) RETURNING id",[video])).rows[0].id;
  await c.query('UPDATE videos SET published_revision_id=$2 WHERE id=$1',[video,revision]);
  await c.query(`INSERT INTO watch_sessions(id,video_id,revision_id,viewer_key,kind,summary)
   SELECT md5('session-'||n)::uuid,$1,$2,'viewer-'||n,'playback',jsonb_build_object('sessionId',md5('session-'||n)::uuid,'viewerKey','viewer-'||n,'userId',NULL,'userName',NULL,'kind','playback','covered','[[0,20000]]'::jsonb,'wall','[[0,20000000]]'::jsonb,'mediaSeconds',20000,'lastPosition',20000,'startedAt',now(),'lastSeenAt',now()) FROM generate_series(1,1000) n`,[video,revision]);
  const setup=performance.now();
  await c.query('SET statement_timeout=180000');
  await c.query(`INSERT INTO watch_intervals(event_id,session_id,video_id,sequence,digest,interval)
   SELECT md5('event-'||n)::uuid,md5('session-'||((n-1)/1000+1))::uuid,$1,(n-1)%1000,repeat('a',64),
   jsonb_build_object('eventId',md5('event-'||n)::uuid,'revisionId',$2::uuid,'sequence',(n-1)%1000,'start',((n-1)%1000)*20,'end',((n-1)%1000+1)*20,'wallStart',((n-1)%1000)*20000,'wallEnd',((n-1)%1000+1)*20000,'playbackRate',1,'visible',true,'kind','playback') FROM generate_series(1,1000000) n`,[video,revision]);
  await c.query('SET statement_timeout=30000');
  await c.query('ANALYZE watch_sessions');await c.query('ANALYZE watch_intervals');
  const from=new Date(Date.now()-86400000).toISOString(),to=new Date(Date.now()+1000).toISOString(),times:number[]=[];
  for(let i=0;i<5;i++){
   const start=performance.now(),report=await reportPage(c,workspace,{kind:'engagement',from,to,limit:50});times.push(performance.now()-start);
   if(report.rows[0].views!==1000||report.rows[0].completionRate!==1||report.rows[0].watchSeconds!==20000000)throw new Error('Benchmark metrics differ from reference values');
  }
  const plan=(await c.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT event_id FROM watch_intervals WHERE session_id=md5('session-1')::uuid AND sequence=501")).rows[0]['QUERY PLAN'];
  if(!JSON.stringify(plan).includes('Index Scan'))throw new Error('Event lookup lost its session/sequence index');
  console.log(JSON.stringify({fixture:'1000000 intervals, 1000 fully watched sessions, one revision',cpu:os.cpus()[0].model,hostMemoryGiB:Math.round(os.totalmem()/1024**3),database:(await c.query('SHOW server_version')).rows[0].server_version,fixtureInsertMs:Math.round(performance.now()-setup-times.reduce((a,b)=>a+b,0)),reportMs:times.map(Math.round),eventLookupPlan:plan},null,2));
 }finally{c.release();await closeDatabase();}
}finally{if(created)await admin.query(`DROP DATABASE ${name}`);await admin.end();}
