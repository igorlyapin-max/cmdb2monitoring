# Информационная модель

## Информационные потоки

| ID | Источник | Приемник | Канал | Данные |
| --- | --- | --- | --- | --- |
| IF-001 | CMDBuild | cmdbwebhooks2kafka | HTTP POST `/webhooks/cmdbuild` | CMDBuild webhook payload |
| IF-002 | cmdbwebhooks2kafka | Kafka | topic `cmdbuild.webhooks.*` | Нормализованный CMDB event envelope |
| IF-003 | cmdbkafka2zabbix | Kafka | topic `zabbix.host.requests.*` | Zabbix JSON-RPC request |
| IF-004 | zabbixrequests2api | Zabbix API | HTTP POST `/api_jsonrpc.php` | `host.create`, `host.get`, `host.update`, `host.delete` |
| IF-005 | zabbixrequests2api | Kafka | topic `zabbix.host.responses.*` | Результат вызова Zabbix API |
| IF-006 | Микросервисы | Kafka | `*.logs.*` topics | Structured JSON logs для будущего ELK |
| IF-007 | cmdbkafka2zabbix | Git working copy | файл `rules/cmdbuild-to-zabbix-host-create.json` | Rules и T4 templates |
| IF-008 | Микросервисы | Local FS | `state/*.json` | Последний обработанный объект |

## Срез бизнес-описания

Основной бизнес-срез включает IF-001..IF-005. Он описывает жизненный цикл host в Zabbix по событиям CMDBuild.

## Срез поддержки и ИБ

Срез поддержки включает IF-006..IF-008:
- логи для ELK через Kafka topics;
- state-файлы для восстановления после падения;
- rules из Git;
- секреты и credentials через конфиги/переменные окружения.

## Основные объекты данных

### CMDB event envelope

Передается в `cmdbuild.webhooks.*`.

Поля:
- `source`;
- `eventType`: `create`, `update`, `delete`;
- `entityType`;
- `entityId`;
- `receivedAt`;
- `payload`.

### Zabbix request

Передается в `zabbix.host.requests.*`.

Поля:
- `jsonrpc`;
- `method`;
- `params`;
- `id`;
- optional metadata `cmdb2monitoring` для fallback-сценариев update/delete.

### Zabbix response

Передается в `zabbix.host.responses.*`.

Поля:
- `source`;
- `success`;
- `method`;
- `entityId`;
- `requestId`;
- `host`;
- `errorCode`;
- `errorMessage`;
- `zabbixRequestSent`;
- `processedAt`;
- `input`;
- `missing`;
- `zabbixResponse`.
