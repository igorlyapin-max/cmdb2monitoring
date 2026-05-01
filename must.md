# MUST: соглашения разработки cmdb2monitoring

Этот файл фиксирует обязательные правила разработки проекта. Если правило противоречит более старой документации, актуальным считается `must.md`, затем `TZ_cmdb2monitoring.txt`, затем документы в `aa/`.

## Общие принципы

- Проект ведется в одном monorepo.
- Каждый микросервис живет в отдельной папке `src/<service-name>`.
- Основной язык backend-микросервисов: C# / .NET.
- Frontend/BFF допускается на Node.js, если он не обращается из браузера напрямую к Kafka/CMDBuild/Zabbix.
- Все настройки выносятся в конфигурационные файлы и env overrides. Не хардкодить адреса, topics, credentials, токены, пути state-файлов, endpoints.
- В архитектурных артефактах и документации каждый сетевой поток должен указывать порт, если порт известен.
- Kafka topics создаются внешней инфраструктурой. Код микросервисов не должен создавать topics при старте.
- Логи проектируются под ELK. Пока ELK отсутствует, structured JSON logs пишутся в Kafka log topics.
- Runtime state хранится в `state/*.json` и не попадает в git.
- Production secrets не хранятся в git. Использовать переменные окружения, secret storage или local config, исключенный из git.
- Frontend credentials не хранить в браузере; использовать server-side session.
- Для `monitoring-ui-api` пользовательские тексты общего меню, Help и базовых всплывающих подсказок должны поддерживаться в русской и английской локалях. При добавлении нового пункта меню, Help-текста или selector tooltip обязательно обновлять словари `ru/en`.
- SAML2 реализуется через проверенную библиотеку, с обязательной проверкой IdP signing certificate и InResponseTo; XML-подписи не проверять самописным кодом.

## Микросервисные соглашения

- Каждый сервис должен иметь `GET /health`.
- Каждый сервис должен иметь `appsettings.json` и `appsettings.Development.json`.
- Конфиги должны проходить `scripts/test-configs.sh`.
- Для Kafka должны быть конфигурируемы:
  - `BootstrapServers`;
  - `Topic`;
  - `ClientId`;
  - `GroupId` для consumers;
  - `SecurityProtocol`;
  - `SaslMechanism`;
  - `Username`;
  - `Password`;
  - `Acks`;
  - `EnableIdempotence`;
  - timeouts.
- Для сервисов с обработкой Kafka offset коммитится только после успешной обработки, публикации результата или осознанного skip/error response.
- Сервисы, которые могут упасть при обработке, должны писать последний обработанный объект и Kafka input offset в state-файл.
- При старте consumer должен читать state-файл и начинать чтение с `lastInputOffset + 1` для соответствующего topic/partition. State-файл не должен быть только диагностическим логом.
- Если сервис запускается на dev host, а источник работает в Docker, HTTP endpoint должен слушать не только loopback. Для текущего webhook-сервиса dev bind: `0.0.0.0:5080`, CMDBuild вызывает `http://192.168.202.100:5080/webhooks/cmdbuild`.

## Kafka и контракты

- Dev topics имеют суффикс `.dev`.
- Base/prod topics не имеют суффикса `.dev`.
- Текущая цепочка:
  - `cmdbuild.webhooks.*`;
  - `zabbix.host.requests.*`;
  - `zabbix.host.responses.*`.
- Log topics:
  - `cmdbwebhooks2kafka.logs.*`;
  - `cmdbkafka2zabbix.logs.*`;
  - `zabbixrequests2api.logs.*`.
- При изменении структуры Kafka-сообщения обязательно обновлять:
  - `TZ_cmdb2monitoring.txt`;
  - `aa/asyncapi/cmdb2monitoring.asyncapi.yaml`;
  - config validation tests, если меняются правила связности/обязательные поля;
  - документацию в `aa/`, если меняются информационные потоки.

## Zabbix lifecycle

- `create` должен приводить к `host.create`.
- `update` без `zabbix_hostid` должен проходить через fallback `host.get -> host.update`.
- Для profile rules с `createOnUpdateWhenMissing=true` update fallback допускает upsert: если `host.get` не нашел host, `zabbixrequests2api` должен валидировать `fallbackCreateParams` и выполнить `host.create`.
- `delete` без `zabbix_hostid` должен проходить через fallback `host.get -> host.delete`.
- Служебная metadata `cmdb2monitoring` допустима только во внутреннем Kafka request. Перед вызовом Zabbix API она должна удаляться.
- Перед `host.create` и `host.update` проверять наличие:
  - host groups;
  - templates;
  - template groups.
- Zabbix templates не являются JSON-файлами проекта. В JSON передаются только ссылки `templateid` на существующие шаблоны Zabbix.
- Если в Zabbix payload передается объект `inventory`, `inventory_mode` не должен быть `-1`, потому что `-1` отключает inventory и Zabbix отклоняет inventory fields.

## Rules и T4

- Правила конвертации хранятся в Git-managed JSON.
- Текущий файл правил: `rules/cmdbuild-to-zabbix-host-create.json`.
- Regex используется не только для валидации, но и для выбора groups/templates/interfaces/tags.
- Rules должны поддерживать расширенные Zabbix host параметры без правки кода: proxy, proxy group, interface profile, host status, TLS/PSK, host macros, inventory fields, maintenances и value maps.
- Rules должны поддерживать `hostProfiles[]`: один CMDB object может формировать один Zabbix host с несколькими `interfaces[]` или несколько Zabbix hosts через fan-out.
- Количество IP в текущем контракте задается явными named fields rules/webhook; произвольные массивы IP не считаются поддержанными без отдельного изменения модели.
- Для Server обязательные webhook keys: `interface/interface2` означают дополнительные interfaces основного host, `profile/profile2` означают отдельные hostProfiles. Старые имена этих полей не поддерживаются как входные alias; реальные CMDBuild attributes `iLo/iLo2/mgmt/mgmt2` связываются через `source.fields[].cmdbAttribute` только для `Управление правилами конвертации` и генерации Body.
- Webhook payload остается плоским. Reference/lookup metadata хранится в rules: `source.fields[].cmdbPath`, `lookupType` и `resolve`; converter поднимает leaf через CMDBuild REST по пути вида `Server.adr.Ip` или `Server.ref1.ref2.lookup`.
- Для lookup source fields `OS` и `zabbixTag` штатное значение перед regex/T4 должно быть lookup `code`; numeric id допускаются только как fallback, если CMDBuild resolver не настроен.
- Для нескольких Zabbix interfaces одного type в одном host только один interface должен иметь `main=1`, остальные должны иметь `main=0`.
- Несовместимые Zabbix templates должны разрешаться через `templateConflictRules`; для update fallback конфликтующие уже привязанные templates передаются в `templates_clear`.
- Новые T4-шаблоны должны использовать `Model.Interfaces`; `Model.Interface` допускается только как обратная совместимость с первым интерфейсом.
- Итоговый JSON-RPC payload формируется T4-шаблонами из rules-файла.
- При изменении rules-файла нужно прогнать:
  - `./scripts/test-configs.sh`;
  - сборку затронутых `.csproj` через `./scripts/dotnet build <project>.csproj -v minimal`.

## ТЗ и архитектурные артефакты

- Любое изменение поведения, контракта, topics, конфигов, схемы обработки или интеграции должно отражаться в `TZ_cmdb2monitoring.txt`.
- Любое изменение конфигурации, запуска, secrets, runtime state/cache или эксплуатационной процедуры должно отражаться в `PROJECT_DOCUMENTATION.md`.
- Папка `aa/` обязательна для архитектурных артефактов.
- При изменении архитектуры обновлять релевантные файлы:
  - `aa/business-process.md`;
  - `aa/information-model.md`;
  - `aa/deployment.md`;
  - `aa/configuration-files.md`;
  - `aa/asyncapi/cmdb2monitoring.asyncapi.yaml`;
  - `aa/openapi/*.yaml`;
  - `aa/maps/*.md`.
- Диаграммы хранить как diagram-as-code (`.mmd`) или другой текстовый формат, пригодный для git diff. Экспорт в картинки/VSDX допустим как производный артефакт, но исходник должен быть текстовым.

## Тестирование

Перед commit/push обязательно выполнить:

```bash
./scripts/test-configs.sh
./scripts/dotnet build src/cmdbwebhooks2kafka/cmdbwebhooks2kafka.csproj -v minimal
./scripts/dotnet build src/cmdbkafka2zabbix/cmdbkafka2zabbix.csproj -v minimal
./scripts/dotnet build src/zabbixrequests2api/zabbixrequests2api.csproj -v minimal
./scripts/dotnet build tests/configvalidation/configvalidation.csproj -v minimal
node src/monitoring-ui-api/scripts/validate-config.mjs
git diff --check
```

Для изменений бизнес-логики дополнительно провести smoke-проверку соответствующего сценария:

- `create`: CMDBuild -> Kafka -> Zabbix `host.create` -> response topic -> host есть в Zabbix.
- `update`: CMDBuild -> Kafka -> fallback `host.get -> host.update` -> response topic -> поля реально изменились в Zabbix.
- `update` с новым дополнительным profile и `createOnUpdateWhenMissing=true`: CMDBuild -> Kafka -> fallback `host.get -> host.create` -> response topic -> дополнительный host есть в Zabbix.
- `delete`: CMDBuild -> Kafka -> fallback `host.get -> host.delete` -> response topic -> host отсутствует в Zabbix.

Для конфигов:

- добавлять или обновлять проверки в `tests/configvalidation`;
- `scripts/test-configs.sh` должен оставаться быстрым и не требовать живых Kafka/Zabbix/CMDBuild;
- интеграционные проверки с живыми сервисами выполняются отдельно и фиксируются в ТЗ при значимом изменении поведения.

## Git

- Работать в `main`, если не оговорено иное.
- Версии фиксировать как SemVer. Minor-релиз (`0.2.0`, `0.3.0`) используется для новых возможностей UI/микросервисов или расширения контрактов; patch-релиз (`0.2.1`) - только для исправлений без расширения поведения.
- При релизном коммите обновлять `CHANGELOG.md`, версию в `TZ_cmdb2monitoring.txt`, `README.md` и package/version metadata затронутых компонентов.
- Коммит должен включать код, ТЗ, документацию и тесты, относящиеся к одному изменению.
- Не коммитить:
  - `bin/`;
  - `obj/`;
  - `state/`;
  - `.dotnet/`;
  - `.nuget/`;
  - `.env*`;
  - local secrets.
  - `rules/.backup/`;
- Перед commit проверить `git status --short`.
- Перед push проверить, что build и config tests прошли.
- После push проверить, что рабочее дерево чистое.

## Минимальный Definition of Done

Изменение считается завершенным, если:

- код реализован;
- конфиги обновлены;
- `TZ_cmdb2monitoring.txt` обновлен;
- `aa/` обновлена, если затронута архитектура/интеграции/контракты;
- `PROJECT_DOCUMENTATION.md` обновлен, если меняются конфиги, запуск, интеграции, secrets, runtime state/cache или эксплуатационные процедуры;
- автотесты/скрипты проверки обновлены;
- `scripts/test-configs.sh` проходит;
- сборка затронутых `.csproj` проходит;
- изменения закоммичены и отправлены в GitHub;
- рабочее дерево после push чистое.
