# Карта метрик

Текущая реализация пока не публикует отдельные Prometheus metrics. До подключения metrics endpoint контроль выполняется через logs, healthcheck и Kafka offsets.

| Metric ID | Компонент | Метрика | Назначение | Статус |
| --- | --- | --- | --- | --- |
| M-001 | cmdbwebhooks2kafka | webhook accepted count | Количество принятых webhook | Кандидат |
| M-002 | cmdbwebhooks2kafka | webhook rejected count | Ошибки авторизации/JSON | Кандидат |
| M-003 | cmdbkafka2zabbix | conversion success count | Успешные конвертации | Кандидат |
| M-004 | cmdbkafka2zabbix | conversion skipped count | Некорректные/неподдерживаемые события | Кандидат |
| M-005 | zabbixrequests2api | zabbix api success count | Успешные вызовы Zabbix API | Кандидат |
| M-006 | zabbixrequests2api | zabbix api error count | Ошибки API/валидации | Кандидат |
| M-007 | zabbixrequests2api | processing latency | Время обработки объекта | Кандидат |
| M-008 | Kafka | consumer lag | Отставание consumer groups | Внешний мониторинг |
| M-009 | monitoring-ui-api | active session count | Количество активных server-side sessions | Кандидат |
| M-010 | monitoring-ui-api | saml login success/error count | Контроль SAML2 авторизации | Кандидат |
| M-011 | monitoring-ui-api | catalog sync duration/error count | Контроль синхронизации CMDBuild/Zabbix catalog | Кандидат |
| M-012 | monitoring-ui-api | rules validate/upload count | Контроль изменений rules через UI | Кандидат |
