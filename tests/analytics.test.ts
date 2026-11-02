import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWatchInterval,extendWatchSession,summarizeEngagement,type WatchInterval,type WatchSession} from '../packages/core/src/analytics';
const now=1_800_000_000_000;
function interval(start:number,end:number,wallSeconds:number,extra:Partial<WatchInterval>={}):WatchInterval{return {eventId:'11111111-1111-4111-8111-111111111111',sessionId:'22222222-2222-4222-8222-222222222222',revisionId:'33333333-3333-4333-8333-333333333333',sequence:0,start,end,wallStart:now-wallSeconds*1000,wallEnd:now,playbackRate:1,visible:true,kind:'playback',...extra};}
function session(viewer='known',id='session'):WatchSession{return {sessionId:id,viewerKey:viewer,userId:viewer==='known'?'user':null,userName:viewer==='known'?'Member':null,kind:'playback',covered:[],wall:[],mediaSeconds:0,lastPosition:0,startedAt:new Date(now).toISOString(),lastSeenAt:new Date(now).toISOString()};}

test('engagement rejects seek credit, impossible rates, old clocks and overlapping sequences',()=>{
 assert.throws(()=>validateWatchInterval(interval(0,100,1),100,now));
 assert.throws(()=>validateWatchInterval(interval(0,1,1,{playbackRate:0}),100,now));
 assert.throws(()=>validateWatchInterval(interval(0,1,1,{wallEnd:now+60000}),100,now));
 assert.throws(()=>validateWatchInterval(interval(0,1,1,{wallStart:now-120000,wallEnd:now-119000}),100,now));
 assert.throws(()=>validateWatchInterval(interval(0,1,1,{sequence:1}),100,now,{sequence:1,wallEnd:now-1000}));
 assert.throws(()=>validateWatchInterval(interval(0,1,1,{sequence:2}),100,now,{sequence:1,wallEnd:now-500}));
 assert.doesNotThrow(()=>validateWatchInterval(interval(10,20,5,{playbackRate:2}),100,now));
});

test('a seek to the ending is not completion and a 2x replay separates wall time from coverage',()=>{
 let s=extendWatchSession(session(),interval(0,10,10));
 s=extendWatchSession(s,interval(90,100,10,{wallStart:now,wallEnd:now+10000,sequence:1}));
 let report=summarizeEngagement([s],100);
 assert.equal(report.views,1);assert.equal(report.uniqueViewers,1);assert.equal(report.completionRate,0);assert.equal(report.uniqueWatchedSeconds,20);assert.equal(report.watchSeconds,20);
 s=extendWatchSession(s,interval(0,10,5,{playbackRate:2,wallStart:now+10000,wallEnd:now+15000,sequence:2}));
 report=summarizeEngagement([s],100);assert.equal(report.watchSeconds,25);assert.equal(report.uniqueWatchedSeconds,20);assert.equal(report.rewatchedMediaSeconds,10);
 assert.equal(report.bins.find(b=>b.start===50)?.viewers,0,'Seek gaps cannot count toward engagement');
});

test('two tabs do not double wall time; hidden playback and previews receive no view credit',()=>{
 const a=extendWatchSession(session('known','a'),interval(0,10,10)),b=extendWatchSession(session('known','b'),interval(0,10,10));
 const hidden=extendWatchSession(session('hidden'),interval(0,10,10,{visible:false}));
 const preview=extendWatchSession({...session('owner'),kind:'preview'},interval(0,10,10));
 const report=summarizeEngagement([a,b,hidden,preview],100);assert.equal(report.views,2);assert.equal(report.uniqueViewers,1);assert.equal(report.watchSeconds,10);assert.equal(report.uniqueWatchedSeconds,10);
});

test('completion uses unique coverage and lost anonymous identity remains unknown',()=>{
 const a=extendWatchSession(session('anonymous-1','a'),interval(0,90,90)),b=extendWatchSession(session('anonymous-2','b'),interval(0,10,10));
 const report=summarizeEngagement([a,b],100);assert.equal(report.views,2);assert.equal(report.uniqueViewers,2);assert.equal(report.anonymousViewers,2);assert.equal(report.completionRate,.5);assert.deepEqual(report.viewers,[]);
});

test('stalled playback cannot receive wall-time credit for unplayed media',()=>{
 const report=summarizeEngagement([extendWatchSession(session(),interval(0,1,20))],100);
 assert.equal(report.watchSeconds,1);
});
