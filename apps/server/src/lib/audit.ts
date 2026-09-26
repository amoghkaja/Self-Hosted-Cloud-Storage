import type { Executor } from '../db/client';
import { auditLog } from '../db/schema';

export interface AuditEvent {
  actorId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  meta?: Record<string, unknown>;
}

/** Append-only security/audit trail. Never let a logging failure break the request. */
export async function audit(exec: Executor, event: AuditEvent): Promise<void> {
  try {
    await exec.insert(auditLog).values({
      actorId: event.actorId,
      action: event.action,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      ip: event.ip ?? null,
      meta: event.meta ?? null,
    });
  } catch {
    // Swallowed intentionally; the request outcome matters more than the audit row.
  }
}
