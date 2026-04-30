# Карта секретов

| Secret ID | Information flows | Где используется | Конфиг/env | Ротация | Комментарий |
| --- | --- | --- | --- | --- | --- |
| SEC-001 | IF-001 | CMDBuild -> cmdbwebhooks2kafka | `CmdbWebhook` token или env | По политике ИБ | Static token сейчас, dynamic mode зарезервирован |
| SEC-002 | IF-002, IF-006 | Kafka SASL для cmdbwebhooks2kafka | `Kafka__Username`, `Kafka__Password` | По политике Kafka | В dev не используется |
| SEC-003 | IF-002, IF-003, IF-006 | Kafka SASL для cmdbkafka2zabbix input/output/logs | `Kafka__Input__*`, `Kafka__Output__*`, `ElkLogging__Kafka__*` | По политике Kafka | В dev не используется |
| SEC-004 | IF-003, IF-005, IF-006 | Kafka SASL для zabbixrequests2api input/output/logs | `Kafka__Input__*`, `Kafka__Output__*`, `ElkLogging__Kafka__*` | По политике Kafka | В dev не используется |
| SEC-005 | IF-004, IF-012 | Zabbix API token | `Zabbix__ApiToken`, `ZABBIX_SERVICE_API_TOKEN` | По политике Zabbix | Рекомендуемый prod-режим |
| SEC-006 | IF-004, IF-012 | Zabbix login/password | `Zabbix__User`, `Zabbix__Password`, `ZABBIX_SERVICE_USER`, `ZABBIX_SERVICE_PASSWORD` | По политике Zabbix | Dev использует `Admin/zabbix`; prod через secret storage |
| SEC-007 | IF-006 | ELK API key | `ElkLogging__Elk__ApiKey` | По политике ELK | Пока ELK не подключен |
| SEC-008 | IF-010 | monitoring-ui-api SAML2 IdP signing certificate | `SAML2_IDP_CERT`, `SAML2_IDP_CERT_PATH`, `Idp:IdpX509Certificate*` | По ротации IdP certificates | Обязателен для проверки SAMLResponse |
| SEC-009 | IF-010 | monitoring-ui-api SP private key | `SAML2_SP_PRIVATE_KEY_PATH`, `Idp:SpPrivateKey*` | По ротации SP certificates | Нужен для signed AuthnRequest или encrypted assertions |
| SEC-010 | IF-011 | monitoring-ui-api CMDBuild service account | `CMDBUILD_SERVICE_USERNAME`, `CMDBUILD_SERVICE_PASSWORD` | По политике CMDBuild | Используется в IdP-режиме для server-side API calls |
| SEC-011 | IF-012 | monitoring-ui-api Zabbix service account/token | `ZABBIX_SERVICE_USER`, `ZABBIX_SERVICE_PASSWORD`, `ZABBIX_SERVICE_API_TOKEN` | По политике Zabbix | Используется в IdP-режиме для server-side API calls |
| SEC-012 | IF-015 | monitoring-ui-api Kafka SASL для Events | `MONITORING_UI_KAFKA_USERNAME`, `MONITORING_UI_KAFKA_PASSWORD`, `EventBrowser:*` | По политике Kafka | В текущем dev не используется, Events read-only |
| SEC-013 | IF-014 | monitoring-ui-api runtime settings | `src/monitoring-ui-api/state/ui-settings.json` | По политике окружения | Может содержать dev credentials, не коммитить |

Production/base config не должен хранить реальные секреты. Использовать переменные окружения, secret storage или local config, исключенный из git.
