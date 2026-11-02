'use client';
import {useEffect,useState} from 'react';
import {api,json,message,time,type Blur,type Clip,type Detail} from './api';
import {cleanupTimeline,type CleanupSuggestion} from '../../../packages/core/src/cleanup';
import {remapEditEffects} from './editing';
import {ErrorNote} from './ui';
import {EditPreview} from './edit-preview';
export type CleanupEdit={analysisId:string;transcriptVersion:string|null;suggestionIds:string[]};
type Analysis={id:string;revisionId:string;transcriptVersion:string|null;language:string|null;status:string;suggestions:CleanupSuggestion[];context?:{status:string;error?:string;provider?:string;model?:string};error:string|null};
export function CleanupPanel({detail,clips,blurs,expectedRevisionId,onApply,onListen}:{detail:Detail;clips:Clip[];blurs:Blur[];expectedRevisionId:string|null;onApply:(clips:Clip[],provenance:CleanupEdit,kept:{start:number;end:number}[])=>void;onListen:(time:number)=>void}){
 const [analysis,setAnalysis]=useState<Analysis|null>(null),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[contextual,setContextual]=useState(false),[english,setEnglish]=useState(detail.transcript?.language==='en'),[preview,setPreview]=useState<'before'|'after'|null>(null);
 const version=detail.transcript?.status==='ready'?detail.transcript.version??'1':null;
 const stale=expectedRevisionId!==detail.video.publishedRevisionId||!!analysis&&(analysis.revisionId!==expectedRevisionId||analysis.transcriptVersion!==version);
 const pending=busy||!!analysis&&['queued','processing'].includes(analysis.status);
 async function load(){try{const result=await api<{analysis:Analysis|null}>(`/videos/${detail.video.id}/cleanup`);setAnalysis(result.analysis);}catch(e){setError(message(e));}}
 useEffect(()=>{void load();},[detail.video.id,detail.video.publishedRevisionId]);
 useEffect(()=>{if(!analysis||!['queued','processing'].includes(analysis.status))return;const timer=setInterval(load,3000);return()=>clearInterval(timer);},[analysis?.status,detail.video.id]);
 async function analyze(){setBusy(true);setError('');setSelected([]);try{await api(`/videos/${detail.video.id}/cleanup`,json('POST',{expectedRevisionId,expectedTranscriptVersion:version,language:english?'en':null,contextual}));await load();}catch(e){setError(message(e));}finally{setBusy(false);}}
 const accepted=analysis?.suggestions.filter(s=>selected.includes(s.id))??[],timeline=cleanupTimeline(clips,detail.video.id,accepted),after=timeline.clips,afterBlurs=remapEditEffects(blurs,0,timeline.kept).blurs;
 const length=(values:Clip[])=>values.reduce((total,c)=>total+c.end-c.start,0);
 const usable=!stale&&analysis?.status==='ready'&&selected.length>0&&after.length>0&&after.length<=100&&afterBlurs.length<=50;
 return <div className="editor-section"><div className="row-between"><h4>Review pauses and filler words</h4><button className="button small" disabled={pending||expectedRevisionId!==detail.video.publishedRevisionId} onClick={analyze}>{pending?'Analyzing audio…':'Analyze audio'}</button></div>
 <p className="help-note">Uses private acoustic analysis. Quiet speech, audible sound, and transcript spans protect cuts. Suggestions are experimental; review before applying.</p>
 <label className="check help-note"><input type="checkbox" checked={english} onChange={e=>setEnglish(e.target.checked)} disabled={pending}/> Include English filler candidates with word timestamps</label>
 <label className="check help-note"><input type="checkbox" checked={contextual} onChange={e=>setContextual(e.target.checked)} disabled={pending}/> Suggest repetitions and tangents using the configured cloud AI model. Transcript text leaves this server.</label>
 <ErrorNote error={error||analysis?.error||''}/>{analysis?.context?.status==='failed'&&<p className="notice">Contextual suggestions failed: {analysis.context.error}. Acoustic suggestions remain available.</p>}{stale&&<p className="notice">Suggestions belong to an older revision or transcript. Analyze again before applying.</p>}
 {analysis?.status==='ready'&&<><p className="help-note">Before {time(length(clips))} · After {time(length(after))} · {accepted.length} selected. Cuts affect each occurrence of this source revision.</p>
 <div className="button-row"><button className="button small" disabled={stale} onClick={()=>setSelected(selected.length===analysis.suggestions.length?[]:analysis.suggestions.map(s=>s.id))}>{selected.length===analysis.suggestions.length?'Clear selection':'Select all'}</button><button className="button small" disabled={!clips.length} onClick={()=>setPreview('before')}>Preview before</button><button className="button small" disabled={!usable} onClick={()=>setPreview('after')}>Preview after</button></div>
 <div style={{maxHeight:350,overflow:'auto'}}>{analysis.suggestions.map(s=><div className="row-between" style={{padding:'8px 0'}} key={s.id}><label className="check"><input type="checkbox" disabled={stale} checked={selected.includes(s.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,s.id]:old.filter(id=>id!==s.id))}/><small>{s.kind} · {s.start.toFixed(2)}–{s.end.toFixed(2)}s</small></label><button className="button small" title={s.reason} onClick={()=>onListen(Math.max(0,s.start-.5))}>Listen in context</button></div>)}</div>
 {!analysis.suggestions.length&&<p className="help-note">No safe pause or enabled filler candidates found.</p>}{afterBlurs.length>50&&<p className="notice">Choose fewer cuts; preserving your privacy blurs would exceed 50 regions.</p>}{after.length>100&&<p className="notice">Choose fewer cuts; a revision supports at most 100 clips.</p>}
 <button className="button" disabled={!usable} onClick={()=>{onApply(after,{analysisId:analysis.id,transcriptVersion:analysis.transcriptVersion,suggestionIds:selected},timeline.kept);setSelected([]);}}>Apply selected cuts to edit</button></>}
 {preview&&<EditPreview key={preview} clips={preview==='before'?clips:after} blurs={preview==='before'?blurs:afterBlurs} onClose={()=>setPreview(null)}/>}</div>;
}
