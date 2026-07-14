/**
 * Acesso a APP_USER + verificacao de senha (bcrypt).
 */
import bcrypt from "bcryptjs";
import { withConnection } from "../db/pool";

export interface AppUser {
  username: string;
  tenant: string;
  roles: string[];
}

/** Autentica: retorna o usuario se a senha bater, senao null. */
export async function authenticateUser(tenant: string, username: string, password: string): Promise<AppUser | null> {
  return withConnection(async (conn) => {
    const res = await conn.execute<any>(
      `SELECT USERNAME, ROLES, PASSWORD_HASH FROM APP_USER
        WHERE TENANT_ID = :t AND USERNAME = :u AND ACTIVE = 1`,
      { t: tenant, u: username }
    );
    if (!res.rows || res.rows.length === 0) return null;
    const row = res.rows[0];
    const ok = await bcrypt.compare(password, row.PASSWORD_HASH);
    if (!ok) return null;
    return {
      username: row.USERNAME,
      tenant,
      roles: String(row.ROLES).split(",").map((r) => r.trim()).filter(Boolean),
    };
  });
}
