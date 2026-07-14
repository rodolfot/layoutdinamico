/**
 * Assinatura/verificacao de JWT. Em producao, use um segredo forte (env) e,
 * idealmente, chaves assimetricas (RS256) + rotacao.
 */
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "dev-secret-troque-em-producao";
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";

export interface AuthClaims {
  sub: string;      // username
  tenant: string;   // tenant do usuario
  roles: string[];  // papeis (admin/editor/viewer/pii)
}

export function signToken(claims: AuthClaims): string {
  const options: jwt.SignOptions = { expiresIn: EXPIRES_IN as any };
  return jwt.sign(claims, SECRET, options);
}

export function verifyToken(token: string): AuthClaims {
  const decoded = jwt.verify(token, SECRET) as any;
  return { sub: decoded.sub, tenant: decoded.tenant, roles: decoded.roles ?? [] };
}
