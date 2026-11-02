import {z} from 'zod';
import {requireActor,type Actor} from '../auth';
import {accessVideo,membership,lockEditableVideo} from '../access';
import {query,transaction} from '../db';
import {body,readBody,fail,json,limit,uuid} from '../http';
import {defaultBrand,brandSchema,presentationSchema,type BrandSettings,type Presentation} from '../branding';
import {sanitizeLogo} from '../brand-assets';
import {viewerIdentity} from './analytics';
import {hashToken} from '../secrets';

export async function videoBrand(video:Record<string,any>){
 const brand=(await query('SELECT settings,version FROM workspace_branding WHERE workspace_id=$1',[video.workspace_id]))[0];
 const saved=(await query('SELECT settings,version,revision_id FROM video_presentation WHERE video_id=$1',[video.id]))[0];
 const current=saved?.revision_id===video.published_revision_id;
 const presentation:Presentation={ctas:current?saved.settings.ctas:[],overrides:saved?.settings.overrides??{},version:saved?.version??0,revisionId:current?saved.revision_id:null};
 return {branding:{...defaultBrand,...brand?.settings,...presentation.overrides} as BrandSettings,presentation};
}
async function manage(c:import('pg').PoolClient,workspaceId:string,userId:string){
 await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId]);
 const role=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[workspaceId,userId])).rows[0]?.role;
 if(!['owner','admin'].includes(role))fail(403,'Workspace branding requires owner or admin membership');
}
const imageResponse=(bytes:Buffer)=>new Response(new Uint8Array(bytes),{headers:{'Content-Type':'image/webp','Content-Length':String(bytes.length),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'"}});
export async function branding(request:Request,parts:string[],actor:Actor|null):Promise<Response|null>{
 if(parts[0]==='workspaces'&&parts[2]==='branding'){
  const user=requireActor(actor),workspaceId=uuid(parts[1]);await membership(workspaceId,user,true);
  if(parts.length===3&&request.method==='GET'){
   const saved=(await query('SELECT settings,version FROM workspace_branding WHERE workspace_id=$1',[workspaceId]))[0];return json(saved??{settings:defaultBrand,version:0});
  }
  if(parts.length===3&&request.method==='PUT'){
   const input=await body(request,z.object({expectedVersion:z.number().int().nonnegative(),settings:brandSchema}).strict());
   return transaction(async c=>{
    await manage(c,workspaceId,user.id);
    const saved=(await c.query('SELECT version FROM workspace_branding WHERE workspace_id=$1',[workspaceId])).rows[0];
    if((saved?.version??0)!==input.expectedVersion)fail(409,'Branding changed. Reload before saving.');
    if(input.settings.logoAssetId&&!(await c.query('SELECT id FROM brand_assets WHERE id=$1 AND workspace_id=$2',[input.settings.logoAssetId,workspaceId])).rowCount)fail(400,'Choose a logo uploaded to this workspace');
    const result=(await c.query('INSERT INTO workspace_branding(workspace_id,settings) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET settings=$2,version=workspace_branding.version+1,updated_at=now() RETURNING settings,version',[workspaceId,JSON.stringify(input.settings)])).rows[0];return json(result);
   });
  }
  if(parts[3]==='assets'&&parts.length===4&&request.method==='POST'){
   await limit('brand-upload:'+user.id,30,3600);const bytes=await readBody(request,2_000_000);
   let safe:Buffer;try{safe=await sanitizeLogo(bytes);}catch{fail(400,'Choose a nonanimated PNG, JPEG or WebP logo up to 2 MB and 4 million pixels');}
   return transaction(async c=>{
    await manage(c,workspaceId,user.id);
    if((await c.query('SELECT count(*)::int AS n FROM brand_assets WHERE workspace_id=$1',[workspaceId])).rows[0].n>=32)fail(409,'This workspace has 32 logos. Remove an unused logo before uploading.');
    const row=(await c.query('INSERT INTO brand_assets(workspace_id,bytes) VALUES($1,$2) RETURNING id',[workspaceId,safe])).rows[0];return json({assetId:row.id},201);
   });
  }
  if(parts[3]==='assets'&&parts[4]&&parts.length===5){
   const id=uuid(parts[4]);
   if(request.method==='GET'){const row=(await query('SELECT bytes FROM brand_assets WHERE id=$1 AND workspace_id=$2',[id,workspaceId]))[0];if(!row)fail(404,'Logo not found');return imageResponse(row.bytes);}
   if(request.method==='DELETE')return transaction(async c=>{
    await manage(c,workspaceId,user.id);
    if((await c.query("SELECT 1 FROM workspace_branding WHERE workspace_id=$1 AND settings->>'logoAssetId'=$2",[workspaceId,id])).rowCount)fail(409,'Remove this logo from branding before deleting it');
    await c.query('DELETE FROM brand_assets WHERE id=$1 AND workspace_id=$2',[id,workspaceId]);return json({ok:true});
   });
  }
  if(parts[3]==='assets'&&parts.length===4&&request.method==='GET')return json({assets:await query('SELECT id,created_at AS "createdAt" FROM brand_assets WHERE workspace_id=$1 ORDER BY created_at DESC',[workspaceId])});
  return null;
 }
 if(parts[0]!=='videos'||!['brand','presentation','cta-events'].includes(parts[2]))return null;
 const videoId=uuid(parts[1]);
 if(parts[2]==='brand'&&parts[3]==='logo'&&parts.length===4&&request.method==='GET'){
  const {row}=await accessVideo(request,videoId,actor);const {branding}=await videoBrand(row);
  if(!branding.logoAssetId)fail(404,'No logo configured');
  const asset=(await query('SELECT bytes FROM brand_assets WHERE id=$1 AND workspace_id=$2',[branding.logoAssetId,row.workspace_id]))[0];if(!asset)fail(404,'Logo unavailable');return imageResponse(asset.bytes);
 }
 if(parts[2]==='presentation'&&parts.length===3&&request.method==='PUT'){
  const user=requireActor(actor);await accessVideo(request,videoId,user,true);
  const input=await body(request,z.object({expectedVersion:z.number().int().nonnegative(),expectedRevisionId:z.uuid(),ctas:presentationSchema.shape.ctas,overrides:presentationSchema.shape.overrides}).strict());
  const settings=presentationSchema.safeParse({ctas:input.ctas,overrides:input.overrides});if(!settings.success)fail(400,'Use unique CTA identities and valid timing');
  return transaction(async c=>{
   const row=await lockEditableVideo(c,videoId,user);
   if(row.status!=='ready'||row.published_revision_id!==input.expectedRevisionId)fail(409,'Published revision changed');
   if(input.ctas.some(cta=>cta.end>row.duration))fail(400,'CTA timing must fit the published recording');
   const saved=(await c.query('SELECT version FROM video_presentation WHERE video_id=$1',[videoId])).rows[0];
   if((saved?.version??0)!==input.expectedVersion)fail(409,'Presentation changed. Reload before saving.');
   const next=(await c.query('INSERT INTO video_presentation(video_id,revision_id,settings) VALUES($1,$2,$3) ON CONFLICT(video_id) DO UPDATE SET revision_id=$2,settings=$3,version=video_presentation.version+1,updated_at=now() RETURNING version',[videoId,row.published_revision_id,JSON.stringify(settings.data)])).rows[0];
   return json({presentation:{...settings.data,version:next.version,revisionId:row.published_revision_id}});
  });
 }
 if(parts[2]==='cta-events'&&parts.length===3&&request.method==='POST'){
  const input=await body(request,z.object({eventId:z.uuid(),sessionId:z.uuid(),revisionId:z.uuid(),presentationVersion:z.number().int().positive(),ctaId:z.uuid(),kind:z.enum(['impression','click']),position:z.number().finite().nonnegative()}).strict());
  const {row}=await accessVideo(request,videoId,actor),viewer=viewerIdentity(request,videoId,actor),digest=hashToken(JSON.stringify(input));
  await limit('cta:'+videoId+':'+viewer.key,300,3600);
  return transaction(async c=>{
   const held=(await c.query('SELECT * FROM videos WHERE id=$1 FOR SHARE',[videoId])).rows[0];
   if(held.deleted_at||held.published_revision_id!==input.revisionId)fail(409,'Published revision changed');
   await accessVideo(request,videoId,actor);
   const presentation=(await c.query('SELECT * FROM video_presentation WHERE video_id=$1',[videoId])).rows[0];
   const cta=presentation?.settings.ctas.find((v:{id:string})=>v.id===input.ctaId);
   if(!cta||presentation.revision_id!==input.revisionId||presentation.version!==input.presentationVersion||input.position<cta.start||input.position>cta.end)fail(409,'CTA is no longer active');
   if(actor?.id===row.owner_id)return json({ok:true,preview:true},200,viewer.headers);
   const old=(await c.query('SELECT digest,viewer_key FROM cta_events WHERE event_id=$1',[input.eventId])).rows[0];
   if(old&&(old.digest!==digest||old.viewer_key!==viewer.key))fail(409,'CTA event identity conflicts');
   const added=await c.query('INSERT INTO cta_events(event_id,video_id,revision_id,presentation_version,cta_id,session_id,viewer_key,kind,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING event_id',[input.eventId,videoId,input.revisionId,input.presentationVersion,input.ctaId,input.sessionId,viewer.key,input.kind,digest]);
   if(!added.rowCount){const collision=(await c.query('SELECT digest,viewer_key FROM cta_events WHERE event_id=$1',[input.eventId])).rows[0];if(collision&&(collision.digest!==digest||collision.viewer_key!==viewer.key))fail(409,'CTA event identity conflicts');}
   if(added.rowCount)await c.query(`INSERT INTO cta_daily(video_id,revision_id,presentation_version,cta_id,day,impressions,clicks) VALUES($1,$2,$3,$4,(now() AT TIME ZONE 'UTC')::date,$5,$6)
    ON CONFLICT(video_id,revision_id,presentation_version,cta_id,day) DO UPDATE SET impressions=cta_daily.impressions+EXCLUDED.impressions,clicks=cta_daily.clicks+EXCLUDED.clicks`,[videoId,input.revisionId,input.presentationVersion,input.ctaId,input.kind==='impression'?1:0,input.kind==='click'?1:0]);
   return json({ok:true,duplicate:!added.rowCount},200,viewer.headers);
  });
 }
 return null;
}
