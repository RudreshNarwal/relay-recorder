import test from 'node:test';
import assert from 'node:assert/strict';
import {WatchCollector,type WatchSample} from '../apps/web/components/watch-collector';
import type {WatchInterval} from '../packages/core/src/analytics';
const revision='33333333-3333-4333-8333-333333333333';
const sample=(position:number,wall:number,extra:Partial<WatchSample>={}):WatchSample=>({position,wall,rate:1,playing:true,visible:true,seeking:false,...extra});

test('player telemetry excludes seek gaps, pauses, hidden playback and buffering',()=>{
 const events:WatchInterval[]=[],collector=new WatchCollector(revision,'playback',e=>events.push(e));
 collector.sample(sample(0,100000));collector.sample(sample(1,101000));collector.sample(sample(2,102000));
 collector.sample(sample(90,102100,{seeking:true}));collector.sample(sample(90,102200));collector.sample(sample(91,103200));collector.sample(sample(91,103300,{playing:false}));
 collector.sample(sample(91,104000,{playing:false}));collector.sample(sample(91,105000));collector.sample(sample(92,106000,{visible:false}));collector.sample(sample(93,107000,{visible:false}));
 collector.sample(sample(93,108000));collector.sample(sample(93,109000));collector.sample(sample(94,110000));collector.stop();
 assert.deepEqual(events.map(e=>[e.start,e.end]),[[0,2],[90,91],[93,94]]);
 assert.deepEqual(events.map(e=>e.sequence),[0,1,2]);assert.equal(new Set(events.map(e=>e.eventId)).size,3);
});
test('player speed changes flush segments and long stalled ticks cannot invent playback',()=>{
 const events:WatchInterval[]=[],collector=new WatchCollector(revision,'playback',e=>events.push(e));
 collector.sample(sample(0,100000));collector.sample(sample(1,101000));collector.sample(sample(1,101000,{rate:2}));
 collector.sample(sample(3,102000,{rate:2}));collector.sample(sample(5,103000,{rate:2}));collector.sample(sample(25,120000,{rate:2}));collector.stop();
 assert.deepEqual(events.map(e=>[e.start,e.end,e.playbackRate]),[[0,1,1],[1,5,2]]);
});
