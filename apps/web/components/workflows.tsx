'use client';
import {useEffect,useRef,useState} from 'react';
import {Copy,FileText,RefreshCw,Sparkles} from 'lucide-react';
import {workflowMarkdown,type WorkflowDraft,type WorkflowTemplate} from '@core/workflows';
import {api,json,message} from './api';
import {DeliveryReview} from './delivery-review';
import {MeetingRecap} from './meeting-recap';
import {ErrorNote,Field,Modal,Spinner} from './ui';

type Artifact={id:string;revisionId:string;template:WorkflowTemplate;version:number;status:string;draft:WorkflowDraft;proposal:WorkflowDraft|null;provider:string|null;model:string|null;usage:{inputTokens?:number;outputTokens?:number;totalTokens?:number}|null;cost:number|null;error:string|null};
type WorkflowList={artifacts:Artifact[];generationEnabled:boolean};
export function Workflows({videoId,workspaceId,revisionId,transcriptReady}:{videoId:string;workspaceId:string;revisionId:string|null;transcriptReady:boolean}){
 const [data,setData]=useState<WorkflowList|null>(null),[templates,setTemplates]=useState<WorkflowTemplate[]>([]),[templateId,setTemplateId]=useState('sop');
 const [canManage,setCanManage]=useState(false),[manage,setManage]=useState(false),[language,setLanguage]=useState(''),[tone,setTone]=useState('concise');
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState<string|null>(null),[editorDirty,setEditorDirty]=useState(false);
 const base=`/videos/${videoId}/workflows`,mounted=useRef(true),loadEpoch=useRef(0);
 async function load(){
  const epoch=++loadEpoch.current;
  const [list,catalog]=await Promise.all([api<WorkflowList>(base),api<{templates:WorkflowTemplate[];canManage:boolean}>(`/workspaces/${workspaceId}/workflow-templates`)]);
  if(!Array.isArray(list.artifacts)||!Array.isArray(catalog.templates))throw new Error('Workflow data unavailable. Refresh to try again.');
  if(!mounted.current||epoch!==loadEpoch.current)return;setData(list);setTemplates(catalog.templates);setCanManage(catalog.canManage);
  setSelected(old=>list.artifacts.some(a=>a.id===old)?old:list.artifacts[0]?.id??null);
 }
 useEffect(()=>{mounted.current=true;load().catch(err=>setError(message(err)));return()=>{mounted.current=false;};},[base,workspaceId]);
 const pending=data?.artifacts.some(a=>['queued','processing'].includes(a.status));
 useEffect(()=>{if(!pending)return;const timer=setInterval(()=>load().catch(err=>setError(message(err))),2500);return()=>clearInterval(timer);},[pending,base]);
 function update(artifact:Artifact){loadEpoch.current++;setData(old=>old?{...old,artifacts:[artifact,...old.artifacts.filter(a=>a.id!==artifact.id)]}:old);setSelected(artifact.id);}
 async function create(generate:boolean){
  if(editorDirty&&!confirm('Discard unsaved changes and create another draft?'))return;
  const template=templates.find(t=>t.id===templateId);if(!template||!revisionId)return;
  setBusy(true);setError('');try{const result=await api<{artifact:Artifact}>(base,json('POST',{expectedRevisionId:revisionId,templateId,templateVersion:template.version,generate,language:language.trim()||undefined,tone}));setEditorDirty(false);update(result.artifact);}catch(err){setError(message(err));}finally{setBusy(false);}
 }
 const current=data?.artifacts.find(a=>a.id===selected);
 return <section className="workflows" aria-label="Workflow drafts"><div className="row-between"><h3><FileText size={16}/> Turn this recording into a document</h3><button className="text-button" onClick={()=>load().then(()=>setError('')).catch(err=>setError(message(err)))}><RefreshCw size={13}/> Refresh workflows</button></div>
  <p className="help-note">Review and edit the result before sharing. Generating a draft never posts to another service.</p><ErrorNote error={error}/>
  {!data?<Spinner label="Loading workflows…"/>:<>
   {!data.generationEnabled&&<p className="notice">Cloud generation is disabled. You can still create and edit a manual draft.</p>}
   {data.generationEnabled&&!transcriptReady&&<p className="notice">Generation needs a ready, nonempty transcript. Manual drafts remain available.</p>}
   <div className="workflow-controls"><Field label="Workflow template"><select value={templateId} onChange={e=>setTemplateId(e.target.value)}>{templates.map(t=><option key={t.id} value={t.id}>{t.name}{t.workspaceId?` · v${t.version}`:''}</option>)}</select></Field><Field label="Output language" hint="Leave blank to match the transcript."><input maxLength={80} value={language} onChange={e=>setLanguage(e.target.value)} placeholder="Match transcript"/></Field><Field label="Tone"><select value={tone} onChange={e=>setTone(e.target.value)}><option value="concise">Concise</option><option value="professional">Professional</option><option value="friendly">Friendly</option></select></Field></div>
   <div className="button-row"><button className="button" disabled={busy||!revisionId} onClick={()=>create(false)}>Create manual draft</button><button className="button primary" disabled={busy||!revisionId||!data.generationEnabled||!transcriptReady} onClick={()=>create(true)}><Sparkles size={13}/>Generate draft</button>{canManage&&<button className="text-button" onClick={()=>setManage(true)}>Manage templates</button>}</div>
   {!revisionId&&<p className="help-note">Drafts become available after the recording finishes processing.</p>}
   {!!data.artifacts.length&&<div className="section-gap"><Field label="Saved workflow"><select value={selected??''} onChange={e=>{if(!editorDirty||confirm('Discard unsaved changes and open another draft?')){setEditorDirty(false);setSelected(e.target.value);}}}>{data.artifacts.map(a=><option key={a.id} value={a.id}>{a.draft.title} · {a.status}</option>)}</select></Field></div>}
   {current&&<WorkflowEditor workspaceId={workspaceId} key={current.id} artifact={current} base={base} revisionId={revisionId!} generationEnabled={data.generationEnabled&&transcriptReady} onSaved={update} onDirty={setEditorDirty}/>}
  </>}
  <MeetingRecap videoId={videoId}/>
  {manage&&<TemplateEditor templates={templates.filter(t=>!!t.workspaceId)} workspaceId={workspaceId} onClose={()=>setManage(false)} onSaved={template=>{setTemplates(old=>[...old.filter(t=>t.id!==template.id),template]);setTemplateId(template.id);setManage(false);}}/>}
 </section>;
}
function WorkflowEditor({workspaceId,artifact,base,revisionId,generationEnabled,onSaved,onDirty}:{workspaceId:string;artifact:Artifact;base:string;revisionId:string;generationEnabled:boolean;onSaved:(artifact:Artifact)=>void;onDirty:(dirty:boolean)=>void}){
 const [delivery,setDelivery]=useState(false);
 const [draft,setDraft]=useState(artifact.draft),[version,setVersion]=useState(artifact.version),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[compare,setCompare]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{if(!dirty){setDraft(artifact.draft);setVersion(artifact.version);}},[artifact.version,artifact.draft,dirty]);
 useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
 const generating=['queued','processing'].includes(artifact.status),stale=dirty&&artifact.version!==version;
 function edit(next:WorkflowDraft){setDraft(next);setDirty(true);onDirty(true);setNotice('');}
 async function save(acceptProposal=false){
  setBusy(true);setError('');try{const result=await api<{artifact:Artifact}>(`${base}/${artifact.id}`,json('PATCH',{expectedVersion:version,...(acceptProposal?{acceptProposal:true}:{draft})}));setDraft(result.artifact.draft);setVersion(result.artifact.version);setDirty(false);onDirty(false);setCompare(false);onSaved(result.artifact);setNotice('Draft saved.');}catch(err){setError(message(err));}finally{setBusy(false);}
 }
 async function generate(){setBusy(true);setError('');try{const result=await api<{artifact:Artifact}>(`${base}/${artifact.id}/generate`,json('POST',{expectedVersion:version,expectedRevisionId:revisionId}));onSaved(result.artifact);}catch(err){setError(message(err));}finally{setBusy(false);}}
 return <div className="panel section-gap" data-workflow-dirty={dirty}><div className="row-between"><h3>{artifact.template.name} <span className="badge">{artifact.status}</span></h3><small>Template v{artifact.template.version}</small></div><ErrorNote error={error||artifact.error||''}/>
  {stale&&<p className="notice">A newer version is available. Your unsaved text is preserved. Copy it before loading the saved version.</p>}
  <Field label="Draft title"><input disabled={busy} value={draft.title} maxLength={300} required onChange={e=>edit({...draft,title:e.target.value})}/></Field>
  {draft.sections.map((section,i)=><Field key={section.heading} label={section.heading}><textarea disabled={busy} rows={4} maxLength={15000} value={section.body} onChange={e=>edit({...draft,sections:draft.sections.map((s,j)=>i===j?{...s,body:e.target.value}:s)})}/></Field>)}
  <div className="button-row"><button className="button primary" disabled={busy||!dirty||stale||!draft.title.trim()} onClick={()=>save()}>Save draft</button><button className="button" disabled={busy||dirty||generating||!generationEnabled} onClick={generate}><Sparkles size={13}/>{generating?'Generating…':'Generate proposal'}</button>{artifact.proposal&&<button className="button" disabled={dirty} onClick={()=>setCompare(true)}>Compare proposal</button>}<button className="button" onClick={()=>navigator.clipboard.writeText(workflowMarkdown(draft)).then(()=>setNotice('Draft copied.')).catch(()=>setError('Clipboard unavailable. Use an export instead.'))}><Copy size={13}/>Copy Markdown</button></div>
  {dirty?<p className="help-note">Save your changes before generating or exporting.{stale&&<button className="text-button" onClick={()=>{if(confirm('Discard unsaved changes and load the saved draft?')){setDirty(false);onDirty(false);setDraft(artifact.draft);setVersion(artifact.version);}}}>Load saved version</button>}</p>:<div className="button-row section-gap"><a className="text-button" href={`/api/v1${base}/${artifact.id}/export?format=markdown`} download>Export Markdown</a><a className="text-button" href={`/api/v1${base}/${artifact.id}/export?format=json`} download>Export JSON</a></div>}
  <button className="button section-gap" disabled={dirty||generating||busy||!['ready','proposed'].includes(artifact.status)} onClick={()=>setDelivery(true)}>Review external delivery</button>
  {delivery&&<DeliveryReview workspaceId={workspaceId} base={base} artifactId={artifact.id} version={version} revisionId={revisionId} draft={draft} onClose={()=>setDelivery(false)}/>}
  {artifact.provider&&<p className="help-note">{artifact.provider} · {artifact.model}{artifact.usage?.totalTokens!==undefined?` · ${artifact.usage.totalTokens} tokens`:''} · Cost unavailable</p>}<p className="help-note" role="status">{notice}</p>
  {compare&&artifact.proposal&&<Modal title="Review the proposal" wide onClose={()=>setCompare(false)}><p>Your saved draft stays unchanged until you accept this proposal.</p><div className="workflow-comparison"><div><h3>Saved draft</h3><DocumentPreview draft={artifact.draft}/></div><div><h3>Generated proposal</h3><DocumentPreview draft={artifact.proposal}/></div></div><div className="modal-footer"><button className="button" onClick={()=>setCompare(false)}>Keep current draft</button><button className="button primary" disabled={busy} onClick={()=>save(true)}>Use this proposal</button></div></Modal>}
 </div>;
}
function DocumentPreview({draft}:{draft:WorkflowDraft}){return <article><h4>{draft.title}</h4>{draft.sections.map(s=><section key={s.heading}><h5>{s.heading}</h5><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{s.body||'—'}</p></section>)}</article>;}
function TemplateEditor({templates,workspaceId,onSaved,onClose}:{templates:WorkflowTemplate[];workspaceId:string;onSaved:(template:WorkflowTemplate)=>void;onClose:()=>void}){
 const [selected,setSelected]=useState(''),[name,setName]=useState(''),[instructions,setInstructions]=useState(''),[headings,setHeadings]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const template=templates.find(t=>t.id===selected);
 return <Modal title="Workspace templates" onClose={onClose}><p>Saving creates a new version. Existing drafts keep their original template.</p><ErrorNote error={error}/><form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{const result=await api<{template:WorkflowTemplate}>(`/workspaces/${workspaceId}/workflow-templates`,json('PUT',{id:template?.id,expectedVersion:template?.version,name,instructions,sections:headings.split('\n').map(s=>s.trim()).filter(Boolean)}));onSaved(result.template);}catch(err){setError(message(err));}finally{setBusy(false);}}}>
  <Field label="Edit template"><select value={selected} onChange={e=>{const t=templates.find(t=>t.id===e.target.value);setSelected(e.target.value);setName(t?.name??'');setInstructions(t?.instructions??'');setHeadings(t?.sections.join('\n')??'');}}><option value="">New template</option>{templates.map(t=><option key={t.id} value={t.id}>{t.name} · v{t.version}</option>)}</select></Field><Field label="Template name"><input required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></Field><Field label="Template instructions"><textarea required maxLength={8000} value={instructions} onChange={e=>setInstructions(e.target.value)}/></Field><Field label="Section headings, one per line" hint="1–20 unique headings, each up to 100 characters."><textarea required maxLength={2020} value={headings} onChange={e=>setHeadings(e.target.value)}/></Field><div className="modal-footer"><button className="button primary" disabled={busy}>Save template version</button></div></form></Modal>;
}
