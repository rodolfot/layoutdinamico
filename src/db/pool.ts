/**
 * Pool de conexoes Oracle (oracledb) em modo Thin (nao precisa de Instant Client).
 */
import oracledb from "oracledb";
import dotenv from "dotenv";
import { currentTenant } from "../requestContext";

dotenv.config();

// Retorna linhas como objetos { COLUNA: valor } e materializa LOBs como strings.
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchAsString = [oracledb.CLOB];

let pool: oracledb.Pool | null = null;

export async function initPool(): Promise<oracledb.Pool> {
  if (pool) return pool;
  pool = await oracledb.createPool({
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectString: process.env.ORACLE_CONNECT_STRING,
    poolMin: 1,
    poolMax: 5,
  });
  return pool;
}

/**
 * Executa uma funcao com uma conexao emprestada do pool e a devolve ao final.
 * Antes de usar, aplica o tenant do contexto da requisicao no Oracle
 * (PKG_APP_CTX.SET_TENANT) para o VPD filtrar por tenant. Best-effort: se o
 * pacote ainda nao existe (ex.: durante as migrations), ignora.
 */
export async function withConnection<T>(
  fn: (conn: oracledb.Connection) => Promise<T>
): Promise<T> {
  const p = await initPool();
  const conn = await p.getConnection();
  try {
    const tenant = currentTenant();
    // seta (ou limpa, quando null) o contexto na sessao reutilizada do pool
    try {
      await conn.execute(`BEGIN PKG_APP_CTX.SET_TENANT(:t); END;`, { t: tenant });
    } catch {
      /* pacote pode nao existir ainda (durante migrate/reset) */
    }
    return await fn(conn);
  } finally {
    await conn.close();
  }
}

/** Verifica conectividade com o Oracle (para healthcheck profundo). */
export async function pingDb(): Promise<boolean> {
  try {
    return await withConnection(async (conn) => {
      await conn.execute("SELECT 1 FROM DUAL");
      return true;
    });
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.close(5);
    pool = null;
  }
}

export { oracledb };
