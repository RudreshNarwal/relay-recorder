'use client';
import {useEffect,useRef,useState} from 'react';
import {api,json,message} from './api';
import {useSession} from './shell';
import {ErrorNote} from './ui';
import {OAuthAccounts,type OAuthAccount} from './oauth-accounts';
type Meeting={id:string;title:string;startsAt:string;endsAt:string;joinUrl:string|null;provider:string|null;allDay:boolean;canceled:boolean;generation:number;selectedGeneration:number|null;accountStatus:string};
type Sync={accountId:string;kind:string;status:string;syncedAt:string|null;nextAt:string|null;attempts:number;error:string|null};
type Data={meetings:Meeting[];sync:Sync[];capabilities:Record<string,{available:boolean;reason:string}>};
export function MeetingsPage(){
 const {workspace}=useSession(),workspaceId=workspace?.id;
 const [data,setData]=useState<Data|null>(null),[accounts,setAccounts]=useState<OAuthAccount[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[view,setView]=useState('upcoming');
 const generation=useRef(0);
 async function load(){if(!workspaceId)return;const epoch=generation.current;const [result,grants]=await Promise.all([api<Data>(`/workspaces/${workspaceId}/meetings`),api<{accounts:OAuthAccount[]}>(`/workspaces/${workspaceId}/oauth/accounts`)]);if(epoch===generation.current){setData(result);setAccounts(grants.accounts);}}
 useEffect(()=>{generation.current++;setData(null);setError('');void load().catch(e=>setError(message(e)));const timer=setInterval(()=>void load().catch(()=>{}),15000);return()=>{generation.current++;clearInterval(timer);};},[workspaceId]);
 async function action(path:string,input:unknown){if(!workspaceId)return;setBusy(true);setError('');try{await api(`/workspaces/${workspaceId}/meetings${path}`,json('POST',input));await load();}catch(e){setError(message(e));}finally{setBusy(false);}}
 if(!workspaceId)return <main className="page-content"><p>Select a workspace first.</p></main>;
 const meetings=(data?.meetings??[]).filter(m=>view==='past'?new Date(m.endsAt).getTime()<=Date.now():new Date(m.endsAt).getTime()>Date.now()).sort((a,b)=>view==='past'?b.startsAt.localeCompare(a.startsAt):a.startsAt.localeCompare(b.startsAt));
 return <main className="page-content"><div className="page-heading"><div><div className="eyebrow">YOUR CALENDAR</div><h1>Meetings</h1><p>Your calendar, your capture choices. Calendar details are visible only to you.</p></div></div><ErrorNote error={error}/>
 <OAuthAccounts workspaceId={workspaceId} accounts={accounts} onRefresh={load} calendarsOnly/>
 <section className="panel section-gap"><h2>Calendar sync</h2><p className="help-note">Primary calendar · previous 30 days and next 90 days · checks every five minutes. Connecting a calendar never authorizes recording.</p>
 {(data?.sync??[]).map(s=><div className="row-between section-gap" key={s.accountId}><div><strong>{s.kind.replaceAll('_',' ')}</strong><p className="help-note">{s.syncedAt?`Last synced ${new Date(s.syncedAt).toLocaleString()}`:'Waiting for first sync'} · {s.status}{s.attempts>=5?' · retries stopped':''}{s.error?` · ${s.error}`:''}</p></div><button className="button" disabled={busy||s.status!=='active'} onClick={()=>action('/sync',{accountId:s.accountId})}>Sync calendar</button></div>)}
 {!data?.sync.length&&<p>Connect Google Calendar or Microsoft Calendar to see meeting occurrences.</p>}</section>
 <section className="panel section-gap"><div className="row-between"><h2>Meeting occurrences</h2><label>Show <select value={view} onChange={e=>setView(e.target.value)}><option value="upcoming">Upcoming</option><option value="past">Past</option></select></label></div>
 {meetings.map(m=>{const selected=m.selectedGeneration===m.generation,capability=m.provider?data?.capabilities[m.provider]:null;return <article className="section-gap" key={m.id}><div className="row-between"><h3>{m.title}</h3><span>{m.canceled?'Canceled':selected?'Selected for capture':'Not selected'}</span></div><p>{new Date(m.startsAt).toLocaleString()} – {new Date(m.endsAt).toLocaleTimeString()} · {m.provider??'No supported meeting link'}</p>
 {capability&&!capability.available&&<p className="help-note">{capability.reason}</p>}
 <div className="button-row">{m.joinUrl&&<a className="button" href={m.joinUrl} target="_blank" rel="noopener noreferrer">Open meeting</a>}<button className="button" disabled={busy||m.canceled||m.allDay||!m.joinUrl||m.accountStatus!=='active'||view==='past'} onClick={()=>action(`/${m.id}/select`,{expectedGeneration:m.generation,selected:!selected})}>{selected?'Remove capture selection':'Select this occurrence'}</button></div><p className="help-note">Selection applies only to this occurrence. Time or meeting-link changes require a new selection. Capture also requires a configured provider runner and host authorization.</p></article>;})}
 {!meetings.length&&<p>No {view} meetings in the synced calendar window.</p>}</section></main>;
}
