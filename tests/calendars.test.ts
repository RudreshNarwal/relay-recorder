import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarPage,normalizeCalendarEvent,conferenceURL} from '../packages/core/src/calendars';

test('calendar normalization preserves occurrence identity and absolute time without importing private descriptions',()=>{
 const event=normalizeCalendarEvent('google_calendar',{id:'series_20261101T083000Z',summary:'Review',description:'private secret',start:{dateTime:'2026-11-01T01:30:00-07:00'},end:{dateTime:'2026-11-01T02:30:00-08:00'},location:'https://us02web.zoom.us/j/123456789?pwd=secret'});
 assert.equal(event.externalId,'series_20261101T083000Z');assert.equal(event.start,'2026-11-01T08:30:00.000Z');assert.equal(event.end,'2026-11-01T10:30:00.000Z');assert.equal(event.provider,'zoom');assert.equal(JSON.stringify(event).includes('description'),false);
 assert.deepEqual(normalizeCalendarEvent('google_calendar',{id:'removed',status:'cancelled'}),{externalId:'removed',canceled:true});
 assert.deepEqual(normalizeCalendarEvent('microsoft_calendar',{id:'removed','@removed':{reason:'deleted'}}),{externalId:'removed',canceled:true});
 const ms=normalizeCalendarEvent('microsoft_calendar',{id:'outlook-occurrence',subject:'Review',start:{dateTime:'2026-11-01T08:30:00.0000000',timeZone:'UTC'},end:{dateTime:'2026-11-01T09:00:00.0000000',timeZone:'UTC'},onlineMeeting:{joinUrl:'https://teams.microsoft.com/l/meetup-join/abc'}});
 assert.equal(ms.start,event.start);assert.equal(ms.provider,'teams');
 assert.throws(()=>normalizeCalendarEvent('microsoft_calendar',{id:'bad',start:{dateTime:'2026-11-01T01:30:00',timeZone:'Pacific Standard Time'},end:{dateTime:'2026-11-01T02:30:00',timeZone:'Pacific Standard Time'}}));
 for(const bad of ['http://zoom.us/j/123','https://zoom.us.evil.test/j/123','https://evil@zoom.us/j/123','https://zoom.us:444/j/123','file:///secret'])assert.equal(conferenceURL(bad),null);
});

test('calendar pages enforce fixed API origins, incremental query rules and complete checkpoints',async()=>{
 const urls:string[]=[];const fetcher:typeof fetch=async(input,init)=>{const url=String(input);urls.push(url);assert.equal(init?.redirect,'error');return Response.json({items:[],nextSyncToken:'next'});};
 const first=await calendarPage('google_calendar','token',null,undefined,fetcher);assert.equal(first.cursor,'next');assert.ok(new URL(urls[0]).searchParams.has('timeMin'));
 await calendarPage('google_calendar','token',{cursor:'old'},'page2',fetcher);const incremental=new URL(urls[1]);assert.equal(incremental.searchParams.get('syncToken'),'old');assert.equal(incremental.searchParams.get('pageToken'),'page2');assert.equal(incremental.searchParams.has('timeMin'),false);
 for(const url of ['https://evil.test/?access_token=secret','https://graph.microsoft.com/v1.0/users/other/calendarView/delta','http://graph.microsoft.com/v1.0/me/calendarView/delta'])await assert.rejects(calendarPage('microsoft_calendar','token',{cursor:url},undefined,fetcher));
 assert.equal(urls.length,2);
 await assert.rejects(calendarPage('google_calendar','token',null,undefined,async()=>Response.json({items:[]})),/checkpoint/);
 await assert.rejects(calendarPage('microsoft_calendar','token',null,undefined,async()=>Response.json({value:[],'@odata.nextLink':'https://evil.test/'})),/cursor/);
});
