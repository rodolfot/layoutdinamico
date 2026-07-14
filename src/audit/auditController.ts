/**
 * GET /audit?entity=&action=&actor=&limit=  -> trilha de auditoria (do tenant).
 */
import { Router, Request, Response } from "express";
import { queryAudit } from "./auditRepo";
import { getTenant } from "./actor";

export const auditRouter = Router();

auditRouter.get("/audit", async (req: Request, res: Response) => {
  try {
    const rows = await queryAudit({
      tenant: getTenant(req),
      entity: req.query.entity as string | undefined,
      action: req.query.action as string | undefined,
      actor: req.query.actor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    return res.json({ count: rows.length, entries: rows });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: err?.message });
  }
});
