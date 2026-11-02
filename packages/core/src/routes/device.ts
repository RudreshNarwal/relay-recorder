import {z} from 'zod';
import {createHash} from 'node:crypto';
import {query,transaction} from '../db';
import {body,fail,json,origin,uuid,limit} from '../http';
import {requireActor,type Actor} from '../auth';
import {token,hashToken,constantEqual} from '../secrets';
export async function device(request:Request,parts:string[],user:Actor|null):Promise<Response|null>{
 if(parts[0]!=='device')return null;const method=request.method;
 if(parts[1]==='start'&&method==='POST'){
  const input=await body(request,z.object({challenge:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}));await limit('device-start',1000,3600);const row=(await query('INSERT INTO device_logins(challenge) VALUES($1) RETURNING id,expires_at',[input.challenge]))[0];return json({id:row.id,verificationUrl:`${origin()}/device?id=${row.id}`,expiresAt:row.expires_at},201);
 }
 if(parts[1]==='approve'&&method==='POST'){
  const u=requireActor(user);const input=await body(request,z.object({id:z.uuid()}));const rows=await query('UPDATE device_logins SET user_id=$2 WHERE id=$1 AND expires_at>now() AND consumed_at IS NULL AND user_id IS NULL RETURNING id',[input.id,u.id]);if(!rows.length)fail(409,'Login request expired or already approved');return json({ok:true});
 }
 if(parts[1]==='exchange'&&method==='POST'){
  const input=await body(request,z.object({id:z.uuid(),verifier:z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/)}));await limit('device-poll:'+input.id,120,300);
  const result=await transaction(async c=>{const row=(await c.query('SELECT * FROM device_logins WHERE id=$1 FOR UPDATE',[input.id])).rows[0];if(!row||new Date(row.expires_at).getTime()<=Date.now()||row.consumed_at)fail(410,'Login request expired');const challenge=createHash('sha256').update(input.verifier).digest('base64url');if(!constantEqual(challenge,row.challenge))fail(403,'Login verifier is invalid');if(!row.user_id)return null;const secret=token();await c.query('INSERT INTO device_tokens(token_hash,user_id) VALUES($1,$2)',[hashToken(secret),row.user_id]);await c.query('UPDATE device_logins SET consumed_at=now() WHERE id=$1',[input.id]);const u=(await c.query('SELECT id,email,name FROM "user" WHERE id=$1',[row.user_id])).rows[0];return {token:secret,user:u};});return json(result||{pending:true},result?200:202);
 }
 if(parts[1]==='session'&&method==='DELETE'){requireActor(user);const authorization=request.headers.get('authorization');if(authorization?.startsWith('Bearer '))await query('DELETE FROM device_tokens WHERE token_hash=$1',[hashToken(authorization.slice(7))]);return json({ok:true});}
 return null;
}
