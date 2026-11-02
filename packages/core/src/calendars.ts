import {oauthJSON} from './oauth-providers';
export type CalendarKind='google_calendar'|'microsoft_calendar';
export type CalendarCursor={cursor:string;windowStart?:string;windowEnd?:string};
export type CalendarEvent={externalId:string;canceled:boolean;title?:string;start?:string;end?:string;joinUrl?:string|null;provider?:string|null;allDay?:boolean};
const google='https://www.googleapis.com/calendar/v3/calendars/primary/events';
const microsoft='https://graph.microsoft.com/v1.0/me/calendarView/delta';
export function conferenceURL(raw:unknown):{url:string;provider:string}|null{
 if(typeof raw!=='string'||raw.length>4000)return null;
 try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
  const provider=(u.hostname==='zoom.us'||u.hostname.endsWith('.zoom.us'))&&/^\/j\/\d{9,11}$/.test(u.pathname)?'zoom':u.hostname==='meet.google.com'&&/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(u.pathname)?'meet':['teams.microsoft.com','teams.live.com'].includes(u.hostname)&&/^\/(l\/meetup-join|meet)\//.test(u.pathname)?'teams':null;
  return provider?{url:u.href,provider}:null;
 }catch{return null;}
}
function date(value:any,microsoft=false){
 if(value?.date&&/^\d{4}-\d{2}-\d{2}$/.test(value.date))return new Date(value.date+'T00:00:00Z').toISOString();
 let raw=value?.dateTime;if(typeof raw!=='string')throw new Error('Calendar event time is invalid.');
 if(microsoft&&!/(?:Z|[+-]\d{2}:\d{2})$/.test(raw)){if(value.timeZone!=='UTC')throw new Error('Calendar time zone is not UTC.');raw+='Z';}
 if(!/(?:Z|[+-]\d{2}:\d{2})$/.test(raw)||!Number.isFinite(Date.parse(raw)))throw new Error('Calendar event time is invalid.');return new Date(raw).toISOString();
}
export function normalizeCalendarEvent(kind:CalendarKind,item:any):CalendarEvent{
 if(typeof item?.id!=='string'||!item.id||item.id.length>2048)throw new Error('Calendar event identity is invalid.');
 if(item.status==='cancelled'||item.isCancelled||item['@removed'])return {externalId:item.id,canceled:true};
 const ms=kind==='microsoft_calendar',start=date(item.start,ms),end=date(item.end,ms);if(end<=start)throw new Error('Calendar event duration is invalid.');
 const candidate=ms?item.onlineMeeting?.joinUrl:item.conferenceData?.entryPoints?.find((p:any)=>p.entryPointType==='video')?.uri??item.hangoutLink;
 const location=ms?item.location?.displayName:item.location;
 const conference=conferenceURL(candidate)??conferenceURL(typeof location==='string'?location.trim():null);
 return {externalId:item.id,canceled:false,title:String((ms?item.subject:item.summary)??'Untitled meeting').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,200),start,end,joinUrl:conference?.url??null,provider:conference?.provider??null,allDay:ms?!!item.isAllDay:!!item.start?.date};
}
function microsoftCursor(raw:string){
 let u:URL;try{u=new URL(raw);}catch{throw new Error('Invalid calendar cursor.');}
 if(u.origin!=='https://graph.microsoft.com'||u.pathname!=='/v1.0/me/calendarView/delta'||u.username||u.password||u.hash||raw.length>16000)throw new Error('Invalid calendar cursor.');return u.href;
}
export async function calendarPage(kind:CalendarKind,token:string,checkpoint:CalendarCursor|null,page?:string,fetcher:typeof fetch=fetch):Promise<{events:CalendarEvent[];next?:string;cursor?:string;windowStart:string;windowEnd:string}>{
 const windowStart=checkpoint?.windowStart??new Date(Date.now()-30*86400000).toISOString(),windowEnd=checkpoint?.windowEnd??new Date(Date.now()+90*86400000).toISOString();
 let url:string;if(kind==='google_calendar'){
  const u=new URL(google);u.searchParams.set('singleEvents','true');u.searchParams.set('showDeleted','true');u.searchParams.set('maxResults','500');
  if(checkpoint?.cursor)u.searchParams.set('syncToken',checkpoint.cursor);else{u.searchParams.set('timeMin',windowStart);u.searchParams.set('timeMax',windowEnd);}
  if(page)u.searchParams.set('pageToken',page);url=u.href;
 }else{url=page?microsoftCursor(page):checkpoint?.cursor?microsoftCursor(checkpoint.cursor):microsoft+'?'+new URLSearchParams({startDateTime:windowStart,endDateTime:windowEnd});}
 const data=await oauthJSON(url,{headers:{Authorization:'Bearer '+token,Prefer:'outlook.timezone="UTC", IdType="ImmutableId", odata.maxpagesize=500'}},fetcher);
 const items=kind==='google_calendar'?data.items:data.value;if(!Array.isArray(items)||items.length>1000)throw new Error('Invalid calendar page.');
 const next=kind==='google_calendar'?data.nextPageToken:data['@odata.nextLink'],cursor=kind==='google_calendar'?data.nextSyncToken:data['@odata.deltaLink'];
 if((next!==undefined&&(typeof next!=='string'||!next||next.length>16000))||(cursor!==undefined&&(typeof cursor!=='string'||!cursor||cursor.length>16000))||(!next&&!cursor))throw new Error('Calendar checkpoint is missing or invalid.');
 if(kind==='microsoft_calendar'){if(next)microsoftCursor(next);if(cursor)microsoftCursor(cursor);}
 return {events:items.map(item=>normalizeCalendarEvent(kind,item)),next,cursor,windowStart,windowEnd};
}
