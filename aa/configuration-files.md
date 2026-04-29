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
