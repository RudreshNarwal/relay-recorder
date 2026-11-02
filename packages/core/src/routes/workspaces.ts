import {audit} from '../audit';
import {z} from 'zod';
import {query,transaction} from '../db';
import {body,fail,json,uuid,origin} from '../http';
import {membership} from '../access';
import {requireActor,type Actor} from '../auth';
import {token,hashToken} from '../secrets';
const name=z.string().trim().min(1).max(120);
export async function workspaces(request:Request,parts:string[],user:Actor|null):Promise<Response|null>{
 const method=request.method;
 if(parts[0]==='me'&&method==='GET'){const u=requireActor(user);const workspaces=await query('SELECT w.id,w.name,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at',[u.id]);return json({user:u,workspaces});}
 if(parts[0]==='workspaces'){
  const u=requireActor(user);
  if(parts.length===1&&method==='POST'){const input=await body(request,z.object({name}));const workspace=await transaction(async c=>{const w=(await c.query('INSERT INTO workspaces(name) VALUES($1) RETURNING *',[input.name])).rows[0];await c.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[w.id,u.id]);return {...w,role:'owner'};});return json({workspace},201);}
  const id=uuid(parts[1]);const role=await membership(id,u);
  if(parts.length===2&&method==='GET'){const w=(await query('SELECT id,name FROM workspaces WHERE id=$1',[id]))[0];return json({workspace:{...w,role}});}
  if(parts.length===2&&method==='PATCH'){await membership(id,u,true);const input=await body(request,z.object({name}));return json({workspace:(await query('UPDATE workspaces SET name=$2 WHERE id=$1 RETURNING id,name',[id,input.name]))[0]});}
  if(parts[2]==='members'&&parts.length===3&&method==='GET'){return json({members:await query('SELECT u.id AS "userId",u.email,u.name,m.role FROM memberships m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.name',[id])});}
  if(parts[2]==='invites'&&method==='POST'){await membership(id,u,true);const input=await body(request,z.object({email:z.email(),role:z.enum(['admin','member'])}));if(role!=='owner'&&input.role==='admin')fail(403,'Only the workspace owner can invite admins');const secret=token();const invite=(await query(`INSERT INTO invites(workspace_id,email,role,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days') RETURNING expires_at`,[id,input.email.toLowerCase(),input.role,hashToken(secret)]))[0];return json({invite:{token:secret,url:`${origin()}/invite/${secret}`,expiresAt:invite.expires_at}},201);}
  if(parts[2]==='members'&&parts[3]&&['PATCH','DELETE'].includes(method)){
   await membership(id,u,true);const target=parts[3];const input=method==='PATCH'?await body(request,z.object({role:z.enum(['admin','member'])})):null;
   await transaction(async c=>{await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[id]);const currentRole=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[id,u.id])).rows[0]?.role;if(!['owner','admin'].includes(currentRole))fail(403,'Workspace access denied');const m=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2',[id,target])).rows[0];if(!m)fail(404,'Member not found');if(m.role==='owner')fail(409,'Workspace owner cannot be removed or demoted');if(currentRole!=='owner'&&(m.role==='admin'||input?.role==='admin'))fail(403,'Only the owner can manage admins');if(input)await c.query('UPDATE memberships SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[id,target,input.role]);else await c.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2',[id,target]);await audit(c,id,u.id,input?'member.updated':'member.removed','member',target);});return json({ok:true});
  }
 }
 if(parts[0]==='invites'&&parts[2]==='accept'&&method==='POST'){
  const u=requireActor(user);if(!u.emailVerified)fail(403,'Verify your email before joining a workspace');
  const workspace=await transaction(async c=>{const invite=(await c.query('SELECT * FROM invites WHERE token_hash=$1 AND expires_at>now() AND accepted_at IS NULL FOR UPDATE',[hashToken(parts[1])])).rows[0];if(!invite)fail(404,'Invitation expired or already used');if(invite.email!==u.email.toLowerCase())fail(403,'This invitation belongs to another email');await c.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[invite.workspace_id,u.id,invite.role]);await c.query('UPDATE invites SET accepted_at=now() WHERE id=$1',[invite.id]);await audit(c,invite.workspace_id,u.id,'invite.accepted','invite',invite.id);return(await c.query('SELECT id,name FROM workspaces WHERE id=$1',[invite.workspace_id])).rows[0];});return json({workspace});
 }
 if(parts[0]==='folders'){
  const u=requireActor(user);const url=new URL(request.url);
  if(parts.length===1&&method==='GET'){const id=uuid(url.searchParams.get('workspaceId')||undefined);await membership(id,u);return json({folders:await query('SELECT id,workspace_id AS "workspaceId",name,parent_id AS "parentId" FROM folders WHERE workspace_id=$1 ORDER BY name',[id])});}
  if(parts.length===1&&method==='POST'){const input=await body(request,z.object({workspaceId:z.uuid(),name,parentId:z.uuid().nullable().optional()}));await membership(input.workspaceId,u);if(input.parentId&&!(await query('SELECT 1 FROM folders WHERE id=$1 AND workspace_id=$2',[input.parentId,input.workspaceId])).length)fail(400,'Parent folder belongs to another workspace');return json({folder:(await query('INSERT INTO folders(workspace_id,name,parent_id) VALUES($1,$2,$3) RETURNING id,workspace_id AS "workspaceId",name,parent_id AS "parentId"',[input.workspaceId,input.name,input.parentId||null]))[0]},201);}
  const id=uuid(parts[1]);const f=(await query('SELECT * FROM folders WHERE id=$1',[id]))[0];if(!f)fail(404,'Folder not found');await membership(f.workspace_id,u);
  if(method==='PATCH'){const input=await body(request,z.object({name}));return json({folder:(await query('UPDATE folders SET name=$2 WHERE id=$1 RETURNING id,workspace_id AS "workspaceId",name,parent_id AS "parentId"',[id,input.name]))[0]});}
  if(method==='DELETE'){await membership(f.workspace_id,u,true);await query('DELETE FROM folders WHERE id=$1',[id]);return json({ok:true});}
 }
 return null;
}
