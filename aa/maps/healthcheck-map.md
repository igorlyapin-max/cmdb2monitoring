# Карта HealthCheck

| Health ID | Information flow | Сервис | Endpoint dev | Ожидаемый ответ | Назначение |
| --- | --- | --- | --- | --- | --- |
| HC-001 | IF-016 | cmdbwebhooks2kafka | `GET http://localhost:5080/health`, из Docker `GET http://192.168.202.100:5080/health` | `{"service":"cmdbwebhooks2kafka-dev","status":"ok"}` | Готовность приема webhook от CMDBuild |
| HC-002 | IF-016 | cmdbkafka2zabbix | `GET http://localhost:5081/health` | `{"service":"cmdbkafka2zabbix-dev","status":"ok"}` | Готовность чтения CMDB topic и конвертации |
| HC-002A | IF-019 | cmdbkafka2zabbix | `POST http://localhost:5081/admin/reload-rules` + Bearer token | `{"service":"cmdbkafka2zabbix-dev","status":"ok","rules":{...}}` | Ручное перечитывание conversion rules |
| HC-003 | IF-016 | zabbixrequests2api | `GET http://localhost:5082/health` | `{"service":"zabbixrequests2api-dev","status":"ok"}` | Готовность вызова Zabbix API |
| HC-003A | IF-016 | zabbixbindings2cmdbuild | `GET http://localhost:5083/health` | `{"service":"zabbixbindings2cmdbuild-dev","status":"ok"}` | Готовность обратной записи binding-ов в CMDBuild |
| HC-004 | IF-009 | monitoring-ui-api | `GET http://localhost:5090/health` | `{"service":"monitoring-ui-api-dev","status":"ok"}` | Готовность frontend/BFF |

Health endpoints не проверяют внешние зависимости глубоко. Проверки Kafka/Zabbix выполняются отдельными smoke-тестами или мониторингом.
