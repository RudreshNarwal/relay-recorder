import {z} from 'zod';
export const watchIntervalSchema=z.object({eventId:z.uuid(),sessionId:z.uuid(),revisionId:z.uuid(),sequence:z.number().int().min(0).max(1_000_000),start:z.number().finite().nonnegative(),end:z.number().finite().positive(),wallStart:z.number().finite().nonnegative(),wallEnd:z.number().finite().positive(),playbackRate:z.number().finite().min(.25).max(4),visible:z.boolean(),kind:z.enum(['playback','preview'])}).strict();
export type WatchInterval=z.infer<typeof watchIntervalSchema>;
type Range=[number,number];
export type WatchSession={sessionId:string;viewerKey:string;userId:string|null;userName:string|null;kind:'playback'|'preview';covered:Range[];wall:Range[];mediaSeconds:number;lastPosition:number;startedAt:string;lastSeenAt:string};
export function validateWatchInterval(input:WatchInterval,duration:number,now:number,previous?:{sequence:number;wallEnd:number}){
 watchIntervalSchema.parse(input);
 const seconds=(input.wallEnd-input.wallStart)/1000,media=input.end-input.start;
 if(!Number.isFinite(duration)||duration<=0||input.end>duration+.05||media<=0||seconds<=0||seconds>30||media>seconds*input.playbackRate+.35)throw new Error('Invalid playback interval or elapsed coverage');
 if(input.wallEnd>now+5000||input.wallStart<now-90000)throw new Error('Playback telemetry is outside the receipt window');
 if(previous?(input.sequence<=previous.sequence||input.wallStart<previous.wallEnd):input.sequence!==0)throw new Error('Playback interval is out of order');
}
export function mergeWatchRanges(ranges:Range[]):Range[]{
 const result:Range[]=[];
 for(const [start,end] of [...ranges].sort((a,b)=>a[0]-b[0])){
  const last=result.at(-1);if(last&&start<=last[1])last[1]=Math.max(last[1],end);else result.push([start,end]);
 }return result;
}
const coveredSeconds=(ranges:Range[])=>ranges.reduce((sum,[a,b])=>sum+b-a,0);
export function extendWatchSession(session:WatchSession,input:WatchInterval):WatchSession{
 if(!input.visible||session.kind==='preview'||input.kind==='preview')return {...session,lastSeenAt:new Date(input.wallEnd).toISOString()};
 const creditedStart=Math.max(input.wallStart,input.wallEnd-(input.end-input.start)/input.playbackRate*1000);
 const covered=mergeWatchRanges([...session.covered,[input.start,input.end]]),wall=mergeWatchRanges([...session.wall,[creditedStart,input.wallEnd]]);
 if(covered.length>4096||wall.length>4096)throw new Error('Playback session exceeded its interval budget');
 return {...session,covered,wall,mediaSeconds:session.mediaSeconds+input.end-input.start,lastPosition:input.end,lastSeenAt:new Date(input.wallEnd).toISOString()};
}
export function summarizeEngagement(input:WatchSession[],duration:number){
 if(!Number.isFinite(duration)||duration<=0)throw new Error('A published duration is required');
 const sessions=input.filter(s=>s.kind==='playback'&&s.covered.length),groups=new Map<string,WatchSession[]>();
 for(const s of sessions)groups.set(s.viewerKey,[...groups.get(s.viewerKey)??[],s]);
 const viewers=[...groups.values()].map(rows=>{
  const covered=mergeWatchRanges(rows.flatMap(s=>s.covered)),wall=mergeWatchRanges(rows.flatMap(s=>s.wall));
  const unique=coveredSeconds(covered),media=rows.reduce((sum,s)=>sum+s.mediaSeconds,0);
  return {viewerKey:rows[0].viewerKey,userId:rows[0].userId,name:rows[0].userName,sessions:rows.length,watchSeconds:coveredSeconds(wall)/1000,uniqueWatchedSeconds:unique,rewatchedMediaSeconds:Math.max(0,media-unique),coverage:Math.min(1,unique/duration),completed:unique>=duration*.9,lastSeenAt:rows.map(s=>s.lastSeenAt).sort().at(-1)!,covered};
 });
 const bins=Array.from({length:100},(_,i)=>{
  const start=i*duration/100,end=(i+1)*duration/100;
  return {start,end,viewers:viewers.filter(v=>v.covered.some(([a,b])=>a<end&&b>start)).length,exitSessions:sessions.filter(s=>s.lastPosition>start&&s.lastPosition<=end).length};
 });
 return {views:sessions.length,uniqueViewers:viewers.length,knownViewers:viewers.filter(v=>v.userId!==null).length,anonymousViewers:viewers.filter(v=>v.userId===null).length,
  watchSeconds:viewers.reduce((n,v)=>n+v.watchSeconds,0),uniqueWatchedSeconds:viewers.reduce((n,v)=>n+v.uniqueWatchedSeconds,0),rewatchedMediaSeconds:viewers.reduce((n,v)=>n+v.rewatchedMediaSeconds,0),
  completionRate:sessions.length?sessions.filter(s=>coveredSeconds(s.covered)>=duration*.9).length/sessions.length:0,
  bins,viewers:viewers.filter(v=>v.userId!==null).map(({viewerKey,covered,...visible})=>visible).sort((a,b)=>b.lastSeenAt.localeCompare(a.lastSeenAt))};
}
