import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceToEditTime, validClips } from '../apps/web/components/editing';
import * as editing from '../apps/web/components/editing';

import {removeSourceRange} from '../packages/core/src/timeline';

test('transcript cuts split source clips and preserve other recordings and revision references',()=>{
 const clips=[{videoId:'a',revisionId:'r1',start:0,end:12},{videoId:'b',revisionId:'r2',start:1,end:8}];
 assert.deepEqual(removeSourceRange(clips,'a','r1',3,6),[{videoId:'a',revisionId:'r1',start:0,end:3},{videoId:'a',revisionId:'r1',start:6,end:12},clips[1]]);
 assert.deepEqual(removeSourceRange(clips,'a','r1',0,12),[clips[1]]);
 assert.deepEqual(removeSourceRange(clips,'a','r1',6,3),clips);
});
test('revision validation rejects empty, negative, reversed, and non-finite clips',()=>{
 assert.equal(validClips([]),false);
 for(const [start,end] of [[-1,2],[3,2],[0,NaN],[0,Infinity]])assert.equal(validClips([{videoId:'a',start,end}]),false);
 assert.equal(validClips([{videoId:'a',start:0,end:.1}]),true);
});

test('thumbnail frames map into the edited timeline after cuts and stitched clips',()=>{
 const clips=[{videoId:'other',start:3,end:5},{videoId:'source',start:10,end:20},{videoId:'source',start:25,end:30}];
 assert.equal(sourceToEditTime(clips,'source',15),7);
 assert.equal(sourceToEditTime(clips,'source',27),14);
 assert.equal(sourceToEditTime(clips,'source',22),null);
});

test('manual trims keep privacy blurs and thumbnails attached to retained footage',()=>{
 const clip={videoId:'a',revisionId:'r1',start:0,end:10};
 const blur={start:5,end:6,x:.2,y:.3,width:.1,height:.2};
 const result=editing.changeTimeline([clip],[blur],5.5,[{clip:{...clip,start:2},from:0}]);
 assert.deepEqual(result.blurs,[{...blur,start:3,end:4}]);
 assert.equal(result.thumbnail,3.5);
});

test('split, reorder, delete and inserted duplicate clips preserve occurrence-specific effects',()=>{
 const clip={videoId:'a',revisionId:'r1',start:0,end:10};
 const blur={start:8,end:12,x:.2,y:.3,width:.1,height:.2};
 // Two identical sources: the first occurrence's tail and second's head are protected.
 const changed=editing.changeTimeline([clip,clip],[blur],11,[
  {clip:{...clip,start:1,end:4},from:1},
  {clip:{...clip,end:5},from:0},
  {clip:{...clip,start:5},from:0},
  {clip}, // A newly stitched copy must not inherit another occurrence's effect.
 ]);
 assert.deepEqual(changed.blurs,[{...blur,start:0,end:1},{...blur,start:11,end:13}]);
 assert.equal(changed.thumbnail,0);
 const removed=editing.changeTimeline([clip,clip],[blur],11,[{clip,from:0}]);
 assert.deepEqual(removed.blurs,[{...blur,start:8,end:10}]);
 assert.equal(removed.thumbnail,0);
});
