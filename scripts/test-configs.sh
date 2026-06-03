#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

./scripts/dotnet run --project tests/configvalidation/configvalidation.csproj -- "$ROOT_DIR"
./scripts/dotnet run --project tests/cmdbresolver/cmdbresolver.csproj -- "$ROOT_DIR"
./scripts/dotnet run --project tests/zabbixbindings/zabbixbindings.csproj -- "$ROOT_DIR"
npm --prefix src/monitoring-ui-api test
./scripts/validate-observability.sh
