# Документация проекта cmdb2monitoring

## Назначение

`cmdb2monitoring` - monorepo интеграции CMDBuild, Kafka и Zabbix.
Основной поток: CMDBuild webhook -> Kafka -> rules/T4 conversion -> Kafka -> Zabbix API -> Kafka response.

Дополнительный компонент `monitoring-ui-api` предоставляет frontend/BFF для оператора:
- health dashboard микросервисов;
- загрузка, валидация и dry-run rules JSON;
- синхронизация справочников Zabbix и CMDBuild;
- local login без IdP;
- SAML2 login через единый IdP.

## Состав репозитория

| Путь | Назначение |
| --- | --- |
| `src/cmdbwebhooks2kafka` | Прием CMDBuild webhook и публикация normalized event в Kafka |
| `src/cmdbkafka2zabbix` | Чтение CMDB events, применение JSON/T4 rules, публикация Zabbix JSON-RPC requests |
| `src/zabbixrequests2api` | Чтение Zabbix requests, вызов Zabbix API, публикация responses |
| `src/monitoring-ui-api` | Node.js frontend/BFF |
| `rules/cmdbuild-to-zabbix-host-create.json` | Правила конвертации CMDBuild Computer-derived events в Zabbix JSON-RPC |
| `aa/` | Архитектурные артефакты, диаграммы, OpenAPI/AsyncAPI, карты |
| `tests/configvalidation` | Проверки конфигураций и обязательных артефактов |
| `scripts/test-configs.sh` | Быстрый общий валидатор конфигов |

## Dev endpoints

| Компонент | URL |
| --- | --- |
| `cmdbwebhooks2kafka` | `http://localhost:5080` |
| `cmdbkafka2zabbix` | `http://localhost:5081` |
| `zabbixrequests2api` | `http://localhost:5082` |
| `monitoring-ui-api` | `http://localhost:5090` |
| CMDBuild | `http://localhost:8090/cmdbuild` |
| Zabbix UI/API | `http://localhost:8081`, `http://localhost:8081/api_jsonrpc.php` |
| Kafka host access | `localhost:9092` |
| Kafka docker network access | `kafka:29092` |

## Kafka topics

| Dev topic | Base/prod topic | Producer | Consumer |
| --- | --- | --- | --- |
| `cmdbuild.webhooks.dev` | `cmdbuild.webhooks` | `cmdbwebhooks2kafka` | `cmdbkafka2zabbix` |
| `zabbix.host.requests.dev` | `zabbix.host.requests` | `cmdbkafka2zabbix` | `zabbixrequests2api` |
| `zabbix.host.responses.dev` | `zabbix.host.responses` | `zabbixrequests2api` | будущий status/UI consumer |
| `cmdbwebhooks2kafka.logs.dev` | `cmdbwebhooks2kafka.logs` | `cmdbwebhooks2kafka` | будущий ELK shipper |
| `cmdbkafka2zabbix.logs.dev` | `cmdbkafka2zabbix.logs` | `cmdbkafka2zabbix` | будущий ELK shipper |
| `zabbixrequests2api.logs.dev` | `zabbixrequests2api.logs` | `zabbixrequests2api` | будущий ELK shipper |

Topics создаются внешней инфраструктурой. Код сервисов не создает topics при старте.

## Конфигурация: общие правила

Base config не должен содержать production secrets.
Dev config может содержать локальные значения для стенда.
Production secrets задаются через env, secret storage или local config, исключенный из git.

.NET-сервисы используют env override с `__`, например:

```bash
Kafka__Input__BootstrapServers=kafka01:9093,kafka02:9093
Zabbix__AuthMode=Token
Zabbix__ApiToken=<secret>
```

Node.js `monitoring-ui-api` использует `config/appsettings*.json` и поддержанные env vars, перечисленные ниже.

## cmdbwebhooks2kafka

Файлы:
- `src/cmdbwebhooks2kafka/appsettings.json`;
- `src/cmdbwebhooks2kafka/appsettings.Development.json`.

Что вносить:

| Секция | Что задавать |
| --- | --- |
| `Service` | Имя сервиса и health route |
| `CmdbWebhook:Route` | URL приема webhook, сейчас `/webhooks/cmdbuild` |
| `CmdbWebhook:*Fields` | Поля, по которым сервис ищет event type, class и id в webhook body |
| `Kafka` | Bootstrap servers, output topic, client id, auth/security |
| `ElkLogging` | Kafka log sink или будущий ELK endpoint |

Для локального Docker Kafka внутри сети использовать:

```bash
Kafka__BootstrapServers=kafka:29092
```

## cmdbkafka2zabbix

Файлы:
- `src/cmdbkafka2zabbix/appsettings.json`;
- `src/cmdbkafka2zabbix/appsettings.Development.json`.

Что вносить:

| Секция | Что задавать |
| --- | --- |
| `Kafka:Input` | Topic `cmdbuild.webhooks.*`, group id, consumer auth/security |
| `Kafka:Output` | Topic `zabbix.host.requests.*`, producer auth/security |
| `ConversionRules` | Repository path, rules file path, git pull behavior, template engine |
| `ProcessingState` | State-файл последнего обработанного объекта |
| `ElkLogging` | Kafka log topic или будущий ELK |

Rules-файл отвечает за:
- `create/update/delete` routing;
- regex validation;
- выбор host groups/templates/interfaces/tags;
- T4 templates для JSON-RPC;
- fallback `host.get -> host.update/delete` без `zabbix_hostid`.

## zabbixrequests2api

Файлы:
- `src/zabbixrequests2api/appsettings.json`;
- `src/zabbixrequests2api/appsettings.Development.json`.

Что вносить:

| Секция | Что задавать |
| --- | --- |
| `Kafka:Input` | Topic `zabbix.host.requests.*`, group id, consumer auth/security |
| `Kafka:Output` | Topic `zabbix.host.responses.*`, producer auth/security |
| `Zabbix:ApiEndpoint` | URL Zabbix JSON-RPC API |
| `Zabbix:AuthMode` | `Token`, `Login`, `LoginOrToken` или `None` |
| `Zabbix:ApiToken` | Token для production, через secret/env |
| `Zabbix:User` / `Zabbix:Password` | Login credentials, только dev или secret/env |
| `Zabbix:Validate*` | Проверки host groups/templates/template groups до API call |
| `Processing` | Gentle delay, retries и retry delay |
| `ProcessingState` | State-файл последнего обработанного объекта |

`Processing:DelayBetweenObjectsMs` по умолчанию 2000, чтобы не отправлять объекты в Zabbix слишком резко.

## monitoring-ui-api

Файлы:
- `src/monitoring-ui-api/config/appsettings.json`;
- `src/monitoring-ui-api/config/appsettings.Development.json`;
- `src/monitoring-ui-api/package.json`;
- `src/monitoring-ui-api/package-lock.json`.

Что вносить:

| Секция | Что задавать |
| --- | --- |
| `Service` | Host, port, health route, public frontend dir |
| `Auth` | IdP mode, session cookie, session timeout, SAML POST limit |
| `Auth:LocalLoginDefaults` | Prefill local login form; только dev/временный режим, в prod должен быть выключен |
| `Idp` | SAML2 SP/IdP настройки |
| `Cmdbuild` | CMDBuild REST base URL, service account для IdP режима, catalog cache |
| `Zabbix` | Zabbix API endpoint, service account/API token для IdP режима, catalog cache |
| `Rules` | Rules path, upload/save policy, optional git auto-commit |
| `Services:HealthEndpoints` | Health endpoints микросервисов для dashboard |

SAML2 endpoints:
- `GET /auth/saml2/metadata` - SP metadata для регистрации в IdP;
- `GET /auth/saml2/login` - SP-initiated login;
- `POST /auth/saml2/acs` - ACS endpoint для SAMLResponse;
- `GET /auth/saml2/logout` - local logout и optional SLO.

IdP режим:
- включить `Auth:UseIdp=true` или `Idp:Enabled=true`;
- задать `Idp:MetadataUrl` или вручную `Idp:EntityId`, `Idp:SsoUrl`, `Idp:SloUrl`;
- обязательно задать `Idp:IdpX509Certificate` или `Idp:IdpX509CertificatePath`;
- внешние URL `Idp:AcsUrl` и `Idp:SloCallbackUrl` должны совпадать с URL, зарегистрированными в IdP;
- задать `Idp:RoleMapping`, чтобы SAML groups превращались в `admin`, `operator`, `readonly`;
- задать `Cmdbuild:ServiceAccount` и `Zabbix:ServiceAccount`, потому что browser credentials в IdP режиме не вводятся.

Local login defaults:
- base config держит `Auth:LocalLoginDefaults:Enabled=false`;
- `appsettings.Development.json` временно заполняет форму текущими dev-значениями;
- при переносе в prod или после перехода на IdP выключить `Enabled` и очистить значения.

Поддержанные env vars:

```bash
PORT=5090
MONITORING_UI_HOST=0.0.0.0
MONITORING_UI_USE_IDP=true
SAML2_METADATA_URL=https://idp.example/metadata
SAML2_ENTITY_ID=https://idp.example/entity
SAML2_SSO_URL=https://idp.example/sso
SAML2_SLO_URL=https://idp.example/slo
SAML2_IDP_CERT_PATH=/run/secrets/idp-signing.crt
SAML2_SP_ENTITY_ID=cmdb2monitoring-monitoring-ui
SAML2_ACS_URL=https://cmdb2monitoring.example/auth/saml2/acs
SAML2_SP_CERT_PATH=/run/secrets/sp.crt
SAML2_SP_PRIVATE_KEY_PATH=/run/secrets/sp.key
CMDBUILD_BASE_URL=https://cmdbuild.example/cmdbuild/services/rest/v3
CMDBUILD_SERVICE_USERNAME=<secret>
CMDBUILD_SERVICE_PASSWORD=<secret>
ZABBIX_API_ENDPOINT=https://zabbix.example/api_jsonrpc.php
ZABBIX_SERVICE_API_TOKEN=<secret>
RULES_FILE_PATH=rules/cmdbuild-to-zabbix-host-create.json
```

Runtime cache/state:
- `src/monitoring-ui-api/data/*.json` - catalog cache, не коммитить;
- `src/monitoring-ui-api/state/ui-settings.json` - persisted UI settings, не коммитить.

## ELK logging

Пока ELK нет, каждый .NET-сервис пишет structured JSON logs в Kafka log topic.
Когда ELK появится:
- задать `ElkLogging:Mode=Elk` или включить `ElkLogging:Elk:Enabled`;
- заполнить `ElkLogging:Elk:Endpoint`, `Index`, `ApiKey`;
- при необходимости отключить Kafka log sink.

## Проверки перед commit/push

```bash
./scripts/test-configs.sh
./scripts/dotnet build cmdb2monitoring.slnx --no-restore -m:1 -v minimal
node src/monitoring-ui-api/scripts/validate-config.mjs
git diff --check
```

Smoke-проверки цепочки:
- `create`: CMDBuild -> Kafka -> Zabbix `host.create` -> response topic -> host есть в Zabbix;
- `update`: CMDBuild -> Kafka -> fallback `host.get -> host.update` -> response topic -> поля изменились в Zabbix;
- `delete`: CMDBuild -> Kafka -> fallback `host.get -> host.delete` -> response topic -> host удален из Zabbix.

## Git и артефакты

В один коммит должны попадать связанные изменения:
- код;
- конфиги;
- `TZ_cmdb2monitoring.txt`;
- `aa/`;
- проверки/тесты;
- документация.

Не коммитить:
- `bin/`, `obj/`;
- `state/`;
- `.dotnet/`, `.nuget/`;
- `.env*`;
- runtime caches и production secrets.
