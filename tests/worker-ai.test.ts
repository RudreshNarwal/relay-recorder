import test from 'node:test';
import assert from 'node:assert/strict';
import { generateVideoAI, validateAIResult, safeAIError } from '../services/worker/src/ai';
const output={title:'Demo',summary:'A useful recording.',chapters:[{start:0,title:'Intro'}],actionItems:['Follow up']};
test('invalid generated chapter timestamps fail instead of publishing',()=>{
 assert.throws(()=>validateAIResult({...output,chapters:[{start:-1,title:'Bad'}]},10),/chapter/i);
 assert.throws(()=>validateAIResult({...output,actionItems:'wrong'},10),/action/i);
 assert.deepEqual(validateAIResult(output,10),output);
});
test('provider errors never reveal credential or response body',()=>{
 assert.equal(safeAIError(Object.assign(new Error('secret sk-123 invalid auth'),{statusCode:401})),'AI authentication failed');
 assert.equal(safeAIError(Object.assign(new Error('response secret'),{statusCode:429})),'AI provider rate limit');
 assert.doesNotMatch(safeAIError(new Error('secret sk-123')),/secret|sk-123/);
});
for(const provider of ['google','vertex','openai','anthropic','openrouter'] as const)test(`${provider} maps SDK request and validates response via mocked HTTP`,async()=>{
 let requestUrl='';let sent='';
 const transport=async(input:RequestInfo|URL,init?:RequestInit)=>{
 requestUrl=String(input);sent=String(init?.body);
 const text=JSON.stringify(output);
 const response=provider==='google'||provider==='vertex'?{candidates:[{content:{role:'model',parts:[{text}]},finishReason:'STOP',index:0}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:5,totalTokenCount:8}}:provider==='anthropic'?{id:'msg_1',type:'message',role:'assistant',model:'test',content:[{type:'text',text}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:3,output_tokens:5}}:{id:'chat_1',object:'chat.completion',created:123,model:'test',choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:5,total_tokens:8}};
 return new Response(JSON.stringify(response),{headers:{'content-type':'application/json'}});
 };
 const result=await generateVideoAI({provider,model:'test',apiKey:'test-key',project:'demo-project',location:'us-central1',enabled:true},'Hello recording',10,{fetch:transport,vertexAuth:{getAccessToken:async()=>({token:'fake-adc'})}});
 assert.deepEqual(result.result,output);assert.ok(result.usage);
 assert.match(sent,/Hello recording/); assert.doesNotMatch(sent,/test-key/);
 assert.match(requestUrl,provider==='google'?/generativelanguage.googleapis.com/:provider==='vertex'?/aiplatform.googleapis.com/:provider==='anthropic'?/api.anthropic.com/:provider==='openrouter'?/openrouter.ai/:/api.openai.com/);
});
for(const status of [401,429])test(`SDK ${status} failure stays sanitized and classified`,async()=>{
 const transport=async()=>new Response(JSON.stringify({error:{message:'private-key-supersecret',type:'invalid_request_error',code:'invalid_api_key'}}),{status,headers:{'content-type':'application/json'}});
 await assert.rejects(generateVideoAI({provider:'openai',model:'test',apiKey:'private-key-supersecret',enabled:true},'hello',5,{fetch:transport}),error=>{
 assert.doesNotMatch(String(error),/supersecret|invalid_api_key/);
 assert.match(String(error),status===401?/authentication failed/:/rate limit/);return true;
 });
});
test('SDK malformed structured output is rejected',async()=>{
 const transport=async()=>new Response(JSON.stringify({id:'chat_1',object:'chat.completion',created:123,model:'test',choices:[{index:0,message:{role:'assistant',content:'not JSON'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});
 await assert.rejects(generateVideoAI({provider:'openai',model:'test',apiKey:'key',enabled:true},'hello',5,{fetch:transport}),/malformed JSON/);
});
test('administrator connection test decrypts configured key only inside provider boundary',async()=>{
 const {testAIConnection}=await import('../services/worker/src/ai');
 const {encryptSecret}=await import('../packages/core/src/secrets');
 process.env.ENCRYPTION_KEY=Buffer.alloc(32,7).toString('hex');
 let authorization='';const original=globalThis.fetch;
 globalThis.fetch=async(_input,init)=>{authorization=new Headers(init?.headers).get('authorization')??'';return new Response(JSON.stringify({id:'chat_1',object:'chat.completion',created:123,model:'test',choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});};
 try{const result=await testAIConnection({provider:'openai',model:'test',enabled:true,encryptedApiKey:encryptSecret('admin-secret')});assert.equal(result.ok,true);assert.equal(authorization,'Bearer admin-secret');}
 finally{globalThis.fetch=original;}
});
test('Vertex uses project/location ADC even when environment contains Express API key',async()=>{
 const old=process.env.GOOGLE_VERTEX_API_KEY;process.env.GOOGLE_VERTEX_API_KEY='unexpected-express-key';let endpoint='',authorization='';
 try{
 await generateVideoAI({provider:'vertex',model:'test',project:'explicit-project',location:'us-central1',enabled:true},'hello',3,{vertexAuth:{getAccessToken:async()=>({token:'adc-token'})},fetch:async(input,init)=>{endpoint=String(input);authorization=new Headers(init?.headers).get('authorization')??'';return new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{text:JSON.stringify(output)}]},finishReason:'STOP',index:0}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:1,totalTokenCount:2}}),{headers:{'content-type':'application/json'}});}});
 assert.match(endpoint,/projects\/explicit-project\/locations\/us-central1/);assert.equal(authorization,'Bearer adc-token');
 }finally{if(old===undefined)delete process.env.GOOGLE_VERTEX_API_KEY;else process.env.GOOGLE_VERTEX_API_KEY=old;}
});
