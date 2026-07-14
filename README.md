# POC — Layout Dinâmico em Oracle (core + JSON + metadados)

Evolução de um produto legado de **layout fixo** (cada campo = uma coluna) para um modelo
**híbrido e extensível**, no qual adicionar um campo novo deixa de ser projeto (banco + backend + config)
e passa a ser **um cadastro de metadados**, dando autonomia ao cliente — evoluída até um **MVP SaaS
multi-tenant, LGPD-aware e auditável**.

Stack: **Node.js + TypeScript + Express + oracledb** · **Oracle Database Free 23ai** (tipo `JSON` nativo) ·
**JWT** para autenticação · **Oracle VPD** para isolamento por tenant.

---

## 🚀 Início rápido (clone e rode)

Pré-requisito: **Docker Desktop** (ou Docker Engine + Compose).

```bash
git clone https://github.com/rodolfot/layoutdinamico.git
cd layoutdinamico
docker compose --profile full up -d --build
# 1º boot do Oracle leva ~2-3 min. Acompanhe: docker compose ps
```

Quando os containers estiverem *healthy*, abra **<http://localhost:3000>** e entre:

| Usuário | Senha | Perfil |
|---|---|---|
| `admin` | `admin123` | tudo + vê dados sensíveis (papel `pii`) |
| `editor` | `editor123` | cadastra/edita, **sem** ver sensível |
| `viewer` | `viewer123` | somente leitura (mascarado) |

- **Não precisa configurar nada.** O Compose orquestra, nesta ordem: `oracle` (healthy) →
  `grants` (aplica os privilégios de VPD como SYS) → `api` (roda as *migrations* e sobe).
- 📖 **Guia de uso visual** (passo a passo): <http://localhost:3000/ui/guia.html> · também em [GUIA-DE-USO.md](GUIA-DE-USO.md).
- Parar tudo: `docker compose --profile full down` (adicione `-v` para apagar os dados e recomeçar limpo).

**Desenvolvimento com hot reload** (API fora do container):

```bash
docker compose up -d                 # só o Oracle
# grants de VPD (uma vez, como SYSDBA):
docker exec -i poc-oracle-free sqlplus -s "sys/oracle_sys_pw@localhost:1521/FREEPDB1 as sysdba" < scripts/grant-vpd.sql
cp .env.example .env
npm install
npm run db:reset                     # aplica as migrations V001..V009
npm run dev                          # API + UI em http://localhost:3000
```

> No Windows há também `./setup.ps1` (faz Docker → Oracle → grants → migrations → dev num comando).

---

## 1. Arquitetura

Modelo **híbrido "core + dynamic + metadata-driven"**, com três pilares:

| Pilar | O que guarda | Onde |
|---|---|---|
| **Core** | Campos críticos do negócio (obrigatórios, integridade forte) | Colunas fixas tipadas em `REGISTRO` |
| **Dynamic** | Campos opcionais, novos ou **desconhecidos** | Coluna `ATTRS JSON` em `REGISTRO` |
| **Metadados** | Contrato de cada campo (validação + exibição) | Tabela `FIELD_METADATA` |

```
                 ┌────────────────────────────────────────────┐
 POST /registros ─────────────►  API (Express + TS)            │
   (Bearer JWT)  │  1. carrega METADADOS da versão ativa (cache)│
                 │  2. valida payload contra metadados          │
                 │  3. separa: CORE (colunas) x DYNAMIC (JSON)   │
                 │  4. persiste                                  │
                 └───────────────┬───────────────┬──────────────┘
                                 │               │
                        colunas fixas       coluna JSON (ATTRS)
                                 ▼               ▼
              ┌───────────────────────────────────────────────┐
              │  REGISTRO: ID, CPF, NOME, EMAIL | ATTRS(JSON)  │
              └───────────────────────────────────────────────┘
                                 ▲
 GET /registros/:id/view ────────┘  lê registro + metadados VISÍVEIS/ordenados
 GET /form-definition ───────────►  gera o schema do formulário a partir dos metadados
```

**Por que híbrido (recomendado) e não 100% EAV nem 100% JSON?**
- **Colunas fixas** nos campos críticos preservam integridade, FK, tipos, índices e o legado.
- **JSON** absorve o volátil/opcional/desconhecido **sem DDL por campo**.
- **Metadados** desacoplam validação e exibição do código → o cliente evolui o layout sem deploy.
- Trade-off vs **EAV puro**: EAV é ainda mais flexível, mas consultas viram auto-joins caros e a tipagem
  some. JSON dá o mesmo ganho com SQL muito mais simples (`JSON_VALUE`, `JSON_TABLE`) e índices
  funcionais. **EAV fica como alternativa secundária** só para histórico campo-a-campo ou milhares de
  atributos esparsos por linha.

---

## 2. Modelo de dados

Núcleo do modelo (todas as tabelas têm `TENANT_ID` para isolamento multi-tenant):

```
LAYOUT_VERSION            REGISTRO                          FIELD_METADATA
──────────────            ─────────────────────────         ──────────────────────────────
VERSION_ID (PK)           ID (PK)                           FIELD_ID (PK)
TENANT_ID                 TENANT_ID                         TENANT_ID / LAYOUT_VERSION (FK)
LABEL                     CPF   (CORE, UNIQUE p/ tenant)     LOGICAL_NAME  ("rendaMensal")
STATUS(DRAFT/ACTIVE/…)    NOME  (CORE, NOT NULL)             JSON_PATH · STORAGE (CORE|DYNAMIC)
CREATED_AT                EMAIL (CORE, opcional)             DATA_TYPE (STRING/NUMBER/BOOLEAN/DATE/ARRAY/OBJECT)
                          LAYOUT_VERSION (FK)                REQUIRED / VISIBLE / EDITABLE (0/1)
                          ATTRS (JSON dinâmicos)             SENSITIVE / MASK_STYLE   ← LGPD
                          ROW_VERSION (concorrência)         DISPLAY_ORDER / LABEL / LABEL_I18N / SECTION
                          DELETED/…  (soft-delete)           VALIDATION (JSON) / VISIBLE_WHEN (JSON) / ACTIVE
```

Tabelas de apoio: `REGISTRO_HISTORY` (snapshots), `IGNORED_FIELDS` (governança), `AUDIT_LOG` (trilha),
`APP_USER` (auth) e `SCHEMA_MIGRATIONS`. DDL completa versionada em [migrations/](migrations/) — a baseline
está em [V001__baseline.sql](migrations/V001__baseline.sql).

Ponto central: **`FIELD_METADATA` descreve tanto CORE quanto DYNAMIC**. A mesma engine valida e exibe os
dois — inclusive campos legados. `STORAGE` diz de onde vem o valor (coluna ou JSON via `JSON_PATH`).

---

## 3. Autenticação, RBAC e isolamento (VPD)

O contexto de segurança (**tenant**, **ator**, permissão de ver dado sensível) vem de um **JWT verificado**,
nunca de headers spoofáveis. Login em `POST /auth/login` → token; **todas** as rotas (exceto `/health`,
`/auth/login` e `/ui`) exigem `Authorization: Bearer <token>`.

```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H "Content-Type: application/json" \
  -d '{"tenant":"default","username":"admin","password":"admin123"}' | jq -r .token)
curl localhost:3000/registros -H "Authorization: Bearer $TOKEN"
```

**Papéis (RBAC)** — [src/auth/middleware.ts](src/auth/middleware.ts), usuários seed em
[V006](migrations/V006__auth_users.sql):

| Papel | Concede |
|---|---|
| `viewer` | leitura (dados sensíveis mascarados) |
| `editor` | criar/editar registros + governança |
| `admin` | versionamento, editor de layout, ativar versões |
| `pii` | **revelar** dados sensíveis (sem máscara) |

`requireRole(...)` nas rotas: escrita de registro exige `editor`/`admin`; versionamento e editor de campos
exigem `admin`. Sem permissão → **`403`**; sem token → **`401`**.

**Isolamento reforçado (VPD / Row-Level Security)** — [V007](migrations/V007__vpd_tenant_isolation.sql) +
[V009](migrations/V009__vpd_all_tenant_tables.sql): o Oracle injeta `TENANT_ID = <contexto>` em **toda**
query sobre `REGISTRO`, `REGISTRO_HISTORY`, `AUDIT_LOG` e `IGNORED_FIELDS`. O contexto é setado por um
pacote confiável (`PKG_APP_CTX`) a partir do tenant do token, propagado via `AsyncLocalStorage`
([src/requestContext.ts](src/requestContext.ts)) e aplicado no pool ([src/db/pool.ts](src/db/pool.ts)).
Provado: um `SELECT` sem `WHERE` só vê o tenant da sessão; `update_check` bloqueia gravar linha de outro
tenant (`ORA-28115`). Defesa em profundidade — mesmo um bug que esqueça o filtro no código não vaza dados.

> Os **grants de VPD** (`CREATE ANY CONTEXT`, `EXECUTE ON DBMS_RLS`) são privilégio de DBA. No Docker isso
> é **automático** (serviço `grants`). Fora do Docker, rode [scripts/grant-vpd.sql](scripts/grant-vpd.sql)
> como SYSDBA uma vez por ambiente.

**Tela de login** [src/ui/login.html](src/ui/login.html): guarda o token no `localStorage`; todas as telas
usam [src/ui/auth.js](src/ui/auth.js) (`authFetch` injeta o Bearer e redireciona ao login em `401`).

---

## 4. Exemplos de payload

**Request válido** ([examples/request.valid.json](examples/request.valid.json)) — obrigatórios + opcionais
+ **campos extras não cadastrados** (`corPreferida`, `instagram`):

```jsonc
{
  "cpf": "12345678901",       // CORE obrigatório
  "nome": "Maria Silva",       // CORE obrigatório
  "email": "maria@ex.com",     // CORE opcional
  "rendaMensal": 7500,          // DYNAMIC conhecido
  "estadoCivil": "CASADO",     // DYNAMIC conhecido (enum)
  "possuiVeiculo": true,        // DYNAMIC conhecido
  "corPreferida": "azul",      // DESCONHECIDO -> vai para ATTRS
  "instagram": "@maria.silva"  // DESCONHECIDO -> vai para ATTRS
}
```

```bash
curl -X POST localhost:3000/registros -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" -d @examples/request.valid.json
# 201 { "id": 1, "unknownFieldsStored": ["corPreferida","instagram"] }
```

`unknownFieldsStored` lista os campos que **não existem no layout** — aceitos e guardados no `ATTRS`, e que
viram **pendentes** na governança (§8). Pela tela de cadastro esse array é sempre vazio (o formulário só
oferece campos já configurados); ele enche quando um **campo novo chega por integração/API**.

**Request inválido** ([examples/request.invalid.json](examples/request.invalid.json)) → **`422`** com um
erro por campo (sem `cpf`, `nome` curto, renda negativa, enum inválido).

> Catálogo completo de requisições (com login + token) em [examples/requests.http](examples/requests.http)
> (REST Client do VS Code).

---

## 5. Fluxo de persistência e leitura

**Escrita** (`POST /registros`) — [registroService](src/registros/registroService.ts): carrega metadados
da versão ativa (cache) → valida ([validator](src/validation/validator.ts)) → **separa** CORE (colunas) de
DYNAMIC/desconhecidos (mapa `attrs`) → `INSERT` com `attrs` serializado na coluna `ATTRS JSON`.
**Nenhuma coluna nova é criada para campos extras.**

**Leitura para a tela:**
- `GET /registros/:id/view` → junta o registro com os metadados **`VISIBLE=1 AND ACTIVE=1`**, ordenados por
  `DISPLAY_ORDER`, resolve cada valor (coluna se CORE, `attrs[key]` se DYNAMIC), aplica **máscara** (LGPD) e
  **rótulo por idioma** (i18n) e respeita **condicionais** (`visibleWhen`).
- `GET /form-definition` → **schema do formulário**; a UI monta os campos **sem nada fixo no HTML**.
- `GET /registros/:id` → registro cru (core + `attrs`; sensíveis mascarados conforme o papel).
- `GET /registros/:id/history` → histórico de alterações do registro.
- `GET /dashboard` → visão consolidada (versão ativa, contadores, pendentes, auditoria recente); `GET /`
  redireciona para a home.

---

## 6. Validação (dirigida por metadados)

| Regra | Comportamento |
|---|---|
| Campo **obrigatório** ausente/vazio | `422` com erro por campo |
| Campo **opcional conhecido** ausente | Aceito, não valida |
| Campo **desconhecido** (sem metadado) | Política `UNKNOWN_FIELDS_POLICY`: `passthrough` (grava no `ATTRS`) ou `reject` (`422`) |
| Tipo / `regex` / `min` / `max` / `enum` | Validados quando declarados em `VALIDATION` |
| `ARRAY` (com `itemType`/`itemRegex`) e `OBJECT` | Validação por item / de forma |

Código em [src/validation/validator.ts](src/validation/validator.ts).

---

## 7. Multi-tenant, LGPD e capacidades de layout

**Multi-tenant** — `TENANT_ID` em todas as tabelas; cada tenant tem **seu próprio layout ativo** e vê **só
os seus dados** (garantido no banco pelo VPD, §3). CPF é único **por tenant**. O seed traz dois tenants:
`default` e `acme`.

**Mascaramento LGPD** — metadado por campo `SENSITIVE` + `MASK_STYLE` (`cpf` | `email` | `partial` |
`full`). A leitura **mascara por padrão**; só revela para quem tem o papel `pii`. Lógica em
[src/masking.ts](src/masking.ts). Todo acesso **revelado** gera um evento `READ_SENSITIVE` na auditoria (§9).

```bash
# viewer (sem pii) -> mascarado ;  admin (com pii) -> revelado
curl localhost:3000/registros/1/view -H "Authorization: Bearer $VIEWER_TOKEN"
#  CPF "*******8901"  ·  E-mail "m**********@ex.com"  ·  Renda "****"
curl localhost:3000/registros/1/view -H "Authorization: Bearer $ADMIN_TOKEN"
#  valores reais + gera READ_SENSITIVE na trilha
```

**i18n de rótulos** — `LABEL_I18N` (JSON `{pt,en,…}`); `/form-definition?lang=en` e `/view?lang=en`
resolvem o rótulo com fallback para `LABEL`.

**Campos compostos / listas** — `ARRAY` (+ `ITEM_TYPE`) e `OBJECT`; arrays no JSON ganham **multivalue
index** (`IX_REG_TELEFONES`, [V002](migrations/V002__indexes.sql)) para filtros de "contém".

**Condicionais** — `VISIBLE_WHEN` (`{field, equals}`): o campo só aparece quando outro campo tem o valor
esperado, tanto no `/view` (servidor omite) quanto no formulário (mostra/esconde em tempo real).
Ex.: `nomeConjuge` só quando `estadoCivil = CASADO`.

**Soft-delete + histórico + concorrência** — `DELETED/DELETED_AT/DELETED_BY` (nunca apaga fisicamente);
cada `CREATE`/`UPDATE`/`DELETE` grava snapshot em `REGISTRO_HISTORY`; `ROW_VERSION` dá **concorrência
otimista** (`PUT` com `If-Match: <rowVersion>` → `409 VERSION_CONFLICT` em divergência).

---

## 8. Governança de campos novos (aprovar / ignorar)

Fecha o ciclo: um campo desconhecido não fica solto no JSON para sempre — entra numa **fila de pendentes**
e um gestor decide, sem `ALTER TABLE` e sem deploy.

**Fluxo:** `campo desconhecido chega (integração) → gravado no ATTRS → detectado como pendente →
Aprovar (vira metadado configurado, passa a ser validado e exibido) ou Ignorar (sai da fila; o dado permanece)`.

| Endpoint | Papel | Ação |
|---|---|---|
| `GET /pending-fields` | editor/admin | Lista chaves do `ATTRS` sem metadado nem ignoradas (`occurrences`, `sample`, `inferredType`) |
| `POST /metadata` | editor/admin | **Aprova**: cria `FIELD_METADATA` (`DYNAMIC`) e limpa o cache |
| `POST /ignored-fields` | editor/admin | **Ignora**: registra em `IGNORED_FIELDS` (não apaga o `ATTRS`) |

**Tela:** [src/ui/governanca.html](src/ui/governanca.html). Decisão de design: **Ignorar não destrói dado**
— só remove da fila. Ver [V003](migrations/V003__governance.sql).

---

## 9. Versionamento de layout (+ export/import + conflitos)

`LAYOUT_VERSION` referenciada em `REGISTRO` e `FIELD_METADATA`. Cada registro "lembra" com qual layout foi
criado; a leitura usa os metadados **daquela** versão — publicar uma v2 não quebra registros da v1.
Ciclo de vida: `DRAFT` → `ACTIVE` (uma por vez) → `RETIRED`.

| Endpoint | Papel | Ação |
|---|---|---|
| `GET /layout-versions` | qualquer | Lista versões (status + contagem) e a ativa |
| `POST /layout-versions` | admin | Cria `DRAFT`; com `cloneFrom` copia os metadados |
| `POST /layout-versions/:id/activate` | admin | Promove a `ACTIVE`; a anterior vira `RETIRED` |
| `GET /layout-versions/diff?from=&to=` | qualquer | Compara versões: `added`/`removed`/`changed` |
| `GET /layout-versions/:id/export` | qualquer | Baixa o layout como **bundle JSON portável** |
| `POST /layout-versions/import/preview` | admin | Simula: diff + **conflitos** vs. a versão-base (sem gravar) |
| `POST /layout-versions/import` | admin | Cria `DRAFT` a partir do bundle; **`409`** se houver conflito sem `allowConflicts` |

**Tela:** [src/ui/versoes.html](src/ui/versoes.html) — criar/clonar, ativar, comparar, exportar/importar.
Fluxo típico: clona a ativa → edita a `DRAFT` (§10) → confere o `diff` → ativa.

**Export/Import** promove um layout entre ambientes (bundle sem ids de origem, importado como `DRAFT`).
O **round-trip é idêntico** (verificado no smoke test). **Detecção de conflitos:** mudança de `dataType`/
`storage` de um campo existente (que quebraria dados) → `import` bloqueia com `409`, só prosseguindo com
`allowConflicts: true` (auditado como `conflictsAccepted`).

---

## 10. Editor de layout (versões DRAFT)

Edição visual do layout **só em versões `DRAFT`** (a ativa fica somente leitura, para não mudar por engano
o que está no ar). Endpoints (todos `admin`):

| Endpoint | Ação |
|---|---|
| `GET /layout-versions/:id/fields` | Todos os campos da versão (inclui invisíveis/inativos) |
| `PUT /metadata/:fieldId` | Edita um campo — **`409 ONLY_DRAFT_EDITABLE`** se a versão não for DRAFT |
| `DELETE /metadata/:fieldId` | Remove um campo (só DRAFT) |

**Tela:** [src/ui/editor.html](src/ui/editor.html) (acessível pela linha da DRAFT em Versões).

---

## 11. Auditoria (quem fez o quê, e quando)

Trilha **append-only** (`AUDIT_LOG`). O **ator** vem do token autenticado. Ações auditadas:
`CREATE`/`UPDATE`/`DELETE` (registro), **`READ_SENSITIVE`** (acesso a dado sensível revelado, LGPD),
`APPROVE_FIELD`/`IGNORE_FIELD`/`UPDATE_FIELD`/`DELETE_FIELD` (governança/editor),
`CREATE_VERSION`/`ACTIVATE_VERSION` (versionamento). Cada evento guarda ator, timestamp, entidade, id e
`DETAILS` (JSON).

| Endpoint | Ação |
|---|---|
| `GET /audit?entity=&action=&actor=&limit=` | Consulta a trilha (filtros combináveis, recentes primeiro) |

- **`READ_SENSITIVE`** só é gerado quando o dado é **efetivamente revelado** (usuário com papel `pii`) —
  registra quem viu, quais campos e o `reqId`.
- Log **best-effort**: falha ao auditar nunca quebra a operação ([auditRepo.ts](src/audit/auditRepo.ts)).
- Isolada por tenant (VPD). Nota de imutabilidade (Immutable/Blockchain Table) em [V004](migrations/V004__audit.sql).
- **Tela:** [src/ui/auditoria.html](src/ui/auditoria.html).

---

## 12. Consultas JSON, indexação e teste de carga

Exemplos executáveis em [db/04_sample_queries.sql](db/04_sample_queries.sql):

```sql
SELECT ID, JSON_VALUE(ATTRS, '$.rendaMensal' RETURNING NUMBER) AS RENDA FROM REGISTRO;
SELECT ID FROM REGISTRO WHERE JSON_EXISTS(ATTRS, '$.rendaMensal');
SELECT r.ID, jt.renda, jt.estado_civil
FROM REGISTRO r, JSON_TABLE(r.ATTRS, '$' COLUMNS(
   renda NUMBER PATH '$.rendaMensal', estado_civil VARCHAR2(20) PATH '$.estadoCivil')) jt;
```

**Otimização de campos dinâmicos "quentes"** ([V002](migrations/V002__indexes.sql)): (A) **índice funcional**
sobre `JSON_VALUE(...)`; (B) **coluna virtual** + índice (passo natural de "promoção" a core); (C/D)
*JSON Search Index* e *Multivalue Index* (arrays).

**Teste de carga** (`npm run load:test`, `LOAD_N` configurável) — compara o mesmo filtro com e sem o índice
funcional. Exemplo real com 20 000 linhas: **2 ms (com índice) × 10 ms (full scan) ≈ 5×**, plano
`INDEX RANGE SCAN | IX_REG_RENDA`. Script em [scripts/load-test.ts](scripts/load-test.ts).

---

## 13. Qualidade & operação

| Recurso | Como funciona |
|---|---|
| **Auditoria de acesso sensível (LGPD)** | Revelar dado sensível gera `READ_SENSITIVE` (ator, campos, `reqId`); acesso mascarado **não** gera evento |
| **Paginação** | `GET /registros?limit=&offset=` → `{ total, limit, offset, registros }` (default 50, máx 200) |
| **Concorrência otimista** | `ROW_VERSION` + `If-Match`/`expectedVersion` → `409 VERSION_CONFLICT` em divergência |
| **Healthcheck profundo** | `GET /health` executa `SELECT 1 FROM DUAL`; `503` se o Oracle cair (reflete no healthcheck do container) |
| **Logs estruturados + request-id** | 1 linha JSON por requisição (`ts, level, reqId, method, path, status, ms, tenant, actor`); `X-Request-Id` no header ([src/logger.ts](src/logger.ts)) |
| **Hardening** | Limite de corpo (`256kb`); segredos fora do código |

**Smoke test** ([test-e2e.ps1](test-e2e.ps1)): **87 checks** cobrindo todas as regras acima (auth, RBAC,
VPD, mascaramento, governança, versionamento, import/conflitos, soft-delete/histórico, auditoria, etc.).

```powershell
./test-e2e.ps1     # 87 PASS / 0 FAIL
```

---

## 14. Migrations (forward-only)

Schema gerido por **migrations versionadas e não-destrutivas** em [migrations/](migrations/) (`V001…V009`),
rastreadas em `SCHEMA_MIGRATIONS`. Runner próprio ([scripts/migrate.ts](scripts/migrate.ts)) que entende
SQL e blocos PL/SQL (necessário para o VPD).

| Comando | Ação |
|---|---|
| `npm run migrate` | Aplica **apenas as migrations pendentes** (forward-only, idempotente) — é o que o container roda no boot |
| `npm run db:reset` | **DEV**: dropa tudo e reaplica do zero |
| `npm run db:init` | Alias de `db:reset` (conveniência) |

O container ([docker-entrypoint.sh](docker-entrypoint.sh)) roda `migrate` no start: aplica só o que falta,
sem apagar dados. Evoluir o schema = **adicionar `V010__...sql`**, nunca editar uma migration aplicada.

| Migration | Conteúdo |
|---|---|
| V001–V005 | baseline, índices, governança, auditoria, seed do tenant `default` |
| V006 | `APP_USER` + usuários demo (bcrypt) |
| V007 | VPD em `REGISTRO` (contexto + policy) |
| V008 | seed do 2º tenant (`acme`) |
| V009 | VPD nas demais tabelas (`REGISTRO_HISTORY`, `AUDIT_LOG`, `IGNORED_FIELDS`) |

---

## 15. Compatibilidade com o legado — roteiro em etapas

0. **Coexistência (aditivo):** adicionar coluna `ATTRS JSON` + tabelas de metadados. O legado continua
   lendo/gravando as colunas fixas — nada quebra.
1. **Espelhar o layout atual:** popular `FIELD_METADATA` com os campos fixos como `STORAGE=CORE`.
2. **Roteamento por metadados:** a API decide CORE×DYNAMIC pela tabela; **campos novos entram como
   `DYNAMIC`** → cliente cadastra o campo (governança/editor) e usa, **sem deploy**.
3. **Tela dinâmica:** trocar a config fixa pela renderização via `/form-definition`.
4. **Promoção seletiva:** um campo dinâmico "quente" vira coluna (virtual → física) + índice, atualizando
   `STORAGE`. Migração incremental, sem big-bang.

**Prova do requisito-chave (sem tocar banco/backend):**

```bash
curl -X POST localhost:3000/metadata -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"logicalName":"telefone","label":"Telefone","dataType":"STRING","validation":{"regex":"^[0-9]{10,11}$"}}'
curl localhost:3000/form-definition -H "Authorization: Bearer $TOKEN"   # "telefone" já aparece
curl -X POST localhost:3000/registros -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"cpf":"98765432100","nome":"Joao","telefone":"11999998888"}'  # validado e salvo
```

---

## 16. Riscos, vantagens e limitações

**Vantagens:** autonomia do cliente (campo novo = configuração, não projeto); zero-DDL por campo; legado
preservado; UI data-driven; isolamento multi-tenant garantido no banco.

**Riscos / mitigações:**
- **"Lixão" de JSON** → fila de governança + política `reject` em produção + auditoria dos extras.
- **Consulta/índice em JSON** → índice funcional/coluna virtual por campo quente.
- **Tipagem fraca no JSON** → validação por metadados na escrita.
- **BI sobre dinâmicos** → `JSON_TABLE`/views ou promoção a coluna.
- **VPD** exige privilégio de DBA (automatizado no Docker; manual fora dele).
- **Trade-off central:** flexibilidade × governança — resolvido pela camada de metadados.

**Próximos passos possíveis:** testes unitários + CI (GitHub Actions), OpenAPI/Swagger, VPD também em
`LAYOUT_VERSION`/`FIELD_METADATA`, e chaves assimétricas (RS256) para o JWT.

---

## 17. Estrutura do projeto

```
docker-compose.yml            # Oracle + serviço "grants" (VPD) + "api" (profile "full")
Dockerfile · docker-entrypoint.sh   # imagem da API (multi-stage) + migrate no boot
setup.ps1 · test-e2e.ps1      # sobe tudo (Windows) · smoke test (87 checks)
migrations/                   # V001…V009 (baseline, índices, seed, auth, VPD, tenant acme)
scripts/                      # migrate · db-reset · grant-vpd.sql · load-test
db/04_sample_queries.sql      # SQL de referência (JSON_VALUE/JSON_TABLE/JSON_EXISTS)
examples/                     # request válido/inválido · response da view · requests.http
src/
  server.ts                   # bootstrap Express + auth global + request-id + serve /ui
  db/pool.ts                  # pool oracledb (thin) + set do contexto de tenant (VPD)
  requestContext.ts           # AsyncLocalStorage (tenant/actor por request)
  logger.ts · masking.ts      # logs estruturados · mascaramento LGPD + i18n
  types.ts                    # RegistroCore (typed) + attrs Record<string,any> + FieldMetadata
  auth/                       # jwt · userRepo (bcrypt) · authController (/auth/login) · middleware (authenticate/requireRole)
  validation/validator.ts     # validação dirigida por metadados (+ ARRAY/OBJECT)
  registros/                  # repo (core+JSON, soft-delete, histórico) · service · controller
  metadata/                   # metadataRepo/Controller (governança + editor) · layoutVersion*
  forms/formController.ts     # GET /form-definition (i18n, visibleWhen, itemType)
  audit/                      # auditRepo · auditController · actor (contexto do token)
  dashboard/dashboardController.ts    # GET /dashboard
  ui/  app.css · shell.js · auth.js   # design system + cabeçalho/menu + helper de auth
       login.html · dashboard.html · index.html (cadastro) · consulta.html
       governanca.html · versoes.html · editor.html · auditoria.html · guia.html
```

**Telas** (a partir da home, com menu unificado e tema claro/escuro):
login → dashboard · cadastro · consulta · governança · versões · editor · auditoria · guia.

---

Licença: [MIT](LICENSE).
