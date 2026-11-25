#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

project="rules-artifact-contract-$$"
compose_file="deploy/compose.rules-artifact-contract.yml"
rules_dir="$(mktemp -d)"
token="rules-artifact-contract-token"
ui_image="cmdb2monitoring/monitoring-ui-api:rules-artifact-contract"
converter_image="cmdb2monitoring/cmdbkafka2zabbix:rules-artifact-contract"

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
  rm -rf "$rules_dir"
  exit "$status"
}
trap cleanup EXIT

cp -a rules/. "$rules_dir/"
chmod -R a+rwx "$rules_dir"

export RULES_ARTIFACT_UI_IMAGE="$ui_image"
export RULES_ARTIFACT_CONVERTER_IMAGE="$converter_image"
export RULES_ARTIFACT_RULES_HOST_PATH="$rules_dir"
export RULES_ARTIFACT_TOKEN="$token"

phase 'build contract images'
docker build --target gkm-runtime -f deploy/dockerfiles/monitoring-ui-api.Dockerfile -t "$ui_image" .
docker build --target gkm-runtime -f deploy/dockerfiles/cmdbkafka2zabbix.Dockerfile -t "$converter_image" .

phase 'validate contract compose topology'
compose config -q
phase 'start UI and converter with one rules mount'
compose up --detach

phase 'create isolated Kafka topics'
for _ in $(seq 1 30); do
  if compose exec --no-TTY kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --list >/dev/null 2>&1; then
    for topic in rules-artifact-input rules-artifact-output rules-artifact-dlq; do
      compose exec --no-TTY kafka /opt/kafka/bin/kafka-topics.sh \
        --bootstrap-server kafka:9092 --create --if-not-exists --topic "$topic" --partitions 1 --replication-factor 1
    done
    break
  fi
  sleep 1
done

if ! compose exec --no-TTY kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --describe --topic rules-artifact-input >/dev/null 2>&1; then
  echo 'Kafka broker did not become ready.' >&2
  exit 1
fi

ready=false
for _ in $(seq 1 30); do
  if compose exec --no-TTY monitoring-ui-api sh -ec '
    wget -qO- http://127.0.0.1:5090/ready | grep -q ready \
      && wget -qO- http://cmdbkafka2zabbix:8080/ready | grep -q ready
  '; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  echo 'UI or converter did not become ready.' >&2
  exit 1
fi

phase 'publish active rules and verify the loaded converter artifact'
compose exec --no-TTY monitoring-ui-api sh -ec '
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
    const cookie = login.headers.get("set-cookie");
    const current = await fetch("http://127.0.0.1:5090/api/rules/current", { headers: { cookie } });
    if (!current.ok) throw new Error(`rules read failed: ${current.status}`);
    const document = await current.json();
    document.content.rulesVersion = "rules-artifact-contract-e2e";
    const publish = await fetch("http://127.0.0.1:5090/api/rules/publish", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ rules: document.content, expectedRevision: document.revision })
    });
    const result = await publish.json();
    if (!publish.ok || result.applied !== true) throw new Error(`publish did not apply: ${JSON.stringify(result)}`);
    if (result.converterStatus?.expectedSha256 !== result.converterStatus?.actualSha256) throw new Error("converter SHA-256 differs from UI artifact");
    if (result.resolvedPath !== "/app/rules/cmdbuild-to-zabbix-host-create.json") throw new Error(`unexpected UI path: ${result.resolvedPath}`);
    if (result.converterStatus?.location !== "/app/rules/cmdbuild-to-zabbix-host-create.json") throw new Error(`unexpected converter path: ${result.converterStatus?.location}`);
  '\'' "$password"
'

phase 'prove worker consumed the published artifact through Kafka'
printf '%s\n' '{invalid-json' | compose exec --no-TTY kafka /opt/kafka/bin/kafka-console-producer.sh \
  --bootstrap-server kafka:9092 --topic rules-artifact-input
dlq_payload="$(compose exec --no-TTY kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server kafka:9092 --topic rules-artifact-dlq --from-beginning --max-messages 1 --timeout-ms 15000)"
printf '%s' "$dlq_payload" | node -e '
  let payload = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { payload += chunk; });
  process.stdin.on("end", () => {
    const message = JSON.parse(payload.trim());
    if (message.service !== "cmdbkafka2zabbix") throw new Error("unexpected DLQ service");
    if (message.errorCode !== "invalid_json") throw new Error("worker did not process invalid Kafka payload");
    if (message.rulesVersion !== "rules-artifact-contract-e2e") throw new Error("worker did not use the published rules artifact");
  });
'

phase 'rules artifact Kafka consumer contract smoke passed'
