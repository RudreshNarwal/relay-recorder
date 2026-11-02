import test from 'node:test';
import assert from 'node:assert/strict';
import { safeAssetPath } from '../packages/core/src/storage';
import { encryptSecret, decryptSecret } from '../packages/core/src/secrets';
import { canReadVideo, canEditVideo, validateClips, remapSegments } from '../packages/core/src/policy';

const owner={id:'owner',email:'owner@example.com',isAdmin:false};
const other={id:'other',email:'other@example.com',isAdmin:false};
const video={ownerId:'owner',visibility:'private',deletedAt:null};
test('private media denies another workspace member and anonymous viewers',()=>{
 assert.equal(canReadVideo(video,{user:other,role:'member'}),false);
 assert.equal(canReadVideo(video,{user:null,role:null}),false);
 assert.equal(canReadVideo(video,{user:owner,role:'member'}),true);
});
test('workspace visibility and editing remain bounded by membership roles',()=>{
 assert.equal(canReadVideo({...video,visibility:'workspace'},{user:other,role:'member'}),true);
 assert.equal(canEditVideo(video,{user:other,role:'member'}),false);
 assert.equal(canEditVideo(video,{user:other,role:'admin'}),true);
 assert.equal(canReadVideo({...video,deletedAt:'now'},{user:owner,role:'owner'}),false);
});
test('password share requires current unlocked version and explicit shares match verified email',()=>{
 assert.equal(canReadVideo({...video,visibility:'password'},{user:null,role:null,validShare:true,unlocked:false}),false);
 assert.equal(canReadVideo({...video,visibility:'password'},{user:null,role:null,validShare:true,unlocked:true}),true);
 assert.equal(canReadVideo({...video,visibility:'shared'},{user:other,role:null,explicitAccess:true}),true);
 assert.equal(canReadVideo({...video,visibility:'unlisted'},{user:null,role:null,validShare:false}),false);
});
test('media path rejects traversal, absolute paths and encoded traversal',()=>{
 for(const p of ['../secret','/etc/passwd','hls/../../x','%2e%2e/secret','a\\b','a\0b']) assert.throws(()=>safeAssetPath('/tmp/relay',p));
 assert.equal(safeAssetPath('/tmp/relay','hls/segment001.ts'),'/tmp/relay/hls/segment001.ts');
});
test('encrypted provider secret round-trips and rejects tampering',()=>{
 process.env.ENCRYPTION_KEY=Buffer.alloc(32,9).toString('hex');
 const encrypted=encryptSecret('private-key-value');
 assert.ok(!encrypted.includes('private-key-value'));
 assert.equal(decryptSecret(encrypted),'private-key-value');
 const parts=encrypted.split('.'); parts[2]=Buffer.alloc(16).toString('base64url');
 assert.throws(()=>decryptSecret(parts.join('.')));
});
test('edits reject empty, reversed, nonfinite and out-of-bounds clips',()=>{
 const durations=new Map([['v',10]]);
 for(const clips of [[],[{videoId:'v',start:4,end:2}],[{videoId:'v',start:0,end:11}],[{videoId:'v',start:NaN,end:5}]]) assert.throws(()=>validateClips(clips,durations));
 assert.equal(validateClips([{videoId:'v',start:2,end:6}],durations),4);
});
test('cut transcript words shift into resulting timeline without deleted text',()=>{
 const result=remapSegments([{start:1,end:4,text:'one two three',words:[{start:1,end:2,text:'one'},{start:2,end:3,text:'two'},{start:3,end:4,text:'three'}]}],[{start:2,end:4}]);
 assert.deepEqual(result,[{start:0,end:2,text:'two three',words:[{start:0,end:1,text:'two'},{start:1,end:2,text:'three'}]}]);
});
