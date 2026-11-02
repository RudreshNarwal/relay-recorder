import {requireActor,type Actor} from './auth';
import {availableTranscription} from './transcription-config';

export const UPLOAD_PART_BYTES=8*1024*1024;
export const HARD_CAPTURE_LIMITS=Object.freeze({maxUploadBytes:128*1024**3,maxDurationSeconds:86400});
export const DEFAULT_CAPTURE_LIMITS=Object.freeze({maxUploadBytes:32*1024**3,maxDurationSeconds:21600});
export type CaptureLimits={maxUploadBytes:number;maxDurationSeconds:number};

export function validateCaptureLimits(value:CaptureLimits):CaptureLimits{
 for(const key of ['maxUploadBytes','maxDurationSeconds'] as const){
  if(!Number.isSafeInteger(value[key])||value[key]<=0||value[key]>HARD_CAPTURE_LIMITS[key])throw new Error(`Invalid recording limit: ${key}`);
 }
 return {maxUploadBytes:value.maxUploadBytes,maxDurationSeconds:value.maxDurationSeconds};
}
export function captureLimits(env:Record<string,string|undefined>=process.env):CaptureLimits{
 return validateCaptureLimits({
  maxUploadBytes:env.RELAY_MAX_UPLOAD_BYTES===undefined?DEFAULT_CAPTURE_LIMITS.maxUploadBytes:Number(env.RELAY_MAX_UPLOAD_BYTES),
  maxDurationSeconds:env.RELAY_MAX_DURATION_SECONDS===undefined?DEFAULT_CAPTURE_LIMITS.maxDurationSeconds:Number(env.RELAY_MAX_DURATION_SECONDS),
 });
}
export function recordingLimits(row:{capture_limits?:CaptureLimits}):CaptureLimits{
 return validateCaptureLimits(row.capture_limits??DEFAULT_CAPTURE_LIMITS);
}
export function renderTimeout(duration:number):number{
 if(!Number.isFinite(duration)||duration<=0||duration>HARD_CAPTURE_LIMITS.maxDurationSeconds)throw new Error('Invalid render duration');
 return Math.ceil((300+duration*4)*1000);
}
export function durationLimitMessage(limit:number):string{
 return limit===21600?'Duration exceeds six hours':`Duration exceeds ${limit} seconds`;
}
export async function getServerCapabilities(actor:Actor|null,workspaceId?:string){
 requireActor(actor);
 return {uploadPartBytes:UPLOAD_PART_BYTES,...captureLimits(),
  transcription:await availableTranscription(actor,workspaceId),
  features:{audioOnly:true,localTranscripts:true}};
}
