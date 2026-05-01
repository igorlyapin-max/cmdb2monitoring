# Конфигурационные файлы

Все настройки задаются через `appsettings.json`, `appsettings.Development.json` и переменные окружения.

.NET-сервисы используют стандартный синтаксис ASP.NET Core env overrides с разделителем `__`.
`monitoring-ui-api` использует `config/appsettings*.json` и явно поддержанные env overrides, перечисленные в этом документе и в `PROJECT_DOCUMENTATION.md`.

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
| CMDBuild работает в Docker и вызывает локальный webhook | `src/cmdbwebhooks2kafka/Properties/launchSettings.json`, `ASPNETCORE_URLS=http://0.0.0.0:5080` |

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

Dev запуск:
- `launchSettings.json` должен использовать `http://0.0.0.0:5080`;
- CMDBuild-контейнер вызывает webhook по `http://192.168.202.100:5080/webhooks/cmdbuild`;
- `http://localhost:5080` доступен только с dev host и не подходит как URL внутри CMDBuild-контейнера.

Пример env override:

```bash
ASPNETCORE_URLS=http://0.0.0.0:5080
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
| `Kafka:Output:ProfileHeaderName` | Kafka header с именем host profile | Менять только если downstream consumer ожидает другой header |
| `ConversionRules:RepositoryPath` | Git working copy rules | Если rules вынесены в отдельный repo |
| `ConversionRules:RulesFilePath` | Путь к JSON rules | Если меняется файл правил |
| `ConversionRules:PullOnStartup` | Выполнять `git pull` при старте | Для внешнего repo правил |
| `Cmdbuild:BaseUrl` | CMDBuild REST v3 base URL для lookup/reference resolver | Для каждого окружения, через secret/env в prod |
| `Cmdbuild:Username` / `Cmdbuild:Password` | Учетная запись resolver для чтения attributes/cards/lookups | Через secret/env в prod |
| `Cmdbuild:Enabled` | Включает lookup/reference resolver | Отключать только если rules не используют `cmdbPath` или resolver временно недоступен |
| `Cmdbuild:RequestTimeoutMs` | Timeout REST-запросов resolver | При медленном CMDBuild API |
| `Cmdbuild:MaxPathDepth` | Максимальная глубина reference traversal | Если в модели нужны более глубокие пути |
| `ProcessingState:FilePath` | State-файл offset/объекта | Для отдельного окружения или volume |
| `ElkLogging:*` | Настройки логирования | При подключении ELK |

Rules-файл `rules/cmdbuild-to-zabbix-host-create.json` управляет:
- event routing create/update/delete;
- regex validation;
- lookup/reference path conversion через `source.fields[].cmdbPath` и `resolve`;
- hostProfiles fan-out: один CMDB object -> один Zabbix host с несколькими interfaces[] или несколько Zabbix hosts;
- `hostProfiles[].createOnUpdateWhenMissing`: для update fallback разрешает создать отсутствующий дополнительный Zabbix host по `fallbackCreateParams`, если `host.get` не нашел host;
- количество IP задается rules: текущий плоский webhook/rules контракт поддерживает named fields, а не произвольный массив IP; для дополнительных IP добавляются новые `source.fields` и `hostProfiles[].interfaces` или отдельные `hostProfiles[]`;
- выбором groups/templates/interfaces/tags;
- расширенными Zabbix host параметрами: proxy, proxy group, interface profile, host status, TLS/PSK, host macros, inventory fields, maintenances, value maps;
- T4 templates для Zabbix JSON-RPC;
- fallback metadata для update/delete без `zabbix_hostid`, включая `hostProfile`.

При наличии `inventory` в rules/T4 payload необходимо использовать `inventory_mode=0` или другой разрешенный режим inventory. `inventory_mode=-1` отключает inventory, и Zabbix отклоняет такие запросы.

State-файл хранит последний успешно обработанный input offset. При старте consumer назначает позицию чтения `lastInputOffset + 1` для сохраненного topic/partition.

Пример prod overrides для lookup/reference resolver:

```bash
Cmdbuild__Enabled=true
Cmdbuild__BaseUrl=https://cmdbuild.example/cmdbuild/services/rest/v3
Cmdbuild__Username=<secret>
Cmdbuild__Password=<secret>
Cmdbuild__MaxPathDepth=5
```

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

State-файл `zabbixrequests2api` также используется для восстановления позиции Kafka consumer после рестарта: чтение начинается с `lastInputOffset + 1`.

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
| `UiSettings:FilePath` | Runtime settings JSON, куда UI сохраняет настройки | При смене расположения state-файла |
| `Auth:UseIdp` | Включение IdP режима | После настройки SAML2 |
| `Auth:SessionCookieName` | Имя session cookie | При конфликте cookie |
| `Auth:SessionTimeoutMinutes` | Время жизни server-side session | По требованиям ИБ |
| `Auth:MaxSamlPostBytes` | Максимальный размер ACS POST | При больших SAML assertions |
| `Auth:LocalLoginDefaults` | Prefill стартовой формы local login | Только для dev/временной диагностики, в prod держать disabled |
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
| `EventBrowser:*` | Read-only просмотр Kafka topics на вкладке Events | При смене Kafka, auth или списка topics |
| `Services:HealthEndpoints` | Health endpoints микросервисов | При добавлении сервисов |

Поддержанные env overrides `monitoring-ui-api`:

| Env | Конфиг |
| --- | --- |
| `PORT` | `Service:Port` |
| `MONITORING_UI_HOST` | `Service:Host` |
| `MONITORING_UI_SETTINGS_FILE` | `UiSettings:FilePath` |
| `MONITORING_UI_USE_IDP` | `Auth:UseIdp` |
| `SAML2_METADATA_URL` | `Idp:MetadataUrl` |
| `SAML2_ENTITY_ID` | `Idp:EntityId` |
| `SAML2_SSO_URL` | `Idp:SsoUrl` |
| `SAML2_SLO_URL` | `Idp:SloUrl` |
| `SAML2_IDP_CERT` | `Idp:IdpX509Certificate` |
| `SAML2_IDP_CERT_PATH` | `Idp:IdpX509CertificatePath` |
| `SAML2_SP_ENTITY_ID` | `Idp:SpEntityId` |
| `SAML2_ACS_URL` | `Idp:AcsUrl` |
| `SAML2_SP_CERT_PATH` | `Idp:SpCertificatePath` |
| `SAML2_SP_PRIVATE_KEY_PATH` | `Idp:SpPrivateKeyPath` |
| `CMDBUILD_BASE_URL` | `Cmdbuild:BaseUrl` |
| `CMDBUILD_SERVICE_USERNAME` | `Cmdbuild:ServiceAccount:Username` |
| `CMDBUILD_SERVICE_PASSWORD` | `Cmdbuild:ServiceAccount:Password` |
| `ZABBIX_API_ENDPOINT` | `Zabbix:ApiEndpoint` |
| `ZABBIX_SERVICE_USER` | `Zabbix:ServiceAccount:User` |
| `ZABBIX_SERVICE_PASSWORD` | `Zabbix:ServiceAccount:Password` |
| `ZABBIX_SERVICE_API_TOKEN` | `Zabbix:ServiceAccount:ApiToken` |
| `RULES_FILE_PATH` | `Rules:RulesFilePath` |
| `MONITORING_UI_EVENTS_ENABLED` | `EventBrowser:Enabled` |
| `MONITORING_UI_KAFKA_BOOTSTRAP_SERVERS` | `EventBrowser:BootstrapServers` |
| `MONITORING_UI_KAFKA_SECURITY_PROTOCOL` | `EventBrowser:SecurityProtocol` |
| `MONITORING_UI_KAFKA_SASL_MECHANISM` | `EventBrowser:SaslMechanism` |
| `MONITORING_UI_KAFKA_USERNAME` | `EventBrowser:Username` |
| `MONITORING_UI_KAFKA_PASSWORD` | `EventBrowser:Password` |
| `MONITORING_UI_EVENTS_MAX_MESSAGES` | `EventBrowser:MaxMessages` |
| `MONITORING_UI_EVENTS_READ_TIMEOUT_MS` | `EventBrowser:ReadTimeoutMs` |
| `MONITORING_UI_EVENTS_TOPICS` | `EventBrowser:Topics`, список через запятую или точку с запятой |

SAML2 endpoints:
- SP metadata: `GET /auth/saml2/metadata`;
- SP initiated login: `GET /auth/saml2/login`;
- ACS: `POST /auth/saml2/acs`;
- logout: `GET /auth/saml2/logout`.

В IdP-режиме `Cmdbuild:ServiceAccount` и `Zabbix:ServiceAccount` используются BFF для server-side API calls. В режиме без IdP пользователь вводит credentials при входе, они хранятся только в памяти server-side session.

## Conversion rules conflict handling

В `rules/cmdbuild-to-zabbix-host-create.json` блок `templateConflictRules` применяется после `templateSelectionRules`. Он нужен для случаев, когда несколько правил выбрали шаблоны Zabbix с одинаковыми item keys или конфликтующими inventory field links. В текущем dev-окружении `ICMP Ping` и agent-шаблоны удаляются при выборе `HP iLO by SNMP` или `Generic by SNMP`, чтобы Zabbix API не отклонял host payload из-за дублирующего key `icmpping` или inventory field `Name`.

Для update fallback rules формируют `templates_clear`. `zabbixrequests2api` получает текущие linked templates через `selectParentTemplates` и передает в Zabbix только те `templateid` из `templates_clear`, которые действительно привязаны к host.

Практический пример: если существующий host уже связан с `Windows by Zabbix agent`, добавление `HP iLO by SNMP` для дополнительного SNMP interface может быть отклонено Zabbix из-за общего inventory field `Name`. В этом случае rules должны оставить целевой SNMP template и передать конфликтующий agent template в `templates_clear`.

Имена CMDBuild classes, attributes и source fields задаются rules, а не кодом. Текущие dev-имена `Server`, `interface/interface2`, `profile/profile2`, `iLo/iLo2/mgmt/mgmt2` являются примером конкретной модели. Для другой модели можно указать любые source keys в `source.fields[].source` и связать их с реальными CMDBuild attributes через `source.fields[].cmdbAttribute` или `source.fields[].cmdbPath`; далее эти fields используются в `hostProfiles[].interfaces[].valueField`, regex/rules и T4.
Для reference/lookup полей CMDBuild Body остается плоским: source key получает numeric id или scalar value, а полный путь хранится в rules как `source.fields[].cmdbPath`, например `Server.adr.Ip` или `Server.ipaddr_reference.another_reference_attribute.ipaddr`.
Смена hostProfile name меняет вычисляемый Zabbix host suffix; ранее созданные дополнительные hosts со старыми suffix не переименовываются автоматически.

Events:
- `EventBrowser:Enabled=true` включает чтение Kafka topics через BFF;
- `EventBrowser:BootstrapServers` в dev равен `localhost:9092`;
- `EventBrowser:SecurityProtocol=Plaintext` для текущей локальной Kafka без авторизации;
- `EventBrowser:Topics` должен содержать используемые сервисами topics, включая request/response/log topics;
- `EventBrowser:MaxMessages` задает количество последних сообщений к выводу, например `5` означает 5 последних;
- UI Settings сохраняет runtime overrides в `UiSettings:FilePath`, по умолчанию `src/monitoring-ui-api/state/ui-settings.json`.

Rules UI:
- `Управление правилами конвертации` показывает CMDBuild, rules и Zabbix в трех колонках;
- edit mode раскрывает reference attributes до scalar/lookup leaf-полей и сохраняет путь в `cmdbPath`;
- edit mode позволяет добавлять rules в draft JSON, удалять rules по группам, выполнять undo/redo и сохранять draft через `Save file as`;
- `Save file as` дополнительно формирует текстовый файл CMDBuild webhook Body/DELETE-инструкций только по добавленным и удаленным в текущей UI-сессии rules/classes/source fields;
- перед сохранением проверяется IP/DNS binding: каждый мониторинговый класс из `source.entityClasses` или `className` regex должен иметь IP или DNS class attribute field, связанный с `interfaceAddressRules` или `hostProfiles[].interfaces`;
- `Логический контроль правил конвертации` подсвечивает только отсутствующие элементы и позволяет удалить выбранные элементы после подтверждения;
- перед удалением rules-файл копируется в `rules/.backup/*.bak`;
- `rules/.backup/` является локальным backup и не коммитится.

Runtime cache:
- `src/monitoring-ui-api/data/zabbix-catalog-cache.json`;
- `src/monitoring-ui-api/data/cmdbuild-catalog-cache.json`.

Runtime state:
- `src/monitoring-ui-api/state/ui-settings.json`.
- `rules/.backup/*.bak`.

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
MONITORING_UI_KAFKA_BOOTSTRAP_SERVERS=kafka:29092
MONITORING_UI_EVENTS_TOPICS=cmdbuild.webhooks,zabbix.host.requests,zabbix.host.responses
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
