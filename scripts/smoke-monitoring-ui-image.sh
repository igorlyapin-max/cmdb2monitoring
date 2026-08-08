#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

version="0.0.0.0"
if [[ -f VERSION ]]; then
  version="$(tr -d '\r\n' < VERSION)"
fi

image="${MONITORING_UI_SMOKE_IMAGE:-cmdb2monitoring/monitoring-ui-api:smoke}"
container="monitoring-ui-image-smoke-$$"

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]] && docker container inspect "$container" >/dev/null 2>&1; then
    docker logs "$container" >&2 || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker build \
  --build-arg "APPLICATION_VERSION=$version" \
  --file deploy/dockerfiles/monitoring-ui-api.Dockerfile \
  --tag "$image" \
  .

embedded_version="$(docker run --rm --entrypoint cat "$image" /app/VERSION)"
image_version_label="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$image")"
if [[ "$embedded_version" != "$version" || "$image_version_label" != "$version" ]]; then
  echo "monitoring-ui-api image version identity does not match VERSION" >&2
  exit 1
fi

docker run -d \
  --name "$container" \
  --mount "type=bind,source=$ROOT_DIR/rules,target=/app/rules,readonly" \
  --env NODE_ENV=Development \
  --env MONITORING_UI_HOST=127.0.0.1 \
  --env PORT=5090 \
  --env RULES_ACTIVE_BASE_DIRECTORY=/app \
  --env RULES_ACTIVE_FILE_PATH=rules/cmdbuild-to-zabbix-host-create.json \
  --env RULES_ACTIVE_WRITE_ENABLED=false \
  --env MONITORING_UI_LOGS_ENABLED=false \
  "$image" >/dev/null

for _ in $(seq 1 20); do
  if docker exec "$container" wget -qO- http://127.0.0.1:5090/ready | grep -q '"ready":true' \
    && docker exec "$container" wget -qO- http://127.0.0.1:5090/health | grep -q '"applicationVersion":"'"$version"'"'; then
    echo "monitoring-ui-api image smoke passed"
    exit 0
  fi
  sleep 1
done

echo "monitoring-ui-api image did not become ready" >&2
exit 1
