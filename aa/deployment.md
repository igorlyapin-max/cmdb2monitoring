# Схема развертывания

Окружение разработки в требованиях не обязательно, но текущие dev-настройки зафиксированы для повторяемости проверки.

## Dev-контур

| Узел | Артефакты | Сетевые адреса |
| --- | --- | --- |
| Workstation/Dev host | `cmdbwebhooks2kafka` | bind `0.0.0.0:5080`, local `http://localhost:5080`, Docker-visible `http://192.168.202.100:5080` |
| Workstation/Dev host | `cmdbkafka2zabbix` | `http://localhost:5081` |
| Workstation/Dev host | `zabbixrequests2api` | `http://localhost:5082` |
| Workstation/Dev host | Node.js frontend/BFF `monitoring-ui-api` | `http://localhost:5090` |
| Docker host | Kafka | host `localhost:9092`, docker network `kafka:29092` |
| Docker host | CMDBuild | `http://localhost:8090/cmdbuild` |
| Docker host | Zabbix | UI `http://localhost:8081`, API `/api_jsonrpc.php` |
| External/Future | SAML2 IdP | `Idp:MetadataUrl`, `Idp:SsoUrl`, `Idp:SloUrl` |
| Future | ELK | Endpoint будет задан через `ElkLogging` |

## Целевые контуры

### Тест ИТ

| Узел | Артефакты | Сетевые адреса |
| --- | --- | --- |
| Application host или Kubernetes namespace | `cmdbwebhooks2kafka` | HTTP `:5080`, внешний URL для CMDBuild `/webhooks/cmdbuild` |
| Application host или Kubernetes namespace | `cmdbkafka2zabbix` | HTTP health `:5081` |
| Application host или Kubernetes namespace | `zabbixrequests2api` | HTTP health `:5082` |
| Application host или Kubernetes namespace | `monitoring-ui-api` | HTTP/HTTPS `:5090` или ingress `:443` |
| Kafka cluster | Topics без `.dev` или с суффиксом контура | Kafka bootstrap `:9092` или TLS/SASL listener `:9093` |
| CMDBuild test | CMDBuild UI/API | HTTP/HTTPS `:8090` или ingress `:443` |
| Zabbix test | Zabbix UI/API | HTTP/HTTPS `:8081` или ingress `:443`, API `/api_jsonrpc.php` |
| IdP test | SAML2 IdP | HTTPS `:443` |
| ELK test | Log storage | HTTPS `:9200` или Kafka shipper по `:9092/:9093` |

### Бизнес Тест

| Узел | Артефакты | Сетевые адреса |
| --- | --- | --- |
| Application host или Kubernetes namespace | Микросервисы и `monitoring-ui-api` | Те же порты приложений `:5080/:5081/:5082/:5090`, внешний доступ через ingress `:443` |
| Kafka cluster | Business-test topics | Kafka `:9092` plaintext только при явном разрешении, иначе TLS/SASL `:9093` |
| CMDBuild business-test | Источник карточек | HTTP/HTTPS endpoint CMDBuild `:8090/:443` |
| Zabbix business-test | Целевая система мониторинга | HTTP/HTTPS API `:8081/:443` |
| IdP business-test | Единая авторизация | HTTPS `:443` |
| ELK business-test | Централизованные логи | HTTPS `:9200` |

### Продуктив

| Узел | Артефакты | Сетевые адреса |
| --- | --- | --- |
| Production application platform | Микросервисы и `monitoring-ui-api` | Внутренние health-порты `:5080/:5081/:5082`, внешний frontend ingress `:443` |
| Production Kafka | Production topics | Только защищенные listeners, обычно TLS/SASL `:9093`; конкретный порт задается конфигом Kafka |
| Production CMDBuild | Webhook source и catalog API | HTTPS `:443` |
| Production Zabbix | JSON-RPC API | HTTPS `:443` |
| Production IdP | SAML2 | HTTPS `:443` |
| Production ELK | Log storage | HTTPS `:9200` или утвержденный порт лог-шиппера |

## Общие требования для Test/Prod

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
| CMDBuild `:8090` | cmdbwebhooks2kafka `:5080` | HTTP POST `/webhooks/cmdbuild` через `http://192.168.202.100:5080` в dev |
| Browser | monitoring-ui-api `:5090` | HTTP |
| monitoring-ui-api `:5090` | IdP SAML2 `:443/:80` | HTTP Redirect/POST |
| monitoring-ui-api `:5090` | CMDBuild REST API `:8090` | HTTP |
| monitoring-ui-api `:5090` | Zabbix API `:8081` | HTTP JSON-RPC |
| monitoring-ui-api `:5090` | .NET services health endpoints `:5080/:5081/:5082` | HTTP |
| monitoring-ui-api | Kafka `localhost:9092` / `kafka:29092` | Kafka protocol, read-only Events |
| cmdbwebhooks2kafka `:5080` | Kafka `:9092` | Kafka protocol |
| cmdbkafka2zabbix `:5081` | Kafka `:9092` | Kafka protocol |
| cmdbkafka2zabbix | Git repository/working copy | local FS или git |
| zabbixrequests2api `:5082` | Kafka `:9092` | Kafka protocol |
| zabbixrequests2api `:5082` | Zabbix API `:8081` | HTTP JSON-RPC |
| Микросервисы | ELK `:9200` или Kafka log topics `:9092/:9093` | HTTP/Kafka |
