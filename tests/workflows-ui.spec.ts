import {test,expect} from '@playwright/test';
import {workflowTemplates} from '../packages/core/src/workflows';

test.use({viewport:{width:1440,height:1050}});
for(const enabled of [false,true])test(`workflow editor keeps manual drafts and reviews proposals (AI ${enabled?'enabled':'disabled'})`,async({page})=>{
 const base=process.env.RELAY_BROWSER_TEST_URL;test.skip(!base,'Set RELAY_BROWSER_TEST_URL to a running source build');
 const id='11111111-1111-4111-8111-111111111111',revision='22222222-2222-4222-8222-222222222222',workspace='33333333-3333-4333-8333-333333333333';
 const video={id,workspaceId:workspace,ownerId:'owner',title:'Product update',description:'',duration:6,status:'ready',publishedRevisionId:revision,transcriptionMode:'on_device',createdAt:'2026-10-26T10:00:00Z'};
 let artifacts:any[]=[],templates=[...workflowTemplates],lastCreate:any,releaseSave:(()=>void)|undefined;let pauseSave=enabled;
 await page.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname.replace('/api/v1',''),method=route.request().method();let data:unknown={};
  if(path==='/me')data={user:{id:'owner',name:'Reviewer',email:'reviewer@example.test',isAdmin:true},workspaces:[{id:workspace,name:'Product team',role:'owner'}]};
  else if(path==='/folders')data={folders:[]};
  else if(path===`/videos/${id}`)data={video,transcript:{id:'speech',revisionId:revision,version:'1',status:'ready',text:'Check tests before deploying.',segments:[],timing:'none'},comments:[],revisions:[],ai:null,permissions:{edit:true,download:true},share:null};
  else if(path===`/workspaces/${workspace}/workflow-templates`){
   if(method==='PUT'){
    const input=route.request().postDataJSON();const template={...input,id:'custom',version:1,workspaceId:workspace,kind:'custom',outputSchema:{}};templates.push(template);data={template};
   }else data={templates,canManage:true};
  }else if(path===`/videos/${id}/workflows`){
   if(method==='POST'){
    lastCreate=route.request().postDataJSON();const template=templates.find(t=>t.id===lastCreate.templateId)!;
    artifacts.unshift({id:'artifact',videoId:id,revisionId:revision,template,version:1,status:'manual',draft:{title:template.name,sections:template.sections.map(heading=>({heading,body:''}))},proposal:null,usage:null,provider:null,model:null});data={artifact:artifacts[0]};
   }else data={artifacts,generationEnabled:enabled};
  }else if(path===`/videos/${id}/workflows/artifact`&&method==='PATCH'){
   const input=route.request().postDataJSON();expect(input.expectedVersion).toBe(artifacts[0].version);
   artifacts[0]={...artifacts[0],draft:input.acceptProposal?artifacts[0].proposal:input.draft,version:artifacts[0].version+1,proposal:null,status:'ready',userEdited:true};data={artifact:artifacts[0]};
  }else if(path.endsWith('/artifact/generate')){
   expect(route.request().postDataJSON()).toEqual({expectedVersion:artifacts[0].version,expectedRevisionId:revision});
   artifacts[0]={...artifacts[0],version:artifacts[0].version+1,status:'proposed',provider:'openai',model:'test',usage:{totalTokens:20},proposal:{...artifacts[0].draft,title:'Generated release guide'}};data={artifact:artifacts[0]};
  }else if(path.includes('/media/'))return route.fulfill({status:404,body:'No playback fixture needed'});
  if(path===`/videos/${id}/workflows/artifact`&&method==='PATCH'&&pauseSave){pauseSave=false;await new Promise<void>(resolve=>{releaseSave=resolve;});}
  await route.fulfill({json:data});
 });
 await page.goto(`${base}/videos/${id}`);
 await page.getByRole('button',{name:'Workflows',exact:true}).click();
 if(!enabled)await expect(page.getByText('Cloud generation is disabled. You can still create and edit a manual draft.')).toBeVisible();
 await page.getByLabel('Workflow template',{exact:true}).selectOption('guide');
 await page.getByLabel('Output language',{exact:true}).fill('English');
 await page.getByLabel('Tone',{exact:true}).selectOption('friendly');
 await page.getByRole('button',{name:'Create manual draft',exact:true}).click();
 await expect(page.getByLabel('Draft title',{exact:true})).toHaveValue('Step-by-step guide');
 expect(lastCreate).toMatchObject({expectedRevisionId:revision,templateId:'guide',templateVersion:1,generate:false,language:'English',tone:'friendly'});
 await page.getByLabel('Draft title',{exact:true}).fill('Human release guide');
 await page.getByLabel('Overview',{exact:true}).fill('Check tests before deploying.');
 await page.getByRole('button',{name:'Transcript',exact:true}).click();
 await page.getByRole('button',{name:'Workflows',exact:true}).click();
 await expect(page.getByLabel('Draft title',{exact:true})).toHaveValue('Human release guide');
 await expect(page.getByLabel('Overview',{exact:true})).toHaveValue('Check tests before deploying.');
 await page.getByRole('button',{name:'Save draft',exact:true}).click();
 if(enabled){await expect(page.getByLabel('Draft title',{exact:true})).toBeDisabled();releaseSave!();}
 await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeDisabled();
 if(enabled){
  await page.getByRole('button',{name:'Generate proposal',exact:true}).click();
  await expect(page.getByLabel('Draft title',{exact:true})).toHaveValue('Human release guide');
  await page.getByRole('button',{name:'Compare proposal',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('Human release guide');
  await expect(page.getByRole('dialog')).toContainText('Generated release guide');
  await page.getByRole('button',{name:'Use this proposal',exact:true}).click();
  await expect(page.getByLabel('Draft title',{exact:true})).toHaveValue('Generated release guide');
 }else await expect(page.getByRole('button',{name:'Generate proposal',exact:true})).toBeDisabled();
 await expect(page.getByRole('link',{name:'Export Markdown',exact:true})).toHaveAttribute('href',`/api/v1/videos/${id}/workflows/artifact/export?format=markdown`);
 await page.getByRole('button',{name:'Manage templates',exact:true}).click();
 await page.getByLabel('Template name',{exact:true}).fill('Release checklist');
 await page.getByLabel('Template instructions',{exact:true}).fill('Use only facts from this recording.');
 await page.getByLabel('Section headings, one per line',{exact:true}).fill('Preparation\nRelease\nVerification');
 await page.getByRole('button',{name:'Save template version',exact:true}).click();
 await expect(page.getByLabel('Workflow template',{exact:true})).toHaveValue('custom');
 if(enabled)await page.locator('.workflows').screenshot({path:'.context/workflow-editor.png'});
});
