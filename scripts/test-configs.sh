#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

./scripts/dotnet run --project tests/configvalidation/configvalidation.csproj -- "$ROOT_DIR"
node src/monitoring-ui-api/scripts/validate-config.mjs
npm --prefix src/monitoring-ui-api run test:mapping
