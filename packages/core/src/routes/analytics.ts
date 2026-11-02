import {query,transaction} from '../db';
import {accessVideo} from '../access';
import {body,fail,json,limit,uuid} from '../http';
import type {Actor} from '../auth';
import {decryptSecret,encryptSecret,hashToken,token} from '../secrets';
import {extendWatchSession,summarizeEngagement,validateWatchInterval,watchIntervalSchema,type WatchSession} from '../analytics';

export function viewerIdentity(request:Request,videoId:string,user:Actor|null){
 let anonymous:string|undefined;
 const cookie=request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('relay_viewer='))?.slice('relay_viewer='.length);
 if(cookie)try{const value=JSON.parse(decryptSecret(cookie));if(typeof value.id==='string'&&value.expires>Date.now())anonymous=value.id;}catch{}
 const created=!anonymous;anonymous??=token();
 const key=hashToken(user?'user:'+user.id:'anonymous:'+anonymous+':'+videoId);
 const headers:Record<string,string>={};
 if(created)headers['Set-Cookie']=`relay_viewer=${encryptSecret(JSON.stringify({id:anonymous,expires:Date.now()+30*86400000}))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${new URL(request.url).protocol==='https:'?'; Secure':''}`;
 return {key,headers};
}
export async function analytics(request:Request,parts:string[],user:Actor|null):Promise<Response|null>{
 if(parts[0]!=='videos'||parts.length!==3||!['watch-intervals','engagement'].includes(parts[2]))return null;
 const id=uuid(parts[1]);
 if(parts[2]==='watch-intervals'&&request.method==='POST'){
  const input=await body(request,watchIntervalSchema),{row}=await accessVideo(request,id,user);
  if(row.status!=='ready'||input.revisionId!==row.published_revision_id)fail(409,'Published revision changed');
  const viewer=viewerIdentity(request,id,user),digest=hashToken(JSON.stringify(input));
  await limit('watch:'+id+':'+viewer.key,2000,3600);await limit('watch-video:'+id,100000,3600);
  const duplicate=await transaction(async c=>{
   // Lock the publication while accepting telemetry; it can never move to another revision mid-write.
   const current=(await c.query('SELECT published_revision_id,deleted_at FROM videos WHERE id=$1 FOR SHARE',[id])).rows[0];
   if(current.deleted_at||current.published_revision_id!==input.revisionId)fail(409,'Published revision changed');
   const replay=(await c.query('SELECT digest,session_id FROM watch_intervals WHERE event_id=$1',[input.eventId])).rows[0];
   if(replay){
    const held=(await c.query('SELECT viewer_key,video_id FROM watch_sessions WHERE id=$1',[replay.session_id])).rows[0];
    if(replay.digest!==digest||held?.viewer_key!==viewer.key||held.video_id!==id)fail(409,'Playback event identity conflicts');
    return true;
   }
   const kind=user?.id===row.owner_id?'preview':input.kind;
   const initial:WatchSession={sessionId:input.sessionId,viewerKey:viewer.key,userId:user?.id??null,userName:user?.name??null,kind,covered:[],wall:[],mediaSeconds:0,lastPosition:0,startedAt:new Date().toISOString(),lastSeenAt:new Date().toISOString()};
   const started=await c.query('INSERT INTO watch_sessions(id,video_id,revision_id,viewer_key,user_id,kind,summary) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING id',[input.sessionId,id,input.revisionId,viewer.key,user?.id??null,kind,JSON.stringify(initial)]);
   // Tell the owner about each viewer's first playback. Anonymous viewers can reset cookies, so cap per video per day.
   if(started.rowCount&&kind==='playback')await c.query(`INSERT INTO notifications(user_id,video_id,body,kind,email_state,email_next_at)
    SELECT $1,$2,$3,'view','pending',now() WHERE NOT EXISTS(SELECT 1 FROM watch_sessions WHERE video_id=$2 AND viewer_key=$4 AND id<>$5)
    AND (SELECT count(*) FROM notifications WHERE video_id=$2 AND kind='view' AND created_at>now()-interval '1 day')<20`,[row.owner_id,id,`${user?.name??'Someone'} viewed ${row.title}`,viewer.key,input.sessionId]);
   const session=(await c.query('SELECT * FROM watch_sessions WHERE id=$1 FOR UPDATE',[input.sessionId])).rows[0];
   if(session.video_id!==id||session.revision_id!==input.revisionId||session.viewer_key!==viewer.key||session.kind!==kind)fail(409,'Playback session identity conflicts');
   // A duplicate arriving concurrently waits for the session owner, then reads its committed event.
   const repeated=(await c.query('SELECT digest FROM watch_intervals WHERE event_id=$1',[input.eventId])).rows[0];
   if(repeated){if(repeated.digest!==digest)fail(409,'Playback event identity conflicts');return true;}
   if(Date.now()-new Date(session.started_at).getTime()>24*3600000)fail(409,'Start a new playback session');
   try{validateWatchInterval(input,row.duration,Date.now(),session.sequence<0?undefined:{sequence:session.sequence,wallEnd:session.last_wall_end});}catch{fail(400,'Invalid, delayed or out-of-order playback interval');}
   let next;try{next=extendWatchSession(session.summary,input);}catch{fail(429,'Playback session budget reached. Start a new session.');}
   await c.query('INSERT INTO watch_intervals(event_id,session_id,video_id,sequence,digest,interval) VALUES($1,$2,$3,$4,$5,$6)',[input.eventId,input.sessionId,id,input.sequence,digest,JSON.stringify(input)]);
   // Aggregating in the ingestion transaction makes duplicate retries and worker outages harmless.
   await c.query('UPDATE watch_sessions SET sequence=$2,last_wall_end=$3,summary=$4,updated_at=now() WHERE id=$1',[input.sessionId,input.sequence,input.wallEnd,JSON.stringify(next)]);
   return false;
  });return json({ok:true,duplicate},200,viewer.headers);
 }
 if(parts[2]==='engagement'&&request.method==='GET'){
  const {row}=await accessVideo(request,id,user,true),params=new URL(request.url).searchParams;
  const revisionId=params.get('revisionId')?uuid(params.get('revisionId')!):row.published_revision_id;
  if(!revisionId)fail(409,'No published revision');
  const [revision]=await query('SELECT id,duration FROM revisions WHERE id=$1 AND video_id=$2 AND status=\'ready\'',[revisionId,id]);if(!revision||revision.duration<=0)fail(409,'Revision is not ready');
  const to=params.get('to')?new Date(params.get('to')!):new Date(),from=params.get('from')?new Date(params.get('from')!):new Date(to.getTime()-30*86400000);
  if(!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||from>=to||to.getTime()-from.getTime()>90*86400000||to.getTime()>Date.now()+60000)fail(400,'Choose a valid UTC range of at most 90 days');
  const sessions=await query('SELECT s.summary,s.user_id,u.name FROM watch_sessions s LEFT JOIN "user" u ON u.id=s.user_id WHERE s.video_id=$1 AND s.revision_id=$2 AND s.started_at>=$3 AND s.started_at<$4 ORDER BY s.started_at LIMIT 10001',[id,revisionId,from,to]);
  if(sessions.length>10000)fail(409,'Narrow the date range to at most 10000 playback sessions');
  const report=summarizeEngagement(sessions.map(s=>({...s.summary,userId:s.user_id,userName:s.name??null})),revision.duration);
  const [legacy]=await query("SELECT count(DISTINCT session_id) FILTER(WHERE event='play')::int AS views,count(DISTINCT viewer_key)::int AS viewers FROM view_events WHERE video_id=$1 AND revision_id=$2 AND created_at>=$3 AND created_at<$4",[id,revisionId,from,to]);
  const [sharing]=await query('SELECT allow_download FROM shares WHERE video_id=$1',[id]);
  const actions=await query(`SELECT cta_id AS "ctaId",presentation_version AS "presentationVersion",sum(impressions)::int AS impressions,sum(clicks)::int AS clicks FROM cta_daily WHERE video_id=$1 AND revision_id=$2 AND day>=($3::timestamptz AT TIME ZONE 'UTC')::date AND day<=(($4::timestamptz-interval '1 microsecond') AT TIME ZONE 'UTC')::date GROUP BY cta_id,presentation_version`,[id,revisionId,from,to]);
  return json({...report,actions,actionsBasis:'UTC-calendar-days-intersecting-range',measurement:'intervals',revisionId,from:from.toISOString(),to:to.toISOString(),reportingBasis:'sessions-started-in-range',legacy:{approximate:true,...legacy},context:{visibility:row.visibility,downloadsAllowed:sharing?.allow_download??false,downloadCount:null},timeline:report.bins.map(b=>({second:b.start,views:b.viewers}))});
 }
 return null;
}
