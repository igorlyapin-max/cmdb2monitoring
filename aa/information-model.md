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
| IF-010 | monitoring-ui-api `:5090` | IdP/SAML2/OAuth2 и MS AD LDAP/LDAPS `:443/:80/:636/:389` | Redirect/POST SAML2, OAuth2 Authorization Code, LDAP bind/search | AuthnRequest, SAMLResponse, metadata, OAuth2 code/token/userinfo, LDAP user/groups |
| IF-011 | monitoring-ui-api `:5090` | CMDBuild REST API `:8090` | HTTP | Classes, attributes, lookup types, optional session credentials |
| IF-012 | monitoring-ui-api `:5090` | Zabbix API `:8081` | HTTP JSON-RPC | Templates, host groups, template groups, known tags, template item keys/LLD/inventory metadata, existing host templates |
| IF-013 | monitoring-ui-api | Git working copy | файл rules JSON | Rules validate, dry-run, upload |
| IF-014 | monitoring-ui-api | Local FS | `data/*.json`, `state/ui-settings.json`, `state/users.json` | Catalog cache, persisted UI settings и local users; runtime/state-файлы не попадают в git |
| IF-015 | monitoring-ui-api `:5090` | Kafka `:9092` | read-only topics `cmdbuild.webhooks.*`, `zabbix.host.requests.*`, `zabbix.host.responses.*`, `*.logs.*` | Просмотр событий в UI Events через BFF |
| IF-016 | monitoring-ui-api `:5090` | .NET services `:5080/:5081/:5082` | HTTP GET `/health` | Проверка готовности микросервисов на dashboard |
| IF-017 | Browser | Local downloads | rules JSON и `*-webhook-bodies.txt` | `Управление правилами конвертации` / `Save file as`: draft rules и webhook Body/DELETE-инструкции только по изменениям текущей UI-сессии |
| IF-018 | cmdbkafka2zabbix `:5081` | CMDBuild REST API `:8090` | HTTP GET `/classes/{class}/attributes`, `/classes/{class}/cards/{id}`, `/classes/{class}/cards/{id}/relations`, `/lookup_types/{type}/values` | Подъем reference/lookup/domain leaf-значений по `source.fields[].cmdbPath` |
| IF-019 | monitoring-ui-api `:5090` | cmdbkafka2zabbix `:5081` | HTTP POST `/admin/reload-rules` с Bearer token | Сигнал перечитывания conversion rules через provider abstraction |
| IF-020 | monitoring-ui-api `:5090` | CMDBuild REST API `:8090` | HTTP GET/POST/PUT/DELETE `/etl/webhook/` | Чтение и применение выбранного плана CMDBuild webhooks в разделе `Настройка webhooks` |

## Срез бизнес-описания

Основной бизнес-срез включает IF-001..IF-005. Он описывает жизненный цикл host в Zabbix по событиям CMDBuild.

## Срез поддержки и ИБ

Срез поддержки включает IF-006..IF-020:
- логи для ELK через Kafka topics;
- state-файлы для восстановления после падения;
- rules из Git;
- frontend/BFF catalog cache;
- read-only просмотр Kafka topics через monitoring-ui-api;
- health dashboard микросервисов через HTTP endpoints;
- локальный save-as draft rules и webhook-инструкций для оператора;
- чтение CMDBuild reference/lookup/domain leaf-значений конвертером по path metadata из rules;
- авторизованный reload сигнал для перечитывания conversion rules;
- настройка managed CMDBuild webhooks из UI через BFF с явным apply и ограничением префикса `cmdbwebhooks2kafka-`;
- Authorization session и settings для локального входа, MS AD LDAP/LDAPS и IdP SAML2/OAuth2/OIDC;
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
- optional metadata `cmdb2monitoring` для внутренних сценариев и fallback update/delete; содержит `eventType`, `entityId`, `host`, `hostProfile`.

`params` для `host.create/update` может включать:
- `host`, `name`, `status`;
- `inventory_mode`, `inventory`;
- `interfaces`, `groups`, `templates`, `tags`; `interfaces` может содержать несколько элементов для одного Zabbix host;
- `macros`;
- `proxyid`, `proxy_groupid`;
- TLS/PSK поля `tls_connect`, `tls_accept`, `tls_psk_identity`, `tls_psk`.

Если передается `inventory`, `inventory_mode` не должен быть `-1`.

Для `host.update` поля `groups`, `templates`, `tags`, `macros` и `inventory` являются merge-полями на стороне `zabbixrequests2api`: текущие значения Zabbix host сохраняются, если rules не передают значение с тем же ключом. `templates_clear` явно удаляет конфликтующие linked templates. `interfaces` остаются authoritative по rules, writer только переносит существующие `interfaceid`.

Zabbix template metadata из IF-012 хранится рядом с catalog cache и содержит `itemKeys`, `discoveryRuleKeys`, `inventoryLinks`, parent templates, existing host templates и индекс конфликтов. UI использует индекс для предупреждений и блокировок в редакторе rules и Logical Control, а `zabbixrequests2api` повторяет проверку непосредственно перед `host.create/update`.

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
- `authMethod`: `local`, `saml2`, `oauth2` или `ldap`;
- `roles`: `admin`, `editor`, `viewer`;
- `identity`: login/email/displayName/groups для IdP или local user;
- optional `oauth2`: token metadata без записи в state-файл;
- `cmdbuild`: base URL и session-only credentials, если они уже запрошены;
- `zabbix`: API endpoint и session-only credentials/token, если они уже заданы;
- `createdAt`, `lastSeenAt`.

### Monitoring UI users

Хранится в `src/monitoring-ui-api/state/users.json` рядом с `ui-settings.json` и не попадает в git.

Поля:
- `username`;
- `displayName`;
- `role`: `viewer`, `editor`, `admin`;
- `password`: PBKDF2-SHA256 settings, salt и hash;
- `mustChangePassword`;
- `createdAt`, `updatedAt`.

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
- domains;
- lookups;
- lookup values, если `Cmdbuild:Catalog:IncludeLookupValues=true`.

Conversion rules могут содержать `source.fields[].cmdbPath`. Webhook payload при этом остается плоским: значение source key является scalar или numeric id первого reference/lookup, а converter поднимает leaf через CMDBuild REST по path metadata из rules. Для N:N CMDBuild domains используется path `Class.{domain:TargetClass}.Attribute`; converter читает relations текущей карточки и обрабатывает найденные target cards тем же leaf resolver.

### Conversion rules draft session

Хранится в памяти браузера текущей вкладки `monitoring-ui-api`.

Содержит:
- draft rules JSON;
- undo/redo history текущей UI-сессии;
- выбранное действие edit mode: добавление или удаление rule;
- diff между начальным rules JSON и draft для генерации `*-webhook-bodies.txt`.

`Save file as` не пишет draft на backend. Пользователь сохраняет два локальных файла:
- draft rules JSON;
- текстовый файл с CMDBuild webhook Body snippets для добавлений и DELETE-инструкциями для удалений.

### CMDBuild webhook plan

Хранится в памяти браузера текущей вкладки `monitoring-ui-api` и может быть выгружен через `Save file as`.

Содержит:
- текущие managed/unmanaged CMDBuild webhook records, загруженные через BFF;
- желаемые managed records, построенные из conversion rules;
- операции `create`, `update`, `delete` с checkbox выбора;
- current/desired JSON для проверки оператором.

`Save file as` сохраняет только JSON-план локально. `Загрузить в CMDB` отправляет выбранные операции на BFF, а BFF применяет их к CMDBuild REST `/etl/webhook/`. Backend принимает к apply только records с префиксом `cmdbwebhooks2kafka-`, чтобы не менять чужие CMDBuild webhooks.

### Interface language preference

Хранится в cookie браузера `c2m_lang`.

Значения:
- `ru`;
- `en`.

Выбор языка применяется к меню, заголовкам разделов, разделу Help и всплывающим подсказкам. Серверные API и Kafka contracts от выбора языка не зависят.
