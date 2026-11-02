'use client';
import {useEffect,useState} from 'react';
import type {summarizeEngagement} from '@core/analytics';
import {api,message,time,type Detail} from './api';
import {ErrorNote,Field,Spinner} from './ui';
type Engagement=ReturnType<typeof summarizeEngagement>&{revisionId:string;from:string;to:string;legacy:{views:number;viewers:number;approximate:true};actions?:{ctaId:string;presentationVersion:number;impressions:number;clicks:number}[];context:{visibility:string;downloadsAllowed:boolean;downloadCount:null}};
export function Analytics({detail}:{detail:Detail}){
 const [revision,setRevision]=useState(detail.video.publishedRevisionId??''),[range,setRange]=useState(''),[refresh,setRefresh]=useState(0),[data,setData]=useState<Engagement|null>(null),[error,setError]=useState('');
 useEffect(()=>{
  const abort=new AbortController();setError('');setData(null);
  if(revision)api<Engagement>(`/videos/${detail.video.id}/engagement?revisionId=${revision}${range}`,{signal:abort.signal}).then(setData).catch(err=>{if(!abort.signal.aborted)setError(message(err));});
  return()=>abort.abort();
 },[detail.video.id,revision,range,refresh]);
 const revisions=detail.revisions.filter(r=>r.status==='ready');
 return <section className="engagement-panel" aria-label="Recording insights"><h3>How this recording is watched</h3><p className="help-note">Completion requires 90% unique coverage. Seeking to the end does not count.</p>
  <form className="workflow-controls" onSubmit={e=>{e.preventDefault();const values=new FormData(e.currentTarget),from=String(values.get('from')),to=String(values.get('to'));if(from&&to){const end=Math.min(Date.parse(`${to}T23:59:59.999Z`),Date.now());if(!Number.isFinite(end)){setError('Choose valid dates.');return;}setRange(`&from=${encodeURIComponent(from+'T00:00:00.000Z')}&to=${encodeURIComponent(new Date(end).toISOString())}`);}else setRange('');setRefresh(n=>n+1);}}>
   <Field label="Insight revision"><select value={revision} onChange={e=>setRevision(e.target.value)}>{revisions.map((r,i)=><option key={r.id} value={r.id}>Version {revisions.length-i}{r.id===detail.video.publishedRevisionId?' · Published':''}</option>)}{!revisions.some(r=>r.id===detail.video.publishedRevisionId)&&detail.video.publishedRevisionId&&<option value={detail.video.publishedRevisionId}>Published version</option>}</select></Field>
   <Field label="From date (UTC)"><input name="from" type="date" defaultValue={new Date(Date.now()-30*86400000).toISOString().slice(0,10)}/></Field><Field label="Through date (UTC)"><input name="to" type="date" defaultValue={new Date().toISOString().slice(0,10)}/></Field><button className="button" type="submit">Apply dates / refresh</button>
  </form><ErrorNote error={error}/>
  {!data&&!error?<Spinner label="Loading verified playback intervals…"/>:data&&<>
   <p className="help-note">Sessions started {new Date(data.from).toLocaleString('en-GB',{timeZone:'UTC'})} – {new Date(data.to).toLocaleString('en-GB',{timeZone:'UTC'})} UTC. Owner previews and hidden playback are excluded.</p>
   <div className="stat-grid"><Metric value={String(data.views)} label="Playback sessions"/><Metric value={String(data.uniqueViewers)} label="Unique viewers"/><Metric value={`${Math.round(data.completionRate*100)}%`} label="Completed sessions"/><Metric value={time(data.watchSeconds)} label="Active watch time"/><Metric value={time(data.uniqueWatchedSeconds)} label="Unique media per viewer, summed"/><Metric value={time(data.rewatchedMediaSeconds)} label="Repeated media coverage"/></div>
   <h3 className="section-gap">Timeline coverage</h3><div className="analytics-bars" role="img" aria-label="Unique viewers who watched each timeline section">{data.bins.map((b,i)=><i key={i} title={`${time(b.start)}–${time(b.end)}: ${b.viewers} viewers`} style={{height:`${Math.max(1,b.viewers/Math.max(1,data.uniqueViewers)*100)}%`}}/>)}</div>
   <h3 className="section-gap">Where sessions ended</h3><div className="analytics-bars" role="img" aria-label="Last watched section per playback session">{data.bins.map((b,i)=><i key={i} title={`${time(b.start)}–${time(b.end)}: ${b.exitSessions} sessions`} style={{height:`${Math.max(1,b.exitSessions/Math.max(1,data.views)*100)}%`}}/>)}</div>
   <p className="help-note">Active watch time merges simultaneous tabs for each viewer. Repeated coverage measures replayed media seconds, including duplicate tabs. A lost anonymous cookie creates a new unknown viewer; identity is never inferred.</p>
   {!!data.actions?.length&&<><h3 className="section-gap">Calls to action</h3><div className="report-table"><table><thead><tr><th>Action</th><th>Presentation version</th><th>Impressions</th><th>Clicks</th><th>Click / impression rate</th></tr></thead><tbody>{data.actions.map(action=><tr key={`${action.ctaId}:${action.presentationVersion}`}><td>{detail.presentation?.version===action.presentationVersion?detail.presentation.ctas.find(c=>c.id===action.ctaId)?.label??action.ctaId:action.ctaId}</td><td>{action.presentationVersion}</td><td>{action.impressions}</td><td>{action.clicks}</td><td>{action.impressions?`${Math.round(action.clicks/action.impressions*100)}%`:'—'}</td></tr>)}</tbody></table></div><p className="help-note">CTA counts use UTC calendar days intersecting this range. Each action/event is counted once per page session. Clicks measure opening a destination, not purchases or downstream conversions. Missing telemetry can distort the rate.</p></>}
   <h3 className="section-gap">Known viewers</h3>{data.viewers.length?<div style={{overflowX:'auto'}}><table className="viewer-table"><thead><tr><th>Viewer</th><th>Sessions</th><th>Watch time</th><th>Coverage</th><th>Last watched (UTC)</th></tr></thead><tbody>{data.viewers.map(v=><tr key={v.userId}><td>{v.name||'Member'}</td><td>{v.sessions}</td><td>{time(v.watchSeconds)}</td><td>{Math.round(v.coverage*100)}%</td><td>{new Date(v.lastSeenAt).toLocaleString('en-GB',{timeZone:'UTC'})}</td></tr>)}</tbody></table></div>:<p className="notice">No signed-in viewers in this range.</p>}
   <p className="help-note">{data.anonymousViewers} anonymous viewers. Anonymous identities are shown only as an aggregate.</p>
   <div className="notice">{data.legacy.views} legacy plays · approximate<p className="help-note">Older clients sent point events. These are kept separate and cannot establish watch time or unique coverage.</p></div>
   <p className="help-note">Sharing: {data.context.visibility} · Shared downloads {data.context.downloadsAllowed?'allowed':'disabled'}. Download counts are unavailable. Playback telemetry is best effort and is not tamper-proof evidence.</p>
  </>}
 </section>;
}
function Metric({value,label}:{value:string;label:string}){return <div className="stat-box"><strong>{value}</strong><span>{label}</span></div>;}
