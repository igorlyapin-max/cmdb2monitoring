# Архитектурные артефакты cmdb2monitoring

Папка содержит артефакты, подготовленные по требованиям из `~/projects/aa.txt`.

Формат хранения выбран как text/diagram-as-code, чтобы все материалы версионировались в git и проверялись diff-ом. При необходимости диаграммы `.mmd` можно экспортировать в SVG/PNG/VSDX внешним инструментом.

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
- `maps/secrets-map.md` - карта секретов.
- `maps/event-registration-map.md` - карта регистрации событий.
- `configuration-files.md` - описание конфигурационных файлов и параметров.

Полная эксплуатационная документация по всему проекту находится в `PROJECT_DOCUMENTATION.md` в корне репозитория.

## Границы текущей версии

Текущая версия описывает dev-контур и целевую структуру для тест/прод. Kafka topics создаются внешней инфраструктурой, микросервисы topics не создают.
