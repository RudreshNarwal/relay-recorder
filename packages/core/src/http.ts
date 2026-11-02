import { z } from 'zod';
import { query } from './db';
export class HttpError extends Error {constructor(public status:number,message:string,public code?:string){super(message);}}
export function fail(status:number,message:string,code?:string):never{throw new HttpError(status,message,code);}
export function json(data:unknown,status=200,headers:HeadersInit={}){return Response.json(data,{status,headers:{'Cache-Control':'no-store',...headers}});}
export async function readBody(request:Request,limit:number):Promise<Buffer>{
 const declared=Number(request.headers.get('content-length'));if(declared>limit)fail(413,'Request is too large');
 const reader=request.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
 if(reader){try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();fail(413,'Request is too large');}chunks.push(value);}}finally{reader.releaseLock();}}
 return Buffer.concat(chunks);
}
export async function body<T>(request:Request,schema:z.ZodType<T>,limit=1_000_000):Promise<T>{
 const bytes=await readBody(request,limit);
 let parsed:unknown;try{parsed=JSON.parse(bytes.toString('utf8')||'{}');}catch{fail(400,'Invalid JSON');}
 const result=schema.safeParse(parsed);if(!result.success)fail(400,result.error.issues.map(x=>`${x.path.join('.')}: ${x.message}`).join('; '));return result.data;
}
export function uuid(value:string|undefined){const result=z.uuid().safeParse(value);if(!result.success)fail(400,'Invalid identifier');return result.data;}
export function origin(){return (process.env.BETTER_AUTH_URL||'http://localhost:3000').replace(/\/$/,'');}
export async function limit(key:string,max:number,seconds:number){
 const rows=await query<{count:number}>(`INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,now()+$2*interval '1 second') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.expires_at<now() THEN 1 ELSE rate_limits.count+1 END,expires_at=CASE WHEN rate_limits.expires_at<now() THEN now()+$2*interval '1 second' ELSE rate_limits.expires_at END RETURNING count`,[key,seconds]);
 if(rows[0].count>max)fail(429,'Too many requests; try again later');
}
