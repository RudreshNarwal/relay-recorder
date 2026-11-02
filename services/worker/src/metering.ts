import type {PoolClient} from 'pg';
import type {Job} from './jobs';
export async function recordAIUsage(c:PoolClient,job:Job,result:{provider:string;model:string;usage:unknown}){
 await c.query('INSERT INTO ai_usage(job_id,video_id,attempt,provider,model,usage) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(job_id,attempt) DO NOTHING',[job.id,job.video_id,job.attempts,result.provider,result.model,JSON.stringify(result.usage??null)]);
}
