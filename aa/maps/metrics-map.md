# Карта метрик

Текущая реализация пока не публикует отдельные Prometheus metrics. До подключения metrics endpoint контроль выполняется через logs, healthcheck и Kafka offsets. Поэтому отдельный сетевой информационный поток metrics сейчас не зарегистрирован; после реализации `/metrics` он должен быть добавлен в `information-model.md` и OpenAPI.

| Metric ID | Связанные потоки | Компонент | Метрика | Назначение | Статус |
| --- | --- | --- | --- | --- | --- |
| M-001 | IF-001, IF-002 | cmdbwebhooks2kafka | webhook accepted count | Количество принятых webhook | Кандидат |
| M-002 | IF-001 | cmdbwebhooks2kafka | webhook rejected count | Ошибки авторизации/JSON | Кандидат |
| M-003 | IF-002, IF-003 | cmdbkafka2zabbix | conversion success count | Успешные конвертации | Кандидат |
| M-004 | IF-002 | cmdbkafka2zabbix | conversion skipped count | Некорректные/неподдерживаемые события | Кандидат |
| M-005 | IF-004, IF-005 | zabbixrequests2api | zabbix api success count | Успешные вызовы Zabbix API | Кандидат |
| M-006 | IF-003, IF-004, IF-005 | zabbixrequests2api | zabbix api error count | Ошибки API/валидации | Кандидат |
| M-007 | IF-003, IF-004, IF-005 | zabbixrequests2api | processing latency | Время обработки объекта | Кандидат |
| M-008 | IF-002, IF-003, IF-005 | Kafka | consumer lag | Отставание consumer groups | Внешний мониторинг |
| M-009 | IF-009 | monitoring-ui-api | active session count | Количество активных server-side sessions | Кандидат |
| M-010 | IF-010 | monitoring-ui-api | authorization login success/error count | Контроль локальной, MS AD и IdP авторизации | Кандидат |
| M-011 | IF-011, IF-012, IF-014 | monitoring-ui-api | catalog sync duration/error count | Контроль синхронизации CMDBuild/Zabbix catalog | Кандидат |
| M-012 | IF-013, IF-014 | monitoring-ui-api | rules validate/upload count | Контроль изменений rules через UI | Кандидат |
| M-013 | IF-018 | cmdbkafka2zabbix | cmdb resolver duration/error count | Контроль чтения CMDBuild reference/lookup/domain leaf-значений | Кандидат |
| M-014 | IF-021, IF-022 | zabbixbindings2cmdbuild | binding apply success/error count | Контроль обратной записи `zabbix_main_hostid` и `ZabbixHostBinding` | Кандидат |
