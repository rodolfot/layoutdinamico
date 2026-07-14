/**
 * GET /form-definition?version=N&lang=pt
 * Schema do formulario a partir dos metadados (do tenant), com rotulo i18n,
 * tipo de item (listas), regra condicional (visibleWhen) e flag sensivel.
 */
import { Router, Request, Response } from "express";
import { getActiveLayoutVersion, getFields } from "../metadata/metadataRepo";
import { getTenant, getLang } from "../audit/actor";
import { resolveLabel } from "../masking";

export const formRouter = Router();

formRouter.get("/form-definition", async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  try {
    const version = req.query.version ? Number(req.query.version) : await getActiveLayoutVersion(tenant);
    const lang = getLang(req);
    const fields = await getFields(version);

    const formFields = fields
      .filter((f) => f.visible)
      .map((f) => ({
        name: f.logicalName,
        label: resolveLabel(f, lang),
        type: f.dataType,
        itemType: f.itemType,
        section: f.section,
        required: f.required,
        editable: f.editable,
        sensitive: f.sensitive,
        order: f.displayOrder,
        validation: f.validation ?? null,
        visibleWhen: f.visibleWhen ?? null,
      }));

    return res.json({ tenant, layoutVersion: version, lang, fields: formFields });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: err?.message });
  }
});
