import {test,expect,type Page} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {emptyWorkflow,workflowTemplates} from '../packages/core/src/workflows';

test.use({viewport:{width:1440,height:1050}});
const id='11111111-1111-4111-8111-111111111111',revision='22222222-2222-4222-8222-222222222222',workspace='33333333-3333-4333-8333-333333333333';
const video={id,workspaceId:workspace,ownerId:'owner',title:'Product update',description:'',duration:6,status:'ready',publishedRevisionId:revision,transcriptionMode:'on_device',createdAt:'2026-10-26T10:00:00Z'};
const transcript={id:'speech',revisionId:revision,version:'1',status:'ready',text:'Review the release.',segments:[{start:0,end:1,text:'Removed introduction.'},{start:1,end:6,text:'Review the release.'}],timing:'segment'};
const connection={id:'destination',provider:'github',name:'Product issues',audience:'Private engineering team',destination:{repository:'example/product'},version:1,status:'active'};
const base=process.env.RELAY_BROWSER_TEST_URL;

async function fixture(page:Page,handle:(path:string,method:string,input:any)=>unknown,bytes?:Buffer){
 await page.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname.replace('/api/v1',''),method=route.request().method();
  let data=handle(path,method,method==='GET'?undefined:route.request().postDataJSON());
  if(data===undefined){
   if(path==='/me')data={user:{id:'owner',name:'Reviewer',email:'reviewer@example.test',isAdmin:true},workspaces:[{id:workspace,name:'Product team',role:'owner'}]};
   else if(path==='/folders')data={folders:[]};
   else if(path==='/videos')data={videos:[video]};
   else if(path===`/videos/${id}`)data={video,transcript,comments:[],revisions:[],ai:null,permissions:{edit:true,download:true},share:null};
   else if(path===`/videos/${id}/transcript`)data={transcript};
   else if(path===`/workspaces/${workspace}/workflow-templates`)data={templates:workflowTemplates,canManage:true};
   else if(path===`/workspaces/${workspace}/connections`)data={connections:[connection]};
   else if(path.endsWith('/waveform.json'))data={peaks:Array(40).fill(.5)};
   else if(path.endsWith('/playback.mp4')&&bytes){
    const range=route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    const start=range?Number(range[1]):0,end=range?.[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;
    return route.fulfill({status:range?206:200,contentType:'video/mp4',headers:{'accept-ranges':'bytes',...(range?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})},body:bytes.subarray(start,end+1)});
   }
   else if(path.includes('/media/'))return route.fulfill({status:404,body:'Fixture playback unavailable'});
   else data={};
  }
  await route.fulfill({json:data});
 });
}

test('agent drafts, recap opt-in and external delivery require a saved review',async({page})=>{
 test.skip(!base,'Set RELAY_BROWSER_TEST_URL to a running source build');
 let artifact:any,queued:any,recap:any={enabled:false,version:0,artifactId:null,status:null,error:null,waitingFor:null};
 const path=`/videos/${id}/workflows`;
 await fixture(page,(p,method,input)=>{
  if(p===path){
   if(method==='POST'){
    expect(input).toMatchObject({templateId:'agent_prompt',generate:false,expectedRevisionId:revision});
    const template=workflowTemplates.find(t=>t.id===input.templateId)!;
    artifact={id:'artifact',videoId:id,revisionId:revision,template,version:1,status:'manual',draft:emptyWorkflow(template),proposal:null};
    return {artifact};
   }return {artifacts:artifact?[artifact]:[],generationEnabled:false};
  }
  if(p===`${path}/artifact`&&method==='PATCH'){artifact={...artifact,draft:input.draft,version:2,status:'ready'};return {artifact};}
  if(p===`/videos/${id}/meeting-recap`){
   if(method==='PUT'){expect(input).toEqual({enabled:true,expectedVersion:0});recap={...recap,enabled:true,version:1,waitingFor:'Configure a cloud model to generate a recap.'};}
   return recap;
  }
  if(p===`${path}/artifact/deliveries`){
   if(method==='POST'){queued=input;return {delivery:{id:'delivery',status:'queued'}};}
   return {deliveries:[]};
  }
 });
 await page.goto(`${base}/videos/${id}`);
 await page.getByRole('button',{name:'Workflows',exact:true}).click();
 await page.getByLabel('Workflow template',{exact:true}).selectOption('agent_prompt');
 await page.getByRole('button',{name:'Create manual draft',exact:true}).click();
 await expect(page.getByLabel('Draft title',{exact:true})).toHaveValue('Agent implementation prompt');
 await page.getByLabel('Goal',{exact:true}).fill('Review the release with its source evidence.');
 await expect(page.getByRole('button',{name:'Review external delivery',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Save draft',exact:true}).click();
 await page.getByLabel('Automatically draft a recap for each published version',{exact:true}).click();
 await expect(page.getByLabel('Automatically draft a recap for each published version',{exact:true})).toBeChecked();
 await expect(page.getByText('Configure a cloud model to generate a recap.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Review external delivery',exact:true}).click();
 const dialog=page.getByRole('dialog');
 await dialog.getByLabel('Destination',{exact:true}).selectOption('destination');
 await expect(dialog).toContainText('Private engineering team');
 await expect(dialog).toContainText('Review the release with its source evidence.');
 const deliver=dialog.getByRole('button',{name:'Deliver reviewed draft',exact:true});
 await expect(deliver).toBeDisabled();
 expect(queued).toBeUndefined();
 await dialog.getByLabel('I reviewed the content, destination, and audience.',{exact:true}).check();
 await dialog.screenshot({path:'.context/reviewed-delivery.png'});
 await deliver.click();
 await expect.poll(()=>queued).toMatchObject({connectionId:'destination',expectedVersion:2,expectedRevisionId:revision,confirmed:true});
 expect(queued.idempotencyKey).toMatch(/^[a-f\d-]{36}$/);
 await expect(deliver).toBeDisabled();
});

test('Connections reconciles uncertain deliveries from a historical revision',async({page})=>{
 test.skip(!base,'Set RELAY_BROWSER_TEST_URL to a running source build');
 const oldRevision='44444444-4444-4444-8444-444444444444';let reconciled:any;
 let delivery={id:'delivery',videoId:id,revisionId:oldRevision,artifactId:'old-artifact',connectionId:connection.id,status:'uncertain',externalId:null as string|null,error:'Provider acknowledgement was lost.'};
 await fixture(page,(p,method,input)=>{
  if(p===`/workspaces/${workspace}/deliveries`)return {deliveries:[delivery]};
  if(p===`/videos/${id}/workflows/old-artifact/deliveries/delivery/reconcile`&&method==='POST'){reconciled=input;delivery={...delivery,status:'sent',externalId:input.externalId};return {delivery};}
 });
 await page.goto(`${base}/connections`);
 const history=page.getByRole('region',{name:'Delivery history',exact:true});
 await expect(history).toContainText('Revision 44444444');
 page.once('dialog',dialog=>dialog.accept('provider-item-22'));
 await history.getByRole('button',{name:'Found it at destination',exact:true}).click();
 await expect.poll(()=>reconciled).toEqual({outcome:'sent',externalId:'provider-item-22',confirmed:true});
 await expect(history).toContainText('Provider ID: provider-item-22');
 await expect(history.getByRole('button',{name:'Found it at destination',exact:true})).toHaveCount(0);
});

test('presentation preview and saved recipe retain layers after trimming',async({page})=>{
 test.skip(!base,'Set RELAY_BROWSER_TEST_URL to a running source build');
 const dir=await mkdtemp(join(tmpdir(),'relay-presentation-ui-'));let bytes:Buffer;
 try{const path=join(dir,'preview.mp4');execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=0x30263d:size=320x180:duration=6','-c:v','libx264',path]);bytes=await readFile(path);}finally{await rm(dir,{recursive:true,force:true});}
 let saved:any;
 await fixture(page,(p,method,input)=>{if(p===`/videos/${id}/revisions`&&method==='POST'){saved=input;return {revision:{id:'new',status:'queued'}};}},bytes);
 await page.goto(`${base}/videos/${id}`);
 await page.getByRole('button',{name:'Edit',exact:true}).click();
 await page.getByLabel('Canvas',{exact:true}).selectOption('portrait');
 await page.getByRole('button',{name:'Add text',exact:true}).click();
 await page.getByLabel('Layer 1 text',{exact:true}).fill('Release review');
 await page.getByLabel('Clip 1 start seconds',{exact:true}).fill('1');
 await expect(page.getByLabel('Layer 1 start',{exact:true})).toHaveValue('0');
 await expect(page.getByLabel('Layer 1 end',{exact:true})).toHaveValue('4');
 await page.getByLabel('Burn styled captions into this version',{exact:true}).check();
 await page.getByLabel('Level audio volume',{exact:true}).check();
 await page.getByLabel('Create a three-second animated thumbnail from the selected frame',{exact:true}).check();
 await page.getByRole('button',{name:'Preview edit',exact:true}).click();
 const dialog=page.getByRole('dialog'),layers=dialog.getByRole('img',{name:'Presentation preview layers',exact:true});
 await expect(layers).toContainText(/Release\s*review/);
 await expect(layers).toContainText(/Review\s*the\s*release\./);
 await expect(layers).not.toContainText('Removed');
 await expect.poll(()=>dialog.locator('video').evaluate(v=>(v as HTMLVideoElement).videoWidth)).toBe(320);
 await expect.poll(()=>dialog.locator('video').evaluate(v=>(v as HTMLVideoElement).currentTime)).toBe(1);
 await expect(dialog.locator('.presentation-stage')).toHaveCSS('aspect-ratio','180 / 320');
 await page.getByRole('button',{name:'Show before presentation',exact:true}).click();
 await expect(layers).toHaveCount(0);
 await page.getByRole('button',{name:'Show presentation',exact:true}).click();
 await expect(layers).toContainText(/Release\s*review/);
 await dialog.screenshot({path:'.context/presentation-preview.png'});
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 await page.getByRole('button',{name:'Render new version',exact:true}).click();
 await expect.poll(()=>saved?.presentation).toMatchObject({canvas:'portrait',captions:{burnIn:true},audio:{normalize:true},animatedThumbnail:true});
 expect(saved.clips[0]).toMatchObject({revisionId:revision,start:1,end:6});
 expect(saved.presentation.overlays).toEqual([expect.objectContaining({kind:'text',text:'Release review',start:0,end:4})]);
});
