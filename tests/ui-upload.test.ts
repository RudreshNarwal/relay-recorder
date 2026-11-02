import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, uploadFile } from '../apps/web/components/upload';

test('upload hashes every chunk, skips acknowledged parts, and finalizes contiguous manifest',async()=>{
 const previousFetch=globalThis.fetch; const previousStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 const storage=new Map<string,string>(); Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)}});
 const puts:{url:string;headers:Headers;body:Blob}[]=[];let manifest:any;let clientId:string|undefined;
 globalThis.fetch=async(input,options)=>{
  const url=String(input);if(url==='/api/v1/capabilities')return Response.json({maxUploadBytes:100});
  if(url==='/api/v1/recordings'){clientId=JSON.parse(String(options?.body)).clientId;return Response.json({video:{id:'video-1'},upload:{partSize:4,maxUploadBytes:100,receivedParts:[0]}});}
  if(url.includes('/parts/')){puts.push({url,headers:new Headers(options?.headers),body:options?.body as Blob});return Response.json({index:1});}
  if(url.endsWith('/finalize')){manifest=JSON.parse(String(options?.body));return Response.json({video:{id:'video-1',status:'processing'}});}
  throw new Error(`Unexpected request ${url}`);
 };
 try{
  const file=new File(['abcdefghij'],'clip.mp4',{type:'video/mp4',lastModified:7});const progress:number[]=[];
  const result=await uploadFile(file,'workspace','A walkthrough',value=>progress.push(value),new AbortController().signal);
  assert.equal(result.status,'processing');assert.match(clientId!,/^[0-9a-f-]{36}$/);assert.equal(puts.length,2);
  assert.ok(puts[0].url.endsWith('/parts/1'));assert.equal(puts[0].headers.get('X-Content-SHA256'),await digest(new Blob(['efgh'])));
  assert.deepEqual(manifest.parts.map((part:any)=>[part.index,part.size]),[[0,4],[1,4],[2,2]]);assert.equal(manifest.parts[0].sha256,await digest(new Blob(['abcd'])));
  assert.equal(manifest.mimeType,'video/mp4');assert.equal(progress.at(-1),100);assert.equal(storage.size,0);
 }finally{globalThis.fetch=previousFetch;if(previousStorage)Object.defineProperty(globalThis,'localStorage',previousStorage);else Reflect.deleteProperty(globalThis,'localStorage');}
});

test('upload rejects oversized files before transfer but resumes under admitted limits',async()=>{
 const previousFetch=globalThis.fetch,previousStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 const storage=new Map<string,string>();Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)}});
 const requests:string[]=[];
 globalThis.fetch=async(input)=>{const url=String(input);requests.push(url);
  if(url==='/api/v1/capabilities'){assert.equal(storage.size,1,'Identity must exist before network access');return Response.json({maxUploadBytes:5});}
  if(url==='/api/v1/recordings')return Response.json({video:{id:'video-1'},upload:{partSize:8,maxUploadBytes:20,receivedParts:[]}});
  if(url.endsWith('/finalize'))return Response.json({video:{id:'video-1',status:'processing'}});
  if(url.includes('/parts/'))return Response.json({});
  throw new Error(`Unexpected request ${url}`);
 };
 try{
  const file=new File(['abcdefghij'],'clip.mp4',{type:'video/mp4',lastModified:7});
  await assert.rejects(uploadFile(file,'workspace','Example',()=>{},new AbortController().signal),/upload limit/i);
  assert.deepEqual(requests,['/api/v1/capabilities']);assert.equal(storage.size,0);
  storage.set('relay-upload:workspace:clip.mp4:10:7',crypto.randomUUID());requests.length=0;
  assert.equal((await uploadFile(file,'workspace','Example',()=>{},new AbortController().signal)).status,'processing');
  assert.equal(requests[0],'/api/v1/recordings');assert.equal(storage.size,0);
 }finally{globalThis.fetch=previousFetch;if(previousStorage)Object.defineProperty(globalThis,'localStorage',previousStorage);else Reflect.deleteProperty(globalThis,'localStorage');}
});

test('audio imports declare their stream kind for creation and finalization',async()=>{
 const previousFetch=globalThis.fetch,previousStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}});
 const bodies:Record<string,any>[]=[];
 globalThis.fetch=async(input,options)=>{
  const url=String(input);if(url.endsWith('/capabilities'))return Response.json({maxUploadBytes:100});
  if(options?.method==='POST')bodies.push(JSON.parse(String(options.body)));
  if(url.endsWith('/recordings'))return Response.json({video:{id:'audio-1'},upload:{partSize:8,maxUploadBytes:100,receivedParts:[]}});
  return Response.json({video:{id:'audio-1',status:'processing'}});
 };
 try{
  await uploadFile(new File(['audio'],'note.m4a',{type:'audio/mp4'}),'workspace','Voice note',()=>{},new AbortController().signal);
  assert.equal(bodies[0].mediaKind,'audio');assert.equal(bodies[0].mimeType,'audio/mp4');assert.equal(bodies[1].mimeType,'audio/mp4');
 }finally{globalThis.fetch=previousFetch;if(previousStorage)Object.defineProperty(globalThis,'localStorage',previousStorage);else Reflect.deleteProperty(globalThis,'localStorage');}
});

test('resumed upload retains the explicitly selected speech configuration',async()=>{
 const previousFetch=globalThis.fetch,previousStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 const selected={execution:'server' as const,provider:'deepgram' as const,configurationId:'saved-configuration',configurationVersion:2};
 const key='relay-upload:workspace:clip.mp4:4:7',storage=new Map([[key,'saved-client'],[key+':transcription',JSON.stringify(selected)]]);
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>storage.get(k)||null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)}});
 globalThis.fetch=async(input,options)=>{const url=String(input);
  if(url.endsWith('/recordings')){const body=JSON.parse(String(options?.body));assert.deepEqual(body.transcription,selected);return Response.json({video:{id:'v'},upload:{partSize:8,maxUploadBytes:100,receivedParts:[0]}});}
  if(url.endsWith('/finalize'))return Response.json({video:{id:'v',status:'processing'}});
  throw new Error('Unexpected request');
 };
 try{await uploadFile(new File(['test'],'clip.mp4',{type:'video/mp4',lastModified:7}),'workspace','Example',()=>{},new AbortController().signal);assert.equal(storage.size,0);}
 finally{globalThis.fetch=previousFetch;if(previousStorage)Object.defineProperty(globalThis,'localStorage',previousStorage);else Reflect.deleteProperty(globalThis,'localStorage');}
});

test('rejected speech admission permits explicit reselection without losing the recording identity',async()=>{
 const previousFetch=globalThis.fetch,previousStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 const storage=new Map<string,string>();Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>storage.get(k)||null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)}});
 const selected={execution:'server' as const,provider:'deepgram' as const,configurationId:'old-config',configurationVersion:1};let firstId:string|undefined;
 globalThis.fetch=async(input,options)=>{
  if(String(input).endsWith('/capabilities'))return Response.json({maxUploadBytes:100});
  firstId=JSON.parse(String(options?.body)).clientId;return Response.json({error:'Choose an available speech provider explicitly.',code:'SPEECH_CONFIGURATION_UNAVAILABLE'},{status:409});
 };
 try{
  const file=new File(['test'],'clip.mp4',{type:'video/mp4',lastModified:7});
  await assert.rejects(uploadFile(file,'workspace','Example',()=>{},new AbortController().signal,'video',selected),/explicitly/);
  const replacement={execution:'server' as const,provider:'parakeet' as const};
  globalThis.fetch=async(input,options)=>{
   if(String(input).endsWith('/recordings')){const body=JSON.parse(String(options?.body));assert.equal(body.clientId,firstId);assert.deepEqual(body.transcription,replacement);return Response.json({video:{id:'v'},upload:{partSize:8,maxUploadBytes:100,receivedParts:[]}});}
   return Response.json({video:{id:'v',status:'processing'}});
  };
  await uploadFile(file,'workspace','Example',()=>{},new AbortController().signal,'video',replacement);assert.equal(storage.size,0);
 }finally{globalThis.fetch=previousFetch;if(previousStorage)Object.defineProperty(globalThis,'localStorage',previousStorage);else Reflect.deleteProperty(globalThis,'localStorage');}
});
