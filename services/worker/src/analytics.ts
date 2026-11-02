import {transaction} from '@core/db';
import {defaultRetention,retentionSchema} from '@core/reports';
/** A bounded maintenance pass. Never deletes source media, captions or revisions. */
export async function retainAnalytics(){
 return transaction(async c=>{
  if(!(await c.query("SELECT pg_try_advisory_xact_lock(hashtext('relay-analytics-retention')) AS held")).rows[0].held)return null;
  const saved=(await c.query("SELECT value FROM settings WHERE key='analytics-retention'")).rows[0]?.value;
  const policy=retentionSchema.parse(saved??defaultRetention);
  const raw=(await c.query("DELETE FROM watch_intervals WHERE event_id IN (SELECT event_id FROM watch_intervals WHERE created_at<now()-make_interval(days=>$1) ORDER BY created_at LIMIT 10000) RETURNING event_id",[policy.rawDays])).rowCount;
  const legacy=(await c.query("DELETE FROM view_events WHERE id IN (SELECT id FROM view_events WHERE created_at<now()-make_interval(days=>$1) ORDER BY created_at LIMIT 10000) RETURNING id",[policy.rawDays])).rowCount;
  // Remove only sessions whose raw intervals have already aged out; bound cascades.
  const summaries=(await c.query("DELETE FROM watch_sessions WHERE id IN (SELECT id FROM watch_sessions s WHERE started_at<now()-make_interval(months=>$1) AND NOT EXISTS(SELECT 1 FROM watch_intervals i WHERE i.session_id=s.id) ORDER BY started_at LIMIT 1000) RETURNING id",[policy.aggregateMonths])).rowCount;
  const exports=(await c.query("UPDATE report_exports SET csv=NULL,status='expired',error=NULL WHERE id IN (SELECT id FROM report_exports WHERE expires_at<=now() AND status<>'expired' LIMIT 1000) RETURNING id")).rowCount;
  const ctaRaw=(await c.query("DELETE FROM cta_events WHERE event_id IN (SELECT event_id FROM cta_events WHERE created_at<now()-make_interval(days=>$1) ORDER BY created_at LIMIT 10000) RETURNING event_id",[policy.rawDays])).rowCount;
  const ctaAggregates=(await c.query("DELETE FROM cta_daily WHERE ctid IN (SELECT ctid FROM cta_daily WHERE day<(now() AT TIME ZONE 'UTC')::date-make_interval(months=>$1) ORDER BY day LIMIT 1000) RETURNING cta_id",[policy.aggregateMonths])).rowCount;
  return {raw,legacy,summaries,exports,ctaRaw,ctaAggregates};
 });
}
