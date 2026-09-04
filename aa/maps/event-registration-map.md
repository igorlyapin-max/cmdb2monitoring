# Карта регистрации событий

| Event ID | Information flows | Компонент | Событие | Уровень | Поля |
| --- | --- | --- | --- | --- | --- |
| EV-001 | OAPI0 | cmdbwebhooks2kafka | Webhook получен | Information | eventType, entityType, entityId |
| EV-002 | OAPI0 | cmdbwebhooks2kafka | Ошибка авторизации webhook | Warning | remote endpoint, reason |
| EV-003 | OAPI0 | cmdbwebhooks2kafka | Ошибка JSON | Warning/Error | route, exception |
| EV-004 | AAPI0 | cmdbwebhooks2kafka | Kafka publish success | Information | topic, partition, offset |
| EV-005 | IF0 | cmdbkafka2zabbix | Rules загружены | Information | rules path, schemaVersion, git commit |
| EV-006 | AAPI0, AAPI1 | cmdbkafka2zabbix | Событие сконвертировано | Information | eventType, entityId, host, hostProfile, publishedCount |
| EV-007 | AAPI0 | cmdbkafka2zabbix | Событие пропущено | Information/Warning | entityId, hostProfile, skipReason |
| EV-008 | AAPI1, OAPI1 | zabbixrequests2api | Validation error | Warning | method, entityId, errorCode |
| EV-009 | OAPI1 | zabbixrequests2api | Zabbix API call | Information/Error | method, requestId, status |
| EV-010 | AAPI2 | zabbixrequests2api | Response опубликован | Information | topic, partition, offset, success |
| EV-011 | IF1 | Все сервисы | State загружен/записан | Information | entityId, offset, processedAt |
| EV-012 | OAPI2 | monitoring-ui-api | Local login/logout | Information/Warning | authMethod, user, result |
| EV-013 | OAPI3 | monitoring-ui-api | Authorization login/ACS/callback/LDAP bind | Information/Warning/Error | mode, provider, issuer/nameID/login, roleMapping, result |
| EV-014 | OAPI3, IF3 | monitoring-ui-api | Authorization settings updated | Information | mode, provider, metadataUrl set, oauth2 configured, ldap configured, cert flags |
| EV-015 | IF2 | monitoring-ui-api | Rules validate/upload/dry-run | Information/Warning | rules path, valid, user |
| EV-016 | OAPI5, IF3 | monitoring-ui-api | Zabbix catalog sync | Information/Error | endpoint, counts, error |
| EV-017 | OAPI4, IF3 | monitoring-ui-api | CMDBuild catalog sync | Information/Error | endpoint, counts, error |
| EV-018 | IF4 | monitoring-ui-api frontend | Conversion rules save-as draft/webhook instructions | UI status | session change count, validation warnings |
| EV-019 | OAPI6 | cmdbkafka2zabbix | Lookup/reference/domain field resolution | Warning | fieldName, cmdbPath, reason |
| EV-020 | OAPI2 | monitoring-ui-api frontend | Interface language changed | UI state | language, cookie |
| EV-021 | OAPI7 | cmdbkafka2zabbix / monitoring-ui-api | Conversion rules reload requested | Information/Warning/Error | service, rules name, schemaVersion, version, result |
| EV-022 | AAPI4 | zabbixrequests2api | Binding event published/skipped | Information/Warning/Error | sourceClass, sourceCardId, hostProfile, zabbixHostId, topic, reason |
| EV-023 | OAPI9 | zabbixbindings2cmdbuild | Binding applied to CMDBuild | Information/Error | sourceClass, sourceCardId, hostProfile, bindingStatus, zabbixHostId |

Логи пишутся в JSON и временно публикуются в Kafka log topics для будущей доставки в ELK.
