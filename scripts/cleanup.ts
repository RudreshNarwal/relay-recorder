import { closeDatabase, transaction } from '../packages/core/src/db';

// Only redundant, durably processed upload chunks are eligible. Originals stay.
try {
  const queued = await transaction(async client => {
    await client.query('DELETE FROM rate_limits WHERE expires_at < now()');
    await client.query('DELETE FROM device_logins WHERE expires_at < now()');
    await client.query('DELETE FROM device_tokens WHERE expires_at < now()');
    const result = await client.query(`
      INSERT INTO jobs(kind,video_id,revision_id,payload)
      SELECT 'cleanup',v.id,v.published_revision_id,'{"uploadParts":true}'::jsonb
      FROM videos v
      WHERE v.status='ready' AND v.deleted_at IS NULL
        AND v.updated_at < now()-interval '1 day'
        AND EXISTS(SELECT 1 FROM upload_parts p WHERE p.video_id=v.id)
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.video_id=v.id AND j.kind='cleanup'
          AND j.payload->>'uploadParts'='true' AND j.status IN ('queued','running','done'))
      ON CONFLICT DO NOTHING RETURNING id`);
    return result.rowCount;
  });
  console.log(`Queued ${queued} upload-chunk cleanup jobs. Original recordings remain untouched.`);
} finally {
  await closeDatabase();
}
