import {syncDueCalendars} from './calendars';
import {retainAnalytics} from './analytics';
import {queueMeetingRecaps} from './meeting-recap';
import {deliverNotificationEmails} from './notifications';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { closeDatabase, query } from '@core/db';
import { claimJob, executeJob, reapExpiredJobs } from './jobs';
const raw=Number(process.env.WORKER_CONCURRENCY??2);
const concurrency=Number.isInteger(raw)?Math.min(8,Math.max(1,raw)):2;
let stopping=false;process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
async function lane(){while(!stopping){try{const job=await claimJob(randomUUID());if(job)await executeJob(job);else await delay(1000);}catch{console.error('Worker database unavailable; retrying');await delay(5000);}}}
const reaper=setInterval(()=>void reapExpiredJobs().catch(()=>console.error('Job lease recovery unavailable')),30_000);reaper.unref();
async function heartbeat(){
 if(!process.env.WORKER_HEARTBEAT_PATH)return;
 await query('SELECT 1');
 await writeFile(process.env.WORKER_HEARTBEAT_PATH, new Date().toISOString(), {mode:0o600});
}
await retainAnalytics();
// One scheduler at a time per process; database locks fence multiple processes.
let scheduling=false;
async function scheduleRecaps(){if(scheduling||stopping)return;scheduling=true;try{await queueMeetingRecaps();}catch{console.error('Meeting recap scheduling unavailable');}finally{scheduling=false;}}
const recaps=setInterval(()=>void scheduleRecaps(),15000);recaps.unref();await scheduleRecaps();
let syncing=false;
async function syncCalendars(){if(syncing||stopping)return;syncing=true;try{await syncDueCalendars();}catch{console.error('Calendar synchronization unavailable');}finally{syncing=false;}}
const calendars=setInterval(()=>void syncCalendars(),30000);calendars.unref();void syncCalendars();
let mailing=false;
async function mailNotifications(){if(mailing||stopping)return;mailing=true;try{while(!stopping&&await deliverNotificationEmails()===20);}catch{console.error('Notification email delivery unavailable');}finally{mailing=false;}}
const mailer=setInterval(()=>void mailNotifications(),5000);mailer.unref();
const retention=setInterval(()=>void retainAnalytics().catch(()=>console.error('Analytics retention unavailable')),60000);retention.unref();
await heartbeat();
const health=setInterval(()=>void heartbeat().catch(()=>{}),30_000);health.unref();
await Promise.all(Array.from({length:concurrency},()=>lane()));clearInterval(calendars);clearInterval(mailer);clearInterval(recaps);clearInterval(retention);clearInterval(reaper);clearInterval(health);await closeDatabase();
