# Карта доступов Kafka

| Topic dev | Topic base/prod | Information flows | Producer | Consumer | Данные | Auth текущий dev |
| --- | --- | --- | --- | --- | --- | --- |
| `cmdbuild.webhooks.dev` | `cmdbuild.webhooks` | IF-002, IF-015 | cmdbwebhooks2kafka | cmdbkafka2zabbix, monitoring-ui-api read-only | CMDB event envelope | Plaintext |
| `zabbix.host.requests.dev` | `zabbix.host.requests` | IF-003, IF-015 | cmdbkafka2zabbix | zabbixrequests2api, monitoring-ui-api read-only | Zabbix JSON-RPC request | Plaintext |
| `zabbix.host.responses.dev` | `zabbix.host.responses` | IF-005, IF-015 | zabbixrequests2api | monitoring-ui-api read-only, будущий status UI | Результаты Zabbix API | Plaintext |
| `cmdbwebhooks2kafka.logs.dev` | `cmdbwebhooks2kafka.logs` | IF-006, IF-015 | cmdbwebhooks2kafka | monitoring-ui-api read-only, будущий ELK shipper | Structured logs | Plaintext |
| `cmdbkafka2zabbix.logs.dev` | `cmdbkafka2zabbix.logs` | IF-006, IF-015 | cmdbkafka2zabbix | monitoring-ui-api read-only, будущий ELK shipper | Structured logs | Plaintext |
| `zabbixrequests2api.logs.dev` | `zabbixrequests2api.logs` | IF-006, IF-015 | zabbixrequests2api | monitoring-ui-api read-only, будущий ELK shipper | Structured logs | Plaintext |

Kafka topics создаются внешней инфраструктурой. Микросервисы не создают topics при старте.

`monitoring-ui-api` имеет read-only Kafka-доступ для вкладки Events. Браузер не подключается к Kafka напрямую; все чтение выполняется BFF-адаптером по настройкам `EventBrowser`.

Для SASL/TLS должны быть заполнены соответствующие параметры `SecurityProtocol`, `SaslMechanism`, `Username`, `Password` во всех Kafka-секциях.
