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
- `delete`: CMDBuild -> Kafka -> fallback `host.get -> host.delete` -> response topic -> host отсутствует в Zabbix.

Для конфигов:

- добавлять или обновлять проверки в `tests/configvalidation`;
- `scripts/test-configs.sh` должен оставаться быстрым и не требовать живых Kafka/Zabbix/CMDBuild;
- интеграционные проверки с живыми сервисами выполняются отдельно и фиксируются в ТЗ при значимом изменении поведения.

## Git

- Работать в `main`, если не оговорено иное.
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
