import {openAsBlob} from 'node:fs';
import type {SpeechRequest} from '../transcription';
import {speechJSON,SpeechError,wordResult,pollDelay} from './common';
export async function assemblyai(request:SpeechRequest,signal:AbortSignal){
 const base=request.region==='eu'?'https://api.eu.assemblyai.com/v2':'https://api.assemblyai.com/v2';
 const headers={authorization:request.apiKey!};let remoteId=request.resume?.remoteJobId;
 if(!remoteId){
  if(request.resume?.submissionStarted)throw new SpeechError('AssemblyAI submission is uncertain. Reconcile it before creating another attempt.');
  const upload=await speechJSON(request,base+'/upload',{method:'POST',headers:{...headers,'content-type':'application/octet-stream'},body:await openAsBlob(request.path)},signal);
  let url:URL;try{url=new URL(upload.upload_url);}catch{throw new SpeechError('AssemblyAI returned an invalid upload URL');}
  if(url.protocol!=='https:'||!url.hostname.endsWith('.assemblyai.com')||url.username||url.password)throw new SpeechError('AssemblyAI returned an unsafe upload URL');
  await request.authorize();await request.checkpoint({submissionStarted:true});
  let submitted;
  try{submitted=await speechJSON(request,base+'/transcript',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({audio_url:url.toString(),speech_models:[request.model],speaker_labels:request.speakers??false,format_text:false,disfluencies:true,...(request.language?{language_code:request.language}:{language_detection:true})})},signal,60_000);}
  catch(error){
   // Definite rejections did not create a remote job. A lost response may have done so.
   if(error instanceof SpeechError&&/rejected the request \((400|401|403|422|429)\)/.test(error.message)){await request.checkpoint({submissionStarted:false});throw error;}
   throw new SpeechError('AssemblyAI submission is uncertain. Reconcile it before creating another attempt.');
  }
  if(typeof submitted.id!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(submitted.id))throw new SpeechError('AssemblyAI submission is uncertain: no valid job identifier');
  remoteId=submitted.id;await request.checkpoint({remoteJobId:remoteId,submissionStarted:true});
 }
 if(!/^[a-zA-Z0-9-]{1,100}$/.test(remoteId!))throw new SpeechError('Invalid remote speech job');
 for(let count=0;count<1200;count++){
  const result=await speechJSON(request,`${base}/transcript/${remoteId}`,{headers},signal,60_000);
  if(result.status==='completed')return {...wordResult(request,result.words??[],result.text??'',true),language:result.language_code,requestId:remoteId,usage:{audioSeconds:typeof result.audio_duration==='number'?result.audio_duration:request.duration}};
  if(result.status==='error')throw new SpeechError('AssemblyAI transcription failed. Inspect the job in your provider account.');
  if(!['queued','processing'].includes(result.status))throw new SpeechError('AssemblyAI returned an invalid job status');
  await pollDelay(signal);
 }
 throw new SpeechError('AssemblyAI processing exceeded the polling budget',true);
}
