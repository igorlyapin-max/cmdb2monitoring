# Modernization Backlog - 2026-06-03

This backlog records non-blocking gaps left after the P0/P1 production-rollout iteration and the follow-up observability/live-smoke iteration.

## Closed in follow-up iteration

- Prometheus alert rules and Grafana dashboard for `/metrics`, Kafka queue lag, DLQ depth, auth failures, catalog sync failures, rules reload failures, DLQ publication, and Zabbix request failures.
- Production-ready guarded live smoke script for create/update/delete checks with dev defaults, dry-run by default, explicit execute confirmation, and production-like test-object guardrails.

## P2

- Deeper dependency readiness probes for Kafka/Zabbix/CMDBuild where the deployment platform can tolerate dependency-driven restarts.
- Real ELK/OpenSearch HTTP sink validation after an endpoint and index/API-key model are approved.
- External shared state/lock design for multi-active Kafka worker replicas.
- Production execution of live smoke after environment-specific service accounts and test-object policy are approved.

## P3

- Additional diagrams for production Compose topology and syslog/Kafka log routing.
- Optional env-file generator for production deployments.
- Optional linting for Compose variable completeness beyond the current static runtime contract checks.
