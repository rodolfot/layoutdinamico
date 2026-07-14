/**
 * Versionamento de layout (multi-tenant).
 *   GET  /layout-versions               -> versoes do tenant
 *   GET  /layout-versions/:id/fields     -> todos os campos (editor de DRAFT)
 *   GET  /layout-versions/:id/export     -> bundle portavel
 *   POST /layout-versions/import/preview  -> diff + conflitos (sem gravar)
 *   POST /layout-versions/import          -> importa (cria DRAFT; 409 se conflito sem force)
 *   POST /layout-versions                 -> cria DRAFT (opcional cloneFrom)
 *   GET  /layout-versions/diff            -> diff entre 2 versoes
 *   POST /layout-versions/:id/activate    -> ativa
 */
import { Router, Request, Response } from "express";
import {
  listVersions, createVersion, activateVersion, diffVersions,
  exportVersion, importVersion, previewImport,
} from "./layoutVersionRepo";
import { getActiveLayoutVersion, getAllFields } from "./metadataRepo";
import { audit } from "../audit/auditRepo";
import { getActor, getTenant } from "../audit/actor";
import { requireRole } from "../auth/middleware";

export const layoutVersionRouter = Router();
const adminOnly = requireRole("admin");

layoutVersionRouter.get("/layout-versions", async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  try {
    const versions = await listVersions(tenant);
    const active = await getActiveLayoutVersion(tenant).catch(() => null);
    return res.json({ tenant, active, versions });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: err?.message });
  }
});

layoutVersionRouter.get("/layout-versions/diff", async (req: Request, res: Response) => {
  try {
    if (!req.query.from || !req.query.to) return res.status(422).json({ error: "informe from e to" });
    return res.json(await diffVersions(Number(req.query.from), Number(req.query.to)));
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: err?.message });
  }
});

// Todos os campos de uma versao (inclui invisiveis/inativos) para o editor.
layoutVersionRouter.get("/layout-versions/:id/fields", async (req: Request, res: Response) => {
  try {
    const fields = await getAllFields(Number(req.params.id));
    return res.json({ layoutVersion: Number(req.params.id), fields });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: err?.message });
  }
});

layoutVersionRouter.post("/layout-versions/import/preview", adminOnly, async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  try {
    const body = req.body ?? {};
    const bundle = Array.isArray(body.fields) ? body : body.bundle;
    const against = body.against ? Number(body.against) : await getActiveLayoutVersion(tenant);
    return res.json(await previewImport(bundle, against));
  } catch (err: any) {
    if (err?.badBundle) return res.status(422).json({ error: "BUNDLE_INVALIDO" });
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: err?.message });
  }
});

layoutVersionRouter.post("/layout-versions/import", adminOnly, async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  try {
    const body = req.body ?? {};
    const bundle = Array.isArray(body.fields) ? body : body.bundle;
    const against = body.against ? Number(body.against) : await getActiveLayoutVersion(tenant);
    const preview = await previewImport(bundle, against);
    if (preview.conflicts.length > 0 && body.allowConflicts !== true) {
      return res.status(409).json({ error: "IMPORT_CONFLICTS", message: "Import bloqueado por conflitos. Reenvie com allowConflicts=true.", conflicts: preview.conflicts, summary: preview.summary });
    }
    const result = await importVersion(tenant, bundle, body.label);
    await audit({ tenant, actor: getActor(req), action: "CREATE_VERSION", entity: "LAYOUT_VERSION", entityId: result.versionId, details: { imported: true, sourceLabel: bundle?.sourceLabel ?? null, fieldCount: result.fieldCount, conflictsAccepted: preview.conflicts.length } });
    return res.status(201).json({ status: "DRAFT", conflictsAccepted: preview.conflicts.length, ...result });
  } catch (err: any) {
    if (err?.badBundle) return res.status(422).json({ error: "BUNDLE_INVALIDO" });
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: err?.message });
  }
});

layoutVersionRouter.get("/layout-versions/:id/export", async (req: Request, res: Response) => {
  try {
    const bundle = await exportVersion(Number(req.params.id));
    if (!bundle) return res.status(404).json({ error: "VERSION_NOT_FOUND" });
    res.setHeader("Content-Disposition", `attachment; filename="layout-v${req.params.id}.json"`);
    return res.json(bundle);
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: err?.message });
  }
});

layoutVersionRouter.post("/layout-versions", adminOnly, async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  try {
    const label = req.body?.label;
    if (!label) return res.status(422).json({ error: "label obrigatorio" });
    const cloneFrom = req.body?.cloneFrom ? Number(req.body.cloneFrom) : undefined;
    const id = await createVersion(tenant, label, cloneFrom);
    await audit({ tenant, actor: getActor(req), action: "CREATE_VERSION", entity: "LAYOUT_VERSION", entityId: id, details: { label, clonedFrom: cloneFrom ?? null } });
    return res.status(201).json({ versionId: id, status: "DRAFT", clonedFrom: cloneFrom ?? null });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: err?.message });
  }
});

layoutVersionRouter.post("/layout-versions/:id/activate", adminOnly, async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  try {
    await activateVersion(tenant, Number(req.params.id));
    await audit({ tenant, actor: getActor(req), action: "ACTIVATE_VERSION", entity: "LAYOUT_VERSION", entityId: Number(req.params.id), details: null });
    return res.json({ activated: Number(req.params.id) });
  } catch (err: any) {
    if (err?.notFound) return res.status(404).json({ error: "VERSION_NOT_FOUND" });
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: err?.message });
  }
});
