import {z} from 'zod';

export type WorkflowTemplate={id:string;version:number;workspaceId:string|null;name:string;kind:string;instructions:string;sections:string[];outputSchema:Record<string,unknown>};
export type WorkflowDraft={title:string;sections:{heading:string;body:string}[]};
const definitions:[string,string,string[]][]=[
 ['sop','Standard operating procedure',['Purpose','Prerequisites','Procedure','Verification']],
 ['guide','Step-by-step guide',['Overview','Steps','Expected result']],
 ['pull_request','Pull request description',['Problem','Changes','Validation','Risks']],
 ['qa','QA test plan',['Scope','Test cases','Expected results','Open questions']],
 ['code_docs','Code documentation',['Overview','Interfaces','Examples','Limitations']],
 ['bug','Bug report',['Summary','Reproduction steps','Expected behavior','Actual behavior','Evidence']],
 ['jira','Jira issue',['Summary','Description','Acceptance criteria']],
 ['linear','Linear issue',['Summary','Description','Acceptance criteria']],
 ['slack','Slack message',['Message','Next steps']],
 ['teams','Teams message',['Message','Next steps']],
 ['email','Email draft',['Subject','Body','Next steps']],
 ['cta','Call to action draft',['Suggested label','Destination to confirm','Suggested timing','Reason']],
 ['agent_prompt','Agent implementation prompt',['Goal','Context','Steps and evidence','Expected results','Acceptance criteria','Open questions']],
 ['meeting_recap','Meeting recap',['Summary','Decisions','Action items','Evidence','Open questions']],
];
export function workflowOutputSchema(sections:string[]):Record<string,unknown>{
 return {type:'object',additionalProperties:false,required:['title','sections'],properties:{
  title:{type:'string',minLength:1,maxLength:300},
  sections:{type:'array',minItems:sections.length,maxItems:sections.length,prefixItems:sections.map(heading=>({type:'object',additionalProperties:false,required:['heading','body'],properties:{heading:{const:heading},body:{type:'string',maxLength:15000}}})),items:false},
 }};
}
export const workflowTemplates:WorkflowTemplate[]=definitions.map(([id,name,sections])=>({id,version:1,workspaceId:null,name,kind:id,sections,outputSchema:workflowOutputSchema(sections),instructions:`Create a useful ${name.toLowerCase()}. Use only supported facts. Identify unknown details as open questions.`}));
workflowTemplates.find(t=>t.id==='agent_prompt')!.instructions+=' Write a handoff for a person to review before giving it to an agent; never execute commands or imply work is complete. Number steps, give an expected result per step, cite supplied revision timestamps when available, and make acceptance criteria verifiable. Do not invent repository paths, UI interactions, screenshots or technical context absent from the evidence.';
workflowTemplates.find(t=>t.id==='meeting_recap')!.instructions+=' Separate decisions from proposals. For every action include an owner and due date only if explicit; otherwise mark them unknown. Never infer speaker identity from voice or an unlabeled transcript. Cite supplied revision timestamps when available; do not invent attendees, agreement, deadlines or quotations.';
export const workflowDraftSchema=z.object({title:z.string().trim().min(1).max(300),sections:z.array(z.object({heading:z.string().min(1).max(100),body:z.string().max(15000)}).strict()).min(1).max(20)}).strict();
export function validateWorkflow(value:unknown,sections:string[]):WorkflowDraft{
 const draft=workflowDraftSchema.parse(value);
 if(draft.sections.length!==sections.length||draft.sections.some((s,i)=>s.heading!==sections[i]))throw new Error('Workflow sections do not match this template version');
 return draft;
}
export function emptyWorkflow(template:WorkflowTemplate):WorkflowDraft{return {title:template.name,sections:template.sections.map(heading=>({heading,body:''}))};}
export function workflowMarkdown(draft:WorkflowDraft){return `# ${draft.title}\n\n${draft.sections.map(s=>`## ${s.heading}\n\n${s.body}`).join('\n\n')}\n`;}
/** Text evidence comes from the published transcript; no desktop/visual inspection is implied. */
export function workflowTranscript(template:WorkflowTemplate,text:string,segments:{start:number;end:number;text:string}[],revisionId:string){
 if(!['agent_prompt','meeting_recap'].includes(template.id)||!segments.length)return text;
 return JSON.stringify({revisionId,segments:segments.map(({start,end,text})=>({start,end,text}))});
}
export function workflowDTO(row:Record<string,any>){return {id:row.id,videoId:row.video_id,revisionId:row.revision_id,transcriptVersion:row.transcript_version,template:row.template,templateId:row.template.id,templateVersion:row.template.version,provider:row.provider,model:row.model,status:row.status,draft:row.draft,proposal:row.proposal,version:row.version,userEdited:row.user_edited,usage:row.usage,cost:row.cost,error:row.error,language:row.language,tone:row.tone,createdAt:row.created_at,updatedAt:row.updated_at};}
