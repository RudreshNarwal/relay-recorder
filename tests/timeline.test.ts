import test from 'node:test';
import assert from 'node:assert/strict';
import {mapSourceRangeToOutput,remapSegments,removeSourceRange} from '../packages/core/src/timeline';

test('one source range maps to every retained occurrence on exactly its revision',()=>{
 const clips=[{videoId:'a',revisionId:'old',start:0,end:10},{videoId:'a',revisionId:'new',start:0,end:10},{videoId:'a',revisionId:'old',start:5,end:10},{videoId:'b',revisionId:'old',start:0,end:10}];
 assert.deepEqual(mapSourceRangeToOutput(clips,'a','old',6,8),[{start:6,end:8,clipIndex:0},{start:21,end:23,clipIndex:2}]);
 assert.deepEqual(mapSourceRangeToOutput(clips,'a','old',4,6),[{start:4,end:6,clipIndex:0},{start:20,end:21,clipIndex:2}]);
 const cut=removeSourceRange(clips,'a','old',6,8);
 assert.deepEqual(cut.filter(c=>c.videoId==='a'&&c.revisionId==='old').map(c=>[c.start,c.end]),[[0,6],[8,10],[5,6],[8,10]]);
 assert.deepEqual(cut.filter(c=>c.revisionId==='new'),[clips[1]]);
});
test('caption mapping retains repeated clips and omits partially removed words or untimed text',()=>{
 const segments=[{start:0,end:3,text:'keep secret end',words:[{start:0,end:1,text:'keep'},{start:1,end:2,text:'secret'},{start:2,end:3,text:'end'}]},{start:3,end:5,text:'untimed secret'}];
 const mapped=remapSegments(segments,[{start:0,end:1.5},{start:2,end:3},{start:0,end:1.5},{start:3.5,end:5}]);
 assert.deepEqual(mapped.map(s=>s.text),['keep','end','keep']);
 assert.deepEqual(mapped.flatMap(s=>s.words??[]).map(w=>[w.start,w.end]),[[0,1],[1.5,2.5],[2.5,3.5]]);
});
