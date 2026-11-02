'use client';
import {useState} from 'react';
import {api,json,message} from './api';
import type {Connection} from './connections';
import {ErrorNote} from './ui';
export type Delivery={id:string;videoId:string;revisionId:string;artifactId:string;connectionId:string;status:string;externalId:string|null;error:string|null};
export function DeliveryHistory({items,connections,onRefresh}:{items:Delivery[];connections:Connection[];onRefresh:()=>Promise<void>}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function reconcile(d:Delivery,sent:boolean){
  const externalId=sent?prompt('After checking the destination, enter the provider item ID:'):null;if(sent&&!externalId)return;
  if(!sent&&!confirm('Have you checked that no item was created? Retrying can create a duplicate if the original exists. Changed drafts or permissions will cancel the retry.'))return;
  setBusy(true);setError('');try{await api(`/videos/${d.videoId}/workflows/${d.artifactId}/deliveries/${d.id}/reconcile`,json('POST',{outcome:sent?'sent':'not_sent',...(sent?{externalId}:{}),confirmed:true}));await onRefresh();}catch(err){setError(message(err));}finally{setBusy(false);}
 }
 return <section aria-label="Delivery history"><ErrorNote error={error}/>{items.map(d=>{const connection=connections.find(c=>c.id===d.connectionId),mail=connection&&['gmail','outlook'].includes(connection.provider);return <div className="panel section-gap" key={d.id}><strong>{connection?.name??'Previous destination'} · {d.status==='sent'&&mail?'draft created':d.status}</strong><p className="help-note"><a href={`/videos/${d.videoId}`}>Recording</a> · Revision {d.revisionId.slice(0,8)}</p>{d.externalId&&<p>Provider ID: {d.externalId}</p>}{d.error&&<p>{d.error}</p>}{d.status==='uncertain'&&<div className="button-row"><button className="button" disabled={busy} onClick={()=>reconcile(d,true)}>Found it at destination</button><button className="button" disabled={busy} onClick={()=>reconcile(d,false)}>Confirmed absent: retry</button></div>}</div>;})}{!items.length&&<p className="help-note">No deliveries yet.</p>}</section>;
}
