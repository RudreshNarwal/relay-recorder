import {stat,readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {query} from '../db';
import {fail,uuid} from '../http';
import {accessVideo,shareToken} from '../access';
import type {Actor} from '../auth';
import {revisionRoot,safeAssetPath} from '../storage';
import {captions} from '../captions';
export function byteRange(value:string|null,size:number):{start:number;end:number}|null{
 if(!value)return null;const match=/^bytes=(\d*)-(\d*)$/.exec(value);if(!match||(!match[1]&&!match[2]))fail(416,'Invalid byte range');let start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));let end=match[1]?(match[2]?Math.min(size-1,Number(match[2])):size-1):size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)fail(416,'Byte range is outside file');return{start,end};
}
export async function media(request:Request,parts:string[],user:Actor|null):Promise<Response|null>{
 if(parts[0]!=='videos'||!['media','export'].includes(parts[2])||!['GET','HEAD'].includes(request.method))return null;
 const id=uuid(parts[1]),{row,editable}=await accessVideo(request,id,user);const download=parts[2]==='export';if(download&&!editable&&row.allow_download===false)fail(403,'Downloads are disabled');
 const selected=new URL(request.url).searchParams.get('revision');let revisionId=row.published_revision_id;if(selected){if(!editable)fail(403,'Only editors may preview revisions');uuid(selected);if(!(await query("SELECT 1 FROM revisions WHERE id=$1 AND video_id=$2 AND status='ready'",[selected,id])).length)fail(404,'Revision not ready');revisionId=selected;}
 const version=new URL(request.url).searchParams.get('version');if(version){uuid(version);if(version!==revisionId)fail(409,'This video has changed. Reload to play the published revision.','REVISION_CHANGED');}
 if(!revisionId)fail(409,'Video is still processing');const asset=download?'playback.mp4':parts.slice(3).join('/');if(!/^(playback\.mp4|thumbnail\.(jpg|gif)|waveform\.json|captions\.(vtt|srt)|hls\/(index\.m3u8|[a-zA-Z0-9_-]+\.(ts|m4s|mp4)))$/.test(asset))fail(404,'Asset not found');
 const headers:Record<string,string>={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Vary':'Cookie, Authorization'};
 if(asset.startsWith('captions.')){const t=(await query("SELECT segments,timing,text FROM transcripts WHERE video_id=$1 AND revision_id=$2 AND status='ready'",[id,revisionId]))[0];if(!t)fail(404,'Captions are not ready');if(t.timing==='none'&&t.text)fail(409,'This speech model did not supply caption timestamps','CAPTIONS_UNAVAILABLE');const format=asset.endsWith('vtt')?'vtt':'srt';headers['Content-Type']=format==='vtt'?'text/vtt; charset=utf-8':'application/x-subrip; charset=utf-8';if(format==='srt')headers['Content-Disposition']='attachment; filename="captions.srt"';return new Response(request.method==='HEAD'?null:captions(t.segments,format),{headers});}
 const file=safeAssetPath(revisionRoot(id,revisionId),asset),info=await stat(file).catch(()=>null);if(!info||!info.isFile())fail(404,'Media is not ready');
 const ext=asset.split('.').pop()!;headers['Content-Type']=({mp4:'video/mp4',jpg:'image/jpeg',gif:'image/gif',json:'application/json',m3u8:'application/vnd.apple.mpegurl',ts:'video/mp2t',m4s:'video/iso.segment'} as Record<string,string>)[ext]||'application/octet-stream';
 if(download)headers['Content-Disposition']='attachment; filename="relay-video.mp4"';
 if(ext==='m3u8'){const text=await readFile(file,'utf8');const params=new URLSearchParams();const share=shareToken(request);if(share)params.set('share',share);if(selected)params.set('revision',selected);params.set('version',revisionId);const suffix='?'+params.toString();const rewritten=text.split('\n').map(line=>line&&!line.startsWith('#')?line+suffix:line.replace(/URI="([^"]+)"/g,(_m,uri)=>`URI="${uri}${suffix}"`)).join('\n');return new Response(request.method==='HEAD'?null:rewritten,{headers});}
 let range;try{range=byteRange(request.headers.get('range'),info.size);}catch{return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${info.size}`}});}
 headers['Accept-Ranges']='bytes';headers['Content-Length']=String(range?range.end-range.start+1:info.size);if(range)headers['Content-Range']=`bytes ${range.start}-${range.end}/${info.size}`;
 const stream=request.method==='HEAD'?null:Readable.toWeb(createReadStream(file,range||{})) as ReadableStream<Uint8Array>;return new Response(stream,{status:range?206:200,headers});
}
