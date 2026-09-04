# Карта метрик

## Контракт сбора

Prometheus выполняет pull-сбор с `GET /metrics` всех backend-сервисов. Endpoint отвечает в Prometheus text format (`text/plain; version=0.0.4; charset=utf-8`). Период scrape, retention и контурный адрес Prometheus определяет deployment; для текущих dev endpoint значений периода нет, поэтому он обозначен как `Требует согласования`.

| Collection ID | Information flow | Коллектор | Источник | Endpoint dev | Протокол и ожидаемый ответ | Период | Поведение при ошибке | Назначение |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MC-001 | M0 | Prometheus | cmdbwebhooks2kafka | `GET http://localhost:5080/metrics` | HTTP, Prometheus text format | Требует согласования | target становится недоступен; `Cmdb2MonitoringServiceMetricsMissing` срабатывает после 3 минут отсутствия базовой метрики | Контроль приема CMDBuild webhook |
| MC-002 | M0 | Prometheus | cmdbkafka2zabbix | `GET http://localhost:5081/metrics` | HTTP, Prometheus text format | Требует согласования | target становится недоступен; `Cmdb2MonitoringServiceMetricsMissing` срабатывает после 3 минут отсутствия базовой метрики | Контроль конвертации и Kafka pipeline |
| MC-003 | M0 | Prometheus | zabbixrequests2api | `GET http://localhost:5082/metrics` | HTTP, Prometheus text format | Требует согласования | target становится недоступен; `Cmdb2MonitoringServiceMetricsMissing` срабатывает после 3 минут отсутствия базовой метрики | Контроль вызовов Zabbix API |
| MC-004 | M0 | Prometheus | zabbixbindings2cmdbuild | `GET http://localhost:5083/metrics` | HTTP, Prometheus text format | Требует согласования | target становится недоступен; `Cmdb2MonitoringServiceMetricsMissing` срабатывает после 3 минут отсутствия базовой метрики | Контроль обратной записи Zabbix binding в CMDBuild |
| MC-005 | M0 | Prometheus | monitoring-ui-api | `GET http://localhost:5090/metrics` | HTTP, Prometheus text format | Требует согласования | target становится недоступен; для queue state error предусмотрен `Cmdb2MonitoringQueueStateError` | Контроль BFF, catalog sync и Kafka queue monitor |

`/metrics` не заменяет `/health` и `/ready`: отсутствие scrape означает недоступность наблюдаемости, но не является проверкой доступности внешних Kafka, CMDBuild или Zabbix. Их ошибки отражаются сервисными метриками и отдельными smoke-проверками.

## Правила проектирования

- Counter используется для накопленных событий, gauge - для текущего состояния или величины, histogram - для длительности в секундах.
- Разрешены только ограниченные labels из кода или deployment-конфигурации: `service`, `name`, `pipeline`, `topic`, `mode`, `threshold`, а для планируемых метрик - `role`, `category`, `dependency`, `operation`, `result`, `version`, `revision`, `provenance`.
- `topic` допустим только для конечного списка pipeline/topic из `QueueMonitor` deployment-конфигурации. Нельзя добавлять в labels идентификаторы объектов, пользователей, payload, текст ошибок, токены либо динамически обнаруженные topic.
- Поле `name` у `cmdb2monitoring_events_total` - конечное перечисление имен событий, определенное кодом. Новое значение должно быть добавлено в эту карту и проверено на отсутствие роста cardinality.

Prometheus alert rules находятся в `deploy/observability/prometheus/cmdb2monitoring-alerts.yml`, Grafana dashboard - в `deploy/observability/grafana/cmdb2monitoring-dashboard.json`.

## Каталог метрик

| Metric ID | Связанные потоки | Компонент | Метрика, тип, единица | Допустимые labels | Назначение | Alert/dashboard | Статус |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M-001 | OAPI0, AAPI0, M0 | cmdbwebhooks2kafka | `cmdb2monitoring_events_total{name="webhook_accepted"}`, counter, события | `service`, `name` | Количество принятых webhook | Grafana `Service events` | Реализовано |
| M-002 | OAPI0, M0 | cmdbwebhooks2kafka | `cmdb2monitoring_events_total{name=~"webhook_rejected_.*"}`, counter, события | `service`, `name` | Ошибки авторизации, rate limit и JSON | `Cmdb2MonitoringWebhookAuthRejected`; Grafana `Service events` | Реализовано |
| M-003 | AAPI0, AAPI1, M0 | cmdbkafka2zabbix | `cmdb2monitoring_events_total{name="conversion_published"}`, counter, события | `service`, `name` | Успешные публикации Zabbix request | Grafana `Service events` | Реализовано |
| M-004 | AAPI0, M0 | cmdbkafka2zabbix | `cmdb2monitoring_events_total{name="conversion_skipped"}`, counter, события | `service`, `name` | Некорректные или неподдерживаемые события | Grafana `Service events` | Реализовано |
| M-005 | OAPI1, AAPI2, M0 | zabbixrequests2api | `cmdb2monitoring_events_total{name="zabbix_request_success"}`, counter, события | `service`, `name` | Успешные вызовы Zabbix API | Grafana `Service events` | Реализовано |
| M-006 | AAPI1, OAPI1, AAPI2, M0 | zabbixrequests2api | `cmdb2monitoring_events_total{name="zabbix_request_failed"}`, counter, события | `service`, `name` | Ошибки API или валидации | `Cmdb2MonitoringZabbixRequestFailures`; Grafana `Service events` | Реализовано |
| M-007 | AAPI1, OAPI1, AAPI2, M0 | zabbixrequests2api | `cmdb2monitoring_zabbix_request_duration_seconds`, histogram, секунды | `service`, `operation`, `result` | Длительность запросов к Zabbix API | Требует alert/dashboard по SLO | Требуется реализация |
| M-008 | AAPI0, AAPI1, AAPI2, M0 | monitoring-ui-api / Kafka | `cmdb2monitoring_queue_lag{mode="Lag"}`, gauge, сообщения | `service`, `pipeline`, `topic`, `mode` | Отставание consumer pipeline по high watermark и worker state | `Cmdb2MonitoringQueueCritical`, `Cmdb2MonitoringQueueStateError`; Grafana `Kafka queue lag` | Реализовано |
| M-009 | OAPI2, M0 | monitoring-ui-api | `cmdb2monitoring_active_sessions`, gauge, сессии | `service` | Количество активных server-side sessions | Требует dashboard | Требуется реализация |
| M-010 | OAPI3, M0 | monitoring-ui-api | `cmdb2monitoring_events_total{name=~"auth_.*|authorization_failure"}`, counter, события | `service`, `name` | Контроль локальной, LDAP и IdP авторизации | `Cmdb2MonitoringUiAuthFailures`; Grafana `Authentication failures` | Реализовано |
| M-011 | OAPI4, OAPI5, IF3, M0 | monitoring-ui-api | `cmdb2monitoring_events_total{name=~".*_catalog_sync_.*"}`, counter, события | `service`, `name` | Контроль синхронизации CMDBuild/Zabbix catalog | `Cmdb2MonitoringCatalogSyncFailures`; Grafana `Catalog and rules operations` | Реализовано |
| M-012 | IF2, IF3, OAPI7, M0 | monitoring-ui-api | `cmdb2monitoring_events_total{name=~"rules_reload_.*"}`, counter, события | `service`, `name` | Контроль reload conversion rules через UI/BFF | `Cmdb2MonitoringRulesReloadFailures`; Grafana `Catalog and rules operations` | Реализовано |
| M-013 | OAPI6, M0 | cmdbkafka2zabbix | `cmdb2monitoring_cmdb_resolver_duration_seconds`, histogram, секунды; `cmdb2monitoring_cmdb_resolver_errors_total`, counter, события | `service`, `result` | Контроль чтения CMDBuild reference/lookup/domain leaf-значений | Требует alert/dashboard по SLO и ошибкам | Требуется реализация |
| M-014 | AAPI4, OAPI9, M0 | zabbixbindings2cmdbuild | `cmdb2monitoring_events_total{name=~"binding_.*"}`, counter, события | `service`, `name` | Контроль обратной записи `zabbix_main_hostid` и `ZabbixHostBinding` | Grafana `Service events` | Реализовано |
| M-015 | AAPI0, AAPI1, AAPI2, M0 | cmdbkafka2zabbix / zabbixrequests2api | `cmdb2monitoring_events_total{name="dead_letter_published"}`, counter, события | `service`, `name` | Контроль публикации DLQ сообщений | `Cmdb2MonitoringDeadLetterPublished`; Grafana `DLQ messages` | Реализовано |
| M-016 | AAPI0, AAPI1, AAPI2, M0 | monitoring-ui-api / Kafka | `cmdb2monitoring_queue_lag{mode="TopicDepth"}`, gauge, сообщения | `service`, `pipeline`, `topic`, `mode` | DLQ depth по Kafka low/high watermark | `Cmdb2MonitoringDeadLetterDepth`; Grafana `Kafka queue lag` | Реализовано |
| M-017 | AAPI0, AAPI1, AAPI2, AAPI3, M0 | Kafka consumers/producers | `cmdb2monitoring_kafka_connection_attempts_total`, counter, попытки; `cmdb2monitoring_kafka_connection_errors_total`, counter, ошибки | `service`, `role`, `category`; `category`: `dns`, `timeout`, `tls`, `sasl_auth`, `broker_unavailable` | Диагностика доступности и авторизации Kafka без записи текста ошибки в label | Требует alert/dashboard по категориям | Требуется реализация |
| M-018 | AAPI0, AAPI1, AAPI2, AAPI3, M0 | Kafka consumers/producers | `cmdb2monitoring_kafka_connection_duration_seconds`, histogram, секунды | `service`, `role`, `result` | Длительность установления соединения с Kafka | Требует dashboard по latency | Требуется реализация |
| M-019 | AAPI0, AAPI1, AAPI2, AAPI3, M0 | Kafka consumers | `cmdb2monitoring_queue_oldest_event_age_seconds`, gauge, секунды | `service`, `pipeline` | Возраст самого старого необработанного события в поддерживаемом pipeline | Требует alert по допустимому возрасту | Требуется реализация |
| M-020 | OAPI4, OAPI5, OAPI6, OAPI8, OAPI9, M0 | monitoring-ui-api / cmdbkafka2zabbix / zabbixbindings2cmdbuild | `cmdb2monitoring_external_request_duration_seconds`, histogram, секунды; `cmdb2monitoring_external_requests_total`, counter, запросы | `service`, `dependency`, `operation`, `result` | Длительность и результат вызовов CMDBuild и Zabbix API | Требует alert/dashboard по SLO | Требуется реализация |
| M-021 | M0 | Все сервисы | `cmdb2monitoring_build_info`, gauge, `1` | `service`, `version`, `revision`, `provenance` | Идентификация развернутой сборки и происхождения образа | Требует dashboard release inventory | Требуется реализация |
| M-022 | M0 | Все сервисы | `cmdb2monitoring_service_started_at_seconds`, gauge, Unix seconds | `service` | Время старта сервиса и базовый признак доступности метрик | `Cmdb2MonitoringServiceMetricsMissing`; Grafana `Service metrics availability` | Реализовано |
