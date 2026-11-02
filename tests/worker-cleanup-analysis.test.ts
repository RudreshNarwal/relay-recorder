import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanupSuggestions,applyCleanup,cleanupTimeline} from '../packages/core/src/cleanup';
import {remapEditEffects} from '../apps/web/components/editing';
import {generateCleanupAI} from '../services/worker/src/ai';

const base={revisionId:'revision',transcriptVersion:'1',duration:6,language:'en',segments:[]};
test('acoustic speech and audible music protect gaps missing from the transcript',()=>{
 const suggestions=cleanupSuggestions({...base,speech:[{start:0,end:1},{start:2,end:3}],audible:[{start:4,end:5}]});
 assert.ok(suggestions.length>0);
 for(const s of suggestions){assert.equal(s.kind,'silence');for(const protectedRange of [{start:0,end:1},{start:2,end:3},{start:4,end:5}])assert.ok(s.end<=protectedRange.start-0.1+1e-9||s.start>=protectedRange.end+0.1-1e-9);}
 assert.ok(suggestions.some(s=>Math.abs(s.start-1.225)<1e-9&&Math.abs(s.end-1.775)<1e-9));
});
test('transcript timing protects quiet words even if VAD misses them; missing acoustic evidence fails closed',()=>{
 const segments=[{start:0,end:5.8,text:'quiet speech'}];
 assert.deepEqual(cleanupSuggestions({...base,segments,speech:[],audible:[]}),[]);
 assert.throws(()=>cleanupSuggestions({...base,speech:[],audible:undefined as any}),/acoustic/i);
});
test('filler proposals require actual word timing and an explicit supported language',()=>{
 const segments=[{start:0,end:1,text:'Um hello',words:[{start:0,end:0.2,text:'Um,'},{start:0.3,end:1,text:'hello'}]},{start:2,end:3,text:'uh'},{start:4,end:5,text:'very very important',words:[{start:4,end:4.2,text:'very'},{start:4.3,end:4.5,text:'very'},{start:4.6,end:5,text:'important'}]}];
 const input={...base,segments,speech:[{start:0,end:6}],audible:[{start:0,end:6}]};
 const suggestions=cleanupSuggestions(input);assert.equal(suggestions.length,1);assert.equal(suggestions[0].kind,'filler');assert.equal(suggestions[0].end,0.2);
 assert.deepEqual(cleanupSuggestions({...input,language:'fr'}),[]);
 assert.deepEqual(cleanupSuggestions({...input,language:undefined}),[]);
});
test('accepted cleanup removes every matching occurrence and keeps other revisions and originals',()=>{
 const suggestions=cleanupSuggestions({...base,speech:[{start:0,end:1},{start:2,end:6}],audible:[]});
 const clips=[{videoId:'a',revisionId:'revision',start:0,end:6},{videoId:'a',revisionId:'revision',start:0,end:6},{videoId:'a',revisionId:'other',start:0,end:6}];
 const output=applyCleanup(clips,'a',suggestions);
 assert.equal(output.length,5);assert.deepEqual(output.at(-1),clips[2]);assert.equal(clips.length,3);
});

test('cleanup preserves pending privacy blurs and thumbnail positions across repeated clips',()=>{
 const clips=[{videoId:'a',revisionId:'revision',start:0,end:6},{videoId:'a',revisionId:'revision',start:0,end:6}];
 const suggestion={id:'filler:1:2',revisionId:'revision',transcriptVersion:'1',start:1,end:2,kind:'filler' as const,confidence:'word-rule' as const,reason:'Fixture'};
 const result=cleanupTimeline(clips,'a',[suggestion]);
 assert.deepEqual(result.kept,[{start:0,end:1},{start:2,end:6},{start:6,end:7},{start:8,end:12}]);
 const blur={start:.5,end:8.5,x:0,y:0,width:1,height:1};
 const effects=remapEditEffects([blur],8.5,result.kept);
 assert.deepEqual(effects.blurs.map(b=>[b.start,b.end]),[[.5,1],[1,5],[5,6],[6,6.5]]);
 assert.equal(effects.thumbnail,6.5);
});

test('contextual cleanup uses configured AI with real word boundaries and rejects invented indices',async()=>{
 const words=[{start:0,end:.4,text:'I'},{start:.5,end:.9,text:'I'},{start:1,end:1.8,text:'agree'}],config={provider:'openai' as const,model:'test-model',apiKey:'secret',enabled:true};
 const boundary={fetch:async()=>Response.json({id:'chat',object:'chat.completion',created:123,model:'test-model',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({suggestions:[{kind:'repeat',fromWord:0,toWord:0,reason:'Possible restart; review context.'}]})},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:5,total_tokens:8}})};
 const result=await generateCleanupAI(config,words,{revisionId:'r',transcriptVersion:'1'},boundary);
 assert.equal(result.suggestions[0].start,0);assert.equal(result.suggestions[0].end,.4);assert.equal(result.suggestions[0].confidence,'model-proposal');
 await assert.rejects(generateCleanupAI(config,[],{revisionId:'r',transcriptVersion:'1'},boundary),/word timing/i);
 const bad={fetch:async()=>Response.json({id:'chat',object:'chat.completion',created:123,model:'test-model',choices:[{index:0,message:{role:'assistant',content:'{"suggestions":[{"kind":"ramble","fromWord":0,"toWord":999,"reason":"Invented"}]}'},finish_reason:'stop'}]})};
 await assert.rejects(generateCleanupAI(config,words,{revisionId:'r',transcriptVersion:'1'},bad),/invalid/i);
});
