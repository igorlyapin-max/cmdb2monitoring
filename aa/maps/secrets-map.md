# Карта секретов

| Secret ID | Где используется | Конфиг/env | Ротация | Комментарий |
| --- | --- | --- | --- | --- |
| SEC-001 | CMDBuild -> cmdbwebhooks2kafka | `CmdbWebhook` token или env | По политике ИБ | Static token сейчас, dynamic mode зарезервирован |
| SEC-002 | Kafka SASL для cmdbwebhooks2kafka | `Kafka__Username`, `Kafka__Password` | По политике Kafka | В dev не используется |
| SEC-003 | Kafka SASL для cmdbkafka2zabbix input/output/logs | `Kafka__Input__*`, `Kafka__Output__*`, `ElkLogging__Kafka__*` | По политике Kafka | В dev не используется |
| SEC-004 | Kafka SASL для zabbixrequests2api input/output/logs | `Kafka__Input__*`, `Kafka__Output__*`, `ElkLogging__Kafka__*` | По политике Kafka | В dev не используется |
| SEC-005 | Zabbix API token | `Zabbix__ApiToken` | По политике Zabbix | Рекомендуемый prod-режим |
| SEC-006 | Zabbix login/password | `Zabbix__User`, `Zabbix__Password` | По политике Zabbix | Dev использует `Admin/zabbix`; prod через secret storage |
| SEC-007 | ELK API key | `ElkLogging__Elk__ApiKey` | По политике ELK | Пока ELK не подключен |

Production/base config не должен хранить реальные секреты. Использовать переменные окружения, secret storage или local config, исключенный из git.
