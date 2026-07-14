/**
 * GET /dashboard -> visao consolidada do estado da POC (do tenant).
 */
import { Router, Request, Response } from "express";
import { getActiveLayoutVersion, getFields, getPendingFields } from "../metadata/metadataRepo";
import { listVersions } from "../metadata/layoutVersionRepo";
import { countRegistros } from "../registros/registroRepo";
import { queryAudit } from "../audit/auditRepo";
import { getTenant } from "../audit/actor";

export const dashboardRouter = Router();

dashboardRouter.get("/dashboard", async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  try {
    const active = await getActiveLayoutVersion(tenant);
    const [versions, fields, pending, registrosTotal, recentAudit] = await Promise.all([
      listVersions(tenant),
      getFields(active),
      getPendingFields(tenant, active),
      countRegistros(tenant),
      queryAudit({ tenant, limit: 8 }),
    ]);

    const activeRow = versions.find((v) => v.versionId === active);
    return res.json({
      tenant,
      activeVersion: {
        id: active,
        label: activeRow?.label ?? null,
        fieldCount: fields.length,
        visibleFields: fields.filter((f) => f.visible).length,
      },
      counts: {
        registros: registrosTotal,
        versions: versions.length,
        draftVersions: versions.filter((v) => v.status === "DRAFT").length,
        pendingFields: pending.length,
      },
      pending: pending.slice(0, 5),
      recentAudit,
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: err?.message });
  }
});
