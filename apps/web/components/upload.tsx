'use client';
import { useRef, useState } from 'react';
import { UploadCloud, CheckCircle2, FileVideo } from 'lucide-react';
import { api, APIError, json, message, Video } from './api';
import { ErrorNote, Field, Modal } from './ui';
import {SpeechChoice,selfHostedSpeech} from './speech-choice';
import type {TranscriptionSelection} from '../../../packages/core/src/transcription';
export async function digest(blob: Blob): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), b => b.toString(16).padStart(2,'0')).join(''); }
export async function uploadFile(file: File, workspaceId: string, title: string, onProgress: (percent: number) => void, signal: AbortSignal, mediaKind:'video'|'audio'=(file.type.startsWith('audio/')||/\.m4a$/i.test(file.name))?'audio':'video',transcription?:TranscriptionSelection,enhanceAudio=true): Promise<Video> {
  const mimeType=mediaKind==='audio'?(/\.webm$/i.test(file.name)?'audio/webm':'audio/mp4'):(file.type||'video/mp4');
  const key = `relay-upload:${workspaceId}:${file.name}:${file.size}:${file.lastModified}${mediaKind==='audio'?':audio':''}`;
  let clientId = localStorage.getItem(key);
  if(clientId&&!localStorage.getItem(key+':speechRejected')){const saved=localStorage.getItem(key+':transcription');transcription=saved?JSON.parse(saved):undefined;}
  else if(clientId){if(transcription)localStorage.setItem(key+':transcription',JSON.stringify(transcription));else localStorage.removeItem(key+':transcription');}
  if (!clientId) {
    clientId = crypto.randomUUID(); localStorage.setItem(key, clientId);
    if(transcription)localStorage.setItem(key+':transcription',JSON.stringify(transcription));
    const capabilities = await api<{maxUploadBytes:number}>('/capabilities', {signal});
    if (file.size > capabilities.maxUploadBytes) {
      localStorage.removeItem(key);
      localStorage.removeItem(key+':transcription');
      throw new Error(`This file exceeds the server upload limit (${(capabilities.maxUploadBytes/1024**3).toFixed(2)} GiB).`);
    }
  }
  let result: {video: Video; upload: {partSize: number; maxUploadBytes:number; receivedParts: number[]}};
  try {
    result = await api('/recordings', { ...json('POST', {clientId, workspaceId, title, mediaKind, enhanceAudio, transcriptionMode:'server_api', mimeType,...(transcription?{transcription}:{})}), signal });
    localStorage.removeItem(key+':speechRejected');
  } catch(error) {
    // Only a rejected admission permits explicit reselection. Preserve identity on every failure.
    if(error instanceof APIError&&error.code==='SPEECH_CONFIGURATION_UNAVAILABLE')localStorage.setItem(key+':speechRejected','1');
    throw error;
  }
  if (file.size > result.upload.maxUploadBytes) throw new Error('This file exceeds the upload limit admitted for this recording.');
  const parts: {index:number; sha256:string; size:number}[] = []; const size = result.upload.partSize || 8388608;
  for (let offset = 0, index = 0; offset < file.size; offset += size, index++) {
    if (signal.aborted) throw new DOMException('Upload paused. Select this file again to resume.', 'AbortError');
    const part = file.slice(offset, offset + size); const sha256 = await digest(part);
    if (!result.upload.receivedParts.includes(index)) {
      for (let attempt=0; ; attempt++) {
        try { await api(`/recordings/${result.video.id}/parts/${index}`, {method:'PUT', headers:{'Content-Type':'application/octet-stream','X-Content-SHA256':sha256},body:part, signal}); break; }
        catch(err) { if(signal.aborted || attempt >= 2) throw err; await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt)); }
      }
    }
    parts.push({index,sha256,size:part.size}); onProgress(Math.min(99, Math.round((offset + part.size) / file.size * 100)));
  }
  const finished = await api<{video: Video}>(`/recordings/${result.video.id}/finalize`, {...json('POST', {parts,mimeType}), signal});
  localStorage.removeItem(key);localStorage.removeItem(key+':transcription'); onProgress(100); return finished.video;
}
export function UploadModal({ workspaceId, onClose, onComplete }: {workspaceId: string; onClose: () => void; onComplete: () => void}) {
  const [transcription,setTranscription]=useState<TranscriptionSelection>(selfHostedSpeech); const [file,setFile] = useState<File|null>(null); const [mediaKind,setMediaKind]=useState<'video'|'audio'>('video'); const [enhanceAudio,setEnhanceAudio]=useState(true); const [title,setTitle] = useState(''); const [progress,setProgress] = useState(0); const [busy,setBusy] = useState(false); const [error,setError] = useState(''); const [done,setDone] = useState<Video|null>(null); const controller = useRef<AbortController|null>(null);
  function select(selected?: File) { if(!selected) return; if(!selected.size) {setError('This file is empty. Choose MP4, MOV, WebM, or M4A media.'); return;} if(!/\.(mp4|mov|webm|m4a)$/i.test(selected.name)) {setError('Choose MP4, MOV, WebM, or M4A media.');return;} setMediaKind(selected.type.startsWith('audio/')||/\.m4a$/i.test(selected.name)?'audio':'video'); setFile(selected); setTitle(selected.name.replace(/\.[^.]+$/,'')); setError(''); }
  async function start(e: React.FormEvent) {e.preventDefault(); if(!file)return; setBusy(true); setError(''); controller.current = new AbortController(); try{const video = await uploadFile(file,workspaceId,title,setProgress,controller.current.signal,mediaKind,transcription,enhanceAudio);setDone(video);onComplete();}catch(err){setError(controller.current.signal.aborted?'Upload paused. Choose this same file to resume your progress.':message(err));}finally{setBusy(false);}}
  return <Modal title={done ? 'Your recording is on its way.' : 'Bring your recording to Relay'} onClose={() => {controller.current?.abort();onClose();}}><ErrorNote error={error} />{done ? <div style={{textAlign:'center',padding:'20px 0'}}><CheckCircle2 size={45} color="#9d7bd0" style={{marginBottom:20}} /><p className="muted" style={{fontSize:13,lineHeight:1.8}}>Upload complete. We’re preparing playback, captions, and your transcript.</p><div className="modal-footer"><button className="button" onClick={onClose}>Back to library</button><a className="button primary" href={`/videos/${done.id}`}>Open recording</a></div></div> : <form onSubmit={start}><div className="drop-zone" onDragOver={e => e.preventDefault()} onDrop={e => {e.preventDefault();if(!busy)select(e.dataTransfer.files[0]);}}>{file ? <FileVideo size={30} /> : <UploadCloud size={32} />}<strong>{file ? file.name : 'Drop a recording here'}</strong><small>{file ? `${(file.size/1048576).toFixed(1)} MB · ready to upload` : 'MP4, MOV, WebM, or M4A'}</small><input type="file" aria-label="Choose recording file" accept="video/mp4,video/quicktime,video/webm,audio/mp4,audio/webm,.mov,.m4a" disabled={busy} onChange={e => select(e.target.files?.[0])} /></div><Field label="Recording type"><select value={mediaKind} disabled={busy} onChange={e=>setMediaKind(e.target.value as 'video'|'audio')}><option value="video">Screen or camera video</option><option value="audio">Audio only</option></select></Field><SpeechChoice workspaceId={workspaceId} value={transcription} onChange={setTranscription} disabled={busy}/><label><input type="checkbox" checked={enhanceAudio} disabled={busy} onChange={e=>setEnhanceAudio(e.target.checked)}/> Enhance voice: reduce background noise and level volume</label><Field label="Give it a name"><input value={title} onChange={e => setTitle(e.target.value)} required maxLength={250} disabled={busy} placeholder="A quick walkthrough of…" /></Field>{busy && <><div className="row-between"><small>Uploading securely{progress >= 99 ? ' · finalizing…' : '…'}</small><small>{progress}%</small></div><div className="progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><span style={{width:`${progress}%`}} /></div></>}<p className="help-note">Uploads resume when you select the same file again. Your original stays on your device. A resumed upload keeps its original transcription choice.</p><div className="modal-footer">{busy ? <button className="button" type="button" onClick={() => controller.current?.abort()}>Pause upload</button> : <button className="button" type="button" onClick={onClose}>Close</button>}<button className="button primary" disabled={!file || busy}>{busy ? 'Uploading…' : 'Upload recording'}</button></div></form>}</Modal>;
}
