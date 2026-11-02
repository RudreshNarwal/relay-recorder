import pg, { type PoolClient, type QueryResultRow } from 'pg';
const { Pool } = pg;
let pool: pg.Pool | undefined;
export function db(): pg.Pool {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12, statement_timeout: 30_000 });
  }
  return pool;
}
export async function query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db().query<T>(sql, params)).rows;
}
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function closeDatabase() { await pool?.end(); pool = undefined; }
