'use client';
import {useEffect,useRef,useState} from 'react';
import {Download,RefreshCw} from 'lucide-react';
import {api,json,message} from './api';
import {useSession} from './shell';
import {ErrorNote,Field,Spinner} from './ui';

type Page={columns:string[];rows:Record<string,string|number|boolean|null>[];nextCursor:string|null;from:string;to:string;basis:string};
type Export={id:string;status:string;kind:string;rowCount:number|null;error:string|null;expiresAt:string};
const kinds=[['engagement','Viewer engagement'],['users','Team adoption'],['content','Recording inventory'],['operations','Processing diagnostics'],['provider_usage','Provider usage']] as const;
const label=(s:string)=>s.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase());
/** Numbers align right for scanning; identifiers stay on one line instead of wrapping mid-UUID. */
const cellKind=(value:unknown,column:string)=>typeof value==='number'?'num':/Id$/.test(column)?'id':undefined;
export function ReportsPage(){
 const {workspace,user}=useSession();
 const [kind,setKind]=useState('engagement'),[from,setFrom]=useState(new Date(Date.now()-30*86400000).toISOString().slice(0,10)),[to,setTo]=useState(new Date().toISOString().slice(0,10));
 const [page,setPage]=useState<Page|null>(null),[exports,setExports]=useState<Export[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [audit,setAudit]=useState<any[]>([]),[auditCursor,setAuditCursor]=useState<string|null>(null),[policy,setPolicy]=useState({rawDays:90,aggregateMonths:13});
 const epoch=useRef(0),scope=useRef(''),base=`/workspaces/${workspace?.id}/reports`,allowed=!!workspace&&['owner','admin'].includes(workspace.role);
 scope.current=base;
 function input(){return {kind,from:`${from}T00:00:00.000Z`,to:to===new Date().toISOString().slice(0,10)?new Date().toISOString():new Date(Date.parse(`${to}T00:00:00.000Z`)+86400000).toISOString()};}
 async function load(cursor?:string){
  const version=++epoch.current;setBusy(true);setError('');
  try{const data=await api<Page>(base+'?'+new URLSearchParams({...input(),...(cursor?{cursor}:{})}));if(version===epoch.current)setPage(data);}
  catch(err){if(version===epoch.current){setPage(null);setError(message(err));}}finally{if(version===epoch.current)setBusy(false);}
 }
 async function loadExports(){const result=await api<{exports:Export[]}>(base+'/exports');if(scope.current===base)setExports(result.exports);}
 async function loadAudit(cursor?:string){const result=await api<{events:any[];nextCursor:string|null}>(base+'/audit'+(cursor?'?cursor='+cursor:''));if(scope.current!==base)return;setAudit(old=>cursor?[...old,...result.events]:result.events);setAuditCursor(result.nextCursor);}
 useEffect(()=>{
  epoch.current++;setPage(null);setExports([]);setAudit([]);
  if(allowed){void load();void loadExports().catch(err=>setError(message(err)));void loadAudit().catch(err=>setError(message(err)));}
  if(user.isAdmin)void api<{retention:typeof policy}>('/admin/analytics-retention').then(r=>setPolicy(r.retention)).catch(err=>setError(message(err)));
  return()=>{epoch.current++;};
 },[workspace?.id,allowed]);
 useEffect(()=>{if(!exports.some(e=>e.status==='queued'))return;const timer=setInterval(()=>loadExports().catch(err=>setError(message(err))),2500);return()=>clearInterval(timer);},[exports,base]);
 if(!allowed)return <main className="page-content"><h1>Workspace reports</h1><p>Workspace owners and admins can view these reports. Recording owners can use Insights on their own recordings.</p></main>;
 return <main className="page-content reports-page"><div className="page-heading"><div><div className="eyebrow">UNDERSTAND YOUR WORKSPACE</div><h1>Workspace reports</h1><p>{workspace!.name} · all times UTC. Current workspace permissions apply to every report and download.</p></div></div>
  <ErrorNote error={error}/>
  <form className="report-filters" onSubmit={e=>{e.preventDefault();void load();}}>
   <Field label="Report"><select disabled={busy} value={kind} onChange={e=>{epoch.current++;setKind(e.target.value);setPage(null);}}>{kinds.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></Field>
   <Field label="From (UTC)"><input disabled={busy} type="date" required value={from} onChange={e=>{epoch.current++;setFrom(e.target.value);setPage(null);}}/></Field>
   <Field label="Through (UTC)"><input disabled={busy} type="date" required max={new Date().toISOString().slice(0,10)} value={to} onChange={e=>{epoch.current++;setTo(e.target.value);setPage(null);}}/></Field>
   <button className="button primary" disabled={busy}><RefreshCw size={14}/> Run report</button>
   <button className="button" type="button" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await api(base+'/exports',json('POST',input()));await loadExports();await loadAudit();}catch(err){setError(message(err));}finally{setBusy(false);}}}><Download size={14}/> Prepare CSV</button>
  </form>
  <p className="help-note">Engagement groups sessions by their start date and video revision. Completion requires 90% unique coverage. Team activity means creating a recording or credited playback. Source bytes exclude rendered copies. Usage shows returned metering; blank values and cost mean unavailable, not zero.</p>
  {busy&&!page?<Spinner label="Building report…"/>:page&&<><div className="report-table" tabIndex={0} role="region" aria-label="Report results"><table><thead><tr>{page.columns.map(column=><th key={column} className={cellKind(page.rows[0]?.[column],column)}>{label(column)}</th>)}</tr></thead><tbody>{page.rows.map((row,i)=><tr key={i}>{page.columns.map(column=><td key={column} className={cellKind(row[column],column)}>{row[column]===null?'—':typeof row[column]==='boolean'?(row[column]?'Yes':'No'):typeof row[column]==='number'?Number(row[column]).toLocaleString(undefined,{maximumFractionDigits:2}):String(row[column])}</td>)}</tr>)}</tbody></table>{!page.rows.length&&<p>No matching records.</p>}</div><div className="button-row section-gap"><button className="button" disabled={busy} onClick={()=>void load()}>First page</button><button className="button" disabled={busy||!page.nextCursor} onClick={()=>void load(page.nextCursor!)}>Next page</button><small>{page.rows.length} {(page.rows.length)===1?'row':'rows'} on this page</small></div></>}
  <section className="panel section-gap"><h2>Your CSV exports</h2><p>Up to 5,000 rows per export. Links require your account and expire after 24 hours. Access changes can require a fresh export.</p>
   {!exports.length&&<p className="help-note">Prepare a CSV from the report filters above.</p>}{exports.map(exp=><div className="revision-row" key={exp.id}><div><strong>{kinds.find(([id])=>id===exp.kind)?.[1]??exp.kind}</strong><small>{exp.status} · {exp.rowCount??'…'} rows · Expires {new Date(exp.expiresAt).toLocaleString()}</small>{exp.error&&<ErrorNote error={exp.error}/>}</div>{exp.status==='ready'&&<a className="button" href={`/api/v1${base}/exports/${exp.id}/download`} download><Download size={14}/>Download CSV</a>}</div>)}
  </section>
  <section className="panel section-gap"><h2>Activity log</h2><p className="help-note">Recorded report, membership, sharing and deletion actions. Content, passwords, tokens and transcript text are excluded. This log starts when this version is installed.</p>{audit.map(event=><div className="revision-row" key={event.id}><div><strong>{event.action}</strong><small>{event.actorId??'Deleted account / system'} · {event.objectType} {event.objectId}</small></div><small>{new Date(event.createdAt).toLocaleString()}</small></div>)}{!audit.length&&<p>No recorded actions.</p>}{auditCursor&&<button className="button" onClick={()=>loadAudit(auditCursor).catch(err=>setError(message(err)))}>Load earlier activity</button>}</section>
  {user.isAdmin&&<section className="panel section-gap"><h2>Analytics retention</h2><p>Instance-wide analytics policy. Changes take effect during worker cleanup. Recording originals, revisions and captions remain untouched.</p><form className="report-filters" onSubmit={async e=>{e.preventDefault();if(!confirm('Apply analytics retention? Expired analytics will be permanently removed during cleanup. Recording media is unaffected.'))return;setBusy(true);try{const result=await api<{retention:typeof policy}>('/admin/analytics-retention',json('PUT',policy));setPolicy(result.retention);setError('');}catch(err){setError(message(err));}finally{setBusy(false);}}}><Field label="Raw event days"><input type="number" min={1} max={365} value={policy.rawDays} onChange={e=>setPolicy({...policy,rawDays:Number(e.target.value)})}/></Field><Field label="Session aggregate months"><input type="number" min={1} max={36} value={policy.aggregateMonths} onChange={e=>setPolicy({...policy,aggregateMonths:Number(e.target.value)})}/></Field><button className="button" disabled={busy}>Save analytics policy</button></form></section>}
 </main>;
}
