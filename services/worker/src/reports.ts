import type {Job} from './jobs';
import {withLease} from './lease';
import {PermanentError} from './media';
import {HttpError} from '@core/http';
import {reportAccess,reportInput,reportPage,csvCell} from '@core/reports';

export async function buildReport(job:Job){
 try{await withLease(job,async c=>{
  const exp=(await c.query('SELECT * FROM report_exports WHERE id=$1 FOR UPDATE',[job.payload.exportId])).rows[0];
  if(!exp||!exp.requested_by||new Date(exp.expires_at).getTime()<=Date.now())throw new PermanentError('Report expired or requester unavailable');
  await reportAccess(c,exp.workspace_id,exp.requested_by);
  const input=reportInput.parse(exp.request),deadline=Date.now()+25000,videoIds=new Set<string>(),userIds=new Set<string>();
  let cursor:string|undefined,rows=0,bytes=0;const chunks:string[]=[];
  do{
   const page=await reportPage(c,exp.workspace_id,{...input,cursor});
   if(!chunks.length)chunks.push(page.columns.map(csvCell).join(',')+'\r\n');
   const chunk=page.rows.map(row=>page.columns.map(key=>csvCell(row[key])).join(',')+'\r\n').join('');
   rows+=page.rows.length;bytes+=Buffer.byteLength(chunk);
   if(rows>5000||bytes>10_000_000||Date.now()>deadline)throw new PermanentError('Report exceeds the export budget. Narrow the date range or video filter.');
   chunks.push(chunk);page.videoIds.forEach(id=>videoIds.add(id));page.userIds.forEach(id=>userIds.add(id));cursor=page.nextCursor??undefined;
  }while(cursor);
  // Recheck every referenced object's current access before storing a snapshot.
  const visible=(await c.query('SELECT id FROM videos WHERE id=ANY($1::uuid[]) AND workspace_id=$2 AND deleted_at IS NULL FOR SHARE',[[...videoIds],exp.workspace_id])).rows;
  if(visible.length!==videoIds.size)throw new PermanentError('Report access changed. Request a fresh export.');
  await c.query("UPDATE report_exports SET status='ready',csv=$2,row_count=$3,video_ids=$4,user_ids=$5,error=NULL WHERE id=$1",[exp.id,chunks.join(''),rows,[...videoIds],[...userIds]]);
  await c.query("UPDATE jobs SET status='done',locked_at=NULL,locked_by=NULL,last_error=NULL,updated_at=now() WHERE id=$1",[job.id]);
 });}catch(error){if(error instanceof HttpError)throw new PermanentError(error.message);throw error;}
}
