/**
 * Reset de DEV: dropa os objetos da aplicacao e re-aplica todas as migrations.
 * DESTRUTIVO - use so em desenvolvimento.  npm run db:reset
 */
import { withConnection, closePool } from "../src/db/pool";
import { runMigrations } from "./migrate";

// ordem: VPD primeiro, depois tabelas (dependencias de FK por ultimo o pai)
const DROPS = [
  `BEGIN DBMS_RLS.DROP_POLICY(USER, 'REGISTRO', 'REGISTRO_TENANT_ISO'); EXCEPTION WHEN OTHERS THEN NULL; END;`,
  `BEGIN DBMS_RLS.DROP_POLICY(USER, 'REGISTRO_HISTORY', 'HISTORY_TENANT_ISO'); EXCEPTION WHEN OTHERS THEN NULL; END;`,
  `BEGIN DBMS_RLS.DROP_POLICY(USER, 'AUDIT_LOG', 'AUDIT_TENANT_ISO'); EXCEPTION WHEN OTHERS THEN NULL; END;`,
  `BEGIN DBMS_RLS.DROP_POLICY(USER, 'IGNORED_FIELDS', 'IGNORED_TENANT_ISO'); EXCEPTION WHEN OTHERS THEN NULL; END;`,
  `DROP FUNCTION VPD_TENANT_PREDICATE`,
  `DROP CONTEXT APP_CTX`,
  `DROP PACKAGE PKG_APP_CTX`,
  `DROP TABLE APP_USER CASCADE CONSTRAINTS`,
  `DROP TABLE AUDIT_LOG CASCADE CONSTRAINTS`,
  `DROP TABLE IGNORED_FIELDS CASCADE CONSTRAINTS`,
  `DROP TABLE REGISTRO_HISTORY CASCADE CONSTRAINTS`,
  `DROP TABLE FIELD_METADATA CASCADE CONSTRAINTS`,
  `DROP TABLE REGISTRO CASCADE CONSTRAINTS`,
  `DROP TABLE LAYOUT_VERSION CASCADE CONSTRAINTS`,
  `DROP TABLE SCHEMA_MIGRATIONS CASCADE CONSTRAINTS`,
];

async function run() {
  await withConnection(async (conn) => {
    for (const stmt of DROPS) {
      try { await conn.execute(stmt); } catch { /* ignora se nao existe */ }
    }
    await conn.commit();
  });
  console.log("Objetos removidos. Reaplicando migrations...");
  await runMigrations();
  await closePool();
  console.log("Reset concluido.");
}

run().catch(async (err) => {
  console.error("Falha no reset:", err.message);
  await closePool();
  process.exit(1);
});
