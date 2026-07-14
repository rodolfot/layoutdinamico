#!/bin/sh
set -e

# Migrations forward-only (nao-destrutivas): aplica apenas o que falta. Idempotente.
echo "[entrypoint] aplicando migrations pendentes..."
node dist/scripts/migrate.js || { echo "[entrypoint] falha nas migrations"; exit 1; }

echo "[entrypoint] iniciando API..."
exec node dist/src/server.js
