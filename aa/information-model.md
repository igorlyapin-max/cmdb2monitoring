# Информационная модель

## Информационные потоки

| ID | Источник | Приемник | Канал | Данные |
| --- | --- | --- | --- | --- |
| IF-001 | CMDBuild `:8090` | cmdbwebhooks2kafka `:5080` | HTTP POST `/webhooks/cmdbuild`, dev URL `http://192.168.202.100:5080/webhooks/cmdbuild` | CMDBuild webhook payload |
| IF-002 | cmdbwebhooks2kafka `:5080` | Kafka `:9092` | topic `cmdbuild.webhooks.*` | Нормализованный CMDB event envelope |
| IF-003 | cmdbkafka2zabbix `:5081` | Kafka `:9092` | topic `zabbix.host.requests.*` | Zabbix JSON-RPC request |
| IF-004 | zabbixrequests2api `:5082` | Zabbix API `:8081` | HTTP POST `/api_jsonrpc.php` | `host.create`, `host.get`, `host.update`, `host.delete` |
| IF-005 | zabbixrequests2api `:5082` | Kafka `:9092` | topic `zabbix.host.responses.*` | Результат вызова Zabbix API |
| IF-006 | Микросервисы `:5080/:5081/:5082` | Kafka `:9092` | `*.logs.*` topics | Structured JSON logs для будущего ELK |
| IF-007 | cmdbkafka2zabbix `:5081` | Git working copy | файл `rules/cmdbuild-to-zabbix-host-create.json` | Rules и T4 templates |
| IF-008 | Микросервисы `:5080/:5081/:5082` | Local FS | `state/*.json` | Последний обработанный объект |
| IF-009 | Browser | monitoring-ui-api `:5090` | HTTP UI/API | Session, dashboard, rules actions, catalog actions |
| IF-010 | monitoring-ui-api `:5090` | IdP SAML2 `:443/:80` | Redirect/POST SAML2 | AuthnRequest, SAMLResponse, metadata |
| IF-011 | monitoring-ui-api `:5090` | CMDBuild REST API `:8090` | HTTP | Classes, attributes, lookup types, optional service account |
| IF-012 | monitoring-ui-api `:5090` | Zabbix API `:8081` | HTTP JSON-RPC | Templates, host groups, template groups, known tags |
| IF-013 | monitoring-ui-api | Git working copy | файл rules JSON | Rules validate, dry-run, upload |
| IF-014 | monitoring-ui-api | Local FS | `data/*.json`, `state/ui-settings.json` | Catalog cache и persisted UI settings; runtime-файл не попадает в git |
| IF-015 | monitoring-ui-api `:5090` | Kafka `:9092` | read-only topics `cmdbuild.webhooks.*`, `zabbix.host.requests.*`, `zabbix.host.responses.*`, `*.logs.*` | Просмотр событий в UI Events через BFF |
| IF-016 | monitoring-ui-api `:5090` | .NET services `:5080/:5081/:5082` | HTTP GET `/health` | Проверка готовности микросервисов на dashboard |

## Срез бизнес-описания

Основной бизнес-срез включает IF-001..IF-005. Он описывает жизненный цикл host в Zabbix по событиям CMDBuild.

## Срез поддержки и ИБ

Срез поддержки включает IF-006..IF-016:
- логи для ELK через Kafka topics;
- state-файлы для восстановления после падения;
- rules из Git;
- frontend/BFF catalog cache;
- read-only просмотр Kafka topics через monitoring-ui-api;
- health dashboard микросервисов через HTTP endpoints;
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

`params` для `host.create/update` может включать:
- `host`, `name`, `status`;
- `inventory_mode`, `inventory`;
- `interfaces`, `groups`, `templates`, `tags`;
- `macros`;
- `proxyid`, `proxy_groupid`;
- TLS/PSK поля `tls_connect`, `tls_accept`, `tls_psk_identity`, `tls_psk`.

Если передается `inventory`, `inventory_mode` не должен быть `-1`.

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
- tags;
- proxies;
- proxyGroups;
- macros;
- inventoryFields;
- interfaceProfiles;
- hostStatuses;
- maintenances;
- tlsPskModes;
- valueMaps.

CMDBuild cache:
- classes;
- attributes;
- lookups.
