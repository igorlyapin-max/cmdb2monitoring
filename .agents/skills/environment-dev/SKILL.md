---
name: environment-dev
description: Development environment guide for cmdb2monitoring integrations with Kafka, Zabbix, and CMDBuild. Use when Codex needs to inspect or operate the local dev containers, Kafka topics/messages, CMDBuild webhooks/catalog, Zabbix API/catalog/hosts, runtime endpoints, credentials, or end-to-end environment behavior.
---

# Environment Dev

## Scope

Use this skill for the running development environment around `cmdb2monitoring`: Kafka, CMDBuild, Zabbix, service endpoints, containers, catalogs, topics, and webhook/API checks.
Use `$developer-local` for repository coding workflow, tests, commits, and documentation rules.

Treat config files as the source of truth. Verify current values in `appsettings*.json` and `src/monitoring-ui-api/config/*.json` before acting, because ports, topics, tokens, or credentials may change.

## Current Dev Endpoints

- CMDBuild UI/API: `http://localhost:8090`, login `admin/admin`.
- Zabbix UI/API: `http://localhost:8081`, login `admin/zabbix`.
- Kafka from host: `127.0.0.1:9092`, protocol `PLAINTEXT`.
- Kafka from Docker network `cmdbuild_default`: `kafka:29092`, protocol `PLAINTEXT`.
- `cmdbwebhooks2kafka`: `http://localhost:5080`, webhook route `POST /webhooks/cmdbuild`.
- `cmdbkafka2zabbix`: `http://localhost:5081`.
- `zabbixrequests2api`: `http://localhost:5082`.
- `monitoring-ui-api`: default `http://localhost:5090`; use another port only if configured or occupied.

Kafka currently has no SASL, no TLS, no login/password. `KAFKA_CLUSTER_ID` is a KRaft cluster identifier, not a password. Host access is limited by the localhost port binding; containers in the Docker network can connect to `kafka:29092` without credentials.

## Kafka Topics

Current development topics:

- CMDBuild events: `cmdbuild.webhooks.dev`.
- Zabbix JSON-RPC requests: `zabbix.host.requests.dev`.
- Zabbix responses: `zabbix.host.responses.dev`.

Confirm topic names from service configs before reading or writing. Do not make microservice code create topics. Create topics only as an explicit external/operator action when the user asks.

Useful checks:

```bash
docker ps --format 'table {{.Names}}	{{.Status}}	{{.Ports}}'
docker exec kafka kafka-topics --bootstrap-server kafka:29092 --list
docker exec kafka kafka-console-consumer --bootstrap-server kafka:29092 --topic <topic> --from-beginning --max-messages <n>
```

For “show latest messages”, prefer the repository UI event browser or a bounded Kafka consumer. Avoid unbounded consumers unless the user explicitly wants a live tail.

## CMDBuild Agreements

- Webhooks call `cmdbwebhooks2kafka` with `POST /webhooks/cmdbuild`.
- Webhook authorization is Bearer token; token is configured in the service and manually entered in CMDBuild.
- Webhook bodies should include `id`, `code`, `className`, and the class attributes used by rules.
- Current monitored classes are `Computer` descendants such as `Notebook`, `PC`, `Server`, and `tk`; do not create monitoring webhooks for superclasses.
- Common payload fields: `ip_address`, `dns_name`, `management_ip`, `management_dns`, `description`, `OS`, `zabbixTag`.
- `OS` and `zabbixTag` can be lookup values; mapping behavior is configured in rules.

If adding fields to webhooks, update rules and UI/docs through `$developer-local` as needed.

## Zabbix Agreements

- `zabbixrequests2api` validates host groups, templates, and template groups before API calls.
- Tags are created on hosts as part of host payload; missing host groups/templates/template groups are errors.
- Zabbix templates are existing Zabbix objects referenced by `templateid`, not JSON files in the repository.
- For host creation/update, at least one IP or DNS interface is required.
- Multi-address objects can be represented as either one Zabbix host with multiple `interfaces[]` or multiple Zabbix hosts through `hostProfiles[]`.

## End-to-End Checks

For create/update/delete investigation:

1. Check service configs for current topics, ports, tokens, and state file paths.
2. Inspect `cmdbuild.webhooks.dev` for incoming CMDBuild events.
3. Inspect `zabbix.host.requests.dev` for converted JSON-RPC requests.
4. Inspect `zabbix.host.responses.dev` for API success/errors.
5. Check state files for `cmdbkafka2zabbix` and `zabbixrequests2api` if old messages are unexpectedly skipped or replayed.
6. Use Zabbix UI/API to confirm host, templates, groups, tags, interfaces, and inventory.

When diagnosing missing objects, separate these failure points: webhook not sent, Kafka event missing, conversion skipped, request validation failed, Zabbix API error, or state offset already advanced.

## Safety

- Do not clear topics, delete hosts, change CMDBuild webhooks, or modify Zabbix objects unless the user explicitly asks.
- When clearing test data is requested, state exactly which topic/object will be affected and prefer bounded, reversible, or dev-only actions.
- Do not assume credentials or auth modes are production-safe; this skill describes the local dev environment only.
