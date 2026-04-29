# Карта доступов Kafka

| Topic dev | Topic base/prod | Producer | Consumer | Данные | Auth текущий dev |
| --- | --- | --- | --- | --- | --- |
| `cmdbuild.webhooks.dev` | `cmdbuild.webhooks` | cmdbwebhooks2kafka | cmdbkafka2zabbix | CMDB event envelope | Plaintext |
| `zabbix.host.requests.dev` | `zabbix.host.requests` | cmdbkafka2zabbix | zabbixrequests2api | Zabbix JSON-RPC request | Plaintext |
| `zabbix.host.responses.dev` | `zabbix.host.responses` | zabbixrequests2api | будущий потребитель/status UI | Результаты Zabbix API | Plaintext |
| `cmdbwebhooks2kafka.logs.dev` | `cmdbwebhooks2kafka.logs` | cmdbwebhooks2kafka | будущий ELK shipper | Structured logs | Plaintext |
| `cmdbkafka2zabbix.logs.dev` | `cmdbkafka2zabbix.logs` | cmdbkafka2zabbix | будущий ELK shipper | Structured logs | Plaintext |
| `zabbixrequests2api.logs.dev` | `zabbixrequests2api.logs` | zabbixrequests2api | будущий ELK shipper | Structured logs | Plaintext |

Kafka topics создаются внешней инфраструктурой. Микросервисы не создают topics при старте.

`monitoring-ui-api` в текущей реализации не имеет прямого Kafka-доступа. Просмотр событий через UI остается отдельной будущей задачей и должен выполняться через BFF-адаптер, а не из браузера.

Для SASL/TLS должны быть заполнены соответствующие параметры `SecurityProtocol`, `SaslMechanism`, `Username`, `Password` во всех Kafka-секциях.
