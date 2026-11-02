import test from 'node:test';
import assert from 'node:assert/strict';
import {captureLimits,renderTimeout,DEFAULT_CAPTURE_LIMITS,HARD_CAPTURE_LIMITS,UPLOAD_PART_BYTES} from '../packages/core/src/capabilities';
import {validateManifest} from '../packages/core/src/routes/recordings';

test('invalid operator limits fail closed instead of allowing unbounded processing',()=>{
 for(const value of ['0','-1','Infinity','NaN','1.5','99999999999999999999','']){
  assert.throws(()=>captureLimits({RELAY_MAX_UPLOAD_BYTES:value}));
  assert.throws(()=>captureLimits({RELAY_MAX_DURATION_SECONDS:value}));
 }
 assert.throws(()=>captureLimits({RELAY_MAX_DURATION_SECONDS:'86401'}));
 assert.throws(()=>captureLimits({RELAY_MAX_UPLOAD_BYTES:String(128*1024**3+1)}));
});
test('largest allowed manifest fits the bounded request and rejects one extra byte',()=>{
 const parts=Array.from({length:HARD_CAPTURE_LIMITS.maxUploadBytes/UPLOAD_PART_BYTES},(_,index)=>({index,size:UPLOAD_PART_BYTES,sha256:'a'.repeat(64)}));
 assert.doesNotThrow(()=>validateManifest(parts,HARD_CAPTURE_LIMITS));
 assert.ok(Buffer.byteLength(JSON.stringify({parts,mimeType:'video/mp4'}))<4_000_000);
 assert.throws(()=>validateManifest([...parts,{index:parts.length,size:1,sha256:'b'.repeat(64)}],HARD_CAPTURE_LIMITS));
});
test('manifests obey their snapshotted byte budget even at a partial part boundary',()=>{
 const part={index:0,size:6,sha256:'a'.repeat(64)};
 assert.throws(()=>validateManifest([part],{maxUploadBytes:5,maxDurationSeconds:10}));
 assert.doesNotThrow(()=>validateManifest([part],{maxUploadBytes:6,maxDurationSeconds:10}));
 assert.throws(()=>validateManifest([{...part,index:1}],DEFAULT_CAPTURE_LIMITS));
});
test('long accepted recordings receive a bounded duration-aware render budget',()=>{
 assert.ok(renderTimeout(21600)>21600*1000);
 assert.ok(renderTimeout(1)<renderTimeout(3600));
 assert.throws(()=>renderTimeout(Infinity));
 assert.throws(()=>renderTimeout(86401));
});
