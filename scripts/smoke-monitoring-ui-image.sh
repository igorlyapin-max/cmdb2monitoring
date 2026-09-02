#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

version="0.0.0.0"
if [[ -f VERSION ]]; then
  version="$(tr -d '\r\n' < VERSION)"
fi

image="${MONITORING_UI_SMOKE_IMAGE:-cmdb2monitoring/monitoring-ui-api:smoke}"
project="monitoring-ui-image-smoke-$$"
compose_file="deploy/compose.monitoring-ui-smoke.yml"

phase() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

compose() {
  docker compose --project-name "$project" --file "$compose_file" "$@"
}

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    compose logs --no-color >&2 || true
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

phase 'build monitoring-ui-api image'
docker build \
  --build-arg "APPLICATION_VERSION=$version" \
  --file deploy/dockerfiles/monitoring-ui-api.Dockerfile \
  --tag "$image" \
  .

phase 'verify embedded image identity'
embedded_version="$(docker run --rm --entrypoint cat "$image" /app/VERSION)"
image_version_label="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$image")"
if [[ "$embedded_version" != "$version" || "$image_version_label" != "$version" ]]; then
  echo "monitoring-ui-api image version identity does not match VERSION" >&2
  exit 1
fi

export MONITORING_UI_SMOKE_IMAGE="$image"
export MONITORING_UI_SMOKE_RULES_HOST_PATH="$ROOT_DIR/rules"

phase 'validate Compose lifecycle contour'
compose config -q
phase 'start root-owned volume fixture, initializer, and BFF'
compose up --detach

init_container="$(compose ps --all -q monitoring-ui-data-init)"
if [[ -z "$init_container" ]]; then
  echo 'monitoring-ui-data-init container was not created' >&2
  exit 1
fi

for _ in $(seq 1 20); do
  init_state="$(docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}' "$init_container")"
  if [[ "$init_state" == 'exited:0' ]]; then
    break
  fi
  if [[ "$init_state" == exited:* ]]; then
    echo "monitoring-ui-data-init failed: $init_state" >&2
    exit 1
  fi
  sleep 1
done
if [[ "$init_state" != 'exited:0' ]]; then
  echo "monitoring-ui-data-init did not complete: $init_state" >&2
  exit 1
fi

phase 'verify BFF readiness and non-root data write'
for _ in $(seq 1 20); do
  if compose exec --no-TTY --user 10001:10001 monitoring-ui-api \
    sh -ec 'test -w /app/data && touch /app/data/.smoke-write && rm /app/data/.smoke-write' \
    && compose exec --no-TTY monitoring-ui-api \
      sh -ec "wget -qO- http://127.0.0.1:5090/ready | grep -q '\"ready\":true' && wget -qO- http://127.0.0.1:5090/health | grep -q '\"applicationVersion\":\"$version\"'"; then
    phase 'monitoring-ui-api image smoke passed'
    exit 0
  fi
  sleep 1
done

echo 'monitoring-ui-api image did not become ready' >&2
exit 1
