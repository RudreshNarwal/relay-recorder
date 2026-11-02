import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {transcribeAudio,type SpeechRequest,type SpeechCheckpoint} from '../services/worker/src/transcription';
import {checkedWords,checkedSegments} from '../services/worker/src/speech/common';

async function fixture(run:(request:SpeechRequest)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'relay-speech-provider-'));const original=globalThis.fetch;
 try{
  const file=join(root,'audio.wav');await writeFile(file,Buffer.alloc(32044));
  await run({path:file,duration:1,provider:'deepgram',model:'nova-3',region:'us',apiKey:'private-speech-key',configurationVersion:1,language:'en',checkpoint:async()=>{},authorize:async()=>{}});
 }finally{globalThis.fetch=original;await rm(root,{recursive:true,force:true});}
}

test('Deepgram requests verbatim words and preserves actual timestamps',()=>fixture(async request=>{
 globalThis.fetch=async(input,options)=>{
  const url=new URL(String(input));assert.equal(url.hostname,'api.deepgram.com');assert.equal(url.searchParams.get('filler_words'),'true');assert.equal(url.searchParams.get('model'),'nova-3');assert.equal(new Headers(options?.headers).get('authorization'),'Token private-speech-key');assert.equal(options?.redirect,'error');
  return Response.json({metadata:{request_id:'dg-1',duration:1},results:{channels:[{detected_language:'en',alternatives:[{transcript:'um hello',words:[{word:'um',start:0.1,end:0.3,speaker:0},{word:'hello',start:0.5,end:0.9,speaker:0}]}]}]}});
 };
 const result=await transcribeAudio(request,new AbortController().signal);assert.equal(result.timing,'word');assert.equal(result.segments[0].words?.[1].start,0.5);assert.equal(result.segments[0].words?.[0].text,'um');assert.equal(result.requestId,'dg-1');
}));
test('AssemblyAI checkpoints remote ID and converts milliseconds exactly once',()=>fixture(async request=>{
 let checkpoint:SpeechCheckpoint={};let submissions=0;
 globalThis.fetch=async(input,options)=>{
  const url=String(input);if(url.endsWith('/upload'))return Response.json({upload_url:'https://cdn.assemblyai.com/upload/fixture'});
  if(options?.method==='POST'){submissions++;assert.deepEqual(JSON.parse(String(options.body)).speech_models,['universal-3-5-pro']);return Response.json({id:'asr-1'});}
  return Response.json({id:'asr-1',status:'completed',language_code:'en',text:'hello',words:[{start:100,end:800,text:'hello',speaker:'A'}],audio_duration:1});
 };
 const configured={...request,provider:'assemblyai' as const,model:'universal-3-5-pro',checkpoint:async(value:SpeechCheckpoint)=>{checkpoint={...checkpoint,...value};}};
 const result=await transcribeAudio(configured,new AbortController().signal);assert.equal(result.segments[0].words?.[0].start,0.1);assert.equal(result.segments[0].words?.[0].end,0.8);assert.equal(checkpoint.remoteJobId,'asr-1');
 await transcribeAudio({...configured,resume:checkpoint},new AbortController().signal);assert.equal(submissions,1,'Retry must poll the existing remote job');
}));
test('OpenAI plain transcription stays untimed; diarized model preserves segment times',()=>fixture(async request=>{
 globalThis.fetch=async(_input,options)=>{const body=options?.body as FormData;assert.equal(body.get('model'),'gpt-4o-transcribe');assert.equal(body.get('response_format'),'json');assert.equal(body.get('timestamp_granularities[]'),null);return Response.json({text:'hello world',usage:{type:'duration',seconds:1}});};
 const result=await transcribeAudio({...request,provider:'openai',model:'gpt-4o-transcribe',region:'provider-default'},new AbortController().signal);assert.equal(result.timing,'none');assert.deepEqual(result.segments,[]);assert.equal(result.text,'hello world');
 globalThis.fetch=async(_input,options)=>{const body=options?.body as FormData;assert.equal(body.get('response_format'),'diarized_json');return Response.json({text:'hello',segments:[{start:0.2,end:0.8,text:'hello',speaker:'A'}]});};
 const diarized=await transcribeAudio({...request,provider:'openai',model:'gpt-4o-transcribe-diarize',region:'provider-default'},new AbortController().signal);assert.equal(diarized.timing,'segment');assert.equal(diarized.segments[0].start,0.2);assert.equal(diarized.segments[0].words,undefined);
}));
test('speech errors redact credentials, honor bounded Retry-After and reject invalid timing',()=>fixture(async request=>{
 for(const status of [401,403,429,500]){
  globalThis.fetch=async()=>new Response('private-speech-key',{status,headers:{'Retry-After':'7'}});
  await assert.rejects(transcribeAudio(request,new AbortController().signal),(error:any)=>{assert.doesNotMatch(error.message,/private-speech-key/);assert.equal(error.retryable,status===429||status===500);if(status===429)assert.equal(error.retryAfterSeconds,7);return true;});
 }
 globalThis.fetch=async()=>new Response('invalid json private-speech-key');await assert.rejects(transcribeAudio(request,new AbortController().signal),(error:Error)=>!error.message.includes('private-speech-key'));
 globalThis.fetch=async()=>Response.json({results:{channels:[{alternatives:[{transcript:'hello',words:[{word:'hello',start:100,end:800}]}]}]}});await assert.rejects(transcribeAudio(request,new AbortController().signal),/timestamp/i);
 let contacted=false;globalThis.fetch=async()=>{contacted=true;throw new Error('Should not send');};
 await assert.rejects(transcribeAudio({...request,duration:2000},new AbortController().signal),/limit/i);assert.equal(contacted,false);
 await assert.rejects(transcribeAudio({...request,authorize:async()=>{throw new Error('Configuration revoked');}},new AbortController().signal),/revoked/);assert.equal(contacted,false);
}));
test('AssemblyAI ambiguous submission stops without creating a second remote job',()=>fixture(async request=>{
 let checkpoint:SpeechCheckpoint={};let submissions=0;
 globalThis.fetch=async(input)=>{if(String(input).endsWith('/upload'))return Response.json({upload_url:'https://cdn.assemblyai.com/upload/fixture'});submissions++;throw new Error('Connection lost private-speech-key');};
 const configured={...request,provider:'assemblyai' as const,model:'universal-3-5-pro',checkpoint:async(value:SpeechCheckpoint)=>{checkpoint={...checkpoint,...value};}};
 await assert.rejects(transcribeAudio(configured,new AbortController().signal),/uncertain/i);
 await assert.rejects(transcribeAudio({...configured,resume:checkpoint},new AbortController().signal),/uncertain/i);assert.equal(submissions,1);
}));
test('silence and missing word alignment never fabricate timestamped words',()=>fixture(async request=>{
 globalThis.fetch=async()=>Response.json({results:{channels:[{alternatives:[{transcript:'',words:[]}]}]}});
 assert.deepEqual((await transcribeAudio(request,new AbortController().signal)).segments,[]);
 globalThis.fetch=async()=>Response.json({results:{channels:[{alternatives:[{transcript:'hello',words:[]}]}]}});
 const untimed=await transcribeAudio(request,new AbortController().signal);assert.equal(untimed.timing,'none');assert.deepEqual(untimed.segments,[]);assert.equal(untimed.text,'hello');
}));

test('timing normalization rejects intervals outside audio and words outside their segment',()=>{
 for(const start of [1,1.1])assert.throws(()=>checkedWords([{start,end:1.2,text:'outside'}],1),/timestamp/i);
 assert.throws(()=>checkedSegments([{start:0.2,end:0.7,text:'wrong bounds',words:[{start:0.1,end:0.3,text:'wrong'}]}],1),/segment/i);
 assert.throws(()=>checkedSegments([{start:0.2,end:0.7,text:'wrong bounds',words:[{start:0.5,end:0.8,text:'wrong'}]}],1),/segment/i);
 assert.throws(()=>checkedSegments([{start:0.2,end:0.7,text:'wrong order',words:[{start:0.5,end:0.6,text:'second'},{start:0.3,end:0.4,text:'first'}]}],1),/timestamp/i);
 assert.deepEqual(checkedWords([{start:0.8,end:1.1,text:'tail'}],1),[{start:0.8,end:1,text:'tail'}]);
});

test('timeouts, cancellation, byte limits and oversized responses stay bounded and redact transport errors',()=>fixture(async request=>{
 globalThis.fetch=async()=>{throw new Error('private-speech-key timeout');};
 await assert.rejects(transcribeAudio(request,new AbortController().signal),(error:any)=>error.retryable&&!error.message.includes('private-speech-key'));
 let contacted=false;globalThis.fetch=async()=>{contacted=true;return new Response('{}');};
 const canceled=new AbortController();canceled.abort();await assert.rejects(transcribeAudio(request,canceled.signal));assert.equal(contacted,false);
 const {open}=await import('node:fs/promises');const handle=await open(request.path,'r+');try{await handle.truncate(64*1024**2+1);}finally{await handle.close();}
 await assert.rejects(transcribeAudio(request,new AbortController().signal),/limit/);assert.equal(contacted,false);
 await writeFile(request.path,Buffer.alloc(32044));
 globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(8*1024**2+1));controller.close();}}));
 await assert.rejects(transcribeAudio(request,new AbortController().signal),/response exceeds limit/);
}));
