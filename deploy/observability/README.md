# cmdb2monitoring observability

Artifacts:

- `prometheus/cmdb2monitoring-alerts.yml` - Prometheus alert rules for service metrics, queue lag, DLQ depth, auth failures, catalog sync failures, rules reload failures, DLQ publication, and Zabbix request failures.
- `grafana/cmdb2monitoring-dashboard.json` - Grafana dashboard using Prometheus datasource variable `DS_PROMETHEUS`.

Expected scrape targets:

- `cmdbwebhooks2kafka` `/metrics`
- `cmdbkafka2zabbix` `/metrics`
- `zabbixrequests2api` `/metrics`
- `zabbixbindings2cmdbuild` `/metrics`
- `monitoring-ui-api` `/metrics`

Validate repository artifacts:

```bash
./scripts/validate-observability.sh
node scripts/live-smoke.mjs --dry-run
```
