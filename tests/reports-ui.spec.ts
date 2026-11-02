import {test,expect} from '@playwright/test';
test.use({viewport:{width:1440,height:1050}});
test('workspace reports filter, paginate and prepare protected exports',async({page})=>{
 const base=process.env.RELAY_BROWSER_TEST_URL;test.skip(!base,'Set RELAY_BROWSER_TEST_URL to a running source build');
 const workspace='33333333-3333-4333-8333-333333333333';let exports:any[]=[],lastRequest:any;
 await page.route('**/api/v1/**',async route=>{
  const url=new URL(route.request().url()),path=url.pathname.replace('/api/v1',''),method=route.request().method();let data:any={};
  if(path==='/me')data={user:{id:'owner',name:'Reviewer',email:'reviewer@example.test',isAdmin:true},workspaces:[{id:workspace,name:'Product team',role:'owner'}]};
  else if(path==='/folders')data={folders:[]};
  else if(path==='/admin/analytics-retention')data={retention:{rawDays:90,aggregateMonths:13}};
  else if(path.endsWith('/audit'))data={events:[{id:'1',actorId:'owner',action:'report.requested',objectType:'report',objectId:'fixture-export',createdAt:new Date().toISOString()}],nextCursor:null};
  else if(path.endsWith('/exports')){
   if(method==='POST'){lastRequest=route.request().postDataJSON();exports=[{id:'export',kind:lastRequest.kind,status:'ready',rowCount:1,expiresAt:new Date(Date.now()+86400000).toISOString()}];data={export:exports[0]};}else data={exports};
  }else if(path.endsWith('/reports')){
   const next=url.searchParams.has('cursor');data={columns:['title','views','watchSeconds','completionRate'],rows:[{title:next?'Customer onboarding':'Product walkthrough',views:next?3:12,watchSeconds:135,completionRate:.75}],nextCursor:next?null:'next',from:url.searchParams.get('from'),to:url.searchParams.get('to')};
  }
  await route.fulfill({json:data});
 });
 await page.goto(`${base}/reports?workspace=${workspace}`);
 await expect(page.getByRole('heading',{name:'Workspace reports',exact:true})).toBeVisible();
 await expect(page.getByRole('cell',{name:'Product walkthrough',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Next page',exact:true}).click();await expect(page.getByRole('cell',{name:'Customer onboarding',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Next page',exact:true})).toBeDisabled();
 await page.getByLabel('Report',{exact:true}).selectOption('users');
 await page.getByRole('button',{name:'Run report',exact:true}).click();
 await page.getByRole('button',{name:'Prepare CSV',exact:true}).click();
 await expect(page.getByRole('link',{name:'Download CSV',exact:true})).toHaveAttribute('href',`/api/v1/workspaces/${workspace}/reports/exports/export/download`);expect(lastRequest.kind).toBe('users');
 await expect(page.getByText('report.requested',{exact:true})).toBeVisible();
 await page.screenshot({path:'.context/workspace-reports.png',fullPage:true});
});
