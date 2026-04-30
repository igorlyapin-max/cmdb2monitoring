# Схема развертывания

Окружение разработки в требованиях не обязательно, но текущие dev-настройки зафиксированы для повторяемости проверки.

## Dev-контур

| Узел | Артефакты | Сетевые адреса |
| --- | --- | --- |
| Workstation/Dev host | .NET микросервисы | `localhost:5080`, `localhost:5081`, `localhost:5082` |
| Workstation/Dev host | Node.js frontend/BFF `monitoring-ui-api` | `http://localhost:5090` |
| Docker host | Kafka | host `localhost:9092`, docker network `kafka:29092` |
| Docker host | CMDBuild | `http://localhost:8090/cmdbuild` |
| Docker host | Zabbix | UI `http://localhost:8081`, API `/api_jsonrpc.php` |
| External/Future | SAML2 IdP | `Idp:MetadataUrl`, `Idp:SsoUrl`, `Idp:SloUrl` |
| Future | ELK | Endpoint будет задан через `ElkLogging` |

## Test/Prod-контуры

Для тестового и продуктивного контуров требуется:
- отдельные Kafka topics без `.dev`;
- secrets через переменные окружения или secret storage;
- внешний процесс создания Kafka topics;
- отдельные service accounts для CMDBuild webhook, Kafka и Zabbix API;
- отдельные service accounts для `monitoring-ui-api` при IdP-режиме;
- публичный URL `monitoring-ui-api` должен совпадать с SAML2 `AcsUrl` и `SloCallbackUrl`;
- IdP должен знать SP metadata из `/auth/saml2/metadata`;
- выделенный ELK endpoint.

## Сетевая связность

| Откуда | Куда | Протокол |
| --- | --- | --- |
| CMDBuild | cmdbwebhooks2kafka | HTTP POST |
| Browser | monitoring-ui-api | HTTP |
| monitoring-ui-api | IdP SAML2 | HTTP Redirect/POST |
| monitoring-ui-api | CMDBuild REST API | HTTP |
| monitoring-ui-api | Zabbix API | HTTP JSON-RPC |
| monitoring-ui-api | .NET services health endpoints | HTTP |
| monitoring-ui-api | Kafka `localhost:9092` / `kafka:29092` | Kafka protocol, read-only Events |
| cmdbwebhooks2kafka | Kafka | Kafka protocol |
| cmdbkafka2zabbix | Kafka | Kafka protocol |
| cmdbkafka2zabbix | Git repository/working copy | local FS или git |
| zabbixrequests2api | Kafka | Kafka protocol |
| zabbixrequests2api | Zabbix API | HTTP JSON-RPC |
| Микросервисы | ELK или Kafka log topics | HTTP/Kafka |
