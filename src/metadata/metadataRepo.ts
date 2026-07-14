/**
 * Acesso a FIELD_METADATA (multi-tenant). Layout ativo com cache em memoria.
 */
import { withConnection, oracledb } from "../db/pool";
import { FieldMetadata, ValidationRule, VisibleWhen, DataType, ItemType, MaskStyle } from "../types";

const cache = new Map<number, FieldMetadata[]>();

function toBool(n: number): boolean {
  return Number(n) === 1;
}

function parseJson(raw: any): any {
  if (raw == null) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

function mapRow(row: any): FieldMetadata {
  return {
    fieldId: row.FIELD_ID,
    tenantId: row.TENANT_ID,
    layoutVersion: row.LAYOUT_VERSION,
    logicalName: row.LOGICAL_NAME,
    jsonPath: row.JSON_PATH,
    storage: row.STORAGE,
    dataType: row.DATA_TYPE,
    itemType: row.ITEM_TYPE,
    required: toBool(row.REQUIRED),
    visible: toBool(row.VISIBLE),
    editable: toBool(row.EDITABLE),
    sensitive: toBool(row.SENSITIVE),
    maskStyle: row.MASK_STYLE,
    displayOrder: row.DISPLAY_ORDER,
    label: row.LABEL,
    labelI18n: parseJson(row.LABEL_I18N),
    section: row.SECTION,
    validation: parseJson(row.VALIDATION),
    visibleWhen: parseJson(row.VISIBLE_WHEN),
    active: toBool(row.ACTIVE),
  };
}

/** Versao de layout ACTIVE mais recente do tenant. */
export async function getActiveLayoutVersion(tenant: string): Promise<number> {
  return withConnection(async (conn) => {
    const res = await conn.execute<any>(
      `SELECT VERSION_ID FROM LAYOUT_VERSION
        WHERE TENANT_ID = :t AND STATUS = 'ACTIVE'
        ORDER BY VERSION_ID DESC
        FETCH FIRST 1 ROWS ONLY`,
      { t: tenant }
    );
    if (!res.rows || res.rows.length === 0) {
      throw new Error(`Nenhuma LAYOUT_VERSION ativa para o tenant '${tenant}'. Rode o seed.`);
    }
    return res.rows[0].VERSION_ID as number;
  });
}

/** Metadados ATIVOS de uma versao, ordenados por DISPLAY_ORDER (com cache). */
export async function getFields(layoutVersion: number): Promise<FieldMetadata[]> {
  if (cache.has(layoutVersion)) return cache.get(layoutVersion)!;
  const fields = await withConnection(async (conn) => {
    const res = await conn.execute<any>(
      `SELECT * FROM FIELD_METADATA
        WHERE LAYOUT_VERSION = :v AND ACTIVE = 1
        ORDER BY DISPLAY_ORDER`,
      { v: layoutVersion }
    );
    return (res.rows ?? []).map(mapRow);
  });
  cache.set(layoutVersion, fields);
  return fields;
}

/** TODOS os campos de uma versao (inclui invisiveis/inativos) - para o editor. */
export async function getAllFields(layoutVersion: number): Promise<FieldMetadata[]> {
  return withConnection(async (conn) => {
    const res = await conn.execute<any>(
      `SELECT * FROM FIELD_METADATA WHERE LAYOUT_VERSION = :v ORDER BY DISPLAY_ORDER`,
      { v: layoutVersion }
    );
    return (res.rows ?? []).map(mapRow);
  });
}

export function clearCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Governanca de campos novos
// ---------------------------------------------------------------------------

export interface PendingField {
  logicalName: string;
  occurrences: number;
  sample: any;
  inferredType: DataType;
}

function inferType(v: any): DataType {
  if (Array.isArray(v)) return "ARRAY";
  if (v !== null && typeof v === "object") return "OBJECT";
  if (typeof v === "number") return "NUMBER";
  if (typeof v === "boolean") return "BOOLEAN";
  if (typeof v === "string" && !Number.isNaN(Date.parse(v)) && /\d{4}-\d{2}-\d{2}/.test(v)) return "DATE";
  return "STRING";
}

/** Campos no ATTRS (do tenant/versao) sem metadado e nao ignorados. */
export async function getPendingFields(tenant: string, layoutVersion: number): Promise<PendingField[]> {
  return withConnection(async (conn) => {
    const known = await conn.execute<any>(
      `SELECT LOGICAL_NAME FROM FIELD_METADATA WHERE LAYOUT_VERSION = :v`,
      { v: layoutVersion }
    );
    const ignored = await conn.execute<any>(
      `SELECT LOGICAL_NAME FROM IGNORED_FIELDS WHERE LAYOUT_VERSION = :v`,
      { v: layoutVersion }
    );
    const skip = new Set<string>([
      ...(known.rows ?? []).map((r: any) => r.LOGICAL_NAME),
      ...(ignored.rows ?? []).map((r: any) => r.LOGICAL_NAME),
    ]);

    const regs = await conn.execute<any>(
      `SELECT JSON_SERIALIZE(ATTRS) AS ATTRS
         FROM REGISTRO
        WHERE TENANT_ID = :t AND LAYOUT_VERSION = :v AND DELETED = 0 AND ATTRS IS NOT NULL`,
      { t: tenant, v: layoutVersion }
    );

    const agg = new Map<string, { count: number; sample: any }>();
    for (const row of regs.rows ?? []) {
      const attrs = row.ATTRS ? JSON.parse(row.ATTRS) : {};
      for (const [k, val] of Object.entries(attrs)) {
        if (skip.has(k)) continue;
        const cur = agg.get(k);
        if (cur) cur.count += 1;
        else agg.set(k, { count: 1, sample: val });
      }
    }
    return [...agg.entries()]
      .map(([logicalName, { count, sample }]) => ({
        logicalName, occurrences: count, sample, inferredType: inferType(sample),
      }))
      .sort((a, b) => b.occurrences - a.occurrences);
  });
}

export interface NewFieldMetadata {
  logicalName: string;
  dataType: DataType;
  itemType?: ItemType | null;
  required: boolean;
  visible: boolean;
  editable: boolean;
  sensitive?: boolean;
  maskStyle?: MaskStyle | null;
  displayOrder: number;
  label: string;
  labelI18n?: Record<string, string> | null;
  section?: string | null;
  validation?: ValidationRule | null;
  visibleWhen?: VisibleWhen | null;
}

/** "Aprova"/cria um campo (STORAGE=DYNAMIC) na versao e limpa o cache. */
export async function insertMetadata(
  tenant: string,
  layoutVersion: number,
  f: NewFieldMetadata
): Promise<number> {
  const id = await withConnection(async (conn) => {
    const res = await conn.execute<any>(
      `INSERT INTO FIELD_METADATA
         (TENANT_ID, LAYOUT_VERSION, LOGICAL_NAME, JSON_PATH, STORAGE, DATA_TYPE, ITEM_TYPE,
          REQUIRED, VISIBLE, EDITABLE, SENSITIVE, MASK_STYLE, DISPLAY_ORDER, LABEL, LABEL_I18N,
          SECTION, VALIDATION, VISIBLE_WHEN, ACTIVE)
       VALUES
         (:tenant, :lv, :name, :path, 'DYNAMIC', :dtype, :itype,
          :req, :vis, :edt, :sens, :mask, :ord, :label, :labelI18n,
          :section, :validation, :visibleWhen, 1)
       RETURNING FIELD_ID INTO :id`,
      {
        tenant,
        lv: layoutVersion,
        name: f.logicalName,
        path: `$.${f.logicalName}`,
        dtype: f.dataType,
        itype: f.itemType ?? null,
        req: f.required ? 1 : 0,
        vis: f.visible ? 1 : 0,
        edt: f.editable ? 1 : 0,
        sens: f.sensitive ? 1 : 0,
        mask: f.maskStyle ?? null,
        ord: f.displayOrder,
        label: f.label,
        labelI18n: f.labelI18n ? JSON.stringify(f.labelI18n) : null,
        section: f.section ?? null,
        validation: f.validation ? JSON.stringify(f.validation) : null,
        visibleWhen: f.visibleWhen ? JSON.stringify(f.visibleWhen) : null,
        id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      },
      { autoCommit: true }
    );
    return res.outBinds.id[0] as number;
  });
  clearCache();
  return id;
}

/** Atualiza a config de um campo (editor de DRAFT). Retorna false se nao achou. */
export async function updateMetadata(fieldId: number, patch: Partial<NewFieldMetadata> & { active?: boolean }): Promise<boolean> {
  const ok = await withConnection(async (conn) => {
    const sets: string[] = [];
    const binds: Record<string, any> = { id: fieldId };
    const map: Record<string, any> = {
      LABEL: patch.label,
      DISPLAY_ORDER: patch.displayOrder,
      SECTION: patch.section,
      DATA_TYPE: patch.dataType,
      ITEM_TYPE: patch.itemType,
      REQUIRED: patch.required != null ? (patch.required ? 1 : 0) : undefined,
      VISIBLE: patch.visible != null ? (patch.visible ? 1 : 0) : undefined,
      EDITABLE: patch.editable != null ? (patch.editable ? 1 : 0) : undefined,
      SENSITIVE: patch.sensitive != null ? (patch.sensitive ? 1 : 0) : undefined,
      MASK_STYLE: patch.maskStyle,
      ACTIVE: patch.active != null ? (patch.active ? 1 : 0) : undefined,
    };
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) { const b = `p_${col}`; sets.push(`${col} = :${b}`); binds[b] = val; }
    }
    // colunas JSON
    if (patch.labelI18n !== undefined) { sets.push("LABEL_I18N = :p_i18n"); binds.p_i18n = patch.labelI18n ? JSON.stringify(patch.labelI18n) : null; }
    if (patch.validation !== undefined) { sets.push("VALIDATION = :p_val"); binds.p_val = patch.validation ? JSON.stringify(patch.validation) : null; }
    if (patch.visibleWhen !== undefined) { sets.push("VISIBLE_WHEN = :p_vw"); binds.p_vw = patch.visibleWhen ? JSON.stringify(patch.visibleWhen) : null; }

    if (sets.length === 0) return false;
    const res = await conn.execute(
      `UPDATE FIELD_METADATA SET ${sets.join(", ")} WHERE FIELD_ID = :id`,
      binds,
      { autoCommit: true }
    );
    return (res.rowsAffected ?? 0) > 0;
  });
  clearCache();
  return ok;
}

/** Remove um campo do metadado (editor de DRAFT). */
export async function deleteMetadata(fieldId: number): Promise<boolean> {
  const ok = await withConnection(async (conn) => {
    const res = await conn.execute(
      `DELETE FROM FIELD_METADATA WHERE FIELD_ID = :id`,
      { id: fieldId },
      { autoCommit: true }
    );
    return (res.rowsAffected ?? 0) > 0;
  });
  clearCache();
  return ok;
}

/** Status (DRAFT/ACTIVE/RETIRED) da versao a que um campo pertence. */
export async function versionStatusOfField(fieldId: number): Promise<string | null> {
  return withConnection(async (conn) => {
    const res = await conn.execute<any>(
      `SELECT lv.STATUS FROM FIELD_METADATA fm
         JOIN LAYOUT_VERSION lv ON lv.VERSION_ID = fm.LAYOUT_VERSION
        WHERE fm.FIELD_ID = :id`,
      { id: fieldId }
    );
    return res.rows?.[0]?.STATUS ?? null;
  });
}

/** Status de uma versao por id. */
export async function versionStatus(versionId: number): Promise<string | null> {
  return withConnection(async (conn) => {
    const res = await conn.execute<any>(
      `SELECT STATUS FROM LAYOUT_VERSION WHERE VERSION_ID = :id`,
      { id: versionId }
    );
    return res.rows?.[0]?.STATUS ?? null;
  });
}

export async function ignoreField(tenant: string, layoutVersion: number, logicalName: string): Promise<void> {
  await withConnection(async (conn) => {
    await conn.execute(
      `INSERT INTO IGNORED_FIELDS (TENANT_ID, LAYOUT_VERSION, LOGICAL_NAME) VALUES (:t, :v, :n)`,
      { t: tenant, v: layoutVersion, n: logicalName },
      { autoCommit: true }
    );
  });
}
