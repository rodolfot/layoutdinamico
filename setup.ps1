<#
  setup.ps1 - Sobe a POC de Layout Dinamico de ponta a ponta.

  Encadeia: Docker Desktop -> Oracle Free (healthy) -> .env -> npm install
            -> db:init (schema + seed) -> npm run dev (API + UI).

  Uso:
    ./setup.ps1              # sobe tudo e deixa a API rodando (foreground)
    ./setup.ps1 -SkipInstall # pula 'npm install' (deps ja instaladas)
    ./setup.ps1 -ResetDb     # reinicializa schema/seed antes de subir a API
    ./setup.ps1 -Down        # derruba a API e o container Oracle (limpa volume)

  Requisitos: Docker Desktop, Node.js/npm.
#>
[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [switch]$ResetDb,
  [switch]$Down
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$Container = "poc-oracle-free"
$ApiUrl    = "http://localhost:3000"

function Info($m)  { Write-Host "[setup] $m" -ForegroundColor Cyan }
function Ok($m)    { Write-Host "[ok]    $m" -ForegroundColor Green }
function Warn($m)  { Write-Host "[warn]  $m" -ForegroundColor Yellow }

# --------------------------------------------------------------------------
# -Down: teardown e sai
# --------------------------------------------------------------------------
if ($Down) {
  Info "Derrubando container e volume Oracle..."
  docker compose down -v
  Ok "Ambiente removido. (Pare a API com Ctrl+C na janela onde ela roda.)"
  return
}

# --------------------------------------------------------------------------
# 1) Garante Docker Desktop no ar
# --------------------------------------------------------------------------
Info "Verificando Docker daemon..."
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Warn "Daemon offline. Iniciando Docker Desktop..."
  $paths = @("$env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
             "$env:LOCALAPPDATA\Docker\Docker Desktop.exe")
  $exe = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $exe) { throw "Docker Desktop.exe nao encontrado. Instale/abra o Docker manualmente." }
  Start-Process $exe
  foreach ($i in 1..40) {
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 6
  }
  docker info *> $null
  if ($LASTEXITCODE -ne 0) { throw "Docker daemon nao subiu a tempo." }
}
Ok "Docker daemon disponivel."

# --------------------------------------------------------------------------
# 2) Sobe Oracle e aguarda 'healthy'
# --------------------------------------------------------------------------
Info "Subindo Oracle Free (docker compose up -d)..."
docker compose up -d | Out-Null

Info "Aguardando container ficar 'healthy' (pode levar 1-3 min na 1a vez)..."
$health = ""
foreach ($i in 1..60) {
  $health = (docker inspect --format '{{.State.Health.Status}}' $Container 2>$null)
  if ($health -eq "healthy") { break }
  Start-Sleep -Seconds 10
}
if ($health -ne "healthy") { throw "Oracle nao ficou healthy (status=$health)." }
Ok "Oracle healthy."

# --------------------------------------------------------------------------
# 2.1) Grants de VPD (DBA, idempotente) - necessarios para a migration V007.
#      Senha de SYS = ORACLE_PASSWORD do docker-compose.yml.
# --------------------------------------------------------------------------
Info "Aplicando grants de VPD (como SYSDBA)..."
$SysPwd = "oracle_sys_pw"
Get-Content "scripts/grant-vpd.sql" | docker exec -i $Container sqlplus -s "sys/$SysPwd@localhost:1521/FREEPDB1 as sysdba" | Out-Null
Ok "Grants de VPD aplicados."

# --------------------------------------------------------------------------
# 3) .env
# --------------------------------------------------------------------------
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Ok ".env criado a partir de .env.example."
} else {
  Info ".env ja existe (mantido)."
}

# --------------------------------------------------------------------------
# 4) Dependencias
# --------------------------------------------------------------------------
if (-not $SkipInstall) {
  Info "Instalando dependencias (npm install)..."
  npm install --no-audit --no-fund | Out-Null
  Ok "Dependencias instaladas."
} else {
  Info "Pulando npm install (-SkipInstall)."
}

# --------------------------------------------------------------------------
# 5) Schema + seed
#    Roda sempre na 1a vez; nas seguintes so com -ResetDb (o 01_ddl.sql dropa
#    e recria tudo, entao ResetDb apaga os registros existentes).
# --------------------------------------------------------------------------
$needInit = $ResetDb
if (-not $needInit) {
  # Detecta se o schema ja existe consultando a tabela REGISTRO.
  $probe = docker exec -i $Container sh -c "echo 'SELECT 1 FROM REGISTRO WHERE ROWNUM=1; EXIT;' | sqlplus -s app/app_pw@localhost:1521/FREEPDB1" 2>$null
  if ($probe -match "ORA-00942") { $needInit = $true }  # tabela nao existe
}
if ($needInit) {
  Info "Inicializando schema + seed (npm run db:init)..."
  npm run db:init
  Ok "Banco inicializado."
} else {
  Info "Schema ja existe. (Use -ResetDb para recriar do zero.)"
}

# --------------------------------------------------------------------------
# 6) API + UI
# --------------------------------------------------------------------------
Ok "Tudo pronto."
Write-Host ""
Write-Host "  API:  $ApiUrl" -ForegroundColor Green
Write-Host "  UI:   $ApiUrl/ui/index.html" -ForegroundColor Green
Write-Host ""
Info "Subindo a API (Ctrl+C para parar)..."
npm run dev
