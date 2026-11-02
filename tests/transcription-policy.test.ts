import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveTranscriptionSelection,type TranscriptionSelection} from '../packages/core/src/transcription';

const device:TranscriptionSelection={execution:'device',provider:'parakeet'};
const server:TranscriptionSelection={execution:'server',provider:'parakeet'};
const external:TranscriptionSelection={execution:'server',provider:'deepgram',configurationId:'external-1',configurationVersion:2};
const allowed=[device,server,external],ready={supported:true,verified:true,runnable:true};

test('auto prefers verified runnable local Parakeet and otherwise stays self-hosted',()=>{
 assert.deepEqual(resolveTranscriptionSelection('auto',allowed,ready),device);
 for(const state of [{...ready,verified:false},{...ready,runnable:false},{...ready,supported:false}])assert.deepEqual(resolveTranscriptionSelection('auto',allowed,state),server);
 assert.deepEqual(resolveTranscriptionSelection('server',allowed,ready),server);
 assert.throws(()=>resolveTranscriptionSelection('auto',[external],{...ready,runnable:false}),/unavailable/i);
});
test('local-only preserves the local choice while models are unavailable',()=>{
 assert.deepEqual(resolveTranscriptionSelection('local_only',allowed,{supported:true,verified:false,runnable:false}),device);
 assert.throws(()=>resolveTranscriptionSelection('local_only',allowed,{...ready,supported:false}),/unavailable/i);
});
test('external speech requires an explicit available configuration',()=>{
 assert.deepEqual(resolveTranscriptionSelection({externalConfigurationId:'external-1'},allowed,ready),external);
 assert.throws(()=>resolveTranscriptionSelection({externalConfigurationId:'missing'},allowed,ready),/unavailable/i);
 assert.throws(()=>resolveTranscriptionSelection({externalConfigurationId:'external-1'},[device,server],ready),/unavailable/i);
});
