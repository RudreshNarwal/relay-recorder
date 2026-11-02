import {query,transaction} from '@core/db';
import {oauthAccessToken,lockOAuthAccount} from '@core/oauth';
import {calendarPage,type CalendarKind,type CalendarEvent,type CalendarCursor} from '@core/calendars';
import {OAuthError} from '@core/oauth-providers';
/** Network reads happen under the per-calendar lock. Only complete snapshots become visible. */
export async function syncCalendar(accountId:string,onlyIfDue=false){
 try{
  const grant=await oauthAccessToken(accountId);
  if(!['google_calendar','microsoft_calendar'].includes(grant.kind))throw new Error('Not a calendar account.');
  return await transaction(async c=>{
   const state=(await c.query('SELECT * FROM calendar_sync WHERE account_id=$1 FOR UPDATE SKIP LOCKED',[accountId])).rows[0];
   if(!state||(onlyIfDue&&(state.attempts>=5||new Date(state.next_at).getTime()>Date.now())))return false;
   let checkpoint:CalendarCursor|null=state.cursor;
   if(!state.full_synced_at||Date.now()-new Date(state.full_synced_at).getTime()>7*86400000)checkpoint=null;
   let events:CalendarEvent[]=[],next:string|undefined,final:Awaited<ReturnType<typeof calendarPage>>|undefined;
   const pages=new Set<string>();let reset=false;
   for(let i=0;i<20;i++){
    try{final=await calendarPage(grant.kind as CalendarKind,grant.token,checkpoint,next);}
    catch(error){if(error instanceof OAuthError&&error.status===410&&checkpoint&&!reset){checkpoint=null;next=undefined;events=[];pages.clear();reset=true;continue;}throw error;}
    events.push(...final.events);next=final.next;if(!next)break;
    if(pages.has(next))throw new Error('Calendar pagination repeated.');pages.add(next);
   }
   if(!final||next||!final.cursor)throw new Error('Calendar exceeds the sync page limit. Narrow the primary calendar.');
   // Consent may be revoked while fetching. Never commit pages from an obsolete grant.
   await lockOAuthAccount(c,accountId,grant.version);
   const ids:string[]=[];
   for(const event of events){
    ids.push(event.externalId);
    if(event.canceled){await c.query('UPDATE meeting_instances SET canceled=true,generation=generation+1,selected_generation=NULL,updated_at=now() WHERE account_id=$1 AND external_id=$2 AND NOT canceled',[accountId,event.externalId]);continue;}
    await c.query(`INSERT INTO meeting_instances(account_id,external_id,title,starts_at,ends_at,join_url,provider,all_day)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(account_id,external_id) DO UPDATE SET
     title=$3,starts_at=$4,ends_at=$5,join_url=$6,provider=$7,all_day=$8,canceled=false,updated_at=now(),
     generation=meeting_instances.generation+CASE WHEN (meeting_instances.starts_at,meeting_instances.ends_at,meeting_instances.join_url,meeting_instances.canceled) IS DISTINCT FROM ($4::timestamptz,$5::timestamptz,$6::text,false) THEN 1 ELSE 0 END,
     selected_generation=CASE WHEN (meeting_instances.starts_at,meeting_instances.ends_at,meeting_instances.join_url,meeting_instances.canceled) IS DISTINCT FROM ($4::timestamptz,$5::timestamptz,$6::text,false) THEN NULL ELSE meeting_instances.selected_generation END`,
     [accountId,event.externalId,event.title,event.start,event.end,event.joinUrl,event.provider,event.allDay]);
   }
   if(!checkpoint)await c.query('UPDATE meeting_instances SET canceled=true,generation=generation+1,selected_generation=NULL,updated_at=now() WHERE account_id=$1 AND NOT(external_id=ANY($2::text[])) AND NOT canceled',[accountId,ids]);
   await c.query('UPDATE calendar_sync SET cursor=$2,synced_at=now(),full_synced_at=CASE WHEN $3 THEN now() ELSE full_synced_at END,next_at=now()+interval \'5 minutes\',attempts=0,error=NULL WHERE account_id=$1',[accountId,JSON.stringify({cursor:final.cursor,windowStart:final.windowStart,windowEnd:final.windowEnd}),!checkpoint]);
   return true;
  });
 }catch(error){
  await query("UPDATE calendar_sync SET attempts=LEAST(5,attempts+1),next_at=now()+(LEAST(3600,60*power(2,attempts)) * interval '1 second'),error='Calendar sync failed. Check account authorization and retry.' WHERE account_id=$1",[accountId]);throw error;
 }
}
export async function syncDueCalendars(){
 await query("INSERT INTO calendar_sync(account_id) SELECT id FROM oauth_accounts WHERE kind IN ('google_calendar','microsoft_calendar') AND status='active' ON CONFLICT DO NOTHING");
 const rows=await query("SELECT s.account_id FROM calendar_sync s JOIN oauth_accounts a ON a.id=s.account_id JOIN memberships m ON m.workspace_id=a.workspace_id AND m.user_id=a.user_id WHERE a.status='active' AND s.next_at<=now() AND s.attempts<5 ORDER BY s.next_at LIMIT 5");
 for(const row of rows)await syncCalendar(row.account_id,true).catch(()=>{});
}
