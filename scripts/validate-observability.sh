#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_file() {
  local path="$1"
  [[ -f "$path" ]] || fail "Missing required file: $path"
}

require_pattern() {
  local pattern="$1"
  local path="$2"
  local message="$3"
  grep -Eq "$pattern" "$path" || fail "$message"
}

ALERTS_FILE="deploy/observability/prometheus/cmdb2monitoring-alerts.yml"
DASHBOARD_FILE="deploy/observability/grafana/cmdb2monitoring-dashboard.json"
SMOKE_SCRIPT="scripts/live-smoke.mjs"

require_file "$ALERTS_FILE"
require_file "$DASHBOARD_FILE"
require_file "$SMOKE_SCRIPT"

require_pattern "cmdb2monitoring_events_total" "$ALERTS_FILE" "Alert rules must use service event counters."
require_pattern "cmdb2monitoring_queue_lag" "$ALERTS_FILE" "Alert rules must cover Kafka lag/DLQ depth."
require_pattern "webhook_rejected_auth" "$ALERTS_FILE" "Alert rules must cover webhook authorization failures."
require_pattern "auth_failure" "$ALERTS_FILE" "Alert rules must cover UI auth failures."
require_pattern "catalog_sync_failure" "$ALERTS_FILE" "Alert rules must cover catalog sync failures."
require_pattern "rules_reload_failure" "$ALERTS_FILE" "Alert rules must cover rules reload failures."
require_pattern "dead_letter_published" "$ALERTS_FILE" "Alert rules must cover DLQ publication."
require_pattern "cmdb2monitoring_queue_lag" "$DASHBOARD_FILE" "Dashboard must show Kafka lag/DLQ depth."
require_pattern "cmdb2monitoring_events_total" "$DASHBOARD_FILE" "Dashboard must show service event counters."

node --check "$SMOKE_SCRIPT"
node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$DASHBOARD_FILE"

if command -v promtool >/dev/null 2>&1; then
  promtool check rules "$ALERTS_FILE"
else
  echo "promtool not found; skipped Prometheus rule syntax validation."
fi

echo "Observability validation passed."
