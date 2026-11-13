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

init_container="$(compose ps --all -q monitoring-ui-storage-init)"
if [[ -z "$init_container" ]]; then
  echo 'monitoring-ui-storage-init container was not created' >&2
  exit 1
fi

for _ in $(seq 1 20); do
  init_state="$(docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}' "$init_container")"
  if [[ "$init_state" == 'exited:0' ]]; then
    break
  fi
  if [[ "$init_state" == exited:* ]]; then
    echo "monitoring-ui-storage-init failed: $init_state" >&2
    exit 1
  fi
  sleep 1
done
if [[ "$init_state" != 'exited:0' ]]; then
  echo "monitoring-ui-storage-init did not complete: $init_state" >&2
  exit 1
fi

phase 'verify BFF readiness and non-root state/data write'
ready=false
for _ in $(seq 1 20); do
  if compose exec --no-TTY --user 10001:10001 monitoring-ui-api \
    sh -ec 'test -w /app/data && test -w /app/state && touch /app/data/.smoke-write /app/state/.smoke-write && rm /app/data/.smoke-write /app/state/.smoke-write' \
    && compose exec --no-TTY monitoring-ui-api \
      sh -ec "wget -qO- http://127.0.0.1:5090/ready | grep -q '\"ready\":true' && wget -qO- http://127.0.0.1:5090/health | grep -q '\"applicationVersion\":\"$version\"'"; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  echo 'monitoring-ui-api image did not become ready' >&2
  exit 1
fi

phase 'save Runtime Settings as the non-root BFF user and verify restart recovery'
compose exec --no-TTY --user 10001:10001 monitoring-ui-api sh -ec '
  password="$(sed -n "s/^password=//p" /app/state/bootstrap-admin-password.txt)"
  node -e '\''
    const password = process.argv[1];
    const login = await fetch("http://127.0.0.1:5090/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password })
    });
    if (!login.ok) throw new Error(`login failed: ${login.status}`);
    const session = await login.json();
    const update = await fetch("http://127.0.0.1:5090/api/settings/runtime", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: login.headers.get("set-cookie"),
        "x-csrf-token": session.csrfToken
      },
      body: JSON.stringify({ cmdbuild: { webhookTargetUrl: "https://monitoring-webhook.example.local/webhooks/cmdbuild" } })
    });
    if (!update.ok) throw new Error(`runtime settings update failed: ${update.status}`);
  '\'' "$password"
'
compose restart monitoring-ui-api >/dev/null
for _ in $(seq 1 20); do
  if compose exec --no-TTY --user 10001:10001 monitoring-ui-api \
    sh -ec 'grep -q '"'"'https://monitoring-webhook.example.local/webhooks/cmdbuild'"'"' /app/state/ui-settings.json' \
    && compose exec --no-TTY monitoring-ui-api \
      sh -ec "wget -qO- http://127.0.0.1:5090/ready | grep -q '\"ready\":true'"; then
    phase 'Runtime Settings persistence smoke passed'
    break
  fi
  sleep 1
done

if ! compose exec --no-TTY --user 10001:10001 monitoring-ui-api \
  sh -ec 'grep -q '"'"'https://monitoring-webhook.example.local/webhooks/cmdbuild'"'"' /app/state/ui-settings.json'; then
  echo 'Runtime Settings did not persist across BFF restart' >&2
  exit 1
fi

phase 'monitoring-ui-api image smoke passed'
