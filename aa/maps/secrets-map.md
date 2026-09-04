# Карта секретов

| Secret ID | Information flows | Где используется | Конфиг/env | Ротация | Комментарий |
| --- | --- | --- | --- | --- | --- |
| SEC-001 | OAPI0 | CMDBuild -> cmdbwebhooks2kafka | `CmdbWebhook__BearerToken`, `CmdbWebhook:BearerToken` или secret reference | По политике ИБ | Static Bearer token проверяется микросервисом до чтения body и публикации в Kafka |
| SEC-002 | AAPI0, L0 | Kafka SASL для cmdbwebhooks2kafka | `Kafka__Username`, `Kafka__Password` | По политике Kafka | В dev не используется |
| SEC-003 | AAPI0, AAPI1, L0 | Kafka SASL для cmdbkafka2zabbix input/output/logs | `Kafka__Input__*`, `Kafka__Output__*`, `ElkLogging__Kafka__*` | По политике Kafka | В dev не используется |
| SEC-004 | AAPI1, AAPI2, L0, AAPI4 | Kafka SASL для zabbixrequests2api input/output/binding-output/logs | `Kafka__Input__*`, `Kafka__Output__*`, `Kafka__BindingOutput__*`, `ElkLogging__Kafka__*` | По политике Kafka | В dev не используется |
| SEC-005 | OAPI1, OAPI5 | Zabbix API token | `Zabbix__ApiToken`, `ZABBIX_API_TOKEN` | По политике Zabbix | Рекомендуемый prod-режим |
| SEC-006 | OAPI1, OAPI5 | Zabbix login/password | `Zabbix__User`, `Zabbix__Password` или session credentials в `monitoring-ui-api` | По политике Zabbix | UI хранит login/password только в памяти session |
| SEC-007 | L0 | ELK API key | `ElkLogging__Elk__ApiKey` | По политике ELK | Пока ELK не подключен |
| SEC-008 | OAPI3 | monitoring-ui-api SAML2 IdP signing certificate | `SAML2_IDP_CERT`, `SAML2_IDP_CERT_PATH`, `Idp:IdpX509Certificate*` | По ротации IdP certificates | Обязателен для проверки SAMLResponse |
| SEC-009 | OAPI3 | monitoring-ui-api SP private key | `SAML2_SP_PRIVATE_KEY_PATH`, `Idp:SpPrivateKey*` | По ротации SP certificates | Нужен для signed AuthnRequest или encrypted assertions |
| SEC-010 | OAPI4 | monitoring-ui-api CMDBuild session credentials | Диалог UI, только server-side session | По политике CMDBuild | В runtime config не сохраняется |
| SEC-011 | OAPI5 | monitoring-ui-api Zabbix API key/session credentials | `ZABBIX_API_TOKEN` или диалог UI session credentials | По политике Zabbix | Login/password в runtime config не сохраняются |
| SEC-012 | AAPI3 | monitoring-ui-api Kafka SASL для Events | `MONITORING_UI_KAFKA_USERNAME`, `MONITORING_UI_KAFKA_PASSWORD`, `EventBrowser:*` | По политике Kafka | В текущем dev не используется, Events read-only |
| SEC-013 | IF3 | monitoring-ui-api runtime settings | `src/monitoring-ui-api/state/ui-settings.json` | По политике окружения | Может содержать dev credentials, не коммитить |
| SEC-014 | OAPI6 | cmdbkafka2zabbix CMDBuild resolver account | `Cmdbuild__Username`, `Cmdbuild__Password`, `Cmdbuild__BaseUrl` | По политике CMDBuild | Нужен для чтения attributes/cards/relations/lookup values при `source.fields[].cmdbPath` |
| SEC-015 | IF3 | monitoring-ui-api local users | `src/monitoring-ui-api/state/users.json` | При смене пользователя/пароля | Хранит PBKDF2-SHA256 hash/salt, не коммитить |
| SEC-016 | OAPI3 | monitoring-ui-api OAuth2 client secret | `OAUTH2_CLIENT_SECRET`, `Idp:OAuth2:ClientSecret` | По политике IdP | Используется только BFF при authorization code exchange |
| SEC-017 | OAPI3 | monitoring-ui-api LDAP bind password | `LDAP_BIND_PASSWORD`, `Idp:Ldap:BindPassword` | По политике AD/LDAP | Нужен для MS AD login service bind и для чтения AD-групп в IdP режиме; user password хранится только в запросе login и не пишется в state |
| SEC-018 | OAPI7 | cmdbkafka2zabbix rules reload token | `Service__RulesReloadToken`, `Service:RulesReloadToken`, `Services:HealthEndpoints[].RulesReloadToken` в BFF | По политике ИБ | Bearer token для `POST /admin/reload-rules`; не коммитить реальные значения |
| SEC-019 | AAPI4, L0 | Kafka SASL для zabbixbindings2cmdbuild input/logs | `Kafka__Input__*`, `ElkLogging__Kafka__*` | По политике Kafka | В dev не используется |
| SEC-020 | OAPI9 | zabbixbindings2cmdbuild CMDBuild writer account | `Cmdbuild__Username`, `Cmdbuild__Password`, `Cmdbuild__BaseUrl` | По политике CMDBuild | Нужен для записи `zabbix_main_hostid` и карточек `ZabbixHostBinding`; в prod задавать через secret/env |
| SEC-021 | IF3, OAPI6, AAPI4, OAPI9 | Indeed PAM/AAPM bootstrap credentials | `Secrets:IndeedPamAapm:ApplicationToken`, `Secrets:IndeedPamAapm:ApplicationTokenFile`, `Secrets:IndeedPamAapm:ApplicationUsername`, `Secrets:IndeedPamAapm:ApplicationPassword`, aliases `PAMURL`, `PAMUSERNAME`, `PAMPASSWORD`, `PAMTOKEN` | По политике PAM/AAPM | Нужны только для получения сервисных секретов по `secret://id`; хранить в Docker/Kubernetes secret, защищенном mount или env secret, не в git |
| SEC-022 | AAPI0, AAPI1, L0, AAPI3, AAPI4 | Kafka SASL corporate aliases | `SASLUSERNAME`, `SASLPASSWORD`, `SASLPASSWORDSECRET` | По политике Kafka/PAM | Заполняют пустые Kafka SASL поля; `SASLPASSWORDSECRET` преобразуется в `secret://id`, например `AAA.LOCAL\PROD.contractorProfiles` |

Production/base config не должен хранить реальные секреты. Использовать переменные окружения, secret storage, Indeed PAM/AAPM references `secret://id` или local config, исключенный из git.
