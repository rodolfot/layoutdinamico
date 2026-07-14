/**
 * Rotas de registro (multi-tenant, paginacao, concorrencia otimista,
 * auditoria de acesso a dado sensivel).
 */
import { Router, Request, Response } from "express";
import {
  createRegistro, updateRegistro, deleteRegistro,
  getRegistroView, getRegistroRaw, listRegistros, countRegistros, getHistory,
} from "./registroService";
import { audit } from "../audit/auditRepo";
import { getActor, getTenant, canUnmask, getLang, getReqId } from "../audit/actor";
import { requireRole } from "../auth/middleware";
import { logger } from "../logger";

export const registroRouter = Router();
const canWrite = requireRole("editor", "admin");

function fail(res: Response, req: Request, err: any) {
  logger.error("registro_error", { reqId: getReqId(req), detail: err?.message });
  return res.status(500).json({ error: "INTERNAL_ERROR", requestId: getReqId(req) });
}

registroRouter.get("/registros", async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const [rows, total] = await Promise.all([listRegistros(tenant, limit, offset), countRegistros(tenant)]);
  return res.json({ total, limit, offset, registros: rows });
});

registroRouter.post("/registros", canWrite, async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  try {
    const result = await createRegistro(tenant, getActor(req), req.body ?? {});
    if (!result.ok) return res.status(422).json({ error: "VALIDATION_FAILED", errors: result.validation?.errors ?? [] });
    await audit({ tenant, actor: getActor(req), action: "CREATE", entity: "REGISTRO", entityId: result.id, details: { unknownFieldsStored: result.validation?.unknownKeys ?? [] } });
    return res.status(201).json({ id: result.id, unknownFieldsStored: result.validation?.unknownKeys ?? [] });
  } catch (err: any) {
    if (err?.errorNum === 1) return res.status(409).json({ error: "CPF_DUPLICADO" });
    return fail(res, req, err);
  }
});

registroRouter.get("/registros/:id", async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  const raw = await getRegistroRaw(tenant, Number(req.params.id), { lang: getLang(req), unmask: canUnmask(req) });
  if (!raw) return res.status(404).json({ error: "NOT_FOUND" });
  if (raw.sensitiveRevealed.length > 0) {
    await audit({ tenant, actor: getActor(req), action: "READ_SENSITIVE", entity: "REGISTRO", entityId: Number(req.params.id), details: { via: "raw", fields: raw.sensitiveRevealed, reqId: getReqId(req) } });
  }
  return res.json(raw.data);
});

registroRouter.get("/registros/:id/view", async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  const view = await getRegistroView(tenant, Number(req.params.id), { lang: getLang(req), unmask: canUnmask(req) });
  if (!view) return res.status(404).json({ error: "NOT_FOUND" });
  if (view.sensitiveRevealed.length > 0) {
    await audit({ tenant, actor: getActor(req), action: "READ_SENSITIVE", entity: "REGISTRO", entityId: Number(req.params.id), details: { via: "view", fields: view.sensitiveRevealed, reqId: getReqId(req) } });
  }
  return res.json({ id: Number(req.params.id), rowVersion: view.rowVersion, fields: view.fields });
});

registroRouter.put("/registros/:id", canWrite, async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  try {
    // concorrencia otimista: If-Match header (ETag, aspas toleradas) ou body.expectedVersion
    const ifMatch = req.header("If-Match")?.replace(/"/g, "").trim();
    const expectedVersion = ifMatch ? Number(ifMatch)
      : (req.body?.expectedVersion != null ? Number(req.body.expectedVersion) : undefined);
    const result = await updateRegistro(tenant, getActor(req), Number(req.params.id), req.body ?? {}, expectedVersion);
    if (result.notFound) return res.status(404).json({ error: "NOT_FOUND" });
    if (result.conflict) return res.status(409).json({ error: "VERSION_CONFLICT", message: "O registro foi alterado por outra pessoa. Recarregue e tente de novo." });
    if (!result.ok) return res.status(422).json({ error: "VALIDATION_FAILED", errors: result.validation?.errors ?? [] });
    await audit({ tenant, actor: getActor(req), action: "UPDATE", entity: "REGISTRO", entityId: result.id, details: { expectedVersion: expectedVersion ?? null } });
    return res.json({ id: result.id, updated: true });
  } catch (err: any) {
    if (err?.errorNum === 1) return res.status(409).json({ error: "CPF_DUPLICADO" });
    return fail(res, req, err);
  }
});

registroRouter.delete("/registros/:id", canWrite, async (req: Request, res: Response) => {
  const tenant = getTenant(req);
  const ok = await deleteRegistro(tenant, getActor(req), Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "NOT_FOUND" });
  await audit({ tenant, actor: getActor(req), action: "DELETE", entity: "REGISTRO", entityId: Number(req.params.id), details: null });
  return res.json({ id: Number(req.params.id), deleted: true });
});

registroRouter.get("/registros/:id/history", async (req: Request, res: Response) => {
  const hist = await getHistory(getTenant(req), Number(req.params.id));
  return res.json({ id: Number(req.params.id), history: hist });
});
