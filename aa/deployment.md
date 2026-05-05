# Схема развертывания

Окружение разработки в требованиях не обязательно, но текущие dev-настройки зафиксированы для повторяемости проверки.

## Dev-контур

| Узел | Артефакты | Сетевые адреса |
| --- | --- | --- |
| Workstation/Dev host | `cmdbwebhooks2kafka` | bind `0.0.0.0:5080`, local `http://localhost:5080`, Docker-visible `http://192.168.202.100:5080` |
| Workstation/Dev host | `cmdbkafka2zabbix` | `http://localhost:5081` |
| Workstation/Dev host | `zabbixrequests2api` | `http://localhost:5082` |
| Workstation/Dev host | `zabbixbindings2cmdbuild` | `http://localhost:5083` |
| Workstation/Dev host | Node.js frontend/BFF `monitoring-ui-api` | `http://localhost:5090` |
| Docker host | Kafka | host `localhost:9092`, docker network `kafka:29092` |
| Docker host | CMDBuild | `http://localhost:8090/cmdbuild` |
| Docker host | Zabbix | UI `http://localhost:8081`, API `/api_jsonrpc.php` |
| External/Future | IdP / MS AD | SAML2/OAuth2 over HTTPS `:443`, LDAP `:389` или LDAPS `:636` |
| Future | ELK | Endpoint будет задан через `ElkLogging` |

## Совместимость Dev-контура

| Компонент | Подтвержденная версия | Контракт |
| --- | --- | --- |
| CMDBuild | `4.1.0` | REST API v3, webhook JSON |
| Zabbix | `7.0.25` | JSON-RPC `/api_jsonrpc.php`, host/catalog methods |
| Kafka | `3.9.2` | Kafka protocol, KRaft/PLAINTEXT в dev |
| CMDBuild DB | PostgreSQL `17.9` + PostGIS `3.5.x` | Внутренняя БД CMDBuild; наши сервисы не подключаются напрямую |
| Zabbix DB | PostgreSQL `16.13` | Внутренняя БД Zabbix; наши сервисы не подключаются напрямую |
| .NET | SDK `10.0.203`, target `net10.0` | Сборка и запуск .NET-сервисов |
| Node.js | `>=22` | `monitoring-ui-api` |

Для test/prod допускается перенос на другие patch/minor версии только после проверки контрактов: CMDBuild REST/webhook, Zabbix JSON-RPC, Kafka protocol/security, catalog sync и smoke create/update/delete.

## Целевые контуры

### Тест ИТ

| Узел | Артефакты | Сетевые адреса |
| --- | --- | --- |
| Application host или Kubernetes namespace | `cmdbwebhooks2kafka` | HTTP `:5080`, внешний URL для CMDBuild `/webhooks/cmdbuild` |
| Application host или Kubernetes namespace | `cmdbkafka2zabbix` | HTTP health `:5081` |
| Application host или Kubernetes namespace | `zabbixrequests2api` | HTTP health `:5082` |
| Application host или Kubernetes namespace | `zabbixbindings2cmdbuild` | HTTP health `:5083` |
| Application host или Kubernetes namespace | `monitoring-ui-api` | HTTP/HTTPS `:5090` или ingress `:443` |
| Kafka cluster | Topics без `.dev` или с суффиксом контура | Kafka bootstrap `:9092` или TLS/SASL listener `:9093` |
| CMDBuild test | CMDBuild UI/API | HTTP/HTTPS `:8090` или ingress `:443` |
| Zabbix test | Zabbix UI/API | HTTP/HTTPS `:8081` или ingress `:443`, API `/api_jsonrpc.php` |
| IdP test | SAML2/OAuth2 IdP или MS AD LDAP/LDAPS | HTTPS `:443`, LDAP `:389`, LDAPS `:636` |
| ELK test | Log storage | HTTPS `:9200` или Kafka shipper по `:9092/:9093` |

### Бизнес Тест

| Узел | Артефакты | Сетевые адреса |
| --- | --- | --- |
| Application host или Kubernetes namespace | Микросервисы и `monitoring-ui-api` | Те же порты приложений `:5080/:5081/:5082/:5083/:5090`, внешний доступ через ingress `:443` |
| Kafka cluster | Business-test topics | Kafka `:9092` plaintext только при явном разрешении, иначе TLS/SASL `:9093` |
| CMDBuild business-test | Источник карточек | HTTP/HTTPS endpoint CMDBuild `:8090/:443` |
| Zabbix business-test | Целевая система мониторинга | HTTP/HTTPS API `:8081/:443` |
| IdP business-test | Единая авторизация / MS AD | HTTPS `:443`, LDAP `:389`, LDAPS `:636` |
| ELK business-test | Централизованные логи | HTTPS `:9200` |

### Продуктив

| Узел | Артефакты | Сетевые адреса |
| --- | --- | --- |
| Production application platform | Микросервисы и `monitoring-ui-api` | Внутренние health-порты `:5080/:5081/:5082/:5083`, внешний frontend ingress `:443` |
| Production Kafka | Production topics | Только защищенные listeners, обычно TLS/SASL `:9093`; конкретный порт задается конфигом Kafka |
| Production CMDBuild | Webhook source и catalog API | HTTPS `:443` |
| Production Zabbix | JSON-RPC API | HTTPS `:443` |
| Production IdP / MS AD | SAML2/OAuth2 или LDAP/LDAPS | HTTPS `:443`, LDAP `:389`, LDAPS `:636` |
| Production ELK | Log storage | HTTPS `:9200` или утвержденный порт лог-шиппера |

## Общие требования для Test/Prod

Для тестового и продуктивного контуров требуется:
- отдельные Kafka topics без `.dev`;
- secrets через переменные окружения или secret storage;
- внешний процесс создания Kafka topics;
- отдельные service accounts для CMDBuild webhook, Kafka и Zabbix API;
- отдельная CMDBuild service account для `cmdbkafka2zabbix` lookup/reference/domain resolver и чтения `zabbix_main_hostid`/`ZabbixHostBinding`, если rules используют `source.fields[].cmdbPath` или stage 2 direct hostid lookup;
- отдельная CMDBuild service account для `zabbixbindings2cmdbuild` с правом записи `zabbix_main_hostid` в участвующие карточки и create/update/read на `ZabbixHostBinding`;
- для `monitoring-ui-api` операторы вводят CMDBuild credentials на сессию; для catalog sync достаточно read-only metadata/card/relation прав, а для применения `Настройка webhooks` нужны read и create/update/delete или эквивалентные modify-права на CMDBuild ETL/webhook records `/etl/webhook/`;
- Bearer token для `cmdbkafka2zabbix` rules reload endpoint задается как secret/env и совпадает с `monitoring-ui-api` `Services:HealthEndpoints[].RulesReloadToken`;
- для `monitoring-ui-api` не задаются постоянные CMDBuild/Zabbix login/password; при необходимости оператор вводит их на сессию, либо задается read-only `ZABBIX_API_TOKEN`;
- публичный URL `monitoring-ui-api` должен совпадать с SAML2 `AcsUrl`/`SloCallbackUrl` и OAuth2 `RedirectUri`, если включены эти провайдеры;
- IdP должен знать SP metadata из `/auth/saml2/metadata` для SAML2 или OAuth2 client redirect URI для OAuth2/OIDC;
- при режиме `MS AD` и при IdP-роли через AD-группы должна быть сетевая связность от `monitoring-ui-api` к domain controllers по `:389` или `:636`; bind DN/password задаются через secret/env или меню `Авторизация`;
- выделенный ELK endpoint.

## Сетевая связность

| Откуда | Куда | Протокол |
| --- | --- | --- |
| CMDBuild `:8090` | cmdbwebhooks2kafka `:5080` | HTTP POST `/webhooks/cmdbuild` через `http://192.168.202.100:5080` в dev |
| Browser | monitoring-ui-api `:5090` | HTTP |
| monitoring-ui-api `:5090` | IdP/MS AD `:443/:80/:636/:389` | SAML2 Redirect/POST, OAuth2 Authorization Code, LDAP bind/search |
| monitoring-ui-api `:5090` | CMDBuild REST API `:8090` | HTTP |
| monitoring-ui-api `:5090` | Zabbix API `:8081` | HTTP JSON-RPC |
| monitoring-ui-api `:5090` | .NET services health endpoints `:5080/:5081/:5082/:5083` | HTTP |
| monitoring-ui-api `:5090` | cmdbkafka2zabbix `:5081` | HTTP POST `/admin/reload-rules` с Bearer token |
| monitoring-ui-api | Kafka `localhost:9092` / `kafka:29092` | Kafka protocol, read-only Events |
| cmdbwebhooks2kafka `:5080` | Kafka `:9092` | Kafka protocol |
| cmdbkafka2zabbix `:5081` | Kafka `:9092` | Kafka protocol |
| cmdbkafka2zabbix `:5081` | CMDBuild REST API `:8090` | HTTP для lookup/reference/domain resolver по `cmdbPath` |
| cmdbkafka2zabbix | Git repository/working copy | local FS или git |
| zabbixrequests2api `:5082` | Kafka `:9092` | Kafka protocol |
| zabbixrequests2api `:5082` | Zabbix API `:8081` | HTTP JSON-RPC |
| zabbixbindings2cmdbuild `:5083` | Kafka `:9092` | Kafka protocol |
| zabbixbindings2cmdbuild `:5083` | CMDBuild REST API `:8090` | HTTP для записи binding-ов |
| Микросервисы | ELK `:9200` или Kafka log topics `:9092/:9093` | HTTP/Kafka |
