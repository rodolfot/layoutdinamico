/**
 * Governanca + edicao de campos.
 *   GET  /pending-fields         -> campos no ATTRS sem metadado (do tenant)
 *   POST /metadata               -> cria/aprova um campo (DYNAMIC)
 *   PUT  /metadata/:fieldId       -> edita um campo (apenas em versao DRAFT)
 *   DELETE /metadata/:fieldId     -> remove um campo (apenas em versao DRAFT)
 *   POST /ignored-fields          -> ignora um campo pendente
 */
import { Router, Request, Response } from "express";
import {
  getActiveLayoutVersion, getPendingFields, insertMetadata, updateMetadata,
  deleteMetadata, ignoreField, versionStatusOfField, NewFieldMetadata,
} from "./metadataRepo";
import { audit } from "../audit/auditRepo";
import { getActor, getTenant } from "../audit/actor";
import { requireRole } from "../auth/middleware";

export const metadataRouter = Router();
const canApprove = requireRole("editor", "admin");
const adminOnly = requireRole("admin");

metadataRouter.get("/pending-fields", async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  try {
    const version = req.query.version ? Number(req.query.version) : await getActiveLayoutVersion(tenant);
    const pending = await getPendingFields(tenant, version);
    return res.json({ layoutVersion: version, pending });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: err?.message });
  }
});

function fieldFromBody(body: any): NewFieldMetadata {
  return {
    logicalName: body.logicalName,
    label: body.label,
    dataType: body.dataType,
    itemType: body.itemType ?? null,
    required: !!body.required,
    visible: body.visible !== false,
    editable: body.editable !== false,
    sensitive: !!body.sensitive,
    maskStyle: body.maskStyle ?? null,
    displayOrder: Number(body.displayOrder ?? 100),
    section: body.section ?? null,
    labelI18n: body.labelI18n ?? null,
    validation: body.validation ?? null,
    visibleWhen: body.visibleWhen ?? null,
  };
}

metadataRouter.post("/metadata", canApprove, async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  try {
    const body = req.body ?? {};
    const version = body.layoutVersion ? Number(body.layoutVersion) : await getActiveLayoutVersion(tenant);
    if (!body.logicalName || !body.label || !body.dataType) {
      return res.status(422).json({ error: "VALIDATION_FAILED", errors: [{ field: "logicalName/label/dataType", message: "obrigatorios" }] });
    }
    const field = fieldFromBody(body);
    const fieldId = await insertMetadata(tenant, version, field);
    await audit({ tenant, actor: getActor(req), action: "APPROVE_FIELD", entity: "FIELD_METADATA", entityId: field.logicalName, details: { fieldId, layoutVersion: version, config: field } });
    return res.status(201).json({ fieldId, layoutVersion: version, approved: field.logicalName });
  } catch (err: any) {
    if (err?.errorNum === 1) return res.status(409).json({ error: "FIELD_ALREADY_EXISTS" });
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: err?.message });
  }
});

metadataRouter.put("/metadata/:fieldId", adminOnly, async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  const fieldId = Number(req.params.fieldId);
  try {
    const status = await versionStatusOfField(fieldId);
    if (status == null) return res.status(404).json({ error: "FIELD_NOT_FOUND" });
    if (status !== "DRAFT") return res.status(409).json({ error: "ONLY_DRAFT_EDITABLE", message: "So e possivel editar campos de uma versao DRAFT." });
    const ok = await updateMetadata(fieldId, req.body ?? {});
    if (!ok) return res.status(422).json({ error: "NADA_A_ATUALIZAR" });
    await audit({ tenant, actor: getActor(req), action: "UPDATE_FIELD", entity: "FIELD_METADATA", entityId: fieldId, details: req.body ?? {} });
    return res.json({ fieldId, updated: true });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: err?.message });
  }
});

metadataRouter.delete("/metadata/:fieldId", adminOnly, async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  const fieldId = Number(req.params.fieldId);
  try {
    const status = await versionStatusOfField(fieldId);
    if (status == null) return res.status(404).json({ error: "FIELD_NOT_FOUND" });
    if (status !== "DRAFT") return res.status(409).json({ error: "ONLY_DRAFT_EDITABLE" });
    await deleteMetadata(fieldId);
    await audit({ tenant, actor: getActor(req), action: "DELETE_FIELD", entity: "FIELD_METADATA", entityId: fieldId, details: null });
    return res.json({ fieldId, deleted: true });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: err?.message });
  }
});

metadataRouter.post("/ignored-fields", canApprove, async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  try {
    const version = req.body.layoutVersion ? Number(req.body.layoutVersion) : await getActiveLayoutVersion(tenant);
    const name = req.body.logicalName;
    if (!name) return res.status(422).json({ error: "logicalName obrigatorio" });
    await ignoreField(tenant, version, name);
    await audit({ tenant, actor: getActor(req), action: "IGNORE_FIELD", entity: "FIELD_METADATA", entityId: name, details: { layoutVersion: version } });
    return res.status(201).json({ ignored: name, layoutVersion: version });
  } catch (err: any) {
    if (err?.errorNum === 1) return res.status(409).json({ error: "ALREADY_IGNORED" });
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: err?.message });
  }
});
