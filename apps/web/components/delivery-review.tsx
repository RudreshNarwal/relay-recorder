'use client';
import {useEffect,useState} from 'react';
import {workflowMarkdown,type WorkflowDraft} from '@core/workflows';
import {api,json,message} from './api';
import type {Connection} from './connections';
import {ErrorNote,Field,Modal} from './ui';
import {DeliveryHistory,type Delivery} from './delivery-history';
export function DeliveryReview({workspaceId,base,artifactId,version,revisionId,draft,onClose}:{workspaceId:string;base:string;artifactId:string;version:number;revisionId:string;draft:WorkflowDraft;onClose:()=>void}){
 const [connections,setConnections]=useState<Connection[]>([]),[deliveries,setDeliveries]=useState<Delivery[]>([]),[selected,setSelected]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[key,setKey]=useState(()=>crypto.randomUUID());
 const path=`${base}/${artifactId}/deliveries`,connection=connections.find(c=>c.id===selected);
 async function refresh(){const r=await api<{deliveries:Delivery[]}>(path);setDeliveries(r.deliveries);}
 useEffect(()=>{let live=true;api<{connections:Connection[]}>(`/workspaces/${workspaceId}/connections`).then(r=>{if(live)setConnections(r.connections);}).catch(err=>setError(message(err)));void refresh().catch(err=>setError(message(err)));const timer=setInterval(()=>void refresh().catch(err=>setError(message(err))),3000);return()=>{live=false;clearInterval(timer);};},[workspaceId,path]);

 return <Modal title="Review external delivery" onClose={onClose} wide><ErrorNote error={error}/><Field label="Destination"><select value={selected} onChange={e=>{setSelected(e.target.value);setConfirmed(false);setKey(crypto.randomUUID());}}><option value="">Choose a destination</option>{connections.filter(c=>c.status==='active').map(c=><option key={c.id} value={c.id}>{c.name} · {c.provider}</option>)}</select></Field>{!connections.length&&<p>Ask a workspace administrator to configure a destination in Connections.</p>}
 {connection&&<p className="notice">Audience: {connection.audience}. Destination: {JSON.stringify(connection.destination)}. {['gmail','outlook'].includes(connection.provider)?'This creates a draft in the connected mailbox. It does not send email.':'This creates content in the external service.'}</p>}
 <pre className="delivery-preview">{workflowMarkdown(draft)}</pre><p className="help-note">Only this saved draft is sent. Video access stays unchanged. Removing Relay access cannot retract text copied into another service.</p><label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> I reviewed the content, destination, and audience.</label><div className="modal-footer"><button className="button primary" disabled={busy||!connection||!confirmed} onClick={async()=>{setBusy(true);setError('');try{await api(path,json('POST',{connectionId:selected,expectedVersion:version,expectedRevisionId:revisionId,idempotencyKey:key,confirmed:true}));setConfirmed(false);setKey(crypto.randomUUID());await refresh();}catch(err){setError(message(err));}finally{setBusy(false);}}}>{busy?'Queuing…':connection&&['gmail','outlook'].includes(connection.provider)?'Create external draft':'Deliver reviewed draft'}</button></div>
 <h3>Delivery history</h3><DeliveryHistory items={deliveries} connections={connections} onRefresh={refresh}/>
 </Modal>;
}
