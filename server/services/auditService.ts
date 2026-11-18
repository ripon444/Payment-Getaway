import { getDb, isoNow } from '../db/client.ts';
import { newId } from '../utils/crypto.ts';

export type AuditActorType = 'USER' | 'MERCHANT_API' | 'DEVICE' | 'SYSTEM';

export interface AuditEntryInput {
  actorType: AuditActorType;
  actorId: string;
  actorEmail?: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
}

export async function recordAuditLog(entry: AuditEntryInput): Promise<void> {
  const db = getDb();
  await db.execute(
    `INSERT INTO audit_logs (
      id, actor_type, actor_id, actor_email, action, resource_type, resource_id,
      ip_address, user_agent, before_state_json, after_state_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      entry.actorType,
      entry.actorId,
      entry.actorEmail ?? null,
      entry.action,
      entry.resourceType,
      entry.resourceId,
      entry.ipAddress ?? null,
      entry.userAgent ?? null,
      entry.beforeState !== undefined ? JSON.stringify(entry.beforeState) : null,
      entry.afterState !== undefined ? JSON.stringify(entry.afterState) : null,
      isoNow(),
    ],
  );
}
