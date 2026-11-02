import test from 'node:test';
import assert from 'node:assert/strict';

test('connector destinations reject arbitrary hosts, paths, headers and mention injection',async()=>{
 const {connectionSchema}=await import('../packages/core/src/connections');
 assert.equal(connectionSchema.safeParse({provider:'github',name:'Issues',audience:'Engineers',destination:{repository:'org/repo'},token:'token'}).success,true);
 for(const repository of ['org/repo/../../users','https://localhost','org/repo?x=1','org\n/repo'])assert.equal(connectionSchema.safeParse({provider:'github',name:'Issues',audience:'Team',destination:{repository},token:'token'}).success,false);
 assert.equal(connectionSchema.safeParse({provider:'slack',name:'Channel',audience:'Team',destination:{channel:'C12345'},token:'token\r\nHeader: value'}).success,false);
});

test('GitHub and Slack deliver inert drafts to fixed APIs and expose only remote IDs',async()=>{
 const {sendIntegration}=await import('../services/worker/src/integrations');
 let calls=0;
 const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{calls++;const url=String(input),data=JSON.parse(String(init?.body));assert.equal(init?.redirect,'error');
  if(url==='https://api.github.com/repos/org/repo/issues'){assert.equal(data.title,'Review');assert.match(data.body,/Acceptance/);return Response.json({id:12,number:3,html_url:'https://github.com/org/repo/issues/3'});}
  assert.equal(url,'https://slack.com/api/chat.postMessage');assert.equal(data.channel,'C12345');assert.equal(data.link_names,false);assert.equal(data.parse,'none');assert.equal(data.unfurl_links,false);assert.equal(data.blocks[0].text.type,'plain_text');return Response.json({ok:true,ts:'1.25',channel:'C12345'});
 };
 const draft={title:'Review',sections:[{heading:'Acceptance',body:'<!channel> fix bug'}]};
 const github=await sendIntegration({provider:'github',destination:{repository:'org/repo'}},'secret',draft,'request-id',fetcher);assert.equal(github.externalId,'3');
 const slack=await sendIntegration({provider:'slack',destination:{channel:'C12345'}},'secret',draft,'request-id',fetcher);assert.equal(slack.externalId,'C12345:1.25');assert.equal(calls,2);
});

test('ambiguous connector responses are not automatically retried and never disclose secrets',async()=>{
 const {sendIntegration,DeliveryError}=await import('../services/worker/src/integrations');
 const connection={provider:'github',destination:{repository:'org/repo'}},draft={title:'Review',sections:[{heading:'Body',body:'Text'}]};
 for(const fetcher of [async()=>{throw new Error('secret-token')},async()=>new Response('secret-token',{status:503}),async()=>Response.json({})]){
  await assert.rejects(sendIntegration(connection,'secret-token',draft,'request-id',fetcher),error=>error instanceof DeliveryError&&error.state==='uncertain'&&!error.message.includes('secret'));
 }
 await assert.rejects(sendIntegration(connection,'secret-token',draft,'request-id',async()=>new Response('private',{status:429})),error=>error instanceof DeliveryError&&error.state==='retry');
});

for(const provider of ['jira','confluence','linear','notion','teams','gmail','outlook'])test(`${provider} uses bounded text and the selected destination`,async()=>{
 const {sendIntegration}=await import('../services/worker/src/integrations');
 const id='11111111-1111-4111-8111-111111111111';
 const destinations:Record<string,unknown>={jira:{site:'example',email:'operator@example.test',projectKey:'REL',issueTypeId:'10001'},confluence:{site:'example',email:'operator@example.test',spaceId:'100'},linear:{teamId:id},notion:{pageId:id},teams:{teamId:id,channelId:'19:example@thread.tacv2'},gmail:{recipient:'review@example.test'},outlook:{recipient:'review@example.test'}};
 const result=await sendIntegration({provider,destination:destinations[provider]},'private-token',{title:'Review',sections:[{heading:'Text',body:'<script>alert(1)</script>'}]},id,async(input,init)=>{
  const url=new URL(String(input)),body=JSON.parse(String(init?.body));assert.equal(url.protocol,'https:');assert.ok(!url.pathname.endsWith('/send'));
  if(provider==='jira'){assert.equal(body.fields.project.key,'REL');assert.equal(body.fields.description.type,'doc');return Response.json({key:'REL-1'});}
  if(provider==='confluence'){assert.equal(body.spaceId,'100');assert.match(body.body.value,/&lt;script&gt;/);assert.doesNotMatch(body.body.value,/<script>/);}
  if(provider==='linear'){assert.equal(body.variables.input.teamId,id);return Response.json({data:{issueCreate:{success:true,issue:{id}}}});}
  if(provider==='notion')assert.equal(body.parent.page_id,id);
  if(provider==='teams'){assert.equal(body.body.contentType,'text');assert.match(url.pathname,/channels\/19%3Aexample%40thread.tacv2\/messages/);}
  if(provider==='gmail'){assert.equal(url.pathname,'/gmail/v1/users/me/drafts');assert.match(Buffer.from(body.message.raw,'base64url').toString(),/To: review@example.test/);}
  if(provider==='outlook'){assert.equal(body.toRecipients[0].emailAddress.address,'review@example.test');assert.equal(body.body.contentType,'Text');}
  return Response.json({id});
 });assert.ok(result.externalId);
});

test('OAuth deliveries use bearer grants and the authorized Atlassian cloud resource',async()=>{
 const {sendIntegration}=await import('../services/worker/src/integrations');
 const draft={title:'Review',sections:[{heading:'Summary',body:'Reviewed content'}]};
 const calls:{url:string;authorization:string|null}[]=[];
 const fetcher:typeof fetch=async(url,init)=>{calls.push({url:String(url),authorization:new Headers(init?.headers).get('authorization')});return Response.json({key:'TEAM-1',data:{issueCreate:{success:true,issue:{id:'issue'}}}});};
 await sendIntegration({provider:'jira',destination:{site:'team',email:'owner@example.test',projectKey:'TEAM',issueTypeId:'1'},oauth:true,cloudId:'11111111-1111-4111-8111-111111111111'},'oauth-token',draft,'request',fetcher);
 await sendIntegration({provider:'linear',destination:{teamId:'11111111-1111-4111-8111-111111111111'},oauth:true},'oauth-token',draft,'request',fetcher);
 assert.equal(calls[0].url,'https://api.atlassian.com/ex/jira/11111111-1111-4111-8111-111111111111/rest/api/3/issue');
 assert.ok(calls.every(c=>c.authorization==='Bearer oauth-token'));
});
