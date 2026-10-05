#!/usr/bin/env bash
# Stops local dev processes and wipes local dev data (database + files). Development only.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
# Bracketed first letters stop pkill from matching this script's own command line.
pkill -f '[t]sx watch' || true
pkill -f '[s]cripts/dev-db.ts' || true
pkill -f '[n]ode_modules/.bin/vite' || true
pkill -f '[e]mbedded-postgres/linux' || true
sleep 2
rm -rf .dev-data
echo "Dev data wiped."
