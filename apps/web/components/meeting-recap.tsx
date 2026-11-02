'use client';
import {useEffect,useState} from 'react';
import {api,json,message} from './api';
import {ErrorNote} from './ui';
type Recap={enabled:boolean;version:number;artifactId:string|null;status:string|null;error:string|null;waitingFor:string|null};
export function MeetingRecap({videoId}:{videoId:string}){
 const [data,setData]=useState<Recap|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const path=`/videos/${videoId}/meeting-recap`;
 useEffect(()=>{let live=true;const load=()=>api<Recap>(path).then(value=>{if(live)setData(value);}).catch(err=>{if(live)setError(message(err));});void load();const timer=setInterval(()=>void load(),15000);return()=>{live=false;clearInterval(timer);};},[path]);
 return <section className="panel section-gap" aria-label="Meeting recap automation"><h3>Meeting recap</h3><p className="help-note">For meetings you recorded or imported, create a private recap draft when the transcript is ready. Review decisions and actions before sharing.</p><ErrorNote error={error||data?.error||''}/><label><input type="checkbox" checked={data?.enabled??false} disabled={!data||busy} onChange={async e=>{if(!data)return;setBusy(true);setError('');try{setData(await api<Recap>(path,json('PUT',{enabled:e.target.checked,expectedVersion:data.version})));}catch(err){setError(message(err));}finally{setBusy(false);}}}/> Automatically draft a recap for each published version</label><p className="help-note" role="status">{data?.waitingFor|| (data?.artifactId?`Recap ${data.status}. Open it in Saved workflow; failed drafts can be regenerated there.`:'You can also choose Meeting recap above for a manual draft.')}</p><p className="help-note">This does not join or record a meeting. Calendar connections and automatic meeting capture are not available yet.</p></section>;
}
