#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${IMAGE:?set IMAGE}"
service="${SERVICE:?set SERVICE}"
container="cmdb2monitoring-image-smoke-${service}-$$"
port="${PORT:-8080}"

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]] && docker container inspect "$container" >/dev/null 2>&1; then
    docker logs "$container" >&2 || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

run_args=(
  --detach
  --name "$container"
  --publish "127.0.0.1::${port}"
  --env ASPNETCORE_ENVIRONMENT=Development
)
if [[ "$service" == "cmdbkafka2zabbix" ]]; then
  run_args+=(
    --mount "type=bind,source=${ROOT_DIR}/rules,target=/app/rules,readonly"
    --env ConversionRules__BaseDirectory=/app
    --env ConversionRules__RulesFilePath=rules/cmdbuild-to-zabbix-host-create.json
  )
elif [[ "$service" == "monitoring-ui-api" ]]; then
  port=5090
  run_args=(
    --detach
    --name "$container"
    --publish "127.0.0.1::${port}"
    --mount "type=bind,source=${ROOT_DIR}/rules,target=/app/rules,readonly"
    --env NODE_ENV=Development
    --env MONITORING_UI_HOST=0.0.0.0
    --env PORT=5090
    --env RULES_ACTIVE_BASE_DIRECTORY=/app
    --env RULES_ACTIVE_FILE_PATH=rules/cmdbuild-to-zabbix-host-create.json
    --env RULES_ACTIVE_WRITE_ENABLED=false
    --env MONITORING_UI_EVENTS_ENABLED=false
    --env MONITORING_UI_LOGS_ENABLED=false
  )
fi

docker run "${run_args[@]}" "$image" >/dev/null
host_port="$(docker port "$container" "${port}/tcp" | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p')"
[[ -n "$host_port" ]] || { echo "Cannot resolve published port for $service" >&2; exit 1; }

for _ in $(seq 1 30); do
  health="$(curl --fail --silent "http://127.0.0.1:${host_port}/health" || true)"
  ready="$(curl --fail --silent "http://127.0.0.1:${host_port}/ready" || true)"
  if [[ "$health" == *'"applicationVersion"'* && "$health" == *'"buildProvenance":"verified"'* && "$health" == *'"sourceState":"clean"'* && "$ready" == *'"status":"ready"'* ]]; then
    echo "$service image smoke passed"
    exit 0
  fi
  sleep 1
done

echo "$service image did not expose verified /health and /ready" >&2
exit 1
