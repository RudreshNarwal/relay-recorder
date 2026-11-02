import {captureLimits,durationLimitMessage,type CaptureLimits} from './capabilities';
export type User={id:string;email:string;name?:string;isAdmin:boolean};
export type Access={user:User|null;role:string|null;validShare?:boolean;unlocked?:boolean;explicitAccess?:boolean};
export type PolicyVideo={ownerId:string;visibility:string;deletedAt?:unknown};
export function canEditVideo(video:PolicyVideo,access:Access){return !video.deletedAt&&!!access.user&&!!access.role&&(video.ownerId===access.user.id||access.role==='owner'||access.role==='admin');}
export function canReadVideo(video:PolicyVideo,access:Access){
 if(video.deletedAt)return false;if(canEditVideo(video,access))return true;
 switch(video.visibility){case 'workspace':return !!access.user&&!!access.role;case 'unlisted':return !!access.validShare;case 'password':return !!access.validShare&&!!access.unlocked;case 'shared':return !!access.user&&!!access.explicitAccess;default:return false;}
}
export type Clip={videoId:string;revisionId?:string;start:number;end:number};
export function validateClips(clips:Clip[],durations:Map<string,number>,limits:CaptureLimits=captureLimits()){
 if(!clips.length||clips.length>100)throw new Error('Use between 1 and 100 clips');let total=0;
 for(const clip of clips){const duration=durations.get(clip.videoId);if(duration===undefined||!Number.isFinite(clip.start)||!Number.isFinite(clip.end)||clip.start<0||clip.end<=clip.start||clip.end>duration+0.05)throw new Error('Invalid clip range');total+=clip.end-clip.start;}
 if(total>limits.maxDurationSeconds)throw new Error(durationLimitMessage(limits.maxDurationSeconds));return total;
}
export type Word={start:number;end:number;text:string;speaker?:string};
export type Segment=Word&{words?:Word[]};
export {remapSegments} from './timeline';
