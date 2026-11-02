'use client';
import {useEffect,useState} from 'react';
import {api,message} from './api';
import {ErrorNote,Field} from './ui';
import type {TranscriptionSelection,SpeechCapabilities} from '../../../packages/core/src/transcription';
export type SpeechOption=TranscriptionSelection&{capabilities:SpeechCapabilities;externalAudio:boolean;region?:string};
export const selfHostedSpeech:TranscriptionSelection={execution:'server',provider:'parakeet'};
export function SpeechChoice({workspaceId,value,onChange,disabled=false}:{workspaceId:string;value:TranscriptionSelection;onChange:(s:TranscriptionSelection)=>void;disabled?:boolean}){
 const [options,setOptions]=useState<SpeechOption[]>([]),[error,setError]=useState('');
 useEffect(()=>{const abort=new AbortController();api<{transcription:SpeechOption[]}>(`/capabilities?workspaceId=${workspaceId}`,{signal:abort.signal}).then(data=>{setOptions(data.transcription.filter(s=>s.execution==='server'));setError('');}).catch(e=>{if(!abort.signal.aborted)setError(message(e));});return()=>abort.abort();},[workspaceId]);
 const key=(s:TranscriptionSelection)=>s.configurationId?`${s.configurationId}:${s.configurationVersion}`:'parakeet';
 const selected=key(value);
 const current=options.find(s=>key(s)===selected);
 return <><Field label="Transcription"><select value={selected} disabled={disabled} onChange={e=>{const selected=options.find(s=>key(s)===e.target.value);onChange(selected?{execution:selected.execution,provider:selected.provider,configurationId:selected.configurationId,configurationVersion:selected.configurationVersion}:selfHostedSpeech);}}><option value="parakeet">Parakeet · private server</option>{options.filter(s=>s.provider!=='parakeet').map(s=><option key={s.configurationId} value={key(s)}>{s.provider} · {s.model} · external audio</option>)}{selected!=='parakeet'&&!current&&<option value={selected} disabled>Previous provider unavailable · choose explicitly</option>}</select></Field><ErrorNote error={error}/><p className="help-note">{value.provider==='parakeet'?'Audio stays on your self-hosted server. Parakeet supports 25 languages.':`Audio goes to ${value.provider} only when you submit. Provider charges apply. ${current?.capabilities.timing==='none'?'This model supplies text without captions or timed word editing.':'Timing and speaker support depend on this model.'}`}</p></>;
}
