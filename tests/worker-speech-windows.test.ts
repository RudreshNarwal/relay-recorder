import test from 'node:test';
import assert from 'node:assert/strict';
import * as windows from '../services/worker/src/speech/windows';
import type {Segment} from '../packages/core/src/policy';
const segment=(words:Array<[number,number,string]>):Segment=>({start:words[0][0],end:words.at(-1)![1],text:words.map(w=>w[2]).join(' '),words:words.map(([start,end,text])=>({start,end,text}))});

test('long word-timed requests overlap within provider limits and preserve their final tail',()=>{
 assert.deepEqual(windows.speechWindows(22,10,'word'),[{start:0,duration:10},{start:8,duration:10},{start:16,duration:6}]);
 assert.deepEqual(windows.speechWindows(22,10,'none'),[{start:0,duration:10},{start:10,duration:10},{start:20,duration:2}]);
 assert.throws(()=>windows.speechWindows(Infinity,1800,'word'));
});
test('overlap reconciliation keeps actual times, removes duplicate boundary words and retains genuine repetitions',()=>{
 const left=[segment([[6,7,'Well'],[8.1,8.4,'very'],[8.6,8.9,'very'],[9.1,9.4,'useful']])];
 const right=[segment([[8.15,8.45,'very'],[8.65,8.95,'very'],[9.15,9.45,'useful'],[10.2,10.5,'indeed']])];
 const result=windows.mergeSpeechOverlap(left,right,8,10);
 assert.equal(result.map(s=>s.text).join(' '),'Well very very useful indeed');
 assert.deepEqual(result.flatMap(s=>s.words!).map(w=>w.start),[6,8.1,8.6,9.15,10.2]);
});
test('silence, absent shared words, and unaligned output cannot invent timestamps',()=>{
 assert.deepEqual(windows.mergeSpeechOverlap([],[],8,10),[]);
 const a=segment([[7,7.5,'before']]),b=segment([[10,10.5,'after']]);
 assert.deepEqual(windows.mergeSpeechOverlap([a],[b],8,10),[a,b]);
 assert.throws(()=>windows.mergeSpeechOverlap([{start:8,end:10,text:'no alignment'}],[b],8,10),/word timestamps/i);
});
