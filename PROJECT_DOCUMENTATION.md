# Документация проекта cmdb2monitoring

Версия документации: `0.3.0`.
Дата актуализации: 2026-05-01.

## Назначение

`cmdb2monitoring` - monorepo интеграции CMDBuild, Kafka и Zabbix.
Основной поток: CMDBuild webhook -> Kafka -> rules/T4 conversion -> Kafka -> Zabbix API -> Kafka response.

Дополнительный компонент `monitoring-ui-api` предоставляет frontend/BFF для оператора:
- health dashboard микросервисов;
- загрузка, валидация и dry-run rules JSON;
- визуальный Mapping и Validate rules mapping с подсветкой связей CMDBuild -> rules -> Zabbix;
- режим редактирования Mapping: добавление и удаление rules в draft JSON, undo/redo, save-as без записи на backend;
- безопасное удаление отсутствующих элементов из rules с локальным backup в `rules/.backup/`;
- просмотр последних сообщений Kafka topics на вкладке Events;
- синхронизация справочников Zabbix и CMDBuild;
- runtime Settings для endpoint/topic/auth параметров;
- local login без IdP;
- SAML2 login через единый IdP.

## Состав репозитория

| Путь | Назначение |
| --- | --- |
| `src/cmdbwebhooks2kafka` | Прием CMDBuild webhook и публикация normalized event в Kafka |
| `src/cmdbkafka2zabbix` | Чтение CMDB events, применение JSON/T4 rules и `hostProfiles[]`, публикация одного или нескольких Zabbix JSON-RPC requests |
| `src/zabbixrequests2api` | Чтение Zabbix requests, вызов Zabbix API, публикация responses |
| `src/monitoring-ui-api` | Node.js frontend/BFF |
| `rules/cmdbuild-to-zabbix-host-create.json` | Правила конвертации CMDBuild Computer-derived events в Zabbix JSON-RPC |
| `aa/` | Архитектурные артефакты, диаграммы, OpenAPI/AsyncAPI, карты |
| `tests/configvalidation` | Проверки конфигураций и обязательных артефактов |
| `scripts/test-configs.sh` | Быстрый общий валидатор конфигов |

## Dev endpoints

| Компонент | URL |
| --- | --- |
| `cmdbwebhooks2kafka` | `http://localhost:5080`, bind `http://0.0.0.0:5080` |
| `cmdbkafka2zabbix` | `http://localhost:5081` |
| `zabbixrequests2api` | `http://localhost:5082` |
| `monitoring-ui-api` | `http://localhost:5090` |
| CMDBuild | `http://localhost:8090/cmdbuild` |
| Zabbix UI/API | `http://localhost:8081`, `http://localhost:8081/api_jsonrpc.php` |
| Kafka host access | `localhost:9092` |
| Kafka docker network access | `kafka:29092` |

CMDBuild работает в Docker, поэтому webhook URL в CMDBuild должен указывать на адрес host-сервиса, доступный из Docker-сети:

```text
http://192.168.202.100:5080/webhooks/cmdbuild
```

Для локального запуска `cmdbwebhooks2kafka` слушает `0.0.0.0:5080`; если запустить его только на `localhost:5080`, CMDBuild-контейнер не сможет вызвать webhook.

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

Dev launch profile сервиса использует:

```text
http://0.0.0.0:5080
```

Это нужно, чтобы CMDBuild в Docker мог обратиться к webhook через host IP и порт `5080`.

## cmdbkafka2zabbix

Файлы:
- `src/cmdbkafka2zabbix/appsettings.json`;
- `src/cmdbkafka2zabbix/appsettings.Development.json`.

Что вносить:

| Секция | Что задавать |
| --- | --- |
| `Kafka:Input` | Topic `cmdbuild.webhooks.*`, group id, consumer auth/security |
| `Kafka:Output` | Topic `zabbix.host.requests.*`, producer auth/security, `ProfileHeaderName` |
| `ConversionRules` | Repository path, rules file path, git pull behavior, template engine |
| `ProcessingState` | State-файл последнего обработанного объекта |
| `ElkLogging` | Kafka log topic или будущий ELK |

Rules-файл отвечает за:
- `create/update/delete` routing;
- regex validation;
- выбор host profiles, host groups/templates/interfaces/tags;
- выбор proxy, proxy group, interface profile, host status, TLS/PSK, host macros, inventory fields, maintenances и value maps;
- T4 templates для JSON-RPC;
- fallback `host.get -> host.update/delete` без `zabbix_hostid`;
- optional update upsert: `host.get -> host.create`, если profile включает `createOnUpdateWhenMissing` и host еще не существует.

При наличии блока `inventory` в Zabbix payload `inventory_mode` должен быть `0` или другим разрешенным режимом inventory. Значение `-1` отключает inventory и несовместимо с передачей inventory fields.

`ProcessingState` читается при старте. После назначения Kafka partition сервис стартует чтение с `lastInputOffset + 1`, чтобы после рестарта не переобрабатывать уже обработанные сообщения.

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

`ProcessingState` работает по тому же правилу, что и во втором сервисе: state-файл хранит последний успешно обработанный input offset, а consumer при старте начинает с `lastInputOffset + 1`.

`zabbixrequests2api` валидирует не только базовые `host.create/update/delete`, но и расширенные host поля, используемые rules: `status`, `macros`, `inventory`, TLS/PSK параметры. Также зарезервирована обработка Zabbix API methods для следующих задач: `maintenance.*`, `usermacro.*`, `proxy.*`, `valuemap.*`.

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
| `UiSettings` | Путь к runtime settings JSON, который сохраняет UI |
| `Auth` | IdP mode, session cookie, session timeout, SAML POST limit |
| `Auth:LocalLoginDefaults` | Prefill local login form; только dev/временный режим, в prod должен быть выключен |
| `Idp` | SAML2 SP/IdP настройки |
| `Cmdbuild` | CMDBuild REST base URL, service account для IdP режима, catalog cache |
| `Zabbix` | Zabbix API endpoint, service account/API token для IdP режима, catalog cache |
| `Rules` | Rules path, upload/save policy, optional git auto-commit |
| `EventBrowser` | Kafka read-only browser для вкладки Events: bootstrap, auth, topics, limits |
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

Runtime settings:
- вкладка Settings читает текущие значения из merged config и runtime-файла;
- `Save runtime` пишет overrides в `src/monitoring-ui-api/state/ui-settings.json`;
- runtime-файл не коммитится и может содержать dev credentials;
- текущий dev `EventBrowser` смотрит Kafka `localhost:9092` и topics `*.dev`.

Events:
- вкладка Events читает Kafka topics только через BFF;
- браузер не имеет прямого доступа к Kafka;
- список topics берется из `EventBrowser:Topics` и может быть изменен через Settings;
- для SASL/TLS заполняются `EventBrowser:SecurityProtocol`, `SaslMechanism`, `Username`, `Password`.
- вывод по умолчанию показывает последние сообщения выбранного topic, сортировка выполняется от более новых сообщений к более старым;
- раскрытие topic показывает timestamp, сводку service/partition/offset/key и value.

Mapping:
- левая колонка показывает CMDBuild classes/attributes/lookups;
- центральная колонка показывает conversion fields, regex, selection rules и T4 blocks;
- Host profiles в центральной колонке показывают fan-out и конкретные interface profile/valueField связи;
- правая колонка показывает Zabbix catalog entities;
- повторное нажатие на элемент снимает выделение;
- для lookup выделяется только конкретная связка class + lookup + value;
- блоки списков скрываются, если не участвуют в выделении, и могут быть раскрыты пользователем.
- Zabbix catalog sections в Mapping закрыты по умолчанию и лениво загружаются по `+` или при попадании в выделенную цепочку;
- edit mode имеет действия `Добавление правила` и `Удаление правила`;
- добавление правила выбирает CMDBuild class, class attribute field, conversion structure, Zabbix object/payload, priority и regex;
- удаление правила группирует rules по типам, держит группы закрытыми через `+`, удаляет только выбранные rules из draft JSON и оставляет classes/source fields без автоматической чистки;
- undo/redo работают только с draft текущей browser-сессии;
- `Save file as` сохраняет draft JSON и второй текстовый файл с CMDBuild webhook Body/DELETE-инструкциями только по добавленным и удаленным в текущей сессии rules/classes/source fields;
- перед сохранением проверяется, что каждый мониторинговый класс из `source.entityClasses` или `className` regex имеет IP или DNS class attribute field, связанный с `interfaceAddressRules` или `hostProfiles[].interfaces`;
- имена классов CMDBuild нормализуются для UI: например, `NetworkDevice` и `Network device` считаются одним классом, а отображение предпочитает имя/описание из CMDBuild catalog.

Validate rules mapping:
- интерактивно не строит цепочки, а подсвечивает только отсутствующие элементы в CMDBuild/Zabbix источниках;
- для отсутствующих элементов выводятся checkbox;
- кнопка удаления спрашивает подтверждение, создает backup предыдущей версии в `rules/.backup/`, затем удаляет выбранные элементы из rules;
- backup-файлы не коммитятся в Git.
- этот раздел не предназначен для интерактивной подсветки связей, а только для поиска отсутствующих классов, атрибутов и Zabbix-ссылок.

Поддержанные env vars:

```bash
PORT=5090
MONITORING_UI_HOST=0.0.0.0
MONITORING_UI_SETTINGS_FILE=state/ui-settings.json
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
MONITORING_UI_EVENTS_ENABLED=true
MONITORING_UI_KAFKA_BOOTSTRAP_SERVERS=kafka:29092
MONITORING_UI_KAFKA_SECURITY_PROTOCOL=SaslSsl
MONITORING_UI_KAFKA_SASL_MECHANISM=ScramSha512
MONITORING_UI_KAFKA_USERNAME=<secret>
MONITORING_UI_KAFKA_PASSWORD=<secret>
MONITORING_UI_EVENTS_TOPICS=cmdbuild.webhooks,zabbix.host.requests,zabbix.host.responses
```

Runtime cache/state:
- `src/monitoring-ui-api/data/*.json` - catalog cache, не коммитить;
- `src/monitoring-ui-api/state/ui-settings.json` - persisted UI settings, не коммитить.
- `rules/.backup/*.bak` - локальные backup rules перед auto-fix из UI, не коммитить.

## Rules conversion model

`Model.*` в T4-шаблонах - это промежуточная модель `cmdbkafka2zabbix`, а не прямой объект CMDBuild или Zabbix.

Поддержанные группы данных:
- базовые поля: `EntityId`, `Code`, `ClassName`, `Host`, `VisibleName`, `HostProfileName`, `IpAddress`, `Description`, `OperatingSystem`, `ZabbixTag`, `EventType`;
- dynamic source fields: `Model.Field("fieldName")` читает поле из `source.fields` rules;
- Zabbix interfaces: `Interface` для обратной совместимости и `Interfaces` для нескольких `interfaces[]` в одном host;
- Zabbix host links: `Groups`, `Templates`, `Tags`;
- расширенные host параметры: `Status`, `ProxyId`, `ProxyGroupId`, `TlsPsk`, `Macros`, `InventoryFields`, `Maintenances`, `ValueMaps`.

`hostProfiles[]` в rules управляет двумя сценариями:
- один CMDB object -> один Zabbix host с несколькими `interfaces[]`, если несколько IP относятся к одному объекту мониторинга;
- один CMDB object -> несколько Zabbix hosts, если основной сервер и дополнительный profile object должны иметь разные host names, templates, groups или lifecycle.

Для `Server` в dev-правилах дополнительно настроены оба сценария multi-address обработки:
- основной profile `main` создает один Zabbix host с тремя interfaces: `ip_address -> ipAddress`, `interface -> interfaceIpAddress`, `interface2 -> interface2IpAddress`;
- дополнительные profiles `profile` и `profile2` создают отдельные Zabbix hosts с suffix `-profile` и `-profile2`.

Webhook body для Server должен использовать `interface/interface2/profile/profile2`; старые имена этих полей больше не поддерживаются rules/UI.
Реальные CMDBuild attributes остаются `iLo/iLo2/mgmt/mgmt2`; rules связывает их с webhook keys через `source.fields[].cmdbAttribute`. Это поле используется Mapping UI и генератором CMDBuild Body, но не является входным alias для `cmdbkafka2zabbix`.
Переименование hostProfile меняет вычисляемое имя Zabbix host: новые дополнительные hosts получают suffix `-profile`/`-profile2`. Ранее созданные дополнительные hosts со старыми suffix автоматически не переименовываются; оператор должен удалить, отключить или мигрировать их отдельно.

`interface/interface2/profile/profile2` используют SNMP interface `:161`; `main` с `interface/interface2` получает `HP iLO by SNMP`, а `profile/profile2` получают отдельные SNMP monitoring rules. Блок `templateConflictRules` в rules-файле удаляет `ICMP Ping` и agent-шаблоны, если выбран `HP iLO by SNMP` или `Generic by SNMP`, потому что эти SNMP-шаблоны уже содержат item key `icmpping` и заполняют inventory field `Name`.
На update через `host.get` микросервис передает `templates_clear`; `zabbixrequests2api` читает текущие linked templates через `selectParentTemplates` и очищает только реально привязанные конфликтующие templateid.

Пример несовместимости templates: существующий Zabbix host `cmdb-server-srv13` имел agent-шаблон `Windows by Zabbix agent`, а update добавил `HP iLO by SNMP` для дополнительного SNMP interface. Zabbix отклонил `host.update`, потому что оба шаблона заполняют inventory field `Name` (`system.hostname` и `system.name`). Поэтому rules выбирают SNMP template как целевой и передают agent template в `templates_clear` для update fallback.

Ограничения по количеству IP:
- в коде `cmdbkafka2zabbix` нет отдельного числового лимита на `Model.Interfaces`: сервис рендерит столько interfaces, сколько выбрано правилами `hostProfiles[].interfaces`;
- фактический лимит текущей dev-схемы задается rules и плоским webhook body: `main` сейчас может получить до трех interfaces (`ip_address`, `interface`, `interface2`), а `profile` и `profile2` сейчас являются двумя отдельными дополнительными host profiles по одному IP каждый;
- в одном Zabbix host допустимо несколько interfaces, но для каждого Zabbix interface type должен быть только один основной interface с `main=1`; дополнительные interfaces того же type должны иметь `main=0`, иначе Zabbix может отклонить или некорректно применить payload;
- чтобы добавить еще один фиксированный IP в основной host, нужно добавить CMDBuild attribute, webhook field, `source.fields` и новый элемент `hostProfiles[].interfaces`; если это еще один SNMP interface, его interface profile должен быть не-main (`main=0`), кроме одного выбранного основного SNMP interface;
- чтобы добавить еще один отдельный monitoring profile, нужно добавить новый named source field и отдельный `hostProfile` с собственным suffix, например `profile3`; при необходимости upsert на update включается `createOnUpdateWhenMissing=true`;
- произвольное или заранее неизвестное количество IP в одном поле webhook сейчас не поддерживается: текущая модель ожидает плоские именованные поля, а не массив адресов. Для безлимитного списка потребуется отдельное расширение контракта webhook/rules/T4, например массив interfaces или profiles с итерацией.

Поведение при пустых дополнительных адресах:
- если заполнен только `ip_address`, profile `main` все равно создает или обновляет основной Server host с одним agent interface;
- пустые `interface` и `interface2` просто не попадают в `interfaces[]`; когда они позже появятся в update-событии, `main` сформирует update payload уже с дополнительными SNMP interfaces;
- пустые `profile` и `profile2` на create/update не выбирают profiles `profile` и `profile2`, поэтому отдельные hosts `-profile` и `-profile2` не создаются и запросы по ним не публикуются;
- для profiles с `createOnUpdateWhenMissing=true` новое значение `profile` или `profile2`, появившееся только на update, обрабатывается как upsert: `zabbixrequests2api` выполняет `host.get`, при найденном host делает `host.update`, а при отсутствующем host валидирует `fallbackCreateParams` и делает `host.create`;
- если `profile` или `profile2` очищены после того, как дополнительный host уже был создан, автоматического удаления нет: необходимо самостоятельно принять решение по соответствующему объекту мониторинга Zabbix, например оставить, отключить или удалить его отдельным процессом;
- delete-событие пытается удалить `main`, `profile` и `profile2` profiles по вычисленным именам даже при пустых адресах, чтобы удалить ранее созданные дополнительные hosts; если такого host нет, в response будет `host_not_found`.

При наличии нескольких host profiles `cmdbkafka2zabbix` публикует несколько сообщений в `zabbix.host.requests.*`. State входного Kafka offset записывается только после успешной публикации всех сообщений по одному CMDB event.

Расширение rules для новых CMDBuild атрибутов возможно без изменения кода, если:
- атрибут уже приходит в webhook body;
- атрибут добавлен в `source.fields`;
- rules/T4 используют существующие механизмы `Model.Field(...)` или `Model.Source(...)`;
- для создания/обновления Zabbix host остается настроен IP или DNS через `interfaceAddressRules` или `hostProfiles[].interfaces`.

Для нового CMDBuild класса дополнительно нужны:
- класс в CMDBuild catalog и webhook-записи на нужные события;
- добавление класса в `source.entityClasses` или rule condition по `className`;
- обязательная связь IP/DNS class attribute field с Zabbix interface structure;
- актуализированный CMDBuild catalog cache в UI через `CMDBuild Catalog -> Sync`.

Без переписывания микросервисов можно менять JSON rules:
- `source.fields` для уже приходящих CMDBuild атрибутов;
- regex validation и selection rules;
- ссылки на существующие Zabbix host groups/templates/template groups/tags;
- T4 templates, если итоговый JSON-RPC остается валидным для Zabbix.

Переписывание микросервисов потребуется, если нужно добавить принципиально новый тип Zabbix API operation, новый способ чтения source payload или новую runtime-интеграцию.

## ELK logging

Пока ELK нет, каждый .NET-сервис пишет structured JSON logs в Kafka log topic.
Когда ELK появится:
- задать `ElkLogging:Mode=Elk` или включить `ElkLogging:Elk:Enabled`;
- заполнить `ElkLogging:Elk:Endpoint`, `Index`, `ApiKey`;
- при необходимости отключить Kafka log sink.

## Проверки перед commit/push

```bash
./scripts/test-configs.sh
./scripts/dotnet build src/cmdbwebhooks2kafka/cmdbwebhooks2kafka.csproj -v minimal
./scripts/dotnet build src/cmdbkafka2zabbix/cmdbkafka2zabbix.csproj -v minimal
./scripts/dotnet build src/zabbixrequests2api/zabbixrequests2api.csproj -v minimal
./scripts/dotnet build tests/configvalidation/configvalidation.csproj -v minimal
node src/monitoring-ui-api/scripts/validate-config.mjs
git diff --check
```

Smoke-проверки цепочки:
- `create`: CMDBuild -> Kafka -> Zabbix `host.create` -> response topic -> host есть в Zabbix;
- `update`: CMDBuild -> Kafka -> fallback `host.get -> host.update` -> response topic -> поля изменились в Zabbix;
- `update` с новым `profile`/`profile2`: CMDBuild -> Kafka -> fallback `host.get -> host.create` при включенном `createOnUpdateWhenMissing` -> дополнительный host появился в Zabbix;
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
