import type {PoolClient} from 'pg';
import {transaction} from '@core/db';
export const LEASE_SECONDS=120;
export async function withLease<T>(job:{id:string;locked_by:string},action:(client:PoolClient)=>Promise<T>){
 return transaction(async client=>{
  const held=await client.query("SELECT id FROM jobs WHERE id=$1 AND status='running' AND locked_by=$2 AND locked_at>now()-make_interval(secs=>$3) FOR UPDATE",[job.id,job.locked_by,LEASE_SECONDS]);
  if(!held.rowCount)throw new Error('Job lease lost');
  return action(client);
 });
}
