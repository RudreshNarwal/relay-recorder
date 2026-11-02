import { readFile } from 'node:fs/promises';
import { getMigrations } from 'better-auth/db/migration';
import { authOptions } from '../packages/core/src/auth';
import { db, closeDatabase } from '../packages/core/src/db';
const client=await db().connect();
try{
 await client.query("SELECT pg_advisory_lock(hashtext('relay-schema'))");
 const migration=await getMigrations(authOptions());await migration.runMigrations();
 const schema=await readFile(new URL('../packages/core/schema.sql',import.meta.url),'utf8');
 // The idempotent schema re-takes table locks while workers run; a deadlock rolls back cleanly, so retry it.
 for(let attempt=1;;attempt++){
  try{await client.query('BEGIN');await client.query(schema);await client.query('COMMIT');break;}
  catch(error){await client.query('ROLLBACK').catch(()=>{});if((error as {code?:string}).code!=='40P01'||attempt>=5)throw error;console.warn(`Schema migration deadlocked with a running worker; retrying (${attempt}/5)`);await new Promise(r=>setTimeout(r,500*attempt));}
 }
 console.log('Database schema ready.');
}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
finally{await client.query("SELECT pg_advisory_unlock(hashtext('relay-schema'))");client.release();await closeDatabase();}
