import { Request } from "express";

/**
 * Contexto de seguranca derivado do TOKEN JWT verificado (req.auth), nunca de
 * headers spoofaveis. O middleware `authenticate` popula req.auth.
 */
interface AuthClaims { sub: string; tenant: string; roles: string[]; }
function claims(req: Request): AuthClaims | undefined { return (req as any).auth; }

/** Quem executou (username do token). */
export function getActor(req: Request): string {
  return claims(req)?.sub || "anonimo";
}

/** Tenant do usuario autenticado. */
export function getTenant(req: Request): string {
  return claims(req)?.tenant || "default";
}

/** Pode ver dado sensivel sem mascara? Requer o papel 'pii'. */
export function canUnmask(req: Request): boolean {
  return (claims(req)?.roles || []).includes("pii");
}

/** Idioma preferido para rotulos (i18n). ?lang=pt|en ou Accept-Language. */
export function getLang(req: Request): string {
  const q = (req.query.lang as string) || "";
  if (q) return q.slice(0, 5).toLowerCase();
  const al = req.header("Accept-Language") || "";
  return al.split(",")[0].split("-")[0].toLowerCase() || "pt";
}

/** Id de correlacao da requisicao (setado pelo middleware). */
export function getReqId(req: Request): string {
  return (req as any).reqId || "-";
}
