# Конфигурационные файлы

Все настройки задаются через `appsettings.json`, `appsettings.Development.json` и переменные окружения ASP.NET Core с разделителем `__`.

Production/base конфиги не должны содержать реальные секреты. Development конфиги могут содержать локальные dev-значения, если они не используются в продуктивном контуре.

## Общие правила

| Случай | Что менять |
| --- | --- |
| Меняется адрес Kafka | `Kafka:BootstrapServers` или `Kafka:Input/Output:BootstrapServers`, также `ElkLogging:Kafka:BootstrapServers` |
| Включается Kafka SASL | `SecurityProtocol`, `SaslMechanism`, `Username`, `Password` в соответствующей Kafka-секции |
| Меняется имя topic | `Kafka:Topic`, `Kafka:Input:Topic`, `Kafka:Output:Topic`, `ElkLogging:Kafka:Topic` |
| Переход с dev на prod topics | убрать суффикс `.dev`, использовать base config или env override |
| Меняется endpoint Zabbix | `Zabbix:ApiEndpoint` |
| Меняется авторизация Zabbix | `Zabbix:AuthMode`, `Zabbix:ApiToken` или `Zabbix:User`/`Zabbix:Password` |
| Меняется задержка обработки объектов | `Processing:DelayBetweenObjectsMs` |
| Меняется rules-файл | `ConversionRules:RepositoryPath`, `ConversionRules:RulesFilePath` |
| Подключается ELK | `ElkLogging:Mode`, `ElkLogging:Elk:*`, при необходимости отключить Kafka log sink |

## cmdbwebhooks2kafka

Файлы:
- `src/cmdbwebhooks2kafka/appsettings.json`;
- `src/cmdbwebhooks2kafka/appsettings.Development.json`.

Основные секции:

| Параметр | Назначение | Когда менять |
| --- | --- | --- |
| `Service:Name` | Имя сервиса в health/logs | При смене окружения или имени deployment |
| `Service:HealthRoute` | Health endpoint | Если меняется route healthcheck |
| `CmdbWebhook:Route` | Endpoint приема webhook | Если CMDBuild должен вызывать другой путь |
| `CmdbWebhook:EventTypeFields` | Поля поиска event type | Если CMDBuild меняет body webhook |
| `CmdbWebhook:EntityTypeFields` | Поля поиска класса/типа объекта | Если меняется payload |
| `CmdbWebhook:EntityIdFields` | Приоритет выбора id | Если меняется источник идентификатора |
| `Kafka:Topic` | Output topic нормализованных событий | При смене Kafka namespace/окружения |
| `Kafka:SecurityProtocol` | Plaintext/SASL/TLS режим | При включении авторизации Kafka |
| `ElkLogging:*` | Настройки логирования | При подключении ELK или смене log topic |

Пример env override:

```bash
Kafka__BootstrapServers=kafka:29092
Kafka__Topic=cmdbuild.webhooks
ElkLogging__Kafka__Topic=cmdbwebhooks2kafka.logs
```

## cmdbkafka2zabbix

Файлы:
- `src/cmdbkafka2zabbix/appsettings.json`;
- `src/cmdbkafka2zabbix/appsettings.Development.json`.

Основные секции:

| Параметр | Назначение | Когда менять |
| --- | --- | --- |
| `Kafka:Input:Topic` | Входной topic CMDB events | Должен совпадать с output первого сервиса |
| `Kafka:Input:GroupId` | Consumer group | Менять при отдельном независимом потребителе |
| `Kafka:Output:Topic` | Output topic Zabbix JSON-RPC | Должен совпадать с input третьего сервиса |
| `ConversionRules:RepositoryPath` | Git working copy rules | Если rules вынесены в отдельный repo |
| `ConversionRules:RulesFilePath` | Путь к JSON rules | Если меняется файл правил |
| `ConversionRules:PullOnStartup` | Выполнять `git pull` при старте | Для внешнего repo правил |
| `ProcessingState:FilePath` | State-файл offset/объекта | Для отдельного окружения или volume |
| `ElkLogging:*` | Настройки логирования | При подключении ELK |

Rules-файл `rules/cmdbuild-to-zabbix-host-create.json` управляет:
- event routing create/update/delete;
- regex validation;
- выбором groups/templates/interfaces/tags;
- T4 templates для Zabbix JSON-RPC;
- fallback metadata для update/delete без `zabbix_hostid`.

## zabbixrequests2api

Файлы:
- `src/zabbixrequests2api/appsettings.json`;
- `src/zabbixrequests2api/appsettings.Development.json`.

Основные секции:

| Параметр | Назначение | Когда менять |
| --- | --- | --- |
| `Kafka:Input:Topic` | Входной topic JSON-RPC requests | Должен совпадать с output второго сервиса |
| `Kafka:Output:Topic` | Response topic | При смене схемы топиков |
| `Zabbix:ApiEndpoint` | Zabbix JSON-RPC URL | Для каждого окружения |
| `Zabbix:AuthMode` | `None`, `Token`, `Login`, `LoginOrToken` | По способу авторизации Zabbix |
| `Zabbix:ApiToken` | API token | Для token auth, задавать через secret/env |
| `Zabbix:User`/`Password` | Login credentials | Только dev или secret/env |
| `Zabbix:ValidateHostGroups` | Проверка host groups до вызова API | Отключать только для диагностики |
| `Zabbix:ValidateTemplates` | Проверка templates до вызова API | Отключать только для диагностики |
| `Zabbix:ValidateTemplateGroups` | Проверка template groups | Отключать только если Zabbix API ограничен |
| `Processing:DelayBetweenObjectsMs` | Gentle delay между объектами | Увеличивать при нагрузке на Zabbix |
| `Processing:MaxRetryAttempts` | Retry попытки | При нестабильном Zabbix/API |
| `ProcessingState:FilePath` | State-файл | Для отдельного окружения или volume |

Пример prod overrides:

```bash
Zabbix__ApiEndpoint=https://zabbix.example/api_jsonrpc.php
Zabbix__AuthMode=Token
Zabbix__ApiToken=<secret>
Kafka__Input__BootstrapServers=kafka01:9093,kafka02:9093
Kafka__Input__SecurityProtocol=SaslSsl
Kafka__Input__SaslMechanism=ScramSha512
Kafka__Input__Username=<secret>
Kafka__Input__Password=<secret>
```

## monitoring-ui-api

Файлы:
- `src/monitoring-ui-api/config/appsettings.json`;
- `src/monitoring-ui-api/config/appsettings.Development.json`.

Компонент написан на Node.js и совмещает backend-for-frontend API со статическим frontend.
Браузер не должен обращаться напрямую к Kafka, CMDBuild или Zabbix.

Основные секции:

| Параметр | Назначение | Когда менять |
| --- | --- | --- |
| `Service:Host` | IP/interface для bind Node.js сервера | При запуске в контейнере/на сервере |
| `Service:Port` | HTTP port UI/API | При конфликте портов |
| `Service:PublicDir` | Папка статического frontend | При смене сборки UI |
| `Auth:UseIdp` | Включение IdP режима | После настройки SAML2 |
| `Auth:SessionCookieName` | Имя session cookie | При конфликте cookie |
| `Auth:SessionTimeoutMinutes` | Время жизни server-side session | По требованиям ИБ |
| `Auth:MaxSamlPostBytes` | Максимальный размер ACS POST | При больших SAML assertions |
| `Idp:MetadataUrl` | URL IdP metadata XML | Если IdP публикует metadata |
| `Idp:EntityId` | IdP issuer/entityID | Для проверки issuer |
| `Idp:SsoUrl` | IdP SSO endpoint | Если metadata не используется |
| `Idp:SloUrl` | IdP SLO endpoint | При включении logout через IdP |
| `Idp:IdpX509Certificate` / `Idp:IdpX509CertificatePath` | IdP signing certificate | Обязательно для валидации SAMLResponse |
| `Idp:SpEntityId` | SP issuer/entityID | При регистрации SP в IdP |
| `Idp:AcsUrl` | ACS endpoint `/auth/saml2/acs` | При смене внешнего URL UI |
| `Idp:SloCallbackUrl` | SP logout callback | При смене внешнего URL UI |
| `Idp:SpCertificate` / `Idp:SpPrivateKey` | SP cert/key | Если нужно подписывать requests или расшифровывать assertions |
| `Idp:RoleMapping` | Маппинг SAML groups в роли UI | При смене групп IdP |
| `Cmdbuild:BaseUrl` | CMDBuild REST base URL | Для каждого окружения |
| `Cmdbuild:ServiceAccount:*` | Учетная запись BFF для CMDBuild API в IdP режиме | Через secret/env в prod |
| `Cmdbuild:Catalog:*` | Cache и validation настроек CMDBuild catalog | При смене cache policy |
| `Zabbix:ApiEndpoint` | Zabbix JSON-RPC URL | Для каждого окружения |
| `Zabbix:ServiceAccount:*` | Учетная запись/API token BFF для Zabbix API в IdP режиме | Через secret/env в prod |
| `Zabbix:Catalog:*` | Cache и validation настроек Zabbix catalog | При смене cache policy |
| `Rules:RulesFilePath` | Путь к JSON rules-файлу | Если rules вынесены |
| `Rules:AllowUpload` | Разрешить upload rules через UI | Для admin UI |
| `Rules:AllowSave` | Разрешить запись rules-файла | Для read-only окружений отключать |
| `Rules:AutoCommit` | Делать git commit из UI | По умолчанию false |
| `Services:HealthEndpoints` | Health endpoints микросервисов | При добавлении сервисов |

Runtime cache:
- `src/monitoring-ui-api/data/zabbix-catalog-cache.json`;
- `src/monitoring-ui-api/data/cmdbuild-catalog-cache.json`.

Runtime state:
- `src/monitoring-ui-api/state/ui-settings.json`.

Эти файлы не должны попадать в git.

Пример запуска:

```bash
cd src/monitoring-ui-api
npm start
```

Пример env override:

```bash
PORT=5090
CMDBUILD_BASE_URL=http://cmdbuild:8080/cmdbuild/services/rest/v3
ZABBIX_API_ENDPOINT=http://zabbix/api_jsonrpc.php
RULES_FILE_PATH=rules/cmdbuild-to-zabbix-host-create.json
MONITORING_UI_USE_IDP=true
SAML2_METADATA_URL=https://idp.example/metadata
SAML2_IDP_CERT_PATH=/run/secrets/idp-signing.crt
CMDBUILD_SERVICE_USERNAME=<secret>
CMDBUILD_SERVICE_PASSWORD=<secret>
ZABBIX_SERVICE_API_TOKEN=<secret>
```

## Проверка конфигов

Запуск:

```bash
./scripts/test-configs.sh
```

Скрипт проверяет:
- JSON syntax всех appsettings и rules;
- обязательные секции и параметры;
- связность Kafka topics между микросервисами;
- dev topics с суффиксом `.dev`;
- отсутствие production-секретов в base config;
- наличие обязательных архитектурных артефактов в `aa/`.
