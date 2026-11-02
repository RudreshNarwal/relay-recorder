import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test.use({viewport:{width:1440,height:1050}});
test('cleanup selection, previews, undo and saved revision use the same timeline',async({page})=>{
 const base=process.env.RELAY_BROWSER_TEST_URL;test.skip(!base,'Set RELAY_BROWSER_TEST_URL to a running source build');
 const directory=await mkdtemp(join(tmpdir(),'relay-browser-cleanup-'));
 let bytes:Buffer;
 try{const path=join(directory,'preview.mp4');execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=0x30263d:size=320x180:duration=6','-f','lavfi','-i','sine=frequency=440:duration=6','-shortest','-c:v','libx264','-c:a','aac',path]);bytes=await readFile(path);}finally{await rm(directory,{recursive:true,force:true});}
 const id='11111111-1111-4111-8111-111111111111',revision='22222222-2222-4222-8222-222222222222',workspace='33333333-3333-4333-8333-333333333333';
 const video={id,workspaceId:workspace,ownerId:'owner',title:'Product update',description:'A fixture for reviewing acoustic cleanup.',duration:6,status:'ready',publishedRevisionId:revision,transcriptionMode:'on_device',createdAt:'2026-10-26T10:00:00Z'};
 const transcript={id:'transcript',revisionId:revision,version:'1',updatedAt:'2026-10-26T10:00:00Z',language:'en',status:'ready',timing:'word',segments:[{start:0,end:1,text:'Hello team',words:[{start:0,end:.4,text:'Hello'},{start:.5,end:1,text:'team'}]},{start:2,end:6,text:'Here is the update',words:[{start:2,end:6,text:'Here is the update'}]}]};
 let analysis:Record<string,unknown>|null=null,saved:any;
 await page.route('**/api/v1/**',async route=>{
  const url=new URL(route.request().url()),path=url.pathname.replace('/api/v1',''),method=route.request().method();let data:unknown={};
  if(path==='/me')data={user:{id:'owner',name:'Relay reviewer',email:'reviewer@example.test',isAdmin:true},workspaces:[{id:workspace,name:'Product team',role:'owner'}]};
  else if(path==='/folders')data={folders:[]};
  else if(path==='/videos')data={videos:[video]};
  else if(path===`/videos/${id}`)data={video,transcript,comments:[],revisions:[],ai:null,permissions:{edit:true,download:true},share:null};
  else if(path===`/videos/${id}/cleanup`){
   if(method==='POST'){
    expect(route.request().postDataJSON()).toMatchObject({expectedRevisionId:revision,expectedTranscriptVersion:'1',contextual:false});
    analysis={id:'44444444-4444-4444-8444-444444444444',revisionId:revision,transcriptVersion:'1',status:'ready',context:{status:'not_requested'},suggestions:[{id:'silence:1.225:1.775',revisionId:revision,transcriptVersion:'1',start:1.225,end:1.775,kind:'silence',confidence:'acoustic-and-energy',reason:'No speech or audible sound.'}]};
   }data={analysis};
  }else if(path===`/videos/${id}/revisions`&&method==='POST'){saved=route.request().postDataJSON();data={revision:{id:'new',status:'queued'}};}
  else if(path.endsWith('/waveform.json'))data={peaks:Array.from({length:150},(_,i)=>i>25&&i<50?.02:.5)};
  else if(path.endsWith('/playback.mp4'))return route.fulfill({status:200,contentType:'video/mp4',body:bytes});
  else if(path.endsWith('/captions.vtt'))return route.fulfill({status:200,contentType:'text/vtt',body:'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello team\n'});
  else if(path.includes('/media/'))return route.fulfill({status:404,body:'Use MP4 fixture fallback'});
  await route.fulfill({json:data});
 });
 await page.goto(`${base}/videos/${id}`);
 await page.getByRole('button',{name:'Edit',exact:true}).click();
 await page.getByRole('button',{name:'Add blur',exact:true}).click();
 await page.getByLabel('Start (seconds)',{exact:true}).fill('5');
 await page.getByLabel('End (seconds)',{exact:true}).fill('6');
 await page.getByLabel('Clip 1 start seconds').fill('2');
 await expect(page.getByLabel('Start (seconds)',{exact:true})).toHaveValue('3');
 await expect(page.getByLabel('End (seconds)',{exact:true})).toHaveValue('4');
 await page.getByRole('button',{name:'Render new version',exact:true}).click();
 await expect.poll(()=>saved?.blurs?.[0]?.start).toBe(3);
 await page.getByRole('button',{name:'Reset edit',exact:true}).click();
 await page.getByRole('button',{name:'Analyze audio',exact:true}).click();
 await page.getByRole('button',{name:'Select all',exact:true}).click();
 await page.getByRole('button',{name:'Preview before',exact:true}).click();
 await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'Play edit',exact:true}).click();
 await expect.poll(()=>page.getByRole('dialog').locator('video').evaluate(v=>(v as HTMLVideoElement).currentTime)).toBeGreaterThan(.2);await page.getByRole('button',{name:'Close dialog'}).click();
 await page.getByRole('button',{name:'Preview after',exact:true}).click();
 await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'Play edit',exact:true}).click();
 await expect.poll(()=>page.getByRole('dialog').locator('video').evaluate(v=>(v as HTMLVideoElement).currentTime)).toBeGreaterThan(1.8);await page.getByRole('button',{name:'Close dialog'}).click();
 await page.getByRole('button',{name:'Apply selected cuts to edit'}).click();
 await expect(page.getByLabel('Clip 1 end seconds')).toHaveValue('1.225');await expect(page.getByLabel('Clip 2 start seconds')).toHaveValue('1.775');
 await page.getByRole('button',{name:'Undo cleanup',exact:true}).click();await expect(page.getByLabel('Clip 1 end seconds')).toHaveValue('6');await expect(page.getByLabel('Clip 2 start seconds')).toHaveCount(0);
 await page.getByRole('button',{name:'Select all',exact:true}).click();await page.getByRole('button',{name:'Apply selected cuts to edit'}).click();
 await page.locator('.editor').screenshot({path:'.context/cleanup-editor.png'});
 await page.getByRole('button',{name:'Render new version',exact:true}).click();
 await expect.poll(()=>saved?.cleanup?.suggestionIds).toEqual(['silence:1.225:1.775']);
 expect(saved.clips.map((c:any)=>[c.start,c.end])).toEqual([[0,1.225],[1.775,6]]);
});
