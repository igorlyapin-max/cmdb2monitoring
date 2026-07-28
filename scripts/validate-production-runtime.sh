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

reject_pattern() {
  local pattern="$1"
  local path="$2"
  local message="$3"
  if grep -Eq "$pattern" "$path"; then
    fail "$message"
  fi
}

COMPOSE_FILE="deploy/compose.production.yml"
ENV_EXAMPLE_FILE="deploy/production.env.example"
require_file "$COMPOSE_FILE"
require_file "$ENV_EXAMPLE_FILE"

require_pattern "driver: \\$\\{DOCKER_LOG_DRIVER:-syslog\\}" "$COMPOSE_FILE" "Production compose must default Docker logging driver to syslog."
require_pattern "syslog-address:" "$COMPOSE_FILE" "Production compose must configure syslog-address."
require_pattern "/ready" "$COMPOSE_FILE" "Production compose healthchecks must call /ready."
require_pattern "Worker__ReplicaMode: SingleActive" "$COMPOSE_FILE" "Production compose must pin workers to SingleActive mode."
require_pattern "ProcessingState__BaseDirectory: /app" "$COMPOSE_FILE" "Production compose must keep worker state inside /app."
require_pattern "cmdbkafka2zabbix-state:/app/state" "$COMPOSE_FILE" "cmdbkafka2zabbix must persist /app/state."
require_pattern "zabbixrequests2api-state:/app/state" "$COMPOSE_FILE" "zabbixrequests2api must persist /app/state."
require_pattern "zabbixbindings2cmdbuild-state:/app/state" "$COMPOSE_FILE" "zabbixbindings2cmdbuild must persist /app/state."
require_pattern "monitoring-ui-state:/app/state" "$COMPOSE_FILE" "monitoring-ui-api must persist /app/state."
require_pattern "monitoring-ui-data:/app/data" "$COMPOSE_FILE" "monitoring-ui-api must persist /app/data."
require_pattern "CMDB_WEBHOOK_BEARER_TOKEN:\\?" "$COMPOSE_FILE" "Production compose must require CMDB webhook bearer token."
require_pattern "RULES_RELOAD_TOKEN:\\?" "$COMPOSE_FILE" "Production compose must require rules reload token."
require_pattern "ZABBIX_API_TOKEN:\\?" "$COMPOSE_FILE" "Production compose must require Zabbix API token or secret reference."
require_pattern "^SECRETS_PROVIDER=None$" "$ENV_EXAMPLE_FILE" "Production env example must disable PAM/AAPM by default."
require_pattern "^PAMURL=$" "$ENV_EXAMPLE_FILE" "Production env example must leave PAMURL empty in no-PAM mode."
require_pattern "^PAMTOKEN=$" "$ENV_EXAMPLE_FILE" "Production env example must leave PAMTOKEN empty in no-PAM mode."
require_pattern "^PAMUSERNAME=$" "$ENV_EXAMPLE_FILE" "Production env example must leave PAMUSERNAME empty in no-PAM mode."
require_pattern "^PAMPASSWORD=$" "$ENV_EXAMPLE_FILE" "Production env example must leave PAMPASSWORD empty in no-PAM mode."
require_pattern "^SASLPASSWORDSECRET=$" "$ENV_EXAMPLE_FILE" "Production env example must leave SASLPASSWORDSECRET empty in no-PAM mode."
require_pattern "^CMDB_WEBHOOK_BEARER_TOKEN=REPLACE_" "$ENV_EXAMPLE_FILE" "Production env example must use a safe webhook-token placeholder."
require_pattern "^ZABBIX_API_TOKEN=REPLACE_" "$ENV_EXAMPLE_FILE" "Production env example must use a safe Zabbix-token placeholder."
reject_pattern "(secret|aapm)://" "$ENV_EXAMPLE_FILE" "Production env example must not contain PAM/AAPM secret references in no-PAM mode."

for dockerfile in deploy/dockerfiles/*.Dockerfile; do
  require_pattern "/ready" "$dockerfile" "$dockerfile healthcheck must call /ready."
done

require_pattern "npm --prefix src/monitoring-ui-api test" ".github/workflows/ci.yml" "GitHub CI must run full monitoring-ui-api tests."
require_pattern "npm --prefix src/monitoring-ui-api test" ".gitlab-ci.yml" "GitLab CI must run full monitoring-ui-api tests."

echo "Production runtime validation passed."
