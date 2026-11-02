import {queueWorkflow} from '../workflow-queue';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {requireActor,type Actor} from '../auth';
import {accessVideo,membership,lockEditableVideo} from '../access';
import {query,transaction} from '../db';
import {body,fail,json,limit,uuid} from '../http';
import {emptyWorkflow,validateWorkflow,workflowDTO,workflowMarkdown,workflowTemplates,workflowDraftSchema,workflowOutputSchema,type WorkflowTemplate} from '../workflows';
import {type AIConfig} from '../../../../services/worker/src/ai';

async function templates(workspaceId:string){
 const custom=await query('SELECT DISTINCT ON(id) definition FROM workflow_templates WHERE workspace_id=$1 ORDER BY id,version DESC LIMIT 100',[workspaceId]);
 return [...workflowTemplates,...custom.map(r=>r.definition as WorkflowTemplate)];
}
async function generationBudget(userId:string,workspaceId:string){
 await limit('workflow-generate:'+userId,20,3600);
 await limit('workflow-workspace:'+workspaceId,100,3600);
}
export async function workflows(request:Request,parts:string[],actor:Actor|null):Promise<Response|null>{
 if(parts[0]==='workspaces'&&parts[2]==='workflow-templates'&&parts.length===3){
  const user=requireActor(actor),workspaceId=uuid(parts[1]);const role=await membership(workspaceId,user,request.method!=='GET');
  if(request.method==='GET')return json({templates:await templates(workspaceId),canManage:['owner','admin'].includes(role)});
  if(request.method==='PUT'){
   const input=await body(request,z.object({id:z.uuid().optional(),expectedVersion:z.number().int().positive().optional(),name:z.string().trim().min(1).max(100),instructions:z.string().trim().min(1).max(8000),sections:z.array(z.string().trim().min(1).max(100)).min(1).max(20)}));
   if(new Set(input.sections).size!==input.sections.length)fail(400,'Template headings must be unique');
   await limit('workflow-templates:'+user.id,20,3600);
   const definition=await transaction(async c=>{
    await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId]);
    const currentRole=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[workspaceId,user.id])).rows[0]?.role;
    if(!['owner','admin'].includes(currentRole))fail(403,'Workspace access denied');
    const old=input.id?(await c.query('SELECT definition,version FROM workflow_templates WHERE id=$1 AND workspace_id=$2 ORDER BY version DESC LIMIT 1',[input.id,workspaceId])).rows[0]:undefined;
    if(input.id&&(!old||old.version!==input.expectedVersion))fail(409,'Template changed or is unavailable');
    if(!input.id&&(await c.query('SELECT count(DISTINCT id)::int AS count FROM workflow_templates WHERE workspace_id=$1',[workspaceId])).rows[0].count>=100)fail(409,'This workspace already has 100 custom templates');
    const next:WorkflowTemplate={id:input.id??randomUUID(),version:(old?.version??0)+1,workspaceId,kind:'custom',name:input.name,instructions:input.instructions,sections:input.sections,outputSchema:workflowOutputSchema(input.sections)};
    await c.query('INSERT INTO workflow_templates(id,version,workspace_id,definition) VALUES($1,$2,$3,$4)',[next.id,next.version,workspaceId,JSON.stringify(next)]);return next;
   });return json({template:definition});
  }
  return null;
 }
 if(parts[0]!=='videos'||parts[2]!=='workflows')return null;
 const user=requireActor(actor),videoId=uuid(parts[1]),{row}=await accessVideo(request,videoId,user,true);
 if(parts.length===3&&request.method==='GET'){
  const [config]=await query<{value:AIConfig}>("SELECT value FROM settings WHERE key='ai'");
  const artifacts=await query('SELECT * FROM workflow_artifacts WHERE video_id=$1 AND revision_id=$2 ORDER BY created_at DESC LIMIT 100',[videoId,row.published_revision_id]);
  return json({artifacts:artifacts.map(workflowDTO),generationEnabled:!!config?.value.enabled});
 }
 if(parts.length===3&&request.method==='POST'){
  const input=await body(request,z.object({expectedRevisionId:z.uuid(),templateId:z.string().min(1).max(100),templateVersion:z.number().int().positive(),generate:z.boolean().default(false),language:z.string().trim().min(1).max(80).optional(),tone:z.enum(['concise','professional','friendly']).default('concise')}));
  await limit('workflow-create:'+user.id,30,3600);
  if(input.generate)await generationBudget(user.id,row.workspace_id);
  const template=(await templates(row.workspace_id)).find(t=>t.id===input.templateId&&t.version===input.templateVersion);if(!template)fail(409,'Template version changed or is unavailable');
  const artifact=await transaction(async c=>{
   const current=await lockEditableVideo(c,videoId,user);
   if(current.deleted_at||current.status!=='ready'||current.published_revision_id!==input.expectedRevisionId)fail(409,'The published revision changed');
   const entry=(await c.query('INSERT INTO workflow_artifacts(video_id,revision_id,template,draft,requested_by,language,tone) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[videoId,input.expectedRevisionId,JSON.stringify(template),JSON.stringify(emptyWorkflow(template)),user.id,input.language??null,input.tone])).rows[0];
   if(input.generate)await queueWorkflow(c,entry,user);
   return(await c.query('SELECT * FROM workflow_artifacts WHERE id=$1',[entry.id])).rows[0];
  });return json({artifact:workflowDTO(artifact)},201);
 }
 const artifactId=uuid(parts[3]);
 const [artifact]=await query('SELECT * FROM workflow_artifacts WHERE id=$1 AND video_id=$2',[artifactId,videoId]);
 if(!artifact)fail(404,'Workflow not found');if(artifact.revision_id!==row.published_revision_id)fail(409,'This workflow belongs to a different published revision');
 if(parts[4]==='export'&&request.method==='GET'){
  const format=new URL(request.url).searchParams.get('format')??'markdown';if(!['markdown','json'].includes(format))fail(400,'Choose Markdown or JSON');
  return new Response(format==='json'?JSON.stringify(workflowDTO(artifact),null,2):workflowMarkdown(artifact.draft),{headers:{'Cache-Control':'no-store','Content-Type':format==='json'?'application/json':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="workflow-${artifactId}.${format==='json'?'json':'md'}"`,'X-Content-Type-Options':'nosniff'}});
 }
 if((parts.length===4&&request.method==='PATCH')||(parts[4]==='generate'&&request.method==='POST')){
  const generate=parts[4]==='generate';
  const input=await body(request,z.object({expectedVersion:z.number().int().positive(),expectedRevisionId:z.uuid().optional(),draft:workflowDraftSchema.optional(),acceptProposal:z.literal(true).optional()}));
  if(generate){await generationBudget(user.id,row.workspace_id);if(!input.expectedRevisionId)fail(428,'expectedRevisionId is required');}
  else if(!!input.draft===!!input.acceptProposal)fail(400,'Save a draft or accept a proposal');
  const updated=await transaction(async c=>{
   const current=await lockEditableVideo(c,videoId,user);
   if(current.deleted_at||current.status!=='ready'||current.published_revision_id!==artifact.revision_id||(generate&&input.expectedRevisionId!==current.published_revision_id))fail(409,'The published revision changed');
   const entry=(await c.query('SELECT * FROM workflow_artifacts WHERE id=$1 FOR UPDATE',[artifactId])).rows[0];
   if(entry.version!==input.expectedVersion)fail(409,'The draft changed. Reload before saving or generating.');
   if(generate)await queueWorkflow(c,entry,user);
   else{
    let draft;try{draft=validateWorkflow(input.acceptProposal?entry.proposal:input.draft,entry.template.sections);}catch{fail(400,'Draft must match every section of its template version');}
    await c.query("UPDATE workflow_artifacts SET draft=$2,proposal=NULL,version=version+1,user_edited=true,status=CASE WHEN status IN ('queued','processing') THEN status ELSE 'ready' END,error=NULL,updated_at=now() WHERE id=$1",[artifactId,JSON.stringify(draft)]);
   }
   return(await c.query('SELECT * FROM workflow_artifacts WHERE id=$1',[artifactId])).rows[0];
  });return json({artifact:workflowDTO(updated)},generate?202:200);
 }
 return null;
}
