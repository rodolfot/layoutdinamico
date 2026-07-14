/**
 * Middlewares de autenticacao (JWT) e autorizacao (RBAC).
 * O contexto (tenant/actor/roles) passa a vir do TOKEN verificado, nunca de
 * headers spoofaveis. Roda cada request dentro de um AsyncLocalStorage para
 * que a camada de dados aplique o tenant no Oracle (VPD).
 */
import { Request, Response, NextFunction } from "express";
import { verifyToken, AuthClaims } from "./jwt";
import { requestContext } from "../requestContext";

// caminhos publicos (sem token)
const PUBLIC_PREFIXES = ["/auth/login", "/health", "/ui", "/favicon"];

export function authenticate(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/" || PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();

  const header = req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "NAO_AUTENTICADO" });

  try {
    const claims: AuthClaims = verifyToken(token);
    (req as any).auth = claims;
    // executa o restante da request com o tenant no contexto (para o VPD)
    requestContext.run({ tenant: claims.tenant, actor: claims.sub }, () => next());
  } catch {
    return res.status(401).json({ error: "TOKEN_INVALIDO" });
  }
}

/** Exige que o usuario tenha ao menos um dos papeis. */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth: AuthClaims | undefined = (req as any).auth;
    if (!auth) return res.status(401).json({ error: "NAO_AUTENTICADO" });
    if (!roles.some((r) => auth.roles.includes(r))) {
      return res.status(403).json({ error: "SEM_PERMISSAO", required: roles, has: auth.roles });
    }
    next();
  };
}
