import {z} from 'zod';
import {query,transaction} from '../db';
import {body,fail,json,uuid,limit} from '../http';
import {accessVideo,aiDTO} from '../access';
import {requireAdmin,type Actor} from '../auth';
import {encryptSecret} from '../secrets';
import {testAIConnection,type AIConfig} from '../../../../services/worker/src/ai';
const schema=z.object({provider:z.enum(['google','vertex','openai','anthropic','openrouter']),model:z.string().trim().min(1).max(200),apiKey:z.string().max(10000).optional(),project:z.string().max(200).optional(),location:z.string().max(100).optional(),enabled:z.boolean()});
export async function ai(request:Request,parts:string[],user:Actor|null):Promise<Response|null>{
 const method=request.method;
 if(parts[0]==='admin'&&parts[1]==='ai'){
  const u=requireAdmin(user);const current=(await query<{value:AIConfig}>("SELECT value FROM settings WHERE key='ai'"))[0]?.value;
  if(method==='GET')return json({settings:current?{provider:current.provider,model:current.model,project:current.project,location:current.location,enabled:current.enabled,configured:current.provider==='vertex'?!!current.project&&!!current.location:!!current.encryptedApiKey}:{provider:'google',model:'',enabled:false,configured:false}});
  if(parts[2]==='test'&&method==='POST'){await limit('ai-test:'+u.id,5,60);if(!current)fail(400,'Configure a provider first');return json(await testAIConnection(current));}
  if(parts.length===2&&method==='PUT'){
   const input=await body(request,schema);const same=current?.provider===input.provider;const config:AIConfig={provider:input.provider,model:input.model,enabled:input.enabled,project:input.project,location:input.location};if(input.apiKey)config.encryptedApiKey=encryptSecret(input.apiKey);else if(same&&current.encryptedApiKey)config.encryptedApiKey=current.encryptedApiKey;
   if(input.provider==='vertex'){if(!input.project||!input.location)fail(400,'Vertex requires project and location');}else if(input.enabled&&!config.encryptedApiKey)fail(400,'API key is required');
   await query("INSERT INTO settings(key,value) VALUES('ai',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[JSON.stringify(config)]);return json({ok:true});
  }
 }
 if(parts[0]==='videos'&&parts[2]==='ai'){
  const id=uuid(parts[1]);const {row}=await accessVideo(request,id,user,true);
  if(method==='POST'){
   const input=await body(request,z.object({regenerate:z.boolean().optional(),expectedRevisionId:z.uuid().optional()}));
   const expected=input.expectedRevisionId??row.published_revision_id;
   if(!expected)fail(409,'Video is still processing');
   if(expected!==row.published_revision_id)fail(409,'A different revision is published; reload AI notes');
   const config=(await query<{value:AIConfig}>("SELECT value FROM settings WHERE key='ai'"))[0]?.value;
   if(!config?.enabled)fail(409,'Server owner must configure and enable cloud AI');
   await limit('ai:'+user!.id,10,3600);
   await transaction(async c=>{
    const current=(await c.query('SELECT published_revision_id,deleted_at,status FROM videos WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!current||current.deleted_at||current.status==='canceled'||current.published_revision_id!==expected)fail(409,'A different revision is published; reload AI notes');
    if(!(await c.query("SELECT 1 FROM transcripts WHERE video_id=$1 AND revision_id=$2 AND status='ready'",[id,expected])).rowCount)fail(409,'Generate a transcript first');
    await c.query("INSERT INTO ai_results(video_id,revision_id,status) VALUES($1,$2,'queued') ON CONFLICT(video_id,revision_id) DO UPDATE SET status='queued',error=NULL,updated_at=now()",[id,expected]);
    await c.query("INSERT INTO jobs(kind,video_id,revision_id) VALUES('ai',$1,$2) ON CONFLICT DO NOTHING",[id,expected]);
   });return json({ok:true},202);
  }
  if(method==='PATCH'){
   const input=await body(request,z.object({expectedRevisionId:z.uuid().optional(),title:z.string().max(300).optional(),summary:z.string().max(20000).optional(),chapters:z.array(z.object({start:z.number().finite().nonnegative(),title:z.string().max(300)})).max(100).optional(),actionItems:z.array(z.string().max(2000)).max(100).optional()}));
   const {expectedRevisionId,...changes}=input;
   if(!expectedRevisionId)fail(428,'expectedRevisionId is required to edit AI notes');
   if(expectedRevisionId!==row.published_revision_id)fail(409,'A different revision is published; reload AI notes');
   if(!Object.keys(changes).length)fail(400,'Choose at least one AI field to edit');
   const result=await transaction(async c=>{
    const current=(await c.query('SELECT published_revision_id,deleted_at,status,duration FROM videos WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!current||current.deleted_at||current.status==='canceled'||current.published_revision_id!==expectedRevisionId)fail(409,'A different revision is published; reload AI notes');
    for(const chapter of changes.chapters||[])if(chapter.start>current.duration)fail(400,'Chapter outside video');
    const existing=(await c.query('SELECT * FROM ai_results WHERE video_id=$1 AND revision_id=$2 FOR UPDATE',[id,expectedRevisionId])).rows[0];
    if(!existing)fail(404,'Generate AI results for this revision first');
    const edited=[...new Set<string>([...(existing.user_edited||[]),...Object.keys(changes)])];
    return(await c.query('UPDATE ai_results SET title=COALESCE($3,title),summary=COALESCE($4,summary),chapters=COALESCE($5,chapters),action_items=COALESCE($6,action_items),user_edited=$7,updated_at=now() WHERE video_id=$1 AND revision_id=$2 RETURNING *',[id,expectedRevisionId,changes.title??null,changes.summary??null,changes.chapters?JSON.stringify(changes.chapters):null,changes.actionItems?JSON.stringify(changes.actionItems):null,JSON.stringify(edited)])).rows[0];
   });return json({ai:aiDTO(result)});
  }
 }
 return null;
}
