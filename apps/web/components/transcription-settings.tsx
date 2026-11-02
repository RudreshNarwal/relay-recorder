'use client';
import {useEffect,useState} from 'react';
import {api,json,message,type Workspace} from './api';
import {ErrorNote,Field,Spinner} from './ui';
import type {SpeechCapabilities,SpeechProvider} from '../../../packages/core/src/transcription';

type Configuration={id?:string;version?:number;provider:Exclude<SpeechProvider,'parakeet'>;model:string;region:string;enabled:boolean;configured?:boolean;verified?:boolean;workspaceIds:string[];capabilities?:SpeechCapabilities};
type Catalog=Record<SpeechProvider,{models:string[];regions:string[];capabilities:SpeechCapabilities}>;
const empty:Configuration={provider:'deepgram',model:'nova-3',region:'us',enabled:false,workspaceIds:[]};
export function TranscriptionSettings({workspaces}:{workspaces:Workspace[]}){
 const [configs,setConfigs]=useState<Configuration[]>([]),[models,setModels]=useState<Catalog|null>(null),[current,setCurrent]=useState<Configuration>(empty),[key,setKey]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 async function load(){const data=await api<{configurations:Configuration[];models:Catalog}>('/admin/transcription');setConfigs(data.configurations);setModels(data.models);return data.configurations;}
 useEffect(()=>{load().catch(e=>setError(message(e)));},[]);
 async function save(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');setNotice('');try{
  const {configuration}=await api<{configuration:Configuration}>('/admin/transcription',json('PUT',{...current,expectedVersion:current.version,...(key?{apiKey:key}:{})}));setCurrent(configuration);setKey('');await load();setNotice('Saved. Test this version before users can select it.');
 }catch(e){setError(message(e));}finally{setBusy(false);}}
 async function test(){setBusy(true);setError('');setNotice('');try{const result=await api<{ok:boolean;message:string}>('/admin/transcription/test',json('POST',{id:current.id,expectedVersion:current.version}));if(!result.ok)setError(result.message);else setNotice(result.message);const latest=await load();setCurrent(latest.find(c=>c.id===current.id)??current);}catch(e){setError(message(e));}finally{setBusy(false);}}
 return <section className="panel"><h2>Speech, on your terms.</h2><p>Parakeet stays the default. Mac Auto uses a healthy local model, otherwise your private server. External speech sends audio only after a user selects an enabled configuration.</p><ErrorNote error={error}/>{notice&&<div className="success" role="status">{notice}</div>}{!models?<Spinner/>:<>
 <Field label="Saved configuration"><select disabled={busy} value={current.id??''} onChange={e=>{setCurrent(configs.find(c=>c.id===e.target.value)??empty);setKey('');setError('');setNotice('');}}><option value="">New external provider</option>{configs.map(c=><option key={c.id} value={c.id}>{c.provider} · {c.model} · v{c.version}{c.verified?' · tested':' · test required'}</option>)}</select></Field>
 <form onSubmit={save}><Field label="Speech provider"><select value={current.provider} disabled={busy||!!current.id} onChange={e=>{const provider=e.target.value as Configuration['provider'];setCurrent({...empty,provider,model:models[provider].models[0],region:models[provider].regions[0]});setKey('');}}>{(['deepgram','assemblyai','openai'] as const).map(p=><option key={p} value={p}>{p==='assemblyai'?'AssemblyAI':p==='openai'?'OpenAI':'Deepgram'}</option>)}</select></Field>
 <div className="split-fields"><Field label="Model"><select value={current.model} disabled={busy} onChange={e=>setCurrent({...current,model:e.target.value})}>{models[current.provider].models.map(m=><option key={m}>{m}</option>)}</select></Field><Field label="Provider region"><select value={current.region} disabled={busy} onChange={e=>setCurrent({...current,region:e.target.value})}>{models[current.provider].regions.map(r=><option key={r}>{r}</option>)}</select></Field></div>
 <Field label="API key" hint={current.configured?'Leave empty to keep the encrypted key.':'Stored encrypted on your server; never returned to clients.'}><input type="password" autoComplete="new-password" value={key} onChange={e=>setKey(e.target.value)} disabled={busy}/></Field>
 <fieldset><legend>Allowed workspaces</legend>{workspaces.map(w=><label className="check" key={w.id}><input type="checkbox" disabled={busy} checked={current.workspaceIds.includes(w.id)} onChange={e=>setCurrent({...current,workspaceIds:e.target.checked?[...current.workspaceIds,w.id]:current.workspaceIds.filter(id=>id!==w.id)})}/>{w.name}</label>)}</fieldset>
 <label className="check"><input type="checkbox" checked={current.enabled} disabled={busy} onChange={e=>setCurrent({...current,enabled:e.target.checked})}/>Enable after a successful connection test</label>
 <p className="help-note">External adapters currently expose English. Parakeet supports 25 languages. OpenAI plain transcription has no timestamps; captions and word cuts require a timed model. Saving changes invalidates the previous test.</p>
 <div className="button-row"><button className="button primary" disabled={busy}>Save configuration</button><button type="button" className="button" disabled={busy||!current.id||!current.configured} onClick={test}>Test saved connection</button></div>
 <p className="help-note">The test sends a 3.1-second synthetic English clip: “Hello world. This is a transcription test.” Provider charges apply. No recording is used.</p></form></>}
 </section>;
}
