import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {WatchInterval} from '../packages/core/src/analytics';

test('real playback reports played sections across a seek and exposes interval-based insights',async({page})=>{
 const base=process.env.RELAY_BROWSER_TEST_URL;test.skip(!base,'Set RELAY_BROWSER_TEST_URL to a running source build');
 const root=await mkdtemp(join(tmpdir(),'relay-analytics-browser-'));let bytes:Buffer;
 try{const path=join(root,'playback.mp4');execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=size=160x90:duration=8','-f','lavfi','-i','sine=frequency=440:duration=8','-c:v','libx264','-c:a','aac','-shortest',path]);bytes=await readFile(path);}finally{await rm(root,{recursive:true,force:true});}
 const id='11111111-1111-4111-8111-111111111111',revision='22222222-2222-4222-8222-222222222222',workspace='33333333-3333-4333-8333-333333333333',events:WatchInterval[]=[];
 const video={id,workspaceId:workspace,ownerId:'owner',title:'Playback insights',description:'',duration:8,status:'ready',publishedRevisionId:revision,createdAt:'2026-10-26T10:00:00Z'};
 await page.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname.replace('/api/v1','');let data:any={};
  if(path==='/me')data={user:{id:'owner',name:'Owner',email:'owner@example.test',isAdmin:true},workspaces:[{id:workspace,name:'Workspace',role:'owner'}]};
  else if(path==='/folders')data={folders:[]};
  else if(path===`/videos/${id}`)data={video,transcript:null,comments:[],revisions:[{id:revision,status:'ready',duration:8,createdAt:video.createdAt,edit:{clips:[],blurs:[]}}],ai:null,permissions:{edit:true,download:true},share:null};
  else if(path.endsWith('/watch-intervals')){events.push(route.request().postDataJSON());data={ok:true};}
  else if(path.endsWith('/engagement'))data={measurement:'intervals',views:2,uniqueViewers:1,knownViewers:1,anonymousViewers:0,watchSeconds:10,uniqueWatchedSeconds:5,rewatchedMediaSeconds:5,completionRate:0,revisionId:revision,from:'2026-10-01T00:00:00Z',to:'2026-10-27T00:00:00Z',reportingBasis:'sessions-started-in-range',legacy:{views:4,viewers:2,approximate:true},context:{visibility:'private',downloadsAllowed:true,downloadCount:null},bins:[{start:0,end:1,viewers:1,exitSessions:0},{start:1,end:2,viewers:0,exitSessions:2}],viewers:[{userId:'member',name:'Reviewer',sessions:2,watchSeconds:10,uniqueWatchedSeconds:5,rewatchedMediaSeconds:5,coverage:.625,completed:false,lastSeenAt:'2026-10-26T10:00:00Z'}]};
  else if(path.endsWith('/playback.mp4')){
   const range=/bytes=(\d+)-(\d*)/.exec(route.request().headers().range??'');
   const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(bytes.length-1,Number(range[2])):bytes.length-1;
   return route.fulfill({status:range?206:200,contentType:'video/mp4',headers:{'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}:{})},body:bytes.subarray(start,end+1)});
  }
  else if(path.includes('/media/'))return route.fulfill({status:404,body:'MP4 fallback'});
  await route.fulfill({json:data});
 });
 await page.goto(`${base}/videos/${id}`);await page.getByRole('button',{name:'Play',exact:true}).click();
 await expect.poll(()=>page.locator('video').evaluate(v=>(v as HTMLVideoElement).currentTime)).toBeGreaterThan(1);
 await page.getByRole('button',{name:'Pause',exact:true}).click();await expect.poll(()=>events.length).toBeGreaterThan(0);
 await page.locator('video').evaluate(v=>{(v as HTMLVideoElement).currentTime=6;});
 await expect.poll(()=>page.locator('video').evaluate(v=>(v as HTMLVideoElement).currentTime)).toBeGreaterThanOrEqual(6);
 await page.getByLabel('Playback speed',{exact:true}).selectOption('2');
 await page.getByRole('button',{name:'Play',exact:true}).click();
 await expect.poll(()=>page.locator('video').evaluate(v=>(v as HTMLVideoElement).currentTime)).toBeGreaterThan(7);
 await page.locator('video').evaluate(v=>(v as HTMLVideoElement).pause());
 await expect.poll(()=>events.some(e=>e.playbackRate===2)).toBe(true);
 expect(events.every(e=>e.end-e.start<3),JSON.stringify(events)).toBe(true);expect(events.some(e=>e.start>=6)).toBe(true);
 expect(events.every(e=>e.revisionId===revision&&e.end-e.start<=(e.wallEnd-e.wallStart)/1000*e.playbackRate+.35)).toBe(true);
 await page.getByRole('button',{name:'Insights',exact:true}).click();
 await expect(page.getByText('Completion requires 90% unique coverage. Seeking to the end does not count.')).toBeVisible();
 await expect(page.getByRole('cell',{name:'Reviewer',exact:true})).toBeVisible();
 await expect(page.getByText('4 legacy plays · approximate')).toBeVisible();
 await expect(page.getByLabel('Insight revision')).toHaveValue(revision);
 await page.locator('.engagement-panel').screenshot({path:'.context/engagement-insights.png'});
});
