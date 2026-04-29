# Карта HealthCheck

| Flow ID | Сервис | Endpoint dev | Ожидаемый ответ | Назначение |
| --- | --- | --- | --- | --- |
| HC-001 | cmdbwebhooks2kafka | `GET http://localhost:5080/health` | `{"service":"cmdbwebhooks2kafka-dev","status":"ok"}` | Готовность приема webhook |
| HC-002 | cmdbkafka2zabbix | `GET http://localhost:5081/health` | `{"service":"cmdbkafka2zabbix-dev","status":"ok"}` | Готовность чтения CMDB topic и конвертации |
| HC-003 | zabbixrequests2api | `GET http://localhost:5082/health` | `{"service":"zabbixrequests2api-dev","status":"ok"}` | Готовность вызова Zabbix API |
| HC-004 | monitoring-ui-api | `GET http://localhost:5090/health` | `{"service":"monitoring-ui-api-dev","status":"ok"}` | Готовность frontend/BFF |

Health endpoints не проверяют внешние зависимости глубоко. Проверки Kafka/Zabbix выполняются отдельными smoke-тестами или мониторингом.
