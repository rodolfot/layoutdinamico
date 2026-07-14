/**
 * Trilha de auditoria. `audit()` e best-effort: nunca deixa a falha de log
 * quebrar a operacao de negocio (registra o erro e segue).
 */
import { withConnection } from "../db/pool";

export type AuditAction =
  | "CREATE"
  | "UPDATE"
  | "DELETE"
  | "READ_SENSITIVE"
  | "APPROVE_FIELD"
  | "IGNORE_FIELD"
  | "UPDATE_FIELD"
  | "DELETE_FIELD"
  | "CREATE_VERSION"
  | "ACTIVATE_VERSION";

export interface AuditEntry {
  tenant: string;
  actor: string;
  action: AuditAction;
  entity: "REGISTRO" | "FIELD_METADATA" | "LAYOUT_VERSION";
  entityId?: string | number | null;
  details?: Record<string, any> | null;
}

export async function audit(e: AuditEntry): Promise<void> {
  try {
    await withConnection(async (conn) => {
      await conn.execute(
        `INSERT INTO AUDIT_LOG (TENANT_ID, ACTOR, ACTION, ENTITY, ENTITY_ID, DETAILS)
         VALUES (:tenant, :actor, :action, :entity, :entityId, :details)`,
        {
          tenant: e.tenant || "default",
          actor: e.actor || "anonimo",
          action: e.action,
          entity: e.entity,
          entityId: e.entityId != null ? String(e.entityId) : null,
          details: e.details ? JSON.stringify(e.details) : null,
        },
        { autoCommit: true }
      );
    });
  } catch (err) {
    console.error("[audit] falha ao registrar (operacao segue):", err);
  }
}

export interface AuditRow {
  auditId: number;
  ts: string;
  tenant: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string | null;
  details: any;
}

export interface AuditFilter {
  tenant?: string;
  entity?: string;
  action?: string;
  actor?: string;
  limit?: number;
}

export async function queryAudit(f: AuditFilter): Promise<AuditRow[]> {
  return withConnection(async (conn) => {
    const where: string[] = [];
    const binds: Record<string, any> = {};
    if (f.tenant) { where.push("TENANT_ID = :tenant"); binds.tenant = f.tenant; }
    if (f.entity) { where.push("ENTITY = :entity"); binds.entity = f.entity; }
    if (f.action) { where.push("ACTION = :action"); binds.action = f.action; }
    if (f.actor) { where.push("ACTOR = :actor"); binds.actor = f.actor; }
    binds.lim = Math.min(Math.max(f.limit ?? 50, 1), 500);

    const res = await conn.execute<any>(
      `SELECT AUDIT_ID, TO_CHAR(TS, 'YYYY-MM-DD HH24:MI:SS') AS TS, TENANT_ID, ACTOR, ACTION,
              ENTITY, ENTITY_ID, JSON_SERIALIZE(DETAILS) AS DETAILS
         FROM AUDIT_LOG
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY AUDIT_ID DESC
        FETCH FIRST :lim ROWS ONLY`,
      binds
    );
    return (res.rows ?? []).map((r: any) => ({
      auditId: r.AUDIT_ID,
      ts: r.TS,
      tenant: r.TENANT_ID,
      actor: r.ACTOR,
      action: r.ACTION,
      entity: r.ENTITY,
      entityId: r.ENTITY_ID,
      details: r.DETAILS ? JSON.parse(r.DETAILS) : null,
    }));
  });
}
