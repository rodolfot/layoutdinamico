/**
 * Persistencia de REGISTRO (multi-tenant, soft-delete, historico).
 *   - CORE -> colunas fixas; DYNAMIC/desconhecidos -> ATTRS (JSON)
 *   - cada CREATE/UPDATE/DELETE grava um snapshot em REGISTRO_HISTORY
 */
import { withConnection, oracledb } from "../db/pool";
import { RegistroCore } from "../types";

export interface StoredRegistro {
  id: number;
  tenantId: string;
  cpf: string;
  nome: string;
  email: string | null;
  layoutVersion: number;
  attrs: Record<string, any>;
  rowVersion: number;
  deleted: boolean;
}

function parseAttrs(raw: any): Record<string, any> {
  if (raw == null) return {};
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function writeHistory(
  conn: any,
  registroId: number,
  tenant: string,
  operation: "CREATE" | "UPDATE" | "DELETE",
  snapshot: any,
  actor: string
): Promise<void> {
  const v = await conn.execute(
    `SELECT NVL(MAX(VERSION_NO),0)+1 AS N FROM REGISTRO_HISTORY WHERE REGISTRO_ID = :id`,
    { id: registroId }
  );
  const versionNo = v.rows[0].N;
  await conn.execute(
    `INSERT INTO REGISTRO_HISTORY (REGISTRO_ID, TENANT_ID, VERSION_NO, OPERATION, SNAPSHOT, CHANGED_BY)
     VALUES (:id, :t, :vno, :op, :snap, :actor)`,
    { id: registroId, t: tenant, vno: versionNo, op: operation, snap: JSON.stringify(snapshot), actor }
  );
}

export async function insertRegistro(
  tenant: string,
  core: RegistroCore,
  attrs: Record<string, any>,
  layoutVersion: number,
  actor: string
): Promise<number> {
  return withConnection(async (conn) => {
    const res = await conn.execute<any>(
      `INSERT INTO REGISTRO (TENANT_ID, CPF, NOME, EMAIL, LAYOUT_VERSION, ATTRS)
       VALUES (:t, :cpf, :nome, :email, :lv, :attrs)
       RETURNING ID INTO :id`,
      {
        t: tenant,
        cpf: core.cpf,
        nome: core.nome,
        email: core.email ?? null,
        lv: layoutVersion,
        attrs: JSON.stringify(attrs ?? {}),
        id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );
    const id = res.outBinds.id[0] as number;
    await writeHistory(conn, id, tenant, "CREATE", { ...core, attrs }, actor);
    await conn.commit();
    return id;
  });
}

export async function findById(tenant: string, id: number): Promise<StoredRegistro | null> {
  return withConnection(async (conn) => {
    const res = await conn.execute<any>(
      `SELECT ID, TENANT_ID, CPF, NOME, EMAIL, LAYOUT_VERSION, ROW_VERSION, DELETED,
              JSON_SERIALIZE(ATTRS) AS ATTRS
         FROM REGISTRO
        WHERE ID = :id AND TENANT_ID = :t`,
      { id, t: tenant }
    );
    if (!res.rows || res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.ID, tenantId: r.TENANT_ID, cpf: r.CPF, nome: r.NOME, email: r.EMAIL,
      layoutVersion: r.LAYOUT_VERSION, attrs: parseAttrs(r.ATTRS),
      rowVersion: r.ROW_VERSION, deleted: Number(r.DELETED) === 1,
    };
  });
}

/** Lista paginada (mais recentes primeiro), escopada por tenant, exclui deletados. */
export async function listRegistros(
  tenant: string,
  limit: number,
  offset: number
): Promise<Array<{ id: number; cpf: string; nome: string }>> {
  return withConnection(async (conn) => {
    const res = await conn.execute<any>(
      `SELECT ID, CPF, NOME FROM REGISTRO
        WHERE TENANT_ID = :t AND DELETED = 0
        ORDER BY ID DESC
        OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY`,
      { t: tenant, off: offset, lim: limit }
    );
    return (res.rows ?? []).map((r: any) => ({ id: r.ID, cpf: r.CPF, nome: r.NOME }));
  });
}

/** Total de registros (nao deletados) do tenant - para paginacao e dashboard. */
export async function countRegistros(tenant: string): Promise<number> {
  return withConnection(async (conn) => {
    const res = await conn.execute<any>(
      `SELECT COUNT(*) AS C FROM REGISTRO WHERE TENANT_ID = :t AND DELETED = 0`,
      { t: tenant }
    );
    return res.rows?.[0]?.C ?? 0;
  });
}

export type UpdateOutcome = "ok" | "notfound" | "conflict";

/**
 * Atualiza core + attrs, incrementa ROW_VERSION e grava historico.
 * Se expectedVersion vier, aplica concorrencia OTIMISTA: so atualiza se a versao
 * atual bater; caso contrario retorna 'conflict' (edicao concorrente).
 */
export async function updateRegistro(
  tenant: string,
  id: number,
  core: RegistroCore,
  attrs: Record<string, any>,
  actor: string,
  expectedVersion?: number
): Promise<UpdateOutcome> {
  return withConnection(async (conn) => {
    const binds: Record<string, any> = {
      cpf: core.cpf, nome: core.nome, email: core.email ?? null,
      attrs: JSON.stringify(attrs ?? {}), id, t: tenant,
    };
    let versionClause = "";
    if (expectedVersion != null) { versionClause = " AND ROW_VERSION = :expv"; binds.expv = expectedVersion; }

    const res = await conn.execute<any>(
      `UPDATE REGISTRO
          SET CPF = :cpf, NOME = :nome, EMAIL = :email, ATTRS = :attrs,
              ROW_VERSION = ROW_VERSION + 1, UPDATED_AT = SYSTIMESTAMP
        WHERE ID = :id AND TENANT_ID = :t AND DELETED = 0${versionClause}`,
      binds
    );
    if ((res.rowsAffected ?? 0) === 0) {
      // distingue "nao existe" de "versao divergente" (conflito)
      const exists = await conn.execute<any>(
        `SELECT 1 FROM REGISTRO WHERE ID = :id AND TENANT_ID = :t AND DELETED = 0`,
        { id, t: tenant }
      );
      return exists.rows && exists.rows.length > 0 ? "conflict" : "notfound";
    }
    await writeHistory(conn, id, tenant, "UPDATE", { ...core, attrs }, actor);
    await conn.commit();
    return "ok";
  });
}

/** Soft-delete: marca DELETED=1 e grava historico. */
export async function softDelete(tenant: string, id: number, actor: string): Promise<boolean> {
  return withConnection(async (conn) => {
    const res = await conn.execute<any>(
      `UPDATE REGISTRO
          SET DELETED = 1, DELETED_AT = SYSTIMESTAMP, DELETED_BY = :actor
        WHERE ID = :id AND TENANT_ID = :t AND DELETED = 0`,
      { actor, id, t: tenant }
    );
    if ((res.rowsAffected ?? 0) === 0) return false;
    await writeHistory(conn, id, tenant, "DELETE", { deleted: true }, actor);
    await conn.commit();
    return true;
  });
}

export interface HistoryEntry {
  versionNo: number;
  operation: string;
  snapshot: any;
  changedBy: string;
  changedAt: string;
}

export async function getHistory(tenant: string, id: number): Promise<HistoryEntry[]> {
  return withConnection(async (conn) => {
    const res = await conn.execute<any>(
      `SELECT VERSION_NO, OPERATION, JSON_SERIALIZE(SNAPSHOT) AS SNAPSHOT, CHANGED_BY,
              TO_CHAR(CHANGED_AT, 'YYYY-MM-DD HH24:MI:SS') AS CHANGED_AT
         FROM REGISTRO_HISTORY
        WHERE REGISTRO_ID = :id AND TENANT_ID = :t
        ORDER BY VERSION_NO DESC`,
      { id, t: tenant }
    );
    return (res.rows ?? []).map((r: any) => ({
      versionNo: r.VERSION_NO,
      operation: r.OPERATION,
      snapshot: r.SNAPSHOT ? JSON.parse(r.SNAPSHOT) : null,
      changedBy: r.CHANGED_BY,
      changedAt: r.CHANGED_AT,
    }));
  });
}
