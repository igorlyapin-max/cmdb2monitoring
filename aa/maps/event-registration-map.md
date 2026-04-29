# Карта регистрации событий

| Event ID | Компонент | Событие | Уровень | Поля |
| --- | --- | --- | --- | --- |
| EV-001 | cmdbwebhooks2kafka | Webhook получен | Information | eventType, entityType, entityId |
| EV-002 | cmdbwebhooks2kafka | Ошибка авторизации webhook | Warning | remote endpoint, reason |
| EV-003 | cmdbwebhooks2kafka | Ошибка JSON | Warning/Error | route, exception |
| EV-004 | cmdbwebhooks2kafka | Kafka publish success | Information | topic, partition, offset |
| EV-005 | cmdbkafka2zabbix | Rules загружены | Information | rules path, schemaVersion, git commit |
| EV-006 | cmdbkafka2zabbix | Событие сконвертировано | Information | eventType, entityId, host |
| EV-007 | cmdbkafka2zabbix | Событие пропущено | Information/Warning | entityId, skipReason |
| EV-008 | zabbixrequests2api | Validation error | Warning | method, entityId, errorCode |
| EV-009 | zabbixrequests2api | Zabbix API call | Information/Error | method, requestId, status |
| EV-010 | zabbixrequests2api | Response опубликован | Information | topic, partition, offset, success |
| EV-011 | Все сервисы | State загружен/записан | Information | entityId, offset, processedAt |

Логи пишутся в JSON и временно публикуются в Kafka log topics для будущей доставки в ELK.
