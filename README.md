# POC — Layout Dinâmico em Oracle (core + JSON + metadados)

Evolução de um produto legado de **layout fixo** (cada campo = uma coluna) para um modelo
**híbrido e extensível**, no qual adicionar um campo novo deixa de ser projeto (banco + backend + config)
e passa a ser **um cadastro de metadados**, dando autonomia ao cliente.

Stack: **Node.js + TypeScript + Express + oracledb** · **Oracle Database Free 23ai** (tipo `JSON` nativo).

---

## 1. Arquitetura proposta

Modelo **híbrido "core + dynamic + metadata-driven"**, com três pilares:

| Pilar | O que guarda | Onde |
|---|---|---|
| **Core** | Campos críticos do negócio (obrigatórios, com integridade forte) | Colunas fixas tipadas em `REGISTRO` |
| **Dynamic** | Campos opcionais, novos ou **desconhecidos** | Coluna `ATTRS JSON` em `REGISTRO` |
| **Metadados** | Contrato de cada campo (validação + exibição) | Tabela `FIELD_METADATA` |

```
                 ┌────────────────────────────────────────────┐
 POST /registros ─────────────►  API (Express + TS)            │
                 │  1. carrega METADADOS da versão ativa (cache)│
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
                                     e resolve o valor de cada campo
 GET /form-definition ───────────►  gera o schema do formulário a partir dos metadados
```

**Por que híbrido (recomendado) e não 100% EAV nem 100% JSON?**
- **Colunas fixas** nos campos críticos preservam integridade, FK, tipos, índices e o legado.
- **JSON** absorve o volátil/opcional/desconhecido **sem DDL por campo**.
- **Metadados** desacoplam validação e exibição do código → o cliente evolui o layout sem deploy.
- Trade-off vs **EAV puro** (tabela chave-valor): EAV é ainda mais flexível, mas consultas viram
  auto-joins caros e a tipagem some. JSON dá o mesmo ganho com SQL muito mais simples (`JSON_VALUE`,
  `JSON_TABLE`) e índices funcionais. **EAV fica como alternativa secundária** só se você precisar de
  histórico campo-a-campo ou milhares de atributos esparsos por linha.

---

## 2. Modelo de dados

```
LAYOUT_VERSION            REGISTRO                          FIELD_METADATA
──────────────            ─────────────────────────         ──────────────────────────────
VERSION_ID (PK)           ID (PK)                           FIELD_ID (PK)
LABEL                     CPF   (CORE, NOT NULL, UNIQUE)     LAYOUT_VERSION (FK)   ← versionamento
STATUS                    NOME  (CORE, NOT NULL)             LOGICAL_NAME  ("rendaMensal")
CREATED_AT                EMAIL (CORE, opcional)             JSON_PATH     ("$.rendaMensal" | null)
                          LAYOUT_VERSION (FK)                STORAGE       (CORE | DYNAMIC)
                          ATTRS (JSON dinâmicos)             DATA_TYPE     (STRING/NUMBER/BOOLEAN/DATE)
                          STATUS/CREATED_AT/UPDATED_AT       REQUIRED / VISIBLE / EDITABLE (0/1)
                                                             DISPLAY_ORDER / LABEL / SECTION
                                                             VALIDATION (JSON: regex,min,max,enum)
                                                             ACTIVE (0/1)
```

Ponto central: **`FIELD_METADATA` descreve tanto CORE quanto DYNAMIC**. A mesma engine valida e exibe
os dois — inclusive os campos legados. `STORAGE` diz de onde vem o valor (coluna ou JSON via `JSON_PATH`).

DDL completa em [migrations/V001__baseline.sql](migrations/V001__baseline.sql) (com a variante `CLOB + IS JSON` para Oracle 12c–19c comentada).

---

## 3. Como rodar

**Opção rápida (script único):**
```powershell
./setup.ps1        # Docker -> Oracle healthy -> .env -> npm install -> db:init -> dev
./setup.ps1 -ResetDb   # recria schema/seed do zero
./setup.ps1 -Down      # derruba container + volume
```

**Passo a passo:**
```bash
docker compose up -d       # 1. sobe Oracle Free 23ai (aguarde "healthy": docker compose ps)
cp .env.example .env       # 2. credenciais
# 2.1 grants de VPD (uma vez, como SYSDBA) - ver §18:
docker exec -i poc-oracle-free sqlplus -s "sys/oracle_sys_pw@localhost:1521/FREEPDB1 as sysdba" < scripts/grant-vpd.sql
npm install                # 3a. deps
npm run db:reset           #  3b. aplica migrations V001..V008 (dev)
npm run dev                # 4. API + UI (login em /ui/login.html)
# API: http://localhost:3000
```

**Deploy em container (API + banco, unificado):** a API tem `Dockerfile` (multi-stage) e um serviço `api`
no compose sob o profile `full`, que **só sobe após o Oracle ficar healthy** (`depends_on: service_healthy`)
e roda **`npm run migrate`** (forward-only: aplica só as migrations pendentes, sem apagar dados).
Num volume novo, aplique antes os **grants de VPD** (§18) ou a `V007` falhará.

```bash
docker compose --profile full up -d --build   # Oracle + API em containers
# home: http://localhost:3000/  (redireciona para o dashboard)
docker compose --profile full down            # derruba tudo
```

O fluxo de dev (só banco, `docker compose up -d`) permanece intacto — o serviço `api` não sobe sem o profile.

---

## 4. Exemplos de payload

**Request válido** ([examples/request.valid.json](examples/request.valid.json)) — obrigatórios + opcionais + **campos extras não cadastrados** (`corPreferida`, `instagram`):

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
curl -X POST localhost:3000/registros -H "Content-Type: application/json" \
     -d @examples/request.valid.json
# 201 { "id": 1, "unknownFieldsStored": ["corPreferida","instagram"] }
```

**Request inválido** ([examples/request.invalid.json](examples/request.invalid.json)) — sem `cpf`, `nome` curto, renda negativa, enum inválido:

```bash
curl -X POST localhost:3000/registros -H "Content-Type: application/json" \
     -d @examples/request.invalid.json
# 422
# { "error":"VALIDATION_FAILED", "errors":[
#     {"field":"cpf","message":"campo obrigatorio ausente"},
#     {"field":"nome","message":"valor/tamanho minimo: 3"},
#     {"field":"rendaMensal","message":"valor/tamanho minimo: 0"},
#     {"field":"estadoCivil","message":"valor deve ser um de: SOLTEIRO, CASADO, ..."} ]}
```

---

## 5. Fluxo de persistência

1. `POST /registros` → [registroService.createRegistro](src/registros/registroService.ts).
2. Carrega metadados da versão ativa (cache) → [metadataRepo](src/metadata/metadataRepo.ts).
3. Valida contra metadados → [validator](src/validation/validator.ts).
4. **Separa** o payload: chaves `CORE` viram colunas; **todo o resto** (dinâmicos conhecidos +
   desconhecidos) vai para o mapa `attrs`.
5. `INSERT` com `attrs` serializado na coluna `ATTRS JSON` → [registroRepo](src/registros/registroRepo.ts).
   **Nenhuma coluna nova é criada para campos extras.**

---

## 6. Fluxo de leitura para a tela

- `GET /registros/:id/view` → junta o registro com os metadados **`VISIBLE=1 AND ACTIVE=1`**, ordenados
  por `DISPLAY_ORDER`, e resolve cada valor (coluna se `CORE`, `attrs[key]` se `DYNAMIC`). Resposta em
  [examples/response.view.json](examples/response.view.json).
- `GET /form-definition` → devolve o **schema do formulário** (nome, label, tipo, required, editable,
  order, validação). A UI ([src/ui/index.html](src/ui/index.html)) monta os campos **sem nada fixo no HTML**.
- `GET /registros/:id` → registro cru (core + `attrs` completo, inclusive campos desconhecidos).
- `GET /dashboard` → visão consolidada (versão ativa, contadores, campos pendentes, auditoria recente)
  que alimenta a home. `GET /` redireciona para [ui/dashboard.html](src/ui/dashboard.html).

---

## 7. Estratégia de validação (dirigida por metadados)

| Regra | Comportamento |
|---|---|
| Campo **obrigatório** ausente/vazio | `422` com erro por campo |
| Campo **opcional conhecido** ausente | Aceito, não valida |
| Campo **desconhecido** (sem metadado) | Política `UNKNOWN_FIELDS_POLICY`: `passthrough` (grava no `ATTRS`) ou `reject` (`422`) |
| Tipo / `regex` / `min` / `max` / `enum` | Validados quando declarados em `VALIDATION` |

Código em [src/validation/validator.ts](src/validation/validator.ts).

---

## 8. Consultas SQL sobre JSON e indexação

Exemplos executáveis em [db/04_sample_queries.sql](db/04_sample_queries.sql):

```sql
-- extrair campo dinâmico tipado
SELECT ID, JSON_VALUE(ATTRS, '$.rendaMensal' RETURNING NUMBER) AS RENDA FROM REGISTRO;

-- filtrar quem tem o campo
SELECT ID FROM REGISTRO WHERE JSON_EXISTS(ATTRS, '$.rendaMensal');

-- projetar vários campos como colunas (BI/relatório)
SELECT r.ID, jt.renda, jt.estado_civil
FROM REGISTRO r,
     JSON_TABLE(r.ATTRS, '$' COLUMNS(
        renda NUMBER PATH '$.rendaMensal',
        estado_civil VARCHAR2(20) PATH '$.estadoCivil')) jt;
```

**Otimização de campos dinâmicos "quentes"** ([migrations/V002__indexes.sql](migrations/V002__indexes.sql)):
- **(A) Índice funcional** sobre `JSON_VALUE(ATTRS,'$.campo')` — recomendado para poucos campos muito filtrados.
- **(B) Coluna virtual** a partir do JSON + índice comum — deixa a query legível e é o passo natural de
  **promoção** do campo a "core".
- **(C/D) conceituais**: *JSON Search Index* (documento todo) e *Multivalue Index* (arrays).

**Teste de carga** (`npm run load:test`, `LOAD_N` configurável) — semeia N registros com `rendaMensal`
aleatória e compara o **mesmo filtro** com e sem o índice funcional. Exemplo real com 20 000 linhas:

```
COM indice funcional      2 ms
SEM indice (full scan)   10 ms      -> ~5x mais rapido
Plano: INDEX RANGE SCAN | IX_REG_RENDA
```

Confirma na prática que campos dinâmicos "quentes" devem ganhar índice funcional (ou promoção a coluna).
Script em [scripts/load-test.ts](scripts/load-test.ts).

---

## 9. Versionamento de layout

`LAYOUT_VERSION` referenciada em `REGISTRO` e `FIELD_METADATA`. Cada registro "lembra" com qual layout
foi criado; a leitura usa os metadados **daquela** versão. Assim você publica uma v2 (novos campos,
`VISIBLE` diferente) sem quebrar registros da v1. `GET /form-definition?version=N` renderiza qualquer versão.

**Ciclo de vida:** `DRAFT` (em edição) → `ACTIVE` (uma por vez; `getActiveLayoutVersion` usa a ACTIVE de
maior id) → `RETIRED` (aposentada ao ativar outra). Endpoints
([src/metadata/layoutVersionController.ts](src/metadata/layoutVersionController.ts)):

| Endpoint | Ação |
|---|---|
| `GET /layout-versions` | Lista versões (status + contagem de campos) e qual está ativa |
| `POST /layout-versions` | Cria `DRAFT`; com `cloneFrom` copia os metadados de outra versão |
| `POST /layout-versions/:id/activate` | Promove a `ACTIVE`; a anterior vira `RETIRED` |
| `GET /layout-versions/diff?from=&to=` | Compara duas versões: `added` / `removed` / `changed` |

**Tela:** [src/ui/versoes.html](src/ui/versoes.html) → `/ui/versoes.html` (criar/clonar, ativar, comparar).

Fluxo típico: clona a ativa → edita/adiciona campos na `DRAFT` → confere o `diff` → ativa. Registros
antigos permanecem íntegros porque são lidos com a versão em que foram criados (comprovado no smoke test).

**Export / Import (promover entre ambientes):** um layout vira um **bundle JSON portável** (sem ids do
ambiente de origem), que se importa em outro ambiente como uma nova `DRAFT` — revisada e ativada lá.

| Endpoint | Ação |
|---|---|
| `GET /layout-versions/:id/export` | Baixa o bundle (`formatVersion`, `sourceLabel`, `fields[]`) |
| `POST /layout-versions/import/preview` | **Simula** o import: `added/removed/changed` + `conflicts` contra a versão-base (sem gravar) |
| `POST /layout-versions/import` | Cria uma `DRAFT` a partir do bundle (`{ label?, bundle, against?, allowConflicts? }`); `422` se malformado |

O **round-trip é idêntico**: exportar uma versão e reimportá-la produz um layout sem diferenças
(`added/removed/changed` vazios) — verificado no smoke test. A importação nasce `DRAFT` (nunca ativa
sozinha) e é auditada como `CREATE_VERSION` com `details.imported=true`.

**Detecção de conflitos:** antes de trazer um layout, o `preview` compara o bundle com a versão-base do
destino (a ativa, por padrão) e marca **conflitos incompatíveis** — mudança de `dataType` ou `storage` de
um campo existente, que quebraria dados já gravados. Se houver conflito, o `import` retorna **`409`** e só
prossegue com `allowConflicts: true` (registrado na auditoria como `conflictsAccepted`). A tela
[versoes.html](src/ui/versoes.html) faz **Pré-visualizar → mostra diff/conflitos → Confirmar** (checkbox
obrigatório quando há conflito).

---

## 10. Compatibilidade com o legado — roteiro em etapas

0. **Coexistência (aditivo):** adicionar coluna `ATTRS JSON` + tabelas `FIELD_METADATA`/`LAYOUT_VERSION`.
   O legado continua lendo/gravando as colunas fixas — nada quebra.
1. **Espelhar o layout atual:** popular `FIELD_METADATA` com os campos hoje fixos como `STORAGE=CORE`
   (a config atual de "exibe?" vira `VISIBLE`). Comportamento idêntico.
2. **Roteamento por metadados:** a API passa a decidir CORE×DYNAMIC pela tabela; **campos novos entram
   como `DYNAMIC`** → cliente cadastra o campo (via governança/editor ou `POST /metadata`) e usa, **sem deploy**.
3. **Tela dinâmica:** trocar a tela de config fixa pela renderização via `/form-definition`.
4. **Promoção seletiva:** um campo dinâmico que "esquenta" (muito filtrado/relatado) vira coluna
   (virtual → física) + índice, atualizando `STORAGE`. Migração incremental, sem big-bang.

**Prova do requisito-chave (sem tocar banco/backend):** cadastre um campo novo e ele passa a valer na hora.
```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | jq -r .token)
curl -X POST localhost:3000/metadata -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"logicalName":"telefone","label":"Telefone","dataType":"STRING","validation":{"regex":"^[0-9]{10,11}$"}}'
curl localhost:3000/form-definition -H "Authorization: Bearer $TOKEN"   # "telefone" já aparece
curl -X POST localhost:3000/registros -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"cpf":"98765432100","nome":"Joao","telefone":"11999998888"}'  # validado e salvo no ATTRS
```

---

## 11. Governança de campos novos (aprovar / ignorar)

Fecha o ciclo: um campo desconhecido não fica solto no JSON para sempre — ele entra numa **fila de
pendentes** e um gestor decide o que fazer, tudo sem `ALTER TABLE` e sem deploy.

**Fluxo:** `campo desconhecido chega → gravado no ATTRS → detectado como pendente → Aprovar (vira
metadado configurado, passa a ser validado e exibido) ou Ignorar (sai da fila; o dado permanece)`.

**Endpoints** ([src/metadata/metadataController.ts](src/metadata/metadataController.ts)):

| Endpoint | Ação |
|---|---|
| `GET /pending-fields` | Lista chaves do `ATTRS` sem metadado e não ignoradas, com `occurrences`, `sample` e `inferredType` |
| `POST /metadata` | **Aprova**: cria `FIELD_METADATA` (`STORAGE=DYNAMIC`) e limpa o cache |
| `POST /ignored-fields` | **Ignora**: registra em `IGNORED_FIELDS` (não apaga o dado do `ATTRS`) |

**Tela:** [src/ui/governanca.html](src/ui/governanca.html) → `/ui/governanca.html`. Para cada pendente
mostra contagem/amostra/tipo inferido e um formulário (label, tipo, seção, ordem, visível/editável/obrigatório).

```bash
curl localhost:3000/pending-fields
# { "pending":[ {"logicalName":"corPreferida","occurrences":2,"sample":"azul","inferredType":"STRING"} ] }

curl -X POST localhost:3000/metadata -H "Content-Type: application/json" \
  -d '{"logicalName":"corPreferida","label":"Cor preferida","dataType":"STRING","displayOrder":200}'
# 201 -> a partir daqui "corPreferida" aparece em /form-definition e nas telas
```

Decisão de design: **Ignorar não destrói dado** — só remove da fila. Se mudarem de ideia, o valor ainda
está no `ATTRS` para aprovar depois. Tabela em [migrations/V003__governance.sql](migrations/V003__governance.sql).

---

## 12. Auditoria (quem fez o quê, e quando)

Toda operação de mutação relevante é registrada numa trilha **append-only** (`AUDIT_LOG`). O "quem"
vem do header `X-User` (na POC; em produção, do token autenticado).

**Ações auditadas:** `CREATE`/`UPDATE`/`DELETE` (registro), `READ_SENSITIVE` (acesso a dado sensível
revelado), `APPROVE_FIELD` / `IGNORE_FIELD` / `UPDATE_FIELD` / `DELETE_FIELD` (governança/editor),
`CREATE_VERSION` / `ACTIVATE_VERSION` (versionamento). Cada evento guarda ator, timestamp, entidade,
id afetado e `DETAILS` (JSON). **`READ_SENSITIVE`** (LGPD) só é gerado quando o dado é **efetivamente
revelado** (`X-Unmask: true`) — registra quem viu, quais campos e o `reqId`.

| Endpoint | Ação |
|---|---|
| `GET /audit?entity=&action=&actor=&limit=` | Consulta a trilha (filtros combináveis, mais recentes primeiro) |

- Log **best-effort**: falha ao auditar nunca quebra a operação de negócio ([auditRepo.ts](src/audit/auditRepo.ts)).
- Tabela e nota de imutabilidade (Immutable/Blockchain Table) em [migrations/V004__audit.sql](migrations/V004__audit.sql).
- **Tela:** [src/ui/auditoria.html](src/ui/auditoria.html) → `/ui/auditoria.html` (filtros por entidade/ação/ator).

```bash
curl -X POST localhost:3000/registros -H "X-User: maria.gestora" \
     -H "Content-Type: application/json" -d '{"cpf":"31122233399","nome":"Ana"}'
curl "localhost:3000/audit?actor=maria.gestora"
# { "count":1, "entries":[ {"actor":"maria.gestora","action":"CREATE","entity":"REGISTRO",...} ] }
```

---

## 13. Riscos, vantagens e limitações

**Vantagens**
- Autonomia do cliente: campo novo = configuração, não projeto.
- Zero-DDL por campo; legado preservado; UI data-driven.

**Riscos / limitações e mitigações**
- **"Lixão" de JSON** (dados sem governança): mitigado pela **fila de governança** (§11) + política de
  campos desconhecidos (`reject` em produção) + auditoria dos `unknownFieldsStored`.
- **Consulta/índice em JSON** exige cuidado: use índice funcional/coluna virtual por campo quente.
- **Tipagem fraca no JSON**: compensada pela validação por metadados na escrita.
- **Relatório/BI** sobre dinâmicos: use `JSON_TABLE`/views materializadas ou promova a coluna.
- **Trade-off central:** flexibilidade × governança — resolvido pela camada de metadados.

---

## 14. Estrutura do projeto

```
docker-compose.yml            # Oracle Free 23ai (+ serviço api sob profile "full")
Dockerfile / docker-entrypoint.sh  # imagem da API (multi-stage) + init idempotente
setup.ps1 / test-e2e.ps1      # sobe tudo · smoke test (PASS/FAIL das regras)
scripts/load-test.ts          # teste de carga: índice funcional x full scan
db/04_sample_queries.sql      # SQL de referência (JSON_VALUE/JSON_TABLE/JSON_EXISTS)
src/
  server.ts                  # bootstrap Express + serve /ui
  db/pool.ts                 # pool oracledb (thin)
  types.ts                   # RegistroCore (typed) + attrs Record<string,any> + FieldMetadata
  metadata/metadataRepo.ts   # metadados (cache) + versão ativa + governança (pending/approve/ignore)
  metadata/metadataController.ts     # GET /pending-fields · POST /metadata · POST /ignored-fields
  metadata/layoutVersionRepo.ts      # versões: list/create/clone/activate/diff
  metadata/layoutVersionController.ts # GET/POST /layout-versions · diff · activate
  validation/validator.ts    # validação dirigida por metadados (+ ARRAY/OBJECT)
  masking.ts                 # mascaramento LGPD + resolução de rótulo i18n
  logger.ts                  # logger estruturado (JSON lines)
  requestContext.ts          # AsyncLocalStorage (tenant/actor por request → VPD)
  auth/                      # jwt · userRepo (bcrypt) · authController (/auth/login) · middleware (authenticate/requireRole)
  registros/                 # repo (core+JSON, soft-delete, histórico) · service · controller
  forms/formController.ts    # GET /form-definition (i18n, visibleWhen, itemType)
  metadata/                  # metadataRepo/Controller (governança + editor) · layoutVersion*
  audit/                     # auditRepo · auditController · actor (X-User/X-Tenant/X-Unmask/lang)
  dashboard/dashboardController.ts  # GET /dashboard (estado consolidado)
  ui/dashboard.html          # home: indicadores + pendentes + auditoria recente
  ui/index.html              # cadastro (form dinâmico: ARRAY, condicional, marca sensível)
  ui/consulta.html           # consulta + view (máscara/unmask) + JSON bruto + histórico
  ui/governanca.html         # fila de aprovação de campos novos
  ui/versoes.html            # versões: criar/clonar/ativar/comparar/exportar/importar
  ui/editor.html             # editor de campos de versões DRAFT
  ui/auditoria.html          # trilha de auditoria com filtros
  ui/login.html · ui/auth.js # login (JWT no localStorage) + authFetch compartilhado
migrations/                  # V001…V008 (baseline, índices, seed, auth, VPD, tenant acme)
examples/                    # request válido/inválido · response da view · requests.http (catálogo)
scripts/migrate.ts · db-reset.ts · load-test.ts
```

**Telas** (interligadas, a partir da home): dashboard (home) → cadastro · consulta · governança ·
versões · **editor de campos** · auditoria.

> Nota de build: em `npm run dev` a UI é servida de `src/ui`. Para `npm run build` + `npm start`,
> copie `src/ui` para `dist/ui` (o `tsc` não copia assets estáticos).

---

## 15. SaaS (multi-tenant), LGPD e capacidades avançadas

Camada que aproxima a POC de um produto SaaS real. Contexto vem de headers (na POC; em produção,
derive do token/sessão): `X-Tenant` (cliente), `X-User` (ator), `X-Unmask` (papel autorizado a ver
dado sensível), `?lang=` (idioma).

### Multi-tenant
`TENANT_ID` em todas as tabelas (`REGISTRO`, `LAYOUT_VERSION`, `FIELD_METADATA`, `IGNORED_FIELDS`,
`AUDIT_LOG`, `REGISTRO_HISTORY`). Cada tenant tem **seu próprio layout ativo** e vê **só os seus dados** —
toda query é escopada por `X-Tenant`. CPF é único **por tenant** (`UNIQUE (TENANT_ID, CPF)`).

### Mascaramento de dados sensíveis (LGPD)
Metadado por campo: `SENSITIVE` + `MASK_STYLE` (`cpf` | `email` | `partial` | `full`). A leitura
(`/view` e `/registros/:id`) **mascara por padrão**; só revela com `X-Unmask: true`. Lógica em
[src/masking.ts](src/masking.ts).

```bash
curl localhost:3000/registros/1/view -H "X-Tenant: default"
#  CPF -> "*******8901"   E-mail -> "m**********@example.com"   Renda -> "****"
curl localhost:3000/registros/1/view -H "X-Tenant: default" -H "X-Unmask: true"
#  valores reais (papel autorizado)
```

### i18n de rótulos
`LABEL_I18N` (JSON `{pt,en,...}`) por campo; `/form-definition?lang=en` e `/view?lang=en` resolvem o
rótulo com fallback para `LABEL`.

### Campos compostos / listas
`DATA_TYPE` estendido com `ARRAY` (+ `ITEM_TYPE`) e `OBJECT`. Validação por item (`itemRegex`) no
[validator](src/validation/validator.ts); arrays no JSON ganham **multivalue index**
(`IX_REG_TELEFONES`, [migrations/V002__indexes.sql](migrations/V002__indexes.sql)) para filtros de "contém".

### Regras condicionais (visibleWhen)
`VISIBLE_WHEN` (JSON `{field, equals}`): o campo só aparece quando outro campo tem o valor esperado.
Aplicado tanto no `/view` (servidor omite o campo) quanto no formulário dinâmico (mostra/esconde em
tempo real). Ex.: `nomeConjuge` só quando `estadoCivil = CASADO`.

### Soft-delete + histórico de registro
`REGISTRO.DELETED/DELETED_AT/DELETED_BY` (nunca apaga fisicamente; some das listas/leituras).
Cada `CREATE`/`UPDATE`/`DELETE` grava um **snapshot** em `REGISTRO_HISTORY` (append-only, `VERSION_NO`
incremental). Endpoints: `PUT /registros/:id`, `DELETE /registros/:id`, `GET /registros/:id/history`.

### Editor de campos de versões DRAFT
Edição visual do layout **só em versões `DRAFT`** (segurança: a ativa não muda por engano).
`GET /layout-versions/:id/fields` (todos os campos), `PUT /metadata/:fieldId`, `DELETE /metadata/:fieldId`
— com guarda **`409 ONLY_DRAFT_EDITABLE`** se a versão não for DRAFT. Tela [src/ui/editor.html](src/ui/editor.html)
(acessível pela linha da DRAFT em Versões). Fluxo: clona a ativa → edita campos na DRAFT → ativa.

### Cobertura
Todos os itens acima têm checks no smoke test ([test-e2e.ps1](test-e2e.ps1)) e exemplos
em [examples/requests.http](examples/requests.http) (blocos 33–46). Colunas novas no
[migrations/V001__baseline.sql](migrations/V001__baseline.sql); seed com campos sensíveis, i18n, lista e condicional em
[migrations/V005__seed_default_tenant.sql](migrations/V005__seed_default_tenant.sql).

---

## 16. Qualidade & operação

Endurecimento para aproximar de produção (smoke test **78 checks**, blocos `.http` 47–52):

| Recurso | Como funciona |
|---|---|
| **Auditoria de acesso sensível (LGPD)** | Ler dado sensível **revelado** (`X-Unmask: true`) gera `READ_SENSITIVE` na trilha, com ator, campos e `reqId`. Acesso mascarado **não** gera evento. |
| **Paginação** | `GET /registros?limit=&offset=` retorna `{ total, limit, offset, registros }` (default 50, máx 200) — não estoura mais com 20k+. |
| **Concorrência otimista** | `REGISTRO.ROW_VERSION` incrementa a cada update. `PUT` aceita `If-Match: <rowVersion>` (ou `body.expectedVersion`); versão divergente → **`409 VERSION_CONFLICT`** (evita lost update). |
| **Healthcheck profundo** | `GET /health` executa `SELECT 1 FROM DUAL`; retorna `503` se o Oracle cair (o healthcheck do container reflete isso). |
| **Logs estruturados + request-id** | Toda requisição gera uma linha JSON (`ts, level, msg, reqId, method, path, status, ms, tenant, actor`); `reqId` volta no header `X-Request-Id` e entra nas respostas de erro 500. [src/logger.ts](src/logger.ts). |
| **Hardening básico** | Limite de corpo (`256kb`) na API. |

> **Auth JWT + RBAC** e **isolamento reforçado (VPD)** foram implementados — ver §17. O contexto
> (tenant/actor/unmask) passou a vir do **token verificado**, não mais de headers.

---

## 17. Segurança: Auth JWT, RBAC e isolamento VPD

O contexto de segurança (**tenant**, **actor**, permissão de **unmask**) agora vem de um **JWT verificado**,
nunca de headers spoofáveis. Login em `POST /auth/login` → token; todas as rotas (exceto `/health`,
`/auth/login`, `/ui`) exigem `Authorization: Bearer <token>`.

**Usuários demo** (senha entre parênteses), por tenant, em [migrations/V006](migrations/V006__auth_users.sql):

| Usuário | Papéis | Pode |
|---|---|---|
| `admin` (admin123) | admin, editor, viewer, **pii** | tudo, incl. versionamento/editor e **ver dado sensível** |
| `editor` (editor123) | editor, viewer | criar/editar registros e governança; **não** revela sensível |
| `viewer` (viewer123) | viewer | somente leitura (mascarada) |

**RBAC** ([src/auth/middleware.ts](src/auth/middleware.ts)): `requireRole(...)` nas rotas —
escrita de registro exige `editor`/`admin`; versionamento e editor de campos exigem `admin`;
`unmask` de dado sensível exige o papel **`pii`**. Sem permissão → **`403`**; sem token → **`401`**.

**Isolamento reforçado (VPD / Row-Level Security)** ([migrations/V007](migrations/V007__vpd_tenant_isolation.sql)):
o Oracle injeta `TENANT_ID = <contexto>` em **toda** query sobre `REGISTRO`. O contexto é setado por um
pacote confiável (`PKG_APP_CTX`) a partir do tenant do token, propagado via `AsyncLocalStorage`
([src/requestContext.ts](src/requestContext.ts)) e aplicado no pool ([src/db/pool.ts](src/db/pool.ts)).
Provado: um `SELECT` sem `WHERE` só vê o tenant da sessão; `update_check` bloqueia gravar linha de outro
tenant (`ORA-28115`). Defesa em profundidade: mesmo um bug que esqueça o filtro no código não vaza dados.

> **Passo de DBA (uma vez):** o usuário do banco precisa de `GRANT CREATE ANY CONTEXT` e
> `GRANT EXECUTE ON DBMS_RLS` (VPD é operação privilegiada). Ver §18.

```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | jq -r .token)
curl localhost:3000/registros -H "Authorization: Bearer $TOKEN"
```

**Tela de login** [src/ui/login.html](src/ui/login.html): guarda o token no `localStorage`; todas as telas
usam [src/ui/auth.js](src/ui/auth.js) (`authFetch` injeta o Bearer e redireciona ao login em `401`).

---

## 18. Migrations reais (forward-only)

O schema é gerido por **migrations versionadas e não-destrutivas** em [migrations/](migrations/)
(`V001…V008`), rastreadas em `SCHEMA_MIGRATIONS`. Runner próprio ([scripts/migrate.ts](scripts/migrate.ts))
que entende SQL e blocos PL/SQL (para o VPD).

| Comando | Ação |
|---|---|
| `npm run migrate` | Aplica **apenas as migrations pendentes** (forward-only, idempotente) — é o que o container roda no start |
| `npm run db:reset` | **DEV**: dropa tudo e reaplica do zero |
| `npm run db:init` | Alias de `db:reset` (conveniência de dev) |

O container ([docker-entrypoint.sh](docker-entrypoint.sh)) roda `migrate` no boot: sobe só o que falta,
sem apagar dados. Evoluir o schema = **adicionar `V009__...sql`**, nunca editar uma migration aplicada.

**Grants de VPD (DBA, uma vez por ambiente):**
```sql
-- como SYS/SYSTEM (SYSDBA para DBMS_RLS):
GRANT CREATE ANY CONTEXT, DROP ANY CONTEXT, CREATE PROCEDURE TO app;
GRANT EXECUTE ON SYS.DBMS_RLS TO app;      -- requer SYSDBA
GRANT EXECUTE ON SYS.DBMS_SESSION TO app;  -- requer SYSDBA
```
