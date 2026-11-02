import type {PoolClient} from 'pg';
import {hashToken} from './secrets';
/** A permission change invalidates an already reviewed export, even if the actor remains an editor. */
export async function deliveryAccessDigest(c:PoolClient,video:Record<string,any>){
 const shares=(await c.query('SELECT token,version,allow_download FROM shares WHERE video_id=$1 FOR SHARE',[video.id])).rows;
 const audience=(await c.query('SELECT email FROM video_access WHERE video_id=$1 ORDER BY email FOR SHARE',[video.id])).rows;
 return hashToken(JSON.stringify({visibility:video.visibility,owner:video.owner_id,shares,audience}));
}
