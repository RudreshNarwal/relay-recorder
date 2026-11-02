import {test,expect} from '@playwright/test';
import {defaultBrand} from '../packages/core/src/branding';
test.use({viewport:{width:1440,height:1050}});
test('branding preview publishes explicit settings and protected logos',async({page})=>{
 const base=process.env.RELAY_BROWSER_TEST_URL;test.skip(!base,'Set RELAY_BROWSER_TEST_URL to a running source build');
 const workspace='33333333-3333-4333-8333-333333333333';let saved:any;
 await page.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname.replace('/api/v1','');let data:unknown={};
  if(path==='/me')data={user:{id:'owner',name:'Reviewer',email:'reviewer@example.test',isAdmin:true},workspaces:[{id:workspace,name:'Product team',role:'owner'}]};
  else if(path==='/folders')data={folders:[]};
  else if(path.endsWith('/assets'))data={assets:[]};
  else if(path.endsWith('/branding')){if(route.request().method()==='PUT'){saved=route.request().postDataJSON();data={settings:saved.settings,version:1};}else data={settings:defaultBrand,version:0};}
  await route.fulfill({json:data});
 });
 await page.goto(`${base}/branding?workspace=${workspace}`);
 await page.getByLabel('Display name',{exact:true}).fill('Northstar Product');
 await page.getByLabel('Header text',{exact:true}).fill('Small updates. Shared direction.');
 await page.getByLabel('Footer text',{exact:true}).fill('Questions? Bring them to your next team check-in.');
 await page.getByLabel('Thumbnail presentation',{exact:true}).selectOption('branded');
 await page.getByLabel('Show Relay credit',{exact:true}).uncheck();
 const preview=page.getByRole('region',{name:'Branding preview',exact:true});
 await expect(preview).toContainText('Northstar Product');await expect(preview.getByRole('link',{name:'Made with Relay',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Publish branding',exact:true}).click();await expect(page.getByRole('status')).toContainText('published');
 expect(saved.expectedVersion).toBe(0);expect(saved.settings.displayName).toBe('Northstar Product');
 await page.screenshot({path:'.context/customer-branding.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await expect(preview).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
test('share and embed render branded CTAs with safe navigation and deduplicated impressions',async({page})=>{
 const base=process.env.RELAY_BROWSER_TEST_URL;test.skip(!base,'Set RELAY_BROWSER_TEST_URL to a running source build');
 const id='11111111-1111-4111-8111-111111111111',revision='22222222-2222-4222-8222-222222222222',cta='44444444-4444-4444-8444-444444444444';let events:any[]=[];
 await page.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname.replace('/api/v1','');
  if(path==='/me')return route.fulfill({status:401,json:{error:'Sign in'}});
  if(path.endsWith('/cta-events')){events.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}});}
  if(path.includes('/media/'))return route.fulfill({status:404,body:'No playback needed for CTA display'});
  return route.fulfill({json:{video:{id,workspaceId:'workspace',ownerId:'owner',title:'Product update',duration:5,status:'ready',publishedRevisionId:revision,createdAt:new Date().toISOString()},branding:{...defaultBrand,displayName:'Northstar Product',headerText:'Release notes',showRelayCredit:false},presentation:{version:1,revisionId:revision,overrides:{},ctas:[{id:cta,label:'Read guide',url:'https://example.test/guide',start:0,end:5}]},transcript:null,ai:null,revisions:[],comments:[],permissions:{edit:false,download:false},share:null}});
 });
 await page.goto(`${base}/share/fixture-token`);
 await expect(page.getByText('Northstar Product',{exact:true})).toBeVisible();
 const link=page.getByRole('link',{name:'Read guide — opens example.test in a new tab',exact:true});await expect(link).toBeVisible();
 await expect(link).toHaveAttribute('target','_blank');await expect(link).toHaveAttribute('rel','noopener noreferrer');
 await expect.poll(()=>events.filter(e=>e.kind==='impression').length).toBe(1);
 await page.getByRole('button',{name:'Transcript',exact:true}).click();expect(events.filter(e=>e.kind==='impression')).toHaveLength(1);
 await page.goto(`${base}/embed/fixture-token`);await expect(link).toBeVisible();await expect(page.getByText('Northstar Product',{exact:true})).toBeVisible();
});
