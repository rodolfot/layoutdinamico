<#
  test-e2e.ps1 - Smoke test das regras da POC contra a API no ar.
  Requer: API rodando (npm run dev) e schema inicializado (npm run db:init).

  Uso:
    ./test-e2e.ps1                 # usa http://localhost:3000
    ./test-e2e.ps1 -Base http://host:porta

  Observacao: os testes usam CPFs proprios e toleram 409 (ja existente) em
  reexecucoes, entao pode rodar varias vezes sem resetar o banco.
#>
[CmdletBinding()]
param([string]$Base = "http://localhost:3000")

$script:pass = 0
$script:fail = 0

function Check($name, [bool]$cond, $detail = "") {
  if ($cond) { Write-Host "  PASS  $name" -ForegroundColor Green; $script:pass++ }
  else       { Write-Host "  FAIL  $name  $detail" -ForegroundColor Red; $script:fail++ }
}

# Autentica e usa Bearer token. admin tem todos os papeis (inclui 'pii' -> ve sensivel).
function Login($tenant, $u, $p) {
  try {
    (Invoke-RestMethod -Method Post "$Base/auth/login" -ContentType "application/json" `
      -Body (@{ tenant = $tenant; username = $u; password = $p } | ConvertTo-Json)).token
  } catch { $null }
}
$TOK_ADMIN  = Login "default" "admin"  "admin123"
$TOK_EDITOR = Login "default" "editor" "editor123"
$TOK_VIEWER = Login "default" "viewer" "viewer123"
$BASEH   = @{ Authorization = "Bearer $TOK_ADMIN" }   # padrao: admin (ve tudo)
$EDITORH = @{ Authorization = "Bearer $TOK_EDITOR" }
$VIEWERH = @{ Authorization = "Bearer $TOK_VIEWER" }

# Helper: POST que devolve @{ status; body } sem lancar em 4xx.
function Post($json) { return PostTo "/registros" $json }
function PostTo($path, $json, $headers = $BASEH) {
  try {
    $r = Invoke-WebRequest -Method Post "$Base$path" -ContentType "application/json" -Body $json -Headers $headers -SkipHttpErrorCheck
    return @{ status = [int]$r.StatusCode; body = ($r.Content | ConvertFrom-Json) }
  } catch {
    return @{ status = -1; body = $null }
  }
}
function Req($method, $path, $json, $headers = $BASEH) {
  $p = @{ Method = $method; Uri = "$Base$path"; Headers = $headers; SkipHttpErrorCheck = $true }
  if ($json) { $p.ContentType = "application/json"; $p.Body = $json }
  $r = Invoke-WebRequest @p
  return @{ status = [int]$r.StatusCode; body = ($r.Content | ConvertFrom-Json) }
}
function Get($path, $headers = $BASEH) { Invoke-RestMethod "$Base$path" -Headers $headers }

Write-Host "== Smoke test da POC ($Base) ==" -ForegroundColor Cyan

# Regra 1: obrigatorios validados + opcionais + extras aceitos
$cpf1 = "1" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)
$r1 = Post (@{ cpf=$cpf1; nome="Maria Teste"; email="m@ex.com"; rendaMensal=7500;
               estadoCivil="CASADO"; possuiVeiculo=$true; corPreferida="azul" } | ConvertTo-Json)
Check "POST valido retorna 201" ($r1.status -eq 201) "status=$($r1.status)"
Check "campo desconhecido 'corPreferida' vai para unknownFieldsStored" `
      ($r1.body.unknownFieldsStored -contains "corPreferida")
$id1 = $r1.body.id

# Regra 2: obrigatorio ausente -> 422
$r2 = Post (@{ nome="Jo"; rendaMensal=-100; estadoCivil="NAMORANDO" } | ConvertTo-Json)
Check "POST sem obrigatorio retorna 422" ($r2.status -eq 422) "status=$($r2.status)"
$fields422 = @($r2.body.errors.field)
Check "erro aponta 'cpf' obrigatorio" ($fields422 -contains "cpf")
Check "erro aponta 'estadoCivil' fora do enum" ($fields422 -contains "estadoCivil")
Check "erro aponta 'rendaMensal' min" ($fields422 -contains "rendaMensal")

# Regra 3: desconhecido persiste no ATTRS sem quebra
$raw = Get "/registros/$id1"
Check "campo desconhecido persistido em attrs" ($raw.attrs.corPreferida -eq "azul")
Check "campo dinamico conhecido persistido em attrs" ($raw.attrs.rendaMensal -eq 7500)
Check "campo core persistido em coluna" ($raw.cpf -eq $cpf1)

# Regra 4: view metadata-driven nao expoe desconhecido
$view = Get "/registros/$id1/view"
$viewNames = @($view.fields.logicalName)
Check "view inclui campo conhecido (rendaMensal)" ($viewNames -contains "rendaMensal")
Check "view NAO inclui desconhecido (corPreferida)" (-not ($viewNames -contains "corPreferida"))
$orders = @($view.fields.displayOrder)
$sorted = ($orders | Sort-Object) -join ","
Check "view ordenada por displayOrder" (($orders -join ",") -eq $sorted)

# Regra 5: form-definition gerado dos metadados
$form = Get "/form-definition"
Check "form-definition lista campos" ($form.fields.Count -ge 3)
Check "form marca cpf como required" (@($form.fields | Where-Object { $_.name -eq "cpf" }).required -eq $true)

# Regra extra: opcional ausente e aceito
$cpf3 = "2" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)
$r3 = Post (@{ cpf=$cpf3; nome="Somente Core" } | ConvertTo-Json)
Check "POST so com core (opcionais ausentes) retorna 201" ($r3.status -eq 201) "status=$($r3.status)"

# --- Governanca: descoberta -> APROVAR -------------------------------------
# Envia um campo desconhecido unico e valida o ciclo de aprovacao.
$novo = "campoNovo" + (Get-Random -Minimum 10000 -Maximum 99999)
$cpfG = "4" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)
$hg = @{ cpf = $cpfG; nome = "Gov Aprovar" }; $hg[$novo] = "valor-x"
$rg = Post ($hg | ConvertTo-Json)
Check "campo desconhecido reportado em unknownFieldsStored" ($rg.body.unknownFieldsStored -contains $novo)

$pend = (Get "/pending-fields").pending
Check "campo novo aparece em /pending-fields" (@($pend.logicalName) -contains $novo)
$sug = @($pend | Where-Object { $_.logicalName -eq $novo })[0]
Check "pending traz tipo inferido e amostra" ($sug.inferredType -eq "STRING" -and $sug.sample -eq "valor-x")

$appr = PostTo "/metadata" (@{ logicalName=$novo; label="Campo Novo"; dataType="STRING";
                               section="Novos"; displayOrder=200; visible=$true; editable=$true } | ConvertTo-Json)
Check "APROVAR campo retorna 201" ($appr.status -eq 201) "status=$($appr.status)"

$pend2 = (Get "/pending-fields").pending
Check "campo aprovado sai da lista de pendentes" (-not (@($pend2.logicalName) -contains $novo))
$formNames = @((Get "/form-definition").fields.name)
Check "campo aprovado aparece no /form-definition" ($formNames -contains $novo)

# --- Governanca: IGNORAR ---------------------------------------------------
$novo2 = "campoIgnora" + (Get-Random -Minimum 10000 -Maximum 99999)
$cpfI = "5" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)
$hi = @{ cpf = $cpfI; nome = "Gov Ignorar" }; $hi[$novo2] = "descartar"
$ri = Post ($hi | ConvertTo-Json)
$ign = PostTo "/ignored-fields" (@{ logicalName=$novo2 } | ConvertTo-Json)
Check "IGNORAR campo retorna 201" ($ign.status -eq 201) "status=$($ign.status)"

$pend3 = (Get "/pending-fields").pending
Check "campo ignorado sai da lista de pendentes" (-not (@($pend3.logicalName) -contains $novo2))
$rawI = Get "/registros/$($ri.body.id)"
Check "campo ignorado NAO e apagado (dado permanece no ATTRS)" ($rawI.attrs.$novo2 -eq "descartar")

# --- Versionamento de layout -----------------------------------------------
$lv = Get "/layout-versions"
$activeBefore = $lv.active
Check "existe uma versao ACTIVE" ($null -ne $activeBefore)

$cv = PostTo "/layout-versions" (@{ label="Layout Teste $(Get-Random)"; cloneFrom=$activeBefore } | ConvertTo-Json)
Check "criar versao (clone) retorna 201" ($cv.status -eq 201)
$newVer = $cv.body.versionId
$lv2 = (Get "/layout-versions").versions
$vRow = @($lv2 | Where-Object { $_.versionId -eq $newVer })[0]
Check "nova versao aparece na lista como DRAFT" ($vRow.status -eq "DRAFT")
Check "clone copiou os campos da versao ativa" ($vRow.fieldCount -gt 0)

$diff = Get "/layout-versions/diff?from=$activeBefore&to=$newVer"
Check "diff de clone identico nao tem added/removed/changed" `
      ($diff.added.Count -eq 0 -and $diff.removed.Count -eq 0 -and $diff.changed.Count -eq 0)

$act = PostTo "/layout-versions/$newVer/activate" "{}"
Check "ativar nova versao retorna 200" ($act.status -eq 200)
$lv3 = Get "/layout-versions"
Check "versao ativa passou a ser a nova" ($lv3.active -eq $newVer)

# --- Auditoria (o ator vem do TOKEN autenticado: 'admin') ------------------
$cpfA = "6" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)
$ra = PostTo "/registros" (@{ cpf = $cpfA; nome = "Audit Teste" } | ConvertTo-Json) $BASEH
Check "registro criado para auditar (201)" ($ra.status -eq 201)

$aud = @((Get "/audit?actor=admin&action=CREATE").entries)
Check "auditoria registrou CREATE com ator do token (admin)" ($aud.Count -ge 1 -and $aud[0].actor -eq "admin")
Check "evento e CREATE em REGISTRO" ($aud[0].action -eq "CREATE" -and $aud[0].entity -eq "REGISTRO")
Check "evento tem timestamp" ($null -ne $aud[0].ts)

$nomeAud = "campoAudit" + (Get-Random -Minimum 1000 -Maximum 9999)
PostTo "/registros" (@{ cpf = ("7" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)); nome = "x"; $nomeAud = "y" } | ConvertTo-Json) $BASEH | Out-Null
$apA = PostTo "/metadata" (@{ logicalName = $nomeAud; label = "Campo Audit"; dataType = "STRING"; displayOrder = 220 } | ConvertTo-Json) $BASEH
Check "aprovacao de campo auditada (201)" ($apA.status -eq 201)
$audApprove = @((Get "/audit?action=APPROVE_FIELD&actor=admin").entries)
Check "trilha tem APPROVE_FIELD do ator admin" ($audApprove.Count -ge 1 -and ($audApprove.entityId -contains $nomeAud))

# --- Export / Import de layout (promocao entre ambientes) ------------------
$activeVer = (Get "/layout-versions").active
$exp = Get "/layout-versions/$activeVer/export"
Check "export retorna bundle (formatVersion + fields)" ($exp.formatVersion -eq 1 -and @($exp.fields).Count -gt 0)
$fieldCount = @($exp.fields).Count

$imp = PostTo "/layout-versions/import" (@{ label="Importado $(Get-Random)"; bundle=$exp } | ConvertTo-Json -Depth 8)
Check "import retorna 201" ($imp.status -eq 201)
$impVer = $imp.body.versionId
$impRow = @((Get "/layout-versions").versions | Where-Object { $_.versionId -eq $impVer })[0]
Check "import cria versao DRAFT" ($impRow.status -eq "DRAFT")
Check "import preserva contagem de campos" ($imp.body.fieldCount -eq $fieldCount)

$diffImp = Get "/layout-versions/diff?from=$activeVer&to=$impVer"
Check "round-trip identico (diff vazio)" `
      ($diffImp.added.Count -eq 0 -and $diffImp.removed.Count -eq 0 -and $diffImp.changed.Count -eq 0)

$bad = PostTo "/layout-versions/import" (@{ bundle = @{ foo = "bar" } } | ConvertTo-Json)
Check "bundle invalido retorna 422" ($bad.status -eq 422)

# --- Import: preview + deteccao/bloqueio de conflitos ----------------------
$activeVer2 = (Get "/layout-versions").active
$expC = Get "/layout-versions/$activeVer2/export"
# fabrica um conflito incompativel: muda o tipo de um campo existente
$expC.fields | ForEach-Object { if ($_.logicalName -eq "rendaMensal") { $_.dataType = "STRING" } }

$prev = PostTo "/layout-versions/import/preview" (@{ bundle = $expC } | ConvertTo-Json -Depth 8)
Check "preview retorna 200" ($prev.status -eq 200)
Check "preview detecta conflito de tipo em rendaMensal" (@($prev.body.conflicts.logicalName) -contains "rendaMensal")

$blocked = PostTo "/layout-versions/import" (@{ bundle = $expC } | ConvertTo-Json -Depth 8)
Check "import com conflito e bloqueado (409)" ($blocked.status -eq 409)

$forced = PostTo "/layout-versions/import" (@{ bundle = $expC; allowConflicts = $true } | ConvertTo-Json -Depth 8)
Check "import forcado (allowConflicts) retorna 201" ($forced.status -eq 201)
Check "import forcado registra conflictsAccepted >= 1" ($forced.body.conflictsAccepted -ge 1)

# --- Dashboard consolidado -------------------------------------------------
$dash = Get "/dashboard"
Check "dashboard traz versao ativa" ($null -ne $dash.activeVersion.id)
Check "dashboard traz contadores (registros/versoes)" `
      ($null -ne $dash.counts.registros -and $null -ne $dash.counts.versions)
Check "dashboard traz atividade recente" (@($dash.recentAudit).Count -ge 1)

# --- Auth + RBAC -----------------------------------------------------------
$noTok = Invoke-WebRequest "$Base/registros" -SkipHttpErrorCheck
Check "sem token -> 401" ([int]$noTok.StatusCode -eq 401)
Check "login com senha errada -> falha" ($null -eq (Login "default" "admin" "errada"))
$vPost = PostTo "/registros" (@{ cpf = ("1" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)); nome = "x" } | ConvertTo-Json) $VIEWERH
Check "viewer NAO cria registro -> 403" ($vPost.status -eq 403)
$eVer = PostTo "/layout-versions" (@{ label = "x"; cloneFrom = 1 } | ConvertTo-Json) $EDITORH
Check "editor NAO cria versao (admin-only) -> 403" ($eVer.status -eq 403)
$eReg = PostTo "/registros" (@{ cpf = ("1" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)); nome = "Editor ok" } | ConvertTo-Json) $EDITORH
Check "editor cria registro -> 201" ($eReg.status -eq 201)

# --- Multi-tenant + VPD: isolamento entre tenants --------------------------
$acmeTok = Login "acme" "admin" "admin123"
$ACMEH = @{ Authorization = "Bearer $acmeTok" }
$markerD = "DEF-$(Get-Random)"; $markerA = "ACME-$(Get-Random)"
PostTo "/registros" (@{ cpf = ("8" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)); nome = $markerD } | ConvertTo-Json) $BASEH | Out-Null
PostTo "/registros" (@{ cpf = ("8" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)); nome = $markerA } | ConvertTo-Json) $ACMEH | Out-Null
$defNames = @((Get "/registros?limit=500").registros.nome)
$acmeNames = @((Get "/registros?limit=500" $ACMEH).registros.nome)
Check "VPD: default ve o proprio registro" ($defNames -contains $markerD)
Check "VPD: default NAO ve registro de acme" (-not ($defNames -contains $markerA))
Check "VPD: acme ve o proprio registro" ($acmeNames -contains $markerA)
Check "VPD: acme NAO ve registro de default" (-not ($acmeNames -contains $markerD))
# VPD estendido: auditoria isolada por tenant
$acmeAudit = @((Get "/audit?limit=200" $ACMEH).entries)
$defAudit = @((Get "/audit?limit=200").entries)
Check "VPD: auditoria de acme so tem eventos de acme" (@($acmeAudit.tenant | Sort-Object -Unique) -notcontains "default")
Check "VPD: auditoria de default nao contem eventos de acme" (@($defAudit.tenant) -notcontains "acme")

# --- Mascaramento (LGPD) ---------------------------------------------------
$cpfM = "8" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)
$rm = Post (@{ cpf = $cpfM; nome = "Mascara Teste"; email = "teste@ex.com"; rendaMensal = 9999 } | ConvertTo-Json)
$idM = $rm.body.id
$masked = @((Get "/registros/$idM/view" $VIEWERH).fields | Where-Object { $_.logicalName -eq "cpf" })[0]
Check "cpf mascarado para viewer (sem papel pii)" ($masked.masked -eq $true -and ($masked.value -match '\*'))
$unmasked = @((Get "/registros/$idM/view" $BASEH).fields | Where-Object { $_.logicalName -eq "cpf" })[0]
Check "cpf revelado para admin (papel pii)" ($unmasked.value -eq $cpfM)

# --- i18n de labels --------------------------------------------------------
$en = @((Get "/form-definition?lang=en").fields | Where-Object { $_.name -eq "cpf" })[0]
Check "label em ingles via ?lang=en" ($en.label -eq "Taxpayer ID")

# --- Campo lista (ARRAY) ---------------------------------------------------
$badArr = Post (@{ cpf = ("9" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)); nome = "Arr Ruim"; telefones = @("abc") } | ConvertTo-Json)
Check "ARRAY com item invalido -> 422" ($badArr.status -eq 422)
$cpfA2 = "1" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)
$okArr = Post (@{ cpf = $cpfA2; nome = "Arr Bom"; telefones = @("11999998888", "1133334444") } | ConvertTo-Json)
Check "ARRAY valido -> 201" ($okArr.status -eq 201)
$rawArr = Get "/registros/$($okArr.body.id)"
Check "ARRAY persistido no ATTRS" (@($rawArr.attrs.telefones).Count -eq 2)

# --- Campo condicional (visibleWhen) ---------------------------------------
$sol = Post (@{ cpf = ("2" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)); nome = "Solteiro"; estadoCivil = "SOLTEIRO"; nomeConjuge = "X" } | ConvertTo-Json)
$cas = Post (@{ cpf = ("3" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)); nome = "Casado"; estadoCivil = "CASADO"; nomeConjuge = "Par" } | ConvertTo-Json)
$vSol = @((Get "/registros/$($sol.body.id)/view").fields.logicalName)
$vCas = @((Get "/registros/$($cas.body.id)/view").fields.logicalName)
Check "condicional: SOLTEIRO oculta nomeConjuge" (-not ($vSol -contains "nomeConjuge"))
Check "condicional: CASADO exibe nomeConjuge" ($vCas -contains "nomeConjuge")

# --- Soft-delete + historico + update --------------------------------------
$cpfH = "4" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)
$rh = Post (@{ cpf = $cpfH; nome = "Historia" } | ConvertTo-Json)
$idH = $rh.body.id
$upd = Req "Put" "/registros/$idH" (@{ cpf = $cpfH; nome = "Historia Editada" } | ConvertTo-Json)
Check "update retorna 200" ($upd.status -eq 200)
$del = Req "Delete" "/registros/$idH" $null
Check "soft-delete retorna 200" ($del.status -eq 200)
$hist = @((Get "/registros/$idH/history").history)
Check "historico tem CREATE, UPDATE, DELETE" (@($hist.operation) -contains "CREATE" -and @($hist.operation) -contains "UPDATE" -and @($hist.operation) -contains "DELETE")
Check "registro deletado sai da lista" (-not (@((Get "/registros").registros.id) -contains $idH))
$viewDel = Req "Get" "/registros/$idH/view" $null
Check "view de registro deletado -> 404" ($viewDel.status -eq 404)

# --- Editor de campos da DRAFT ---------------------------------------------
$dv = PostTo "/layout-versions" (@{ label = "Draft $(Get-Random)"; cloneFrom = (Get "/layout-versions").active } | ConvertTo-Json)
$draftV = $dv.body.versionId
$addF = PostTo "/metadata" (@{ layoutVersion = $draftV; logicalName = "campoEditor$(Get-Random)"; label = "Editor"; dataType = "STRING"; displayOrder = 95 } | ConvertTo-Json)
Check "adicionar campo na DRAFT -> 201" ($addF.status -eq 201)
$putF = Req "Put" "/metadata/$($addF.body.fieldId)" (@{ required = $true; sensitive = $true; maskStyle = "partial" } | ConvertTo-Json)
Check "editar campo da DRAFT -> 200" ($putF.status -eq 200)
$activeFieldId = (@((Get "/layout-versions/$((Get "/layout-versions").active)/fields").fields | Where-Object { $_.logicalName -eq "email" })[0]).fieldId
$putActive = Req "Put" "/metadata/$activeFieldId" (@{ label = "X" } | ConvertTo-Json)
Check "editar campo de versao ATIVA -> 409" ($putActive.status -eq 409)
$delF = Req "Delete" "/metadata/$($addF.body.fieldId)" $null
Check "remover campo da DRAFT -> 200" ($delF.status -eq 200)

# --- Qualidade: healthcheck profundo, request-id, paginacao, concorrencia ---
$health = Get "/health" @{}
Check "healthcheck profundo checa o banco (db=up)" ($health.status -eq "ok" -and $health.db -eq "up")

$hdrResp = Invoke-WebRequest "$Base/dashboard" -Headers $BASEH -SkipHttpErrorCheck
Check "resposta traz header X-Request-Id" ($null -ne $hdrResp.Headers["X-Request-Id"])

$pg = Get "/registros?limit=2&offset=0"
Check "paginacao retorna total/limit/offset" ($null -ne $pg.total -and $pg.limit -eq 2 -and $pg.offset -eq 0)
Check "paginacao respeita limit" (@($pg.registros).Count -le 2)

# concorrencia otimista
$cpfCC = "5" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)
$cc = Post (@{ cpf = $cpfCC; nome = "Concorrencia" } | ConvertTo-Json)
$u1 = Req "Put" "/registros/$($cc.body.id)" (@{ cpf = $cpfCC; nome = "Edit v1"; expectedVersion = 1 } | ConvertTo-Json)
Check "update com expectedVersion correto -> 200" ($u1.status -eq 200)
$u2 = Req "Put" "/registros/$($cc.body.id)" (@{ cpf = $cpfCC; nome = "Edit stale"; expectedVersion = 1 } | ConvertTo-Json)
Check "update com versao antiga (stale) -> 409 VERSION_CONFLICT" ($u2.status -eq 409 -and $u2.body.error -eq "VERSION_CONFLICT")

# auditoria de acesso a dado sensivel
$cpfSA = "6" + (Get-Random -Minimum 1000000000 -Maximum 9999999999)
$sa = Post (@{ cpf = $cpfSA; nome = "Acesso"; email = "a@ex.com"; rendaMensal = 3000 } | ConvertTo-Json)
# limit alto para o count nao saturar (o default e 50) apos varias execucoes
$before = (Get "/audit?action=READ_SENSITIVE&limit=1000").count
Get "/registros/$($sa.body.id)/view" $VIEWERH | Out-Null   # viewer -> mascarado
$mid = (Get "/audit?action=READ_SENSITIVE&limit=1000").count
Get "/registros/$($sa.body.id)/view" $BASEH | Out-Null     # admin (pii) -> revela
$after = (Get "/audit?action=READ_SENSITIVE&limit=1000").count
Check "view do viewer (mascarada) NAO gera READ_SENSITIVE" ($mid -eq $before)
Check "view do admin (pii) GERA READ_SENSITIVE" ($after -gt $mid)

Write-Host ""
$color = if ($script:fail -eq 0) { "Green" } else { "Red" }
Write-Host "== Resultado: $script:pass PASS / $script:fail FAIL ==" -ForegroundColor $color
if ($script:fail -gt 0) { exit 1 }
