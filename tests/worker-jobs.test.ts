import test from 'node:test';
import assert from 'node:assert/strict';
import { failureDecision, publicationAllowed } from '../services/worker/src/jobs';
import { PermanentError } from '../services/worker/src/media';
test('permanent failures stop; transient failures retry with bounded delay',()=>{
 assert.deepEqual(failureDecision(new PermanentError('invalid media'),1,3),{retry:false,delaySeconds:0});
 assert.deepEqual(failureDecision(new Error('network'),1,3),{retry:true,delaySeconds:10});
 assert.deepEqual(failureDecision(new Error('network'),3,3),{retry:false,delaySeconds:0});
});
test('superseded revision and deleted video cannot publish',()=>{
 assert.equal(publicationAllowed({deleted_at:null,published_revision_id:'new'},'old'),false);
 assert.equal(publicationAllowed({deleted_at:'today',published_revision_id:'old'},'old'),false);
 assert.equal(publicationAllowed({deleted_at:null,published_revision_id:null},null),true);
 assert.equal(publicationAllowed({deleted_at:null,published_revision_id:'old'},'old'),true);
});
test('six-hour speech requests split into bounded contiguous windows without losing tail',async()=>{
 const {transcriptionWindows}=await import('../services/worker/src/jobs');
 assert.deepEqual(transcriptionWindows(3602),[{start:0,duration:1800},{start:1800,duration:1800},{start:3600,duration:2}]);
 assert.equal(transcriptionWindows(21600).length,12);
 assert.throws(()=>transcriptionWindows(21601),/six hours/);
});
