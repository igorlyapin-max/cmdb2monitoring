# Карта метрик

Все backend-сервисы публикуют Prometheus text format на `GET /metrics`. Базовый контракт:

- `cmdb2monitoring_service_started_at_seconds{service}` - время старта сервиса;
- `cmdb2monitoring_events_total{service,name}` - счетчики событий сервиса;
- `cmdb2monitoring_queue_*` - queue lag / DLQ depth gauges, которые публикует `monitoring-ui-api` по настройкам `QueueMonitor`.

Prometheus alert rules находятся в `deploy/observability/prometheus/cmdb2monitoring-alerts.yml`, Grafana dashboard - в `deploy/observability/grafana/cmdb2monitoring-dashboard.json`.

| Metric ID | Связанные потоки | Компонент | Метрика | Назначение | Статус |
| --- | --- | --- | --- | --- | --- |
| M-001 | IF-001, IF-002 | cmdbwebhooks2kafka | `cmdb2monitoring_events_total{name="webhook_accepted"}` | Количество принятых webhook | Реализовано |
| M-002 | IF-001 | cmdbwebhooks2kafka | `cmdb2monitoring_events_total{name=~"webhook_rejected_.*"}` | Ошибки авторизации, rate limit и JSON | Реализовано |
| M-003 | IF-002, IF-003 | cmdbkafka2zabbix | `cmdb2monitoring_events_total{name="conversion_published"}` | Успешные публикации Zabbix request | Реализовано |
| M-004 | IF-002 | cmdbkafka2zabbix | `cmdb2monitoring_events_total{name="conversion_skipped"}` | Некорректные/неподдерживаемые события | Реализовано |
| M-005 | IF-004, IF-005 | zabbixrequests2api | `cmdb2monitoring_events_total{name="zabbix_request_success"}` | Успешные вызовы Zabbix API | Реализовано |
| M-006 | IF-003, IF-004, IF-005 | zabbixrequests2api | `cmdb2monitoring_events_total{name="zabbix_request_failed"}` | Ошибки API/валидации | Реализовано |
| M-007 | IF-003, IF-004, IF-005 | zabbixrequests2api | processing latency | Время обработки объекта | Backlog |
| M-008 | IF-002, IF-003, IF-005 | monitoring-ui-api / Kafka | `cmdb2monitoring_queue_lag{mode="Lag"}` | Отставание consumer pipeline по high watermark и worker state | Реализовано |
| M-009 | IF-009 | monitoring-ui-api | active session count | Количество активных server-side sessions | Backlog |
| M-010 | IF-010 | monitoring-ui-api | `cmdb2monitoring_events_total{name=~"auth_.*|authorization_failure"}` | Контроль локальной, LDAP и IdP авторизации | Реализовано |
| M-011 | IF-011, IF-012, IF-014 | monitoring-ui-api | `cmdb2monitoring_events_total{name=~".*_catalog_sync_.*"}` | Контроль синхронизации CMDBuild/Zabbix catalog | Реализовано |
| M-012 | IF-013, IF-014, IF-019 | monitoring-ui-api | `cmdb2monitoring_events_total{name=~"rules_reload_.*"}` | Контроль reload conversion rules через UI/BFF | Реализовано |
| M-013 | IF-018 | cmdbkafka2zabbix | cmdb resolver duration/error count | Контроль чтения CMDBuild reference/lookup/domain leaf-значений | Backlog |
| M-014 | IF-021, IF-022 | zabbixbindings2cmdbuild | `cmdb2monitoring_events_total{name=~"binding_.*"}` | Контроль обратной записи `zabbix_main_hostid` и `ZabbixHostBinding` | Реализовано |
| M-015 | IF-002, IF-003, IF-005 | cmdbkafka2zabbix / zabbixrequests2api | `cmdb2monitoring_events_total{name="dead_letter_published"}` | Контроль публикации DLQ сообщений | Реализовано |
| M-016 | IF-002, IF-003, IF-005 | monitoring-ui-api / Kafka | `cmdb2monitoring_queue_lag{mode="TopicDepth"}` | DLQ depth по Kafka low/high watermark | Реализовано |
