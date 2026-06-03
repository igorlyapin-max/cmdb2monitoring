# Modernization Backlog - 2026-06-03

This backlog records non-blocking gaps left after the P0/P1 production-rollout iteration.

## P2

- Prometheus dashboards and alert rules for `/metrics`, Kafka consumer lag, DLQ depth, auth failures, catalog sync failures, and rules reload failures.
- Deeper dependency readiness probes for Kafka/Zabbix/CMDBuild where the deployment platform can tolerate dependency-driven restarts.
- Real ELK/OpenSearch HTTP sink validation after an endpoint and index/API-key model are approved.
- External shared state/lock design for multi-active Kafka worker replicas.
- Production smoke scripts for live create/update/delete with CMDBuild, Kafka, and Zabbix after environment-specific service accounts are available.

## P3

- Additional diagrams for production Compose topology and syslog/Kafka log routing.
- Optional env-file generator for production deployments.
- Optional linting for Compose variable completeness beyond the current static runtime contract checks.
