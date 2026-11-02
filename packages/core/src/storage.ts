import path from 'node:path';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {UPLOAD_PART_BYTES,HARD_CAPTURE_LIMITS} from './capabilities';
export const PART_SIZE = UPLOAD_PART_BYTES;
export const MAX_PARTS = Math.ceil(HARD_CAPTURE_LIMITS.maxUploadBytes/PART_SIZE);
// Runtime persistent volume; never include recordings in Next.js build traces.
export function dataRoot() { return path.resolve(/* turbopackIgnore: true */ process.env.DATA_DIR || './data'); }
function id(value: string) { if(!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)) throw new Error('Invalid media identity'); return value; }
export function videoRoot(videoId: string) { return path.join(dataRoot(),'videos',id(videoId)); }
export function revisionRoot(videoId: string, revisionId: string) { return path.join(videoRoot(videoId),'revisions',id(revisionId)); }
export function uploadRoot(videoId: string) { return path.join(dataRoot(),'uploads',id(videoId)); }
export function safeAssetPath(root: string, relative: string) {
 if(!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0') || relative.includes('%') || relative.split('/').some(x=>!x || x==='.' || x==='..')) throw new Error('Invalid asset path');
 const result=path.resolve(root,relative); if(!result.startsWith(path.resolve(root)+path.sep)) throw new Error('Invalid asset path'); return result;
}
export async function atomicWrite(file: string, data: Uint8Array|string) {
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const temp=file+'.'+randomUUID()+'.tmp';
 try { const handle=await open(temp,'wx',0o600); try {await handle.writeFile(data);await handle.sync();} finally {await handle.close();} await rename(temp,file); const dir=await open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();} }
 catch(error){await rm(temp,{force:true}).catch(()=>{});throw error;}
}
