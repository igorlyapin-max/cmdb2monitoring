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
| IF-009 | Browser | monitoring-ui-api | HTTP UI/API | Session, dashboard, rules actions, catalog actions |
| IF-010 | monitoring-ui-api | IdP SAML2 | Redirect/POST SAML2 | AuthnRequest, SAMLResponse, metadata |
| IF-011 | monitoring-ui-api | CMDBuild REST API | HTTP | Classes, attributes, lookup types, optional service account |
| IF-012 | monitoring-ui-api | Zabbix API | HTTP JSON-RPC | Templates, host groups, template groups, known tags |
| IF-013 | monitoring-ui-api | Git working copy | файл rules JSON | Rules validate, dry-run, upload |
| IF-014 | monitoring-ui-api | Local FS | `data/*.json`, `state/ui-settings.json` | Catalog cache и persisted UI settings без runtime secrets в git |

## Срез бизнес-описания

Основной бизнес-срез включает IF-001..IF-005. Он описывает жизненный цикл host в Zabbix по событиям CMDBuild.

## Срез поддержки и ИБ

Срез поддержки включает IF-006..IF-014:
- логи для ELK через Kafka topics;
- state-файлы для восстановления после падения;
- rules из Git;
- frontend/BFF catalog cache;
- SAML2 session и IdP settings;
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

### Monitoring UI session

Хранится в памяти процесса `monitoring-ui-api`.

Поля:
- `authMethod`: `local` или `saml2`;
- `roles`: `admin`, `operator`, `readonly`;
- `identity`: login/email/displayName/groups для SAML2;
- `cmdbuild`: base URL и server-side credentials;
- `zabbix`: API endpoint и server-side credentials/token;
- `createdAt`, `lastSeenAt`.

### Catalog cache

Хранится в `src/monitoring-ui-api/data/*.json` и не попадает в git.

Zabbix cache:
- templates;
- hostGroups;
- templateGroups;
- tags.

CMDBuild cache:
- classes;
- attributes;
- lookups.
