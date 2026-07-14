/**
 * POST /auth/login  { tenant?, username, password } -> { token, ... }
 * Rota PUBLICA (nao exige token).
 */
import { Router, Request, Response } from "express";
import { authenticateUser } from "./userRepo";
import { signToken } from "./jwt";
import { logger } from "../logger";

export const authRouter = Router();

authRouter.post("/auth/login", async (req: Request, res: Response) => {
  const tenant = (req.body?.tenant || "default").toString();
  const username = req.body?.username;
  const password = req.body?.password;
  if (!username || !password) {
    return res.status(422).json({ error: "username e password sao obrigatorios" });
  }
  try {
    const user = await authenticateUser(tenant, username, password);
    if (!user) {
      logger.warn("login_failed", { tenant, username, reqId: (req as any).reqId });
      return res.status(401).json({ error: "CREDENCIAIS_INVALIDAS" });
    }
    const token = signToken({ sub: user.username, tenant: user.tenant, roles: user.roles });
    logger.info("login_ok", { tenant, username, roles: user.roles, reqId: (req as any).reqId });
    return res.json({ token, tenant: user.tenant, username: user.username, roles: user.roles });
  } catch (err: any) {
    logger.error("login_error", { detail: err?.message, reqId: (req as any).reqId });
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
