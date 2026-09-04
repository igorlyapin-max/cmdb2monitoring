# Архитектурные артефакты cmdb2monitoring

Версия артефактов: `0.5.0`.

Папка содержит артефакты, подготовленные по требованиям из `~/projects/aa.txt`.

Формат хранения выбран как text/diagram-as-code, чтобы все материалы версионировались в git и проверялись diff-ом. Markdown/YAML/Mermaid являются источником истины; файлы в `aa/xlsx/` - версионируемые представления для поставки и должны быть согласованы с исходными артефактами. При необходимости диаграммы `.mmd` можно экспортировать в SVG/PNG/VSDX внешним инструментом.

## Состав

- `business-process.md` и `business-process.mmd` - бизнес-процесс, позитивные/негативные сценарии, точки логирования.
- `information-model.md` и `information-model.mmd` - информационные потоки между CMDBuild, микросервисами, Kafka, Zabbix, monitoring UI, IdP и будущим ELK.
- `deployment.md` и `deployment-test.mmd` - схема развертывания для тестового/целевого контура.
- `asyncapi/cmdb2monitoring.asyncapi.yaml` - описание Kafka-потоков.
- `openapi/cmdbwebhooks2kafka.openapi.yaml` - HTTP API webhook-сервиса.
- `openapi/health.openapi.yaml` - health endpoints микросервисов.
- `openapi/monitoring-ui-api.openapi.yaml` - HTTP API frontend/BFF.
- `maps/healthcheck-map.md` - карта healthcheck.
- `maps/kafka-access-map.md` - карта доступов Kafka.
- `maps/metrics-map.md` - карта метрик.
- `xlsx/metrics-map.xlsx` - поставочное XLSX-представление карты метрик.
- `maps/secrets-map.md` - карта секретов.
- `maps/event-registration-map.md` - карта регистрации событий.
- `configuration-files.md` - описание конфигурационных файлов и параметров.

Полная эксплуатационная документация по всему проекту находится в `PROJECT_DOCUMENTATION.md` в корне репозитория.

## Идентификаторы потоков

Информационная модель является источником идентификаторов. Используются typed IDs с нумерацией от нуля без разделителя и padding: `OAPIx` для HTTP/OpenAPI, `AAPIx` для Kafka/AsyncAPI, `Lx` для регистрации событий и log delivery, `Hx` для health/readiness/liveness, `Mx` для Prometheus collection, `IFx` для файловых и иных информационных обменов. Все карты, OpenAPI, AsyncAPI и XLSX ссылаются только на эти ID; legacy формат `IF-XXX` не поддерживается.

## Границы текущей версии

Текущая версия описывает dev-контур и целевую структуру для тест/прод, включая `Управление правилами конвертации`, `Логический контроль правил конвертации`, сохранение языка интерфейса в cookie, lookup/reference/domain path resolution через `cmdbPath` и обратную запись Zabbix binding-ов в CMDBuild через `zabbixbindings2cmdbuild`. Kafka topics создаются внешней инфраструктурой, микросервисы topics не создают.
Для всех сетевых соединений в артефактах указываются порты, если они известны. В dev-контуре CMDBuild вызывает webhook на `http://cmdbwebhooks2kafka:8080/webhooks/cmdbuild`, а `cmdbwebhooks2kafka` слушает `0.0.0.0:5080`.
