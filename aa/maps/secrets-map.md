# Карта секретов

| Secret ID | Где используется | Конфиг/env | Ротация | Комментарий |
| --- | --- | --- | --- | --- |
| SEC-001 | CMDBuild -> cmdbwebhooks2kafka | `CmdbWebhook` token или env | По политике ИБ | Static token сейчас, dynamic mode зарезервирован |
| SEC-002 | Kafka SASL для cmdbwebhooks2kafka | `Kafka__Username`, `Kafka__Password` | По политике Kafka | В dev не используется |
| SEC-003 | Kafka SASL для cmdbkafka2zabbix input/output/logs | `Kafka__Input__*`, `Kafka__Output__*`, `ElkLogging__Kafka__*` | По политике Kafka | В dev не используется |
| SEC-004 | Kafka SASL для zabbixrequests2api input/output/logs | `Kafka__Input__*`, `Kafka__Output__*`, `ElkLogging__Kafka__*` | По политике Kafka | В dev не используется |
| SEC-005 | Zabbix API token | `Zabbix__ApiToken` | По политике Zabbix | Рекомендуемый prod-режим |
| SEC-006 | Zabbix login/password | `Zabbix__User`, `Zabbix__Password` | По политике Zabbix | Dev использует `Admin/zabbix`; prod через secret storage |
| SEC-007 | ELK API key | `ElkLogging__Elk__ApiKey` | По политике ELK | Пока ELK не подключен |
| SEC-008 | monitoring-ui-api SAML2 IdP signing certificate | `SAML2_IDP_CERT`, `SAML2_IDP_CERT_PATH`, `Idp:IdpX509Certificate*` | По ротации IdP certificates | Обязателен для проверки SAMLResponse |
| SEC-009 | monitoring-ui-api SP private key | `SAML2_SP_PRIVATE_KEY_PATH`, `Idp:SpPrivateKey*` | По ротации SP certificates | Нужен для signed AuthnRequest или encrypted assertions |
| SEC-010 | monitoring-ui-api CMDBuild service account | `CMDBUILD_SERVICE_USERNAME`, `CMDBUILD_SERVICE_PASSWORD` | По политике CMDBuild | Используется в IdP-режиме для server-side API calls |
| SEC-011 | monitoring-ui-api Zabbix service account/token | `ZABBIX_SERVICE_USER`, `ZABBIX_SERVICE_PASSWORD`, `ZABBIX_SERVICE_API_TOKEN` | По политике Zabbix | Используется в IdP-режиме для server-side API calls |

Production/base config не должен хранить реальные секреты. Использовать переменные окружения, secret storage или local config, исключенный из git.
