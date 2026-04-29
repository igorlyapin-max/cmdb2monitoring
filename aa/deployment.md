# Схема развертывания

Окружение разработки в требованиях не обязательно, но текущие dev-настройки зафиксированы для повторяемости проверки.

## Dev-контур

| Узел | Артефакты | Сетевые адреса |
| --- | --- | --- |
| Workstation/Dev host | .NET микросервисы | `localhost:5080`, `localhost:5081`, `localhost:5082` |
| Docker host | Kafka | host `localhost:9092`, docker network `kafka:29092` |
| Docker host | CMDBuild | `http://localhost:8090/cmdbuild` |
| Docker host | Zabbix | UI `http://localhost:8081`, API `/api_jsonrpc.php` |
| Future | ELK | Endpoint будет задан через `ElkLogging` |

## Test/Prod-контуры

Для тестового и продуктивного контуров требуется:
- отдельные Kafka topics без `.dev`;
- secrets через переменные окружения или secret storage;
- внешний процесс создания Kafka topics;
- отдельные service accounts для CMDBuild webhook, Kafka и Zabbix API;
- выделенный ELK endpoint.

## Сетевая связность

| Откуда | Куда | Протокол |
| --- | --- | --- |
| CMDBuild | cmdbwebhooks2kafka | HTTP POST |
| cmdbwebhooks2kafka | Kafka | Kafka protocol |
| cmdbkafka2zabbix | Kafka | Kafka protocol |
| cmdbkafka2zabbix | Git repository/working copy | local FS или git |
| zabbixrequests2api | Kafka | Kafka protocol |
| zabbixrequests2api | Zabbix API | HTTP JSON-RPC |
| Микросервисы | ELK или Kafka log topics | HTTP/Kafka |
