#!/usr/bin/env bash
set -euo pipefail

endpoint="${GKM_TLS_SMOKE_ENDPOINT:?set GKM_TLS_SMOKE_ENDPOINT when GKM_CA_PROFILE_ENABLED=true}"
node_image="${GKM_NODE_RUNTIME_IMAGE:?set GKM_NODE_RUNTIME_IMAGE}"
dotnet_image="${GKM_DOTNET_RUNTIME_IMAGE:?set GKM_DOTNET_RUNTIME_IMAGE}"

case "$endpoint" in
  https://*) ;;
  *) echo "GKM_TLS_SMOKE_ENDPOINT must use https://" >&2; exit 1 ;;
esac

authority="${endpoint#https://}"
authority="${authority%%/*}"
host="${authority%%:*}"
port="443"
if [[ "$authority" == *:* ]]; then
  port="${authority##*:}"
fi
[[ -n "$host" && "$port" =~ ^[0-9]+$ ]] \
  || { echo "GKM_TLS_SMOKE_ENDPOINT must include an HTTPS host and numeric port." >&2; exit 1; }

printf '%s [cmdb2monitoring GKM trust] node prepared-base TLS check\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
docker run --rm \
  --env "GKM_TLS_SMOKE_ENDPOINT=$endpoint" \
  --entrypoint sh "$node_image" \
  -ec 'test -n "$NODE_EXTRA_CA_CERTS"; test -r "$NODE_EXTRA_CA_CERTS"; node -e "const https=require(\"https\"); const request=https.get(process.env.GKM_TLS_SMOKE_ENDPOINT, response=>{response.resume(); process.exit(0)}); request.on(\"error\", error=>{console.error(error); process.exit(1)}); request.setTimeout(15000, ()=>request.destroy(new Error(\"TLS smoke timeout\")));"'

printf '%s [cmdb2monitoring GKM trust] .NET prepared-base TLS check\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
docker run --rm \
  --env "GKM_TLS_SMOKE_HOST=$host" \
  --env "GKM_TLS_SMOKE_PORT=$port" \
  --entrypoint sh "$dotnet_image" \
  -ec 'command -v openssl >/dev/null; openssl s_client -connect "$GKM_TLS_SMOKE_HOST:$GKM_TLS_SMOKE_PORT" -servername "$GKM_TLS_SMOKE_HOST" -verify_return_error </dev/null 2>/dev/null | grep -q "Verify return code: 0 (ok)"'
