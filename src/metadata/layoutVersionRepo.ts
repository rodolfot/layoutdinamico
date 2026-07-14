/**
 * Gestao de versoes de layout (multi-tenant): list/create/clone/activate/diff
 * + export/import (bundle portavel) com preview de conflitos.
 */
import { withConnection, oracledb } from "../db/pool";
import { clearCache } from "./metadataRepo";

// colunas de FIELD_METADATA copiadas em clone/import/export
const FIELD_COLS =
  "LOGICAL_NAME, JSON_PATH, STORAGE, DATA_TYPE, ITEM_TYPE, REQUIRED, VISIBLE, EDITABLE, " +
  "SENSITIVE, MASK_STYLE, DISPLAY_ORDER, LABEL, LABEL_I18N, SECTION, VALIDATION, VISIBLE_WHEN, ACTIVE";

export interface LayoutVersion {
  versionId: number;
  label: string;
  status: "DRAFT" | "ACTIVE" | "RETIRED";
  createdAt: string;
  fieldCount: number;
}

export async function listVersions(tenant: string): Promise<LayoutVersion[]> {
  return withConnection(async (conn) => {
    const res = await conn.execute<any>(
      `SELECT lv.VERSION_ID, lv.LABEL, lv.STATUS,
              TO_CHAR(lv.CREATED_AT, 'YYYY-MM-DD HH24:MI:SS') AS CREATED_AT,
              (SELECT COUNT(*) FROM FIELD_METADATA fm WHERE fm.LAYOUT_VERSION = lv.VERSION_ID) AS FIELD_COUNT
         FROM LAYOUT_VERSION lv
        WHERE lv.TENANT_ID = :t
        ORDER BY lv.VERSION_ID DESC`,
      { t: tenant }
    );
    return (res.rows ?? []).map((r: any) => ({
      versionId: r.VERSION_ID, label: r.LABEL, status: r.STATUS,
      createdAt: r.CREATED_AT, fieldCount: r.FIELD_COUNT,
    }));
  });
}

export async function createVersion(tenant: string, label: string, cloneFrom?: number): Promise<number> {
  return withConnection(async (conn) => {
    const ins = await conn.execute<any>(
      `INSERT INTO LAYOUT_VERSION (TENANT_ID, LABEL, STATUS) VALUES (:t, :label, 'DRAFT')
         RETURNING VERSION_ID INTO :id`,
      { t: tenant, label, id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } }
    );
    const newId = ins.outBinds.id[0] as number;
    if (cloneFrom) {
      await conn.execute(
        `INSERT INTO FIELD_METADATA (TENANT_ID, LAYOUT_VERSION, ${FIELD_COLS})
         SELECT :t, :newId, ${FIELD_COLS} FROM FIELD_METADATA WHERE LAYOUT_VERSION = :src`,
        { t: tenant, newId, src: cloneFrom }
      );
    }
    await conn.commit();
    return newId;
  });
}

export async function activateVersion(tenant: string, versionId: number): Promise<void> {
  await withConnection(async (conn) => {
    const chk = await conn.execute<any>(
      `SELECT STATUS FROM LAYOUT_VERSION WHERE VERSION_ID = :id AND TENANT_ID = :t`,
      { id: versionId, t: tenant }
    );
    if (!chk.rows || chk.rows.length === 0) throw Object.assign(new Error("VERSION_NOT_FOUND"), { notFound: true });
    await conn.execute(`UPDATE LAYOUT_VERSION SET STATUS='RETIRED' WHERE TENANT_ID=:t AND STATUS='ACTIVE'`, { t: tenant });
    await conn.execute(`UPDATE LAYOUT_VERSION SET STATUS='ACTIVE' WHERE VERSION_ID=:id`, { id: versionId });
    await conn.commit();
  });
  clearCache();
}

// ---------------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------------

export interface BundleField {
  logicalName: string; jsonPath: string | null; storage: string; dataType: string;
  itemType: string | null; required: number; visible: number; editable: number;
  sensitive: number; maskStyle: string | null; displayOrder: number; label: string;
  labelI18n: any; section: string | null; validation: any; visibleWhen: any; active: number;
}
export interface LayoutBundle { formatVersion: number; sourceLabel: string; exportedAt: string; fields: BundleField[]; }

export async function exportVersion(versionId: number): Promise<LayoutBundle | null> {
  return withConnection(async (conn) => {
    const v = await conn.execute<any>(`SELECT LABEL FROM LAYOUT_VERSION WHERE VERSION_ID = :id`, { id: versionId });
    if (!v.rows || v.rows.length === 0) return null;
    const f = await conn.execute<any>(
      `SELECT LOGICAL_NAME, JSON_PATH, STORAGE, DATA_TYPE, ITEM_TYPE, REQUIRED, VISIBLE, EDITABLE,
              SENSITIVE, MASK_STYLE, DISPLAY_ORDER, LABEL, JSON_SERIALIZE(LABEL_I18N) AS LABEL_I18N,
              SECTION, JSON_SERIALIZE(VALIDATION) AS VALIDATION, JSON_SERIALIZE(VISIBLE_WHEN) AS VISIBLE_WHEN, ACTIVE
         FROM FIELD_METADATA WHERE LAYOUT_VERSION = :id ORDER BY DISPLAY_ORDER`,
      { id: versionId }
    );
    return {
      formatVersion: 1,
      sourceLabel: v.rows[0].LABEL,
      exportedAt: new Date().toISOString(),
      fields: (f.rows ?? []).map((r: any) => ({
        logicalName: r.LOGICAL_NAME, jsonPath: r.JSON_PATH, storage: r.STORAGE, dataType: r.DATA_TYPE,
        itemType: r.ITEM_TYPE, required: r.REQUIRED, visible: r.VISIBLE, editable: r.EDITABLE,
        sensitive: r.SENSITIVE, maskStyle: r.MASK_STYLE, displayOrder: r.DISPLAY_ORDER, label: r.LABEL,
        labelI18n: r.LABEL_I18N ? JSON.parse(r.LABEL_I18N) : null, section: r.SECTION,
        validation: r.VALIDATION ? JSON.parse(r.VALIDATION) : null,
        visibleWhen: r.VISIBLE_WHEN ? JSON.parse(r.VISIBLE_WHEN) : null, active: r.ACTIVE,
      })),
    };
  });
}

export async function importVersion(tenant: string, bundle: LayoutBundle, labelOverride?: string): Promise<{ versionId: number; fieldCount: number }> {
  if (!bundle || !Array.isArray(bundle.fields)) throw Object.assign(new Error("BUNDLE_INVALIDO"), { badBundle: true });
  const label = (labelOverride || `${bundle.sourceLabel || "Importado"} (importado)`).slice(0, 100);
  return withConnection(async (conn) => {
    const ins = await conn.execute<any>(
      `INSERT INTO LAYOUT_VERSION (TENANT_ID, LABEL, STATUS) VALUES (:t, :label, 'DRAFT') RETURNING VERSION_ID INTO :id`,
      { t: tenant, label, id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } }
    );
    const newId = ins.outBinds.id[0] as number;
    for (const f of bundle.fields) {
      await conn.execute(
        `INSERT INTO FIELD_METADATA (TENANT_ID, LAYOUT_VERSION, ${FIELD_COLS})
         VALUES (:t, :lv, :name, :path, :storage, :dtype, :itype, :req, :vis, :edt,
                 :sens, :mask, :ord, :label, :i18n, :section, :validation, :vw, :active)`,
        {
          t: tenant, lv: newId, name: f.logicalName, path: f.jsonPath ?? null, storage: f.storage || "DYNAMIC",
          dtype: f.dataType, itype: f.itemType ?? null, req: f.required ? 1 : 0, vis: f.visible ? 1 : 0, edt: f.editable ? 1 : 0,
          sens: f.sensitive ? 1 : 0, mask: f.maskStyle ?? null, ord: f.displayOrder ?? 100, label: f.label,
          i18n: f.labelI18n ? JSON.stringify(f.labelI18n) : null, section: f.section ?? null,
          validation: f.validation ? JSON.stringify(f.validation) : null, vw: f.visibleWhen ? JSON.stringify(f.visibleWhen) : null,
          active: f.active ? 1 : 0,
        }
      );
    }
    await conn.commit();
    return { versionId: newId, fieldCount: bundle.fields.length };
  });
}

// ---------------------------------------------------------------------------
// Diff / preview de conflitos
// ---------------------------------------------------------------------------

interface FieldSnapshot {
  logicalName: string; storage: string; dataType: string; required: number;
  visible: number; editable: number; displayOrder: number; label: string; section: string | null;
}

async function fieldsOf(versionId: number): Promise<Map<string, FieldSnapshot>> {
  return withConnection(async (conn) => {
    const res = await conn.execute<any>(
      `SELECT LOGICAL_NAME, STORAGE, DATA_TYPE, REQUIRED, VISIBLE, EDITABLE, DISPLAY_ORDER, LABEL, SECTION
         FROM FIELD_METADATA WHERE LAYOUT_VERSION = :v`,
      { v: versionId }
    );
    const map = new Map<string, FieldSnapshot>();
    for (const r of res.rows ?? []) {
      map.set(r.LOGICAL_NAME, {
        logicalName: r.LOGICAL_NAME, storage: r.STORAGE, dataType: r.DATA_TYPE, required: r.REQUIRED,
        visible: r.VISIBLE, editable: r.EDITABLE, displayOrder: r.DISPLAY_ORDER, label: r.LABEL, section: r.SECTION,
      });
    }
    return map;
  });
}

export interface VersionDiff {
  from: number; to: number; added: string[]; removed: string[];
  changed: Array<{ logicalName: string; changes: string[] }>;
}

const CMP_ATTRS: (keyof FieldSnapshot)[] = ["storage", "dataType", "required", "visible", "editable", "displayOrder", "label", "section"];

export async function diffVersions(from: number, to: number): Promise<VersionDiff> {
  const [a, b] = await Promise.all([fieldsOf(from), fieldsOf(to)]);
  const added: string[] = [], removed: string[] = [], changed: VersionDiff["changed"] = [];
  for (const name of b.keys()) if (!a.has(name)) added.push(name);
  for (const name of a.keys()) if (!b.has(name)) removed.push(name);
  for (const name of a.keys()) {
    if (!b.has(name)) continue;
    const fa = a.get(name)!, fb = b.get(name)!;
    const chgs = CMP_ATTRS.filter((k) => fa[k] !== fb[k]).map((k) => `${k}: ${fa[k]} -> ${fb[k]}`);
    if (chgs.length) changed.push({ logicalName: name, changes: chgs });
  }
  return { from, to, added, removed, changed };
}

export interface ImportPreview {
  against: number;
  summary: { added: number; removed: number; changed: number; conflicts: number };
  added: string[]; removed: string[];
  changed: Array<{ logicalName: string; changes: string[] }>;
  conflicts: Array<{ logicalName: string; reason: string }>;
}

export async function previewImport(bundle: LayoutBundle, against: number): Promise<ImportPreview> {
  if (!bundle || !Array.isArray(bundle.fields)) throw Object.assign(new Error("BUNDLE_INVALIDO"), { badBundle: true });
  const target = await fieldsOf(against);
  const incoming = new Map<string, FieldSnapshot>();
  for (const f of bundle.fields) {
    incoming.set(f.logicalName, {
      logicalName: f.logicalName, storage: f.storage, dataType: f.dataType,
      required: f.required ? 1 : 0, visible: f.visible ? 1 : 0, editable: f.editable ? 1 : 0,
      displayOrder: f.displayOrder, label: f.label, section: f.section,
    });
  }
  const added: string[] = [], removed: string[] = [];
  const changed: ImportPreview["changed"] = [], conflicts: ImportPreview["conflicts"] = [];
  for (const name of incoming.keys()) if (!target.has(name)) added.push(name);
  for (const name of target.keys()) if (!incoming.has(name)) removed.push(name);
  for (const name of incoming.keys()) {
    if (!target.has(name)) continue;
    const t = target.get(name)!, i = incoming.get(name)!;
    const chgs = CMP_ATTRS.filter((k) => t[k] !== i[k]).map((k) => `${k}: ${t[k]} -> ${i[k]}`);
    if (chgs.length) changed.push({ logicalName: name, changes: chgs });
    if (t.dataType !== i.dataType) conflicts.push({ logicalName: name, reason: `tipo muda de ${t.dataType} para ${i.dataType}` });
    if (t.storage !== i.storage) conflicts.push({ logicalName: name, reason: `storage muda de ${t.storage} para ${i.storage}` });
  }
  return {
    against,
    summary: { added: added.length, removed: removed.length, changed: changed.length, conflicts: conflicts.length },
    added, removed, changed, conflicts,
  };
}
