import type {PoolClient} from 'pg';
export type AuditAction='connection.created'|'connection.disconnected'|'delivery.queued'|'delivery.sent'|'delivery.reconciled'|'report.requested'|'report.downloaded'|'analytics.retention_changed'|'workspace.updated'|'member.updated'|'member.removed'|'invite.created'|'invite.accepted'|'video.deleted'|'share.updated'|'share.revoked';
/** Intentionally accepts no arbitrary metadata: content and secrets cannot enter this log. */
export async function audit(c:PoolClient,workspaceId:string|null,actorId:string|null,action:AuditAction,objectType:'connection'|'delivery'|'report'|'workspace'|'member'|'invite'|'video'|'analytics',objectId:string){
 await c.query('INSERT INTO audit_events(workspace_id,actor_id,action,object_type,object_id) VALUES($1,$2,$3,$4,$5)',[workspaceId,actorId,action,objectType,objectId]);
}
