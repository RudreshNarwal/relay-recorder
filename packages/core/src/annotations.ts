import type {PoolClient} from 'pg';
import {query} from './db';
import {mapSourceRangeToOutput} from './timeline';
import type {Clip} from './policy';

export async function revisionComments(videoId:string,revisionId:string|null,client?:PoolClient):Promise<Record<string,any>[]>{
 const sql=`SELECT c.id,c.video_id AS "videoId",$2::uuid AS "revisionId",c.revision_id AS "sourceRevisionId",
 c.user_id AS "userId",u.name AS "userName",c.body,
 CASE WHEN a.comment_id IS NOT NULL THEN a.timestamps[1] ELSE c.timestamp END AS timestamp,
 CASE WHEN a.comment_id IS NOT NULL THEN a.timestamps WHEN c.timestamp IS NULL THEN '{}'::double precision[] ELSE ARRAY[c.timestamp] END AS timestamps,
 c.parent_id AS "parentId",c.created_at AS "createdAt"
 FROM comments c JOIN "user" u ON u.id=c.user_id
 LEFT JOIN revision_comment_anchors a ON a.comment_id=c.id AND a.revision_id=$2
 WHERE c.video_id=$1 AND (c.revision_id=$2 OR a.comment_id IS NOT NULL) ORDER BY c.created_at,c.id`;
 return client?(await client.query(sql,[videoId,revisionId])).rows:query(sql,[videoId,revisionId]);
}

export async function carryRevisionAnnotations(client:PoolClient,videoId:string,revisionId:string,clips:Clip[]){
 const comments=new Map<string,number[]>(),chapters:{start:number;title:string}[]=[];let editedChapters=false;
 // Discussion belongs to its video. Stitching another video's media does not import its private conversation.
 const sources=[...new Set(clips.filter(c=>c.videoId===videoId&&c.revisionId).map(c=>c.revisionId!))];
 for(const sourceRevision of sources){
  const source=await revisionComments(videoId,sourceRevision,client),included=new Set<string>();
  const add=(comment:Record<string,any>)=>{
   const times=(comment.timestamps as number[]).flatMap(time=>mapSourceRangeToOutput(clips,videoId,sourceRevision,time,time).map(r=>r.start));
   if(!times.length&&(!comment.parentId||comment.timestamps.length))return false;
   comments.set(comment.id,[...(comments.get(comment.id)??[]),...times]);included.add(comment.id);return true;
  };
  for(const comment of source.filter(c=>!c.parentId))add(comment);
  // Replies remain attached to retained parents; untimed top-level remarks stay on their original revision.
  let pending=source.filter(c=>c.parentId),changed=true;
  while(changed&&pending.length){changed=false;pending=pending.filter(c=>{if(included.has(c.parentId)&&add(c)){changed=true;return false;}return true;});}
  const row=(await client.query("SELECT a.chapters,a.user_edited,r.duration FROM ai_results a JOIN revisions r ON r.id=a.revision_id WHERE a.video_id=$1 AND a.revision_id=$2 AND a.status='ready'",[videoId,sourceRevision])).rows[0];
  if(!row)continue;
  for(let i=0;i<row.chapters.length;i++){
   const chapter=row.chapters[i],end=row.chapters[i+1]?.start??Number(row.duration);
   for(const range of mapSourceRangeToOutput(clips,videoId,sourceRevision,chapter.start,end)){
    const clip=clips[range.clipIndex];
    // A title can describe removed speech. Carry it only when the whole chapter survives in that occurrence.
    if(clip.start<=chapter.start&&clip.end>=end){chapters.push({start:range.start,title:chapter.title});editedChapters||=row.user_edited.includes('chapters');}
   }
  }
 }
 for(const [commentId,times] of comments)await client.query('INSERT INTO revision_comment_anchors(revision_id,comment_id,timestamps) VALUES($1,$2,$3) ON CONFLICT(revision_id,comment_id) DO NOTHING',[revisionId,commentId,[...new Set(times)].sort((a,b)=>a-b)]);
 if(chapters.length)await client.query("INSERT INTO ai_results(video_id,revision_id,chapters,user_edited,status) VALUES($1,$2,$3,$4,'ready') ON CONFLICT(video_id,revision_id) DO NOTHING",[videoId,revisionId,JSON.stringify(chapters.sort((a,b)=>a.start-b.start)),JSON.stringify(editedChapters?['chapters']:[])]);
}
