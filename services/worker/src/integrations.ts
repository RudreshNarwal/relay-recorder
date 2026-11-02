import {workflowMarkdown,type WorkflowDraft} from '@core/workflows';
import {connectionSchema} from '@core/connections';
export class DeliveryError extends Error{constructor(public state:'failed'|'uncertain'|'retry',message:string){super(message);}}
const escapeHTML=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
/** Fixed provider origins and strict destinations prevent credentials following user-supplied URLs. */
export async function sendIntegration(connection:{provider:string;destination:unknown;oauth?:boolean;cloudId?:string},token:string,draft:WorkflowDraft,requestId:string,fetcher:typeof fetch=fetch){
 const parsed=connectionSchema.safeParse({provider:connection.provider,destination:connection.destination,name:'Delivery',audience:'Reviewed',token});
 if(!parsed.success)throw new DeliveryError('failed','Connection configuration is invalid');
 const c=parsed.data,markdown=workflowMarkdown(draft);
 if(connection.oauth&&['jira','confluence'].includes(c.provider)&&! /^[a-f0-9-]{36}$/i.test(connection.cloudId??''))throw new DeliveryError('failed','Atlassian resource authorization is missing.');
 if(markdown.length>30000)throw new DeliveryError('failed','Shorten this draft to 30000 characters before delivery');
 const headers:Record<string,string>={'Content-Type':'application/json',Authorization:`Bearer ${token}`};let url='',payload:unknown;
 switch(c.provider){
  case 'github':url=`https://api.github.com/repos/${c.destination.repository}/issues${c.destination.issueNumber?`/${c.destination.issueNumber}/comments`:''}`;headers.Accept='application/vnd.github+json';headers['X-GitHub-Api-Version']='2022-11-28';payload={...(c.destination.issueNumber?{}:{title:draft.title}),body:markdown+`\n<!-- relay-delivery:${requestId} -->`};break;
  case 'slack':{
   if(markdown.length>12000)throw new DeliveryError('failed','Slack drafts must be at most 12000 characters');
   url='https://slack.com/api/chat.postMessage';const chunks=Array.from({length:Math.ceil(markdown.length/2800)},(_,i)=>markdown.slice(i*2800,(i+1)*2800));
   payload={channel:c.destination.channel,text:markdown.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),blocks:chunks.map(text=>({type:'section',text:{type:'plain_text',text,emoji:false}})),client_msg_id:requestId,parse:'none',link_names:false,mrkdwn:false,unfurl_links:false,unfurl_media:false};break;
  }
  case 'jira':url=connection.oauth?`https://api.atlassian.com/ex/jira/${connection.cloudId}/rest/api/3/issue`:`https://${c.destination.site}.atlassian.net/rest/api/3/issue`;if(!connection.oauth)headers.Authorization='Basic '+Buffer.from(`${c.destination.email}:${token}`).toString('base64');payload={fields:{project:{key:c.destination.projectKey},issuetype:{id:c.destination.issueTypeId},summary:draft.title.slice(0,255),description:{type:'doc',version:1,content:markdown.split('\n').map(line=>({type:'paragraph',content:line?[{type:'text',text:line}]:[]}))}}};break;
  case 'confluence':url=connection.oauth?`https://api.atlassian.com/ex/confluence/${connection.cloudId}/wiki/api/v2/pages`:`https://${c.destination.site}.atlassian.net/wiki/api/v2/pages`;if(!connection.oauth)headers.Authorization='Basic '+Buffer.from(`${c.destination.email}:${token}`).toString('base64');payload={spaceId:c.destination.spaceId,status:'current',title:draft.title,...(c.destination.parentId?{parentId:c.destination.parentId}:{}),body:{representation:'storage',value:markdown.split('\n').map(line=>`<p>${escapeHTML(line)||'<br />'}</p>`).join('')}};break;
  case 'linear':url='https://api.linear.app/graphql';headers.Authorization=connection.oauth?`Bearer ${token}`:token;payload={query:'mutation RelayIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }',variables:{input:{teamId:c.destination.teamId,title:draft.title,description:markdown+`\nRelay delivery: ${requestId}`}}};break;
  case 'notion':url='https://api.notion.com/v1/pages';headers['Notion-Version']='2022-06-28';payload={parent:{page_id:c.destination.pageId},properties:{title:{type:'title',title:[{type:'text',text:{content:draft.title}}]}},children:Array.from({length:Math.ceil(markdown.length/1800)},(_,i)=>({object:'block',type:'paragraph',paragraph:{rich_text:[{type:'text',text:{content:markdown.slice(i*1800,(i+1)*1800)}}]}}))};break;
  case 'teams':url=`https://graph.microsoft.com/v1.0/teams/${c.destination.teamId}/channels/${encodeURIComponent(c.destination.channelId)}/messages`;payload={body:{contentType:'text',content:markdown}};break;
  case 'gmail':url='https://gmail.googleapis.com/gmail/v1/users/me/drafts';payload={message:{raw:Buffer.from(`To: ${c.destination.recipient}\r\nSubject: =?UTF-8?B?${Buffer.from(draft.title).toString('base64')}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(markdown).toString('base64').match(/.{1,76}/g)?.join('\r\n')??''}`).toString('base64url')}};break;
  case 'outlook':url='https://graph.microsoft.com/v1.0/me/messages';payload={subject:draft.title,body:{contentType:'Text',content:markdown},toRecipients:[{emailAddress:{address:c.destination.recipient}}]};break;
 }
 let response:Response;
 try{response=await fetcher(url,{method:'POST',headers,body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new DeliveryError('uncertain','Provider acknowledgement was lost. Check the destination before reconciling.');}
 if(response.status===429){await response.body?.cancel();throw new DeliveryError('retry','Provider rate limited delivery. Retry is scheduled.');}
 if(!response.ok){await response.body?.cancel();throw new DeliveryError(response.status>=500||response.status===408?'uncertain':'failed',`Provider rejected delivery (HTTP ${response.status}). Check connection permissions and destination.`);}
 let data:any;
 try{
  const reader=response.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
  if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024){await reader.cancel();throw new Error('Response budget exceeded');}chunks.push(value);}}finally{reader.releaseLock();}
  data=JSON.parse(Buffer.concat(chunks).toString());
 }catch{throw new DeliveryError('uncertain','Provider returned no verifiable acknowledgement. Check the destination.');}
 if(c.provider==='slack'&&!data.ok)throw new DeliveryError(data.error==='ratelimited'?'retry':'failed','Slack rejected delivery. Check token, scopes and channel membership.');
 if(c.provider==='linear'&&(!data.data?.issueCreate?.success||data.errors))throw new DeliveryError('uncertain','Linear did not confirm creation. Check the destination before reconciling.');
 const externalId=c.provider==='slack'?(data.channel&&data.ts?`${data.channel}:${data.ts}`:null):c.provider==='github'?(c.destination.issueNumber?data.id:data.number):c.provider==='linear'?data.data?.issueCreate?.issue?.id:c.provider==='jira'?data.key:data.id;
 if(!['number','string'].includes(typeof externalId)||!String(externalId).length||String(externalId).length>500)throw new DeliveryError('uncertain','Provider returned no item identifier. Check the destination.');
 return {externalId:String(externalId)};
}
