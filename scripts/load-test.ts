/**
 * Teste de carga para demonstrar o efeito do indice funcional em campo dinamico.
 *
 *   npm run load:test              # LOAD_N=20000 (default)
 *   LOAD_N=50000 npm run load:test
 *
 * O que faz:
 *   1. limpa registros de carga anteriores (NOME LIKE 'LOADTEST%')
 *   2. insere N registros com rendaMensal aleatoria no ATTRS (executeMany)
 *   3. coleta estatisticas (DBMS_STATS) p/ o otimizador
 *   4. mede o MESMO filtro por campo dinamico COM indice x SEM indice (hint NO_INDEX)
 *   5. mostra o plano de execucao (INDEX RANGE SCAN vs FULL)
 */
import { withConnection, closePool, oracledb } from "../src/db/pool";

const N = Number(process.env.LOAD_N ?? 20000);
const BATCH = 5000;
const THRESHOLD = 15000; // filtro: rendaMensal > 15000

const ESTADOS = ["SOLTEIRO", "CASADO", "DIVORCIADO", "VIUVO"];

async function activeVersion(conn: any): Promise<number> {
  const r = await conn.execute(
    `SELECT VERSION_ID FROM LAYOUT_VERSION WHERE STATUS='ACTIVE'
      ORDER BY VERSION_ID DESC FETCH FIRST 1 ROWS ONLY`
  );
  if (!r.rows?.length) throw new Error("sem versao ativa (rode o seed)");
  return r.rows[0].VERSION_ID;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ ms: number; result: T }> {
  const t0 = Date.now();
  const result = await fn();
  const ms = Date.now() - t0;
  console.log(`  ${label.padEnd(34)} ${ms.toString().padStart(6)} ms`);
  return { ms, result };
}

async function run() {
  await withConnection(async (conn) => {
    const lv = await activeVersion(conn);

    console.log(`\n== Seed de carga: ${N} registros (versao ativa #${lv}) ==`);
    await conn.execute(`DELETE FROM REGISTRO WHERE NOME LIKE 'LOADTEST%'`, {}, { autoCommit: true });

    const base = 20000000000; // 11 digitos, fora da faixa dos exemplos curtos
    const t0 = Date.now();
    let inserted = 0;
    for (let start = 0; start < N; start += BATCH) {
      const rows: any[] = [];
      for (let i = start; i < Math.min(start + BATCH, N); i++) {
        const renda = Math.floor(Math.random() * 20000);
        rows.push({
          cpf: String(base + i).slice(-11),
          nome: `LOADTEST-${i}`,
          lv,
          attrs: JSON.stringify({
            rendaMensal: renda,
            estadoCivil: ESTADOS[i % ESTADOS.length],
            tag: "LOADTEST",
          }),
        });
      }
      const res = await conn.executeMany(
        `INSERT INTO REGISTRO (CPF, NOME, LAYOUT_VERSION, ATTRS)
         VALUES (:cpf, :nome, :lv, :attrs)`,
        rows,
        {
          autoCommit: true,
          batchErrors: true, // ignora eventuais CPFs duplicados
          bindDefs: {
            cpf: { type: oracledb.STRING, maxSize: 11 },
            nome: { type: oracledb.STRING, maxSize: 200 },
            lv: { type: oracledb.NUMBER },
            attrs: { type: oracledb.STRING, maxSize: 4000 },
          },
        }
      );
      inserted += rows.length - (res.batchErrors?.length ?? 0);
    }
    console.log(`  inseridos ~${inserted} em ${Date.now() - t0} ms`);

    // Estatisticas para o otimizador escolher bem o plano.
    await conn.execute(
      `BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER, 'REGISTRO'); END;`
    );

    const totalRes = await conn.execute<any>(`SELECT COUNT(*) C FROM REGISTRO`);
    const total = totalRes.rows?.[0]?.C ?? 0;
    console.log(`\n== Consulta por campo dinamico (rendaMensal > ${THRESHOLD}) sobre ${total} linhas ==`);

    const qIndex =
      `SELECT COUNT(*) C FROM REGISTRO
        WHERE JSON_VALUE(ATTRS, '$.rendaMensal' RETURNING NUMBER) > :v`;
    const qNoIndex =
      `SELECT /*+ NO_INDEX(REGISTRO IX_REG_RENDA) */ COUNT(*) C FROM REGISTRO
        WHERE JSON_VALUE(ATTRS, '$.rendaMensal' RETURNING NUMBER) > :v`;

    // aquece cache
    await conn.execute(qIndex, { v: THRESHOLD });
    await conn.execute(qNoIndex, { v: THRESHOLD });

    const withIdx = await timed("COM indice funcional", () => conn.execute(qIndex, { v: THRESHOLD }));
    const noIdx = await timed("SEM indice (full scan)", () => conn.execute(qNoIndex, { v: THRESHOLD }));

    const matched = (withIdx.result as any).rows[0].C;
    const ratio = noIdx.ms > 0 && withIdx.ms > 0 ? (noIdx.ms / Math.max(withIdx.ms, 1)).toFixed(1) : "n/a";
    console.log(`\n  linhas que batem o filtro: ${matched}`);
    console.log(`  speedup aproximado (full/index): ${ratio}x`);

    // Plano de execucao da consulta COM indice
    console.log(`\n== Plano de execucao (consulta com indice) ==`);
    await conn.execute(`EXPLAIN PLAN FOR ${qIndex}`, { v: THRESHOLD });
    const plan = await conn.execute<any>(
      `SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, NULL, 'BASIC'))`
    );
    for (const r of plan.rows ?? []) console.log("  " + r.PLAN_TABLE_OUTPUT);
  });

  await closePool();
}

run().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
