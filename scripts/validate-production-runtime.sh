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
require_pattern "MONITORING_UI_HEALTH_ENDPOINTS_JSON:" "$COMPOSE_FILE" "Production compose must configure health endpoints through one JSON environment variable."
require_pattern "http://cmdbwebhooks2kafka:8080/health" "$COMPOSE_FILE" "Production health endpoints must use Compose service DNS."
require_pattern "http://cmdbkafka2zabbix:8080/health" "$COMPOSE_FILE" "Production converter health endpoint must use Compose service DNS."
require_pattern "http://zabbixrequests2api:8080/health" "$COMPOSE_FILE" "Production Zabbix request health endpoint must use Compose service DNS."
require_pattern "http://zabbixbindings2cmdbuild:8080/health" "$COMPOSE_FILE" "Production binding health endpoint must use Compose service DNS."
require_pattern "MONITORING_UI_RULES_RELOAD_TOKEN:" "$COMPOSE_FILE" "Production UI must receive its rules reload token through an environment variable."
require_pattern "RulesStatusTokenEnv" "$COMPOSE_FILE" "Production UI must resolve the converter status token through a dedicated environment reference."
require_pattern "ZABBIX_API_TOKEN:\\?" "$COMPOSE_FILE" "Production compose must require Zabbix API token or secret reference."
require_pattern "VERSION:\\?set VERSION from the release VERSION file" "$COMPOSE_FILE" "Production compose must require the release VERSION."
require_pattern "^VERSION=REPLACE_WITH_VERSION_FROM_ROOT_VERSION_FILE$" "$ENV_EXAMPLE_FILE" "Production env example must require the root VERSION value."
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
  require_pattern "^FROM runtime AS gkm-runtime$" "$dockerfile" "$dockerfile must expose gkm-runtime only as the runtime-stage alias."
  reject_pattern "customer-ca|debian\.sources" "$dockerfile" "$dockerfile must not contain customer CA or package-source files."
done

require_pattern "ARG NODE_RUNTIME_IMAGE=node:22-alpine" "deploy/dockerfiles/monitoring-ui-api.Dockerfile" "Monitoring UI must keep a configurable Node base image."
for dockerfile in deploy/dockerfiles/cmdbwebhooks2kafka.Dockerfile deploy/dockerfiles/cmdbkafka2zabbix.Dockerfile deploy/dockerfiles/zabbixrequests2api.Dockerfile deploy/dockerfiles/zabbixbindings2cmdbuild.Dockerfile; do
  require_pattern "ARG DOTNET_SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0" "$dockerfile" "$dockerfile must keep a configurable .NET SDK base image."
  require_pattern "ARG DOTNET_RUNTIME_IMAGE=mcr.microsoft.com/dotnet/aspnet:10.0" "$dockerfile" "$dockerfile must keep a configurable .NET runtime base image."
done

require_pattern "BUILD_TARGET" "scripts/build-local-registry-images.sh" "Image build helper must support an explicit target."

require_pattern "npm --prefix src/monitoring-ui-api test" ".github/workflows/ci.yml" "GitHub CI must run full monitoring-ui-api tests."
require_pattern "npm --prefix src/monitoring-ui-api test" ".gitlab-ci.yml" "GitLab CI must run full monitoring-ui-api tests."
require_pattern "smoke-monitoring-ui-image.sh" ".gitlab-ci.yml" "GitLab CI must run the monitoring UI image smoke."
require_file "scripts/smoke-monitoring-ui-image.sh"

echo "Production runtime validation passed."
