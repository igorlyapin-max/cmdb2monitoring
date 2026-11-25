# Карта доступов Kafka

| Topic dev | Topic base/prod | Information flows | Producer | Consumer | Данные | Auth текущий dev |
| --- | --- | --- | --- | --- | --- | --- |
| `cmdbuild.webhooks.dev` | `cmdbuild.webhooks` | AAPI0, AAPI3 | cmdbwebhooks2kafka | cmdbkafka2zabbix, monitoring-ui-api read-only | CMDB event envelope | Plaintext |
| `zabbix.host.requests.dev` | `zabbix.host.requests` | AAPI1, AAPI3 | cmdbkafka2zabbix | zabbixrequests2api, monitoring-ui-api read-only | Zabbix JSON-RPC request | Plaintext |
| `zabbix.host.responses.dev` | `zabbix.host.responses` | AAPI2, AAPI3 | zabbixrequests2api | monitoring-ui-api read-only, будущий status UI | Результаты Zabbix API | Plaintext |
| `zabbix.host.bindings.dev` | `zabbix.host.bindings` | AAPI4, AAPI3 | zabbixrequests2api | zabbixbindings2cmdbuild, monitoring-ui-api read-only | CMDBuild card/profile -> Zabbix hostid binding event | Plaintext |
| `cmdbwebhooks2kafka.logs.dev` | `cmdbwebhooks2kafka.logs` | L0, AAPI3 | cmdbwebhooks2kafka | monitoring-ui-api read-only, будущий ELK shipper | Structured logs | Plaintext |
| `cmdbkafka2zabbix.logs.dev` | `cmdbkafka2zabbix.logs` | L0, AAPI3 | cmdbkafka2zabbix | monitoring-ui-api read-only, будущий ELK shipper | Structured logs | Plaintext |
| `zabbixrequests2api.logs.dev` | `zabbixrequests2api.logs` | L0, AAPI3 | zabbixrequests2api | monitoring-ui-api read-only, будущий ELK shipper | Structured logs | Plaintext |
| `zabbixbindings2cmdbuild.logs.dev` | `zabbixbindings2cmdbuild.logs` | L0, AAPI3 | zabbixbindings2cmdbuild | monitoring-ui-api read-only, будущий ELK shipper | Structured logs | Plaintext |
| `monitoring-ui-api.logs.dev` | `monitoring-ui-api.logs` | L0, AAPI3 | monitoring-ui-api | monitoring-ui-api read-only, будущий ELK shipper | Structured UI/BFF logs | Plaintext |

Kafka topics создаются внешней инфраструктурой. Микросервисы не создают topics при старте.

Браузер не подключается к Kafka напрямую; все чтение выполняется BFF-адаптером `monitoring-ui-api` по настройкам `EventBrowser`. Для вкладки Events Kafka principal BFF требует `READ` и `DESCRIBE` на каждый topic из deployment-owned списка `MONITORING_UI_EVENTS_TOPICS_JSON`, а также `READ` и `DESCRIBE` на временные consumer groups `${EventBrowser.ClientId}-*`. Это read-only доступ к business, DLQ и log topics.

При включенном Kafka log sink `monitoring-ui-api` отдельно требует `WRITE` и `DESCRIBE` только на `monitoring-ui-api.logs`; права `CREATE` не требуются, поскольку topics создает внешняя инфраструктура. Контейнер BFF должен иметь сетевой TLS/SASL-доступ не только к `MONITORING_UI_KAFKA_BOOTSTRAP_SERVERS`, но и ко всем endpoints из Kafka `advertised.listeners`, иначе поиск group coordinator завершается ошибкой до проверки ACL topic.

Для SASL/TLS должны быть заполнены соответствующие параметры `SecurityProtocol`, `SaslMechanism`, `Username`, `Password` во всех Kafka-секциях.
