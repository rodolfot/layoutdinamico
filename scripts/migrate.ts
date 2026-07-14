/**
 * Migrations reais (forward-only, nao-destrutivas).
 *   npm run migrate       -> aplica apenas as migrations pendentes
 *
 * - Cada arquivo migrations/Vxxx__nome.sql roda UMA vez (rastreado em SCHEMA_MIGRATIONS).
 * - Nunca faz DROP; evolucao de schema = nova migration.
 * - Suporta blocos PL/SQL terminados por "/" (para funcoes/policies do VPD).
 */
import fs from "fs";
import path from "path";
import { withConnection, closePool } from "../src/db/pool";

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

/** Divide o arquivo em statements: ";" para SQL, "/" (linha isolada) para PL/SQL. */
function parseStatements(sql: string): string[] {
  const out: string[] = [];
  const lines = sql.split(/\r?\n/);
  let buf: string[] = [];
  let inPlSql = false;

  // stripSemi=true so p/ SQL comum (CREATE TABLE/INSERT...); blocos PL/SQL
  // terminados por "/" PRECISAM manter o ";" final do "END nome;".
  const flush = (stripSemi: boolean) => {
    let s = buf.join("\n").trim();
    if (stripSemi) s = s.replace(/;\s*$/, "");
    if (s) out.push(s);
    buf = [];
  };

  for (const line of lines) {
    const t = line.trim();
    if (t === "/") { flush(false); inPlSql = false; continue; } // terminador SQL*Plus
    if (!inPlSql && /^\s*(BEGIN|DECLARE|CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE|PACKAGE|TRIGGER))/i.test(line)) {
      inPlSql = true;
    }
    if (inPlSql) { buf.push(line); continue; }
    if (t.startsWith("--") || t === "") { buf.push(line); continue; }
    buf.push(line);
    if (t.endsWith(";")) flush(true);
  }
  const tail = buf.join("\n").trim();
  if (tail) out.push(tail);
  return out.filter((s) => s.length > 0 && !/^(--|\s)*$/.test(s));
}

async function ensureMigrationsTable(conn: any): Promise<void> {
  try {
    await conn.execute(
      `CREATE TABLE SCHEMA_MIGRATIONS (
         VERSION    VARCHAR2(20) PRIMARY KEY,
         NAME       VARCHAR2(200) NOT NULL,
         APPLIED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
       )`
    );
  } catch (err: any) {
    if (err?.errorNum !== 955) throw err; // ORA-00955: name already used -> ja existe
  }
}

export async function runMigrations(): Promise<void> {
  if (!fs.existsSync(MIGRATIONS_DIR)) throw new Error(`Pasta migrations/ nao encontrada em ${MIGRATIONS_DIR}`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

  await withConnection(async (conn) => {
    await ensureMigrationsTable(conn);
    const appliedRes = await conn.execute<any>(`SELECT VERSION FROM SCHEMA_MIGRATIONS`);
    const applied = new Set((appliedRes.rows ?? []).map((r: any) => r.VERSION));

    let count = 0;
    for (const file of files) {
      const version = file.split("__")[0];
      if (applied.has(version)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      const statements = parseStatements(sql);
      console.log(`-> aplicando ${file} (${statements.length} statements)`);
      for (const stmt of statements) {
        try {
          await conn.execute(stmt);
        } catch (err: any) {
          console.error(`   ! erro em: ${stmt.slice(0, 90).replace(/\s+/g, " ")}...`);
          throw err; // aborta: migration falha nao pode ser registrada como aplicada
        }
      }
      await conn.execute(
        `INSERT INTO SCHEMA_MIGRATIONS (VERSION, NAME) VALUES (:v, :n)`,
        { v: version, n: file }
      );
      await conn.commit();
      count++;
    }
    console.log(count === 0 ? "Nada a aplicar (schema atualizado)." : `${count} migration(s) aplicada(s).`);
  });
}

// CLI: npm run migrate
if (require.main === module) {
  runMigrations()
    .then(() => closePool())
    .catch(async (err) => {
      console.error("Falha nas migrations:", err.message);
      await closePool();
      process.exit(1);
    });
}
