/**
 * Orquestracao de registro (multi-tenant).
 *   create/update: valida -> separa CORE x DYNAMIC -> persiste (+ historico)
 *   view: campos VISIVEIS (respeitando visibleWhen), rotulo i18n e mascara LGPD
 */
import { getActiveLayoutVersion, getFields } from "../metadata/metadataRepo";
import { validate, UnknownPolicy, ValidationResult } from "../validation/validator";
import {
  findById, insertRegistro, updateRegistro as repoUpdate, softDelete, getHistory,
  listRegistros, countRegistros, StoredRegistro, HistoryEntry,
} from "./registroRepo";
import { FieldMetadata, RegistroCore, RegistroInput, ViewField } from "../types";
import { maskValue, resolveLabel } from "../masking";

const CORE_KEYS = ["cpf", "nome", "email"];
const unknownPolicy = (process.env.UNKNOWN_FIELDS_POLICY as UnknownPolicy) || "passthrough";

export interface MutationResult {
  ok: boolean;
  id?: number;
  validation?: ValidationResult;
  notFound?: boolean;
  conflict?: boolean;
}

function splitPayload(input: RegistroInput, fields: FieldMetadata[]): { core: RegistroCore; attrs: Record<string, any> } {
  const coreFieldNames = new Set(fields.filter((f) => f.storage === "CORE").map((f) => f.logicalName));
  const core: RegistroCore = {
    cpf: String(input.cpf),
    nome: String(input.nome),
    email: input.email != null ? String(input.email) : undefined,
  };
  const attrs: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (coreFieldNames.has(key) || CORE_KEYS.includes(key)) continue;
    attrs[key] = value;
  }
  return { core, attrs };
}

export async function createRegistro(tenant: string, actor: string, input: RegistroInput): Promise<MutationResult> {
  const layoutVersion = await getActiveLayoutVersion(tenant);
  const fields = await getFields(layoutVersion);
  const validation = validate(input, fields, unknownPolicy);
  if (!validation.valid) return { ok: false, validation };
  const { core, attrs } = splitPayload(input, fields);
  const id = await insertRegistro(tenant, core, attrs, layoutVersion, actor);
  return { ok: true, id, validation };
}

export async function updateRegistro(
  tenant: string, actor: string, id: number, input: RegistroInput, expectedVersion?: number
): Promise<MutationResult> {
  const existing = await findById(tenant, id);
  if (!existing || existing.deleted) return { ok: false, notFound: true };
  const fields = await getFields(existing.layoutVersion);
  const validation = validate(input, fields, unknownPolicy);
  if (!validation.valid) return { ok: false, validation };
  const { core, attrs } = splitPayload(input, fields);
  const outcome = await repoUpdate(tenant, id, core, attrs, actor, expectedVersion);
  if (outcome === "ok") return { ok: true, id, validation };
  if (outcome === "conflict") return { ok: false, conflict: true };
  return { ok: false, notFound: true };
}

export async function deleteRegistro(tenant: string, actor: string, id: number): Promise<boolean> {
  return softDelete(tenant, id, actor);
}

function resolveValue(field: FieldMetadata, reg: StoredRegistro): any {
  if (field.storage === "CORE") return (reg as any)[field.logicalName];
  return reg.attrs[field.logicalName];
}

export interface ViewOptions {
  lang: string;
  unmask: boolean;
}

export interface RegistroView {
  rowVersion: number;
  fields: ViewField[];
  /** campos sensiveis efetivamente REVELADOS nesta leitura (para auditoria). */
  sensitiveRevealed: string[];
}

export async function getRegistroView(tenant: string, id: number, opts: ViewOptions): Promise<RegistroView | null> {
  const reg = await findById(tenant, id);
  if (!reg || reg.deleted) return null;
  const fields = await getFields(reg.layoutVersion);

  // valores brutos para avaliar condicoes (visibleWhen)
  const values: Record<string, any> = {};
  for (const f of fields) values[f.logicalName] = resolveValue(f, reg);

  const sensitiveRevealed: string[] = [];
  const viewFields = fields
    .filter((f) => f.visible)
    .filter((f) => !f.visibleWhen || values[f.visibleWhen.field] === f.visibleWhen.equals)
    .map((f) => {
      const raw = values[f.logicalName] ?? null;
      const masked = f.sensitive && !opts.unmask && raw != null;
      if (f.sensitive && !masked && raw != null) sensitiveRevealed.push(f.logicalName);
      return {
        logicalName: f.logicalName,
        label: resolveLabel(f, opts.lang),
        dataType: f.dataType,
        section: f.section,
        editable: f.editable,
        sensitive: f.sensitive,
        masked,
        displayOrder: f.displayOrder,
        value: masked ? maskValue(raw, f.maskStyle) : raw,
      };
    });

  return { rowVersion: reg.rowVersion, fields: viewFields, sensitiveRevealed };
}

export interface RawResult {
  data: any;
  sensitiveRevealed: string[];
}

/** Registro "cru" (core + attrs), com campos sensiveis mascarados (salvo unmask). */
export async function getRegistroRaw(tenant: string, id: number, opts: ViewOptions): Promise<RawResult | null> {
  const reg = await findById(tenant, id);
  if (!reg) return null;
  const fields = await getFields(reg.layoutVersion);
  const sensitive = new Map(fields.filter((f) => f.sensitive).map((f) => [f.logicalName, f.maskStyle]));
  const revealed: string[] = [];
  const mf = (name: string, val: any) => {
    if (!sensitive.has(name) || val == null) return val;
    if (opts.unmask) { revealed.push(name); return val; }
    return maskValue(val, sensitive.get(name)!);
  };
  const data = {
    id: reg.id, tenantId: reg.tenantId, deleted: reg.deleted, rowVersion: reg.rowVersion,
    cpf: mf("cpf", reg.cpf),
    nome: mf("nome", reg.nome),
    email: mf("email", reg.email),
    layoutVersion: reg.layoutVersion,
    attrs: Object.fromEntries(Object.entries(reg.attrs).map(([k, v]) => [k, mf(k, v)])),
  };
  return { data, sensitiveRevealed: revealed };
}

export { findById, listRegistros, countRegistros, getHistory };
export type { HistoryEntry };
