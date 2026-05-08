# Конфигурационные файлы

Все настройки задаются через `appsettings.json`, `appsettings.Development.json` и переменные окружения.

.NET-сервисы используют стандартный синтаксис ASP.NET Core env overrides с разделителем `__`.
`monitoring-ui-api` использует `config/appsettings*.json` и явно поддержанные env overrides, перечисленные в этом документе и в `PROJECT_DOCUMENTATION.md`.

Production/base конфиги не должны содержать реальные секреты. Development конфиги могут содержать локальные dev-значения, если они не используются в продуктивном контуре.
Для сервисных учетных записей поддерживается корпоративный provider `Secrets:Provider=IndeedPamAapm`: в чувствительном строковом поле можно хранить `secret://id`, а фактическое значение будет считано из Indeed PAM/AAPM при старте сервиса и подставлено только в память процесса.

## Общие правила

| Случай | Что менять |
| --- | --- |
| Меняется адрес Kafka | `Kafka:BootstrapServers` или `Kafka:Input/Output:BootstrapServers`, также `ElkLogging:Kafka:BootstrapServers` |
| Включается Kafka SASL | `SecurityProtocol`, `SaslMechanism`, `Username`, `Password` в соответствующей Kafka-секции |
| Меняется имя topic | `Kafka:Topic`, `Kafka:Input:Topic`, `Kafka:Output:Topic`, `ElkLogging:Kafka:Topic` |
| Меняется topic обратной записи binding-ов | `zabbixrequests2api` `Kafka:BindingOutput:Topic` и `zabbixbindings2cmdbuild` `Kafka:Input:Topic` должны совпадать |
| Переход с dev на prod topics | убрать суффикс `.dev`, использовать base config или env override |
| Меняется endpoint Zabbix | `Zabbix:ApiEndpoint` |
| Меняется авторизация Zabbix | для `monitoring-ui-api` - `Zabbix:ApiToken` или session login/password; для `zabbixrequests2api` - `Zabbix:AuthMode` и соответствующий secret |
| Меняется задержка обработки объектов | `Processing:DelayBetweenObjectsMs` |
| Меняется rules-файл | Для converter: `ConversionRules:RepositoryPath`, `ConversionRules:RulesFilePath`; для UI copies: `Rules:RepositoryPath`, `Rules:RulesFilePath` |
| Подключается ELK | `ElkLogging:Mode`, `ElkLogging:Elk:*`, при необходимости отключить Kafka log sink |
| Подключается Indeed PAM/AAPM | `Secrets:Provider=IndeedPamAapm`, `Secrets:IndeedPamAapm:*`, `Secrets:References:{id}:AccountPath/AccountName` или env aliases `PAMURL`/`PAMUSERNAME`/`PAMPASSWORD`; в secret-полях указывать `secret://id` |
| CMDBuild работает в Docker и вызывает локальный webhook | `src/cmdbwebhooks2kafka/Properties/launchSettings.json`, `ASPNETCORE_URLS=http://0.0.0.0:5080` |

## Секреты через Indeed PAM/AAPM

Единый формат поддерживается всеми .NET-микросервисами и `monitoring-ui-api`:

```json
"Secrets": {
  "Provider": "IndeedPamAapm",
  "References": {
    "cmdbuild-writer-password": {
      "AccountPath": "/cmdb2monitoring/cmdbuild",
      "AccountName": "cmdbuild-writer",
      "ValueJsonPath": "password"
    }
  },
  "IndeedPamAapm": {
    "BaseUrl": "https://pam.example.org",
    "PasswordEndpointPath": "/sc_aapm_ui/rest/aapm/password",
    "ApplicationTokenFile": "/run/secrets/indeed-pam-aapm-token",
    "ApplicationUsername": "",
    "ApplicationPassword": "",
    "DefaultAccountPath": "",
    "SendApplicationCredentialsInQuery": false,
    "ResponseType": "json",
    "ValueJsonPath": "password",
    "PasswordExpirationInMinute": "30",
    "PasswordChangeRequired": false,
    "Comment": "cmdb2monitoring {service} {secretId}",
    "TenantId": "",
    "TimeoutMs": 10000
  }
}
```

Использование:

```json
"Cmdbuild": {
  "Username": "cmdbuild-writer",
  "Password": "secret://cmdbuild-writer-password"
}
```

`ApplicationToken`/`ApplicationTokenFile` или `ApplicationUsername`/`ApplicationPassword` является bootstrap-секретом доступа приложения к AAPM и должен передаваться через Docker/Kubernetes secret, защищенный mount или env aliases.
`PasswordEndpointPath` оставлен настраиваемым для совместимости с конкретной публикацией Indeed PAM.
Если AAPM возвращает plain text, `ResponseType` задается не равным `json`; если возвращает JSON, значение читается по `ValueJsonPath`.
Config validation допускает `secret://id` в base config, но продолжает запрещать фактические production-пароли и tokens.

Поддержан корпоративный env-формат:

```bash
PAMURL=https://pam.localhost
PAMUSERNAME=MS_PRO
PAMPASSWORD='*****'
SASLUSERNAME=MS_SUN
SASLPASSWORD=
SASLPASSWORDSECRET=AAA.LOCAL\PROD.contractorProfiles
```

`PAMURL` и `PAMUSERNAME`/`PAMPASSWORD` включают provider `IndeedPamAapm`, если он не задан явно. `SASLPASSWORDSECRET` заполняет пустые Kafka SASL password-поля ссылкой `secret://AAA.LOCAL\PROD.contractorProfiles`; id разбирается по последней точке как `AccountPath=AAA.LOCAL\PROD`, `AccountName=contractorProfiles`. Явно заданные `Kafka__...__Password` и `EventBrowser:Password` не перезаписываются.

## cmdbwebhooks2kafka

Файлы:
- `src/cmdbwebhooks2kafka/appsettings.json`;
- `src/cmdbwebhooks2kafka/appsettings.Development.json`.

Основные секции:

| Параметр | Назначение | Когда менять |
| --- | --- | --- |
| `Service:Name` | Имя сервиса в health/logs | При смене окружения или имени deployment |
| `Service:HealthRoute` | Health endpoint | Если меняется route healthcheck |
| `CmdbWebhook:Route` | Endpoint приема webhook | Если CMDBuild должен вызывать другой путь |
| `CmdbWebhook:AuthorizationMode`, `CmdbWebhook:BearerToken` | Проверка `Authorization: Bearer ...` от CMDBuild | В production задавать token через env/secret storage |
| `CmdbWebhook:EventTypeFields` | Поля поиска event type | Если CMDBuild меняет body webhook |
| `CmdbWebhook:EntityTypeFields` | Поля поиска класса/типа объекта | Если меняется payload |
| `CmdbWebhook:EntityIdFields` | Приоритет выбора id | Если меняется источник идентификатора |
| `Kafka:Topic` | Output topic нормализованных событий | При смене Kafka namespace/окружения |
| `Kafka:SecurityProtocol` | Plaintext/SASL/TLS режим | При включении авторизации Kafka |
| `ElkLogging:*` | Настройки логирования | При подключении ELK или смене log topic |

Dev запуск:
- `launchSettings.json` должен использовать `http://0.0.0.0:5080`;
- CMDBuild-контейнер вызывает webhook по `http://192.168.202.100:5080/webhooks/cmdbuild`;
- `http://localhost:5080` доступен только с dev host и не подходит как URL внутри CMDBuild-контейнера.

Пример env override:

```bash
ASPNETCORE_URLS=http://0.0.0.0:5080
CmdbWebhook__BearerToken=<secret>
Kafka__BootstrapServers=kafka:29092
Kafka__Topic=cmdbuild.webhooks
ElkLogging__Kafka__Topic=cmdbwebhooks2kafka.logs
```

## cmdbkafka2zabbix

Файлы:
- `src/cmdbkafka2zabbix/appsettings.json`;
- `src/cmdbkafka2zabbix/appsettings.Development.json`.

Основные секции:

| Параметр | Назначение | Когда менять |
| --- | --- | --- |
| `Service:RulesReloadRoute` | Management route для перечитывания rules, по умолчанию `/admin/reload-rules` | Если меняется служебный HTTP contract |
| `Service:RulesReloadToken` | Bearer token для rules reload route | Всегда через secret/env в test/prod |
| `Service:RulesStatusRoute` | Read-only management route текущей версии rules, по умолчанию `/admin/rules-status` | Если меняется служебный HTTP contract dashboard |
| `Service:RulesStatusToken` | Bearer token для rules status route; если пустой, используется `RulesReloadToken`, а при пустых обоих токенах status открыт внутри окружения | Через secret/env в test/prod |
| `Kafka:Input:Topic` | Входной topic CMDB events | Должен совпадать с output первого сервиса |
| `Kafka:Input:GroupId` | Consumer group | Менять при отдельном независимом потребителе |
| `Kafka:Output:Topic` | Output topic Zabbix JSON-RPC | Должен совпадать с input третьего сервиса |
| `Kafka:Output:ProfileHeaderName` | Kafka header с именем host profile | Менять только если downstream consumer ожидает другой header |
| `ConversionRules:RepositoryPath` | Git working copy rules | Если rules вынесены в отдельный repo |
| `ConversionRules:ReadFromGit` | Разрешает git-команды для rules working copy | Включать только если rules действительно читаются из локальной git working copy |
| `ConversionRules:RepositoryUrl` | URL git repository, например `https://git.example.org/cmdb2monitoring/conversion-rules.git` | Для фиксации источника rules в настройках/логах; внутри repository ожидается файл по `ConversionRules:RulesFilePath` |
| `ConversionRules:RulesFilePath` | Путь к JSON rules; для dev/test `rules/cmdbuild-to-zabbix-host-create.json` | Если меняется файл правил |
| `ConversionRules:PullOnStartup` | Выполнять `git pull` при старте | Только вместе с `ReadFromGit=true` |
| `ConversionRules:PullOnReload` | Выполнять `git pull --ff-only` по сигналу reload | Только вместе с `ReadFromGit=true`; при другом storage реализуется provider |
| `Cmdbuild:BaseUrl` | CMDBuild REST v3 base URL для lookup/reference/domain resolver | Для каждого окружения, через secret/env в prod |
| `Cmdbuild:Username` / `Cmdbuild:Password` | Учетная запись resolver для чтения attributes/cards/lookups | Через secret/env в prod |
| `Cmdbuild:Enabled` | Включает lookup/reference/domain resolver | Отключать только если rules не используют `cmdbPath` или resolver временно недоступен |
| `Cmdbuild:RequestTimeoutMs` | Timeout REST-запросов resolver | При медленном CMDBuild API |
| `Cmdbuild:MaxPathDepth` | Максимальная глубина `domain`/`reference`/`lookup` traversal в converter, диапазон `2..5`, default `2` | Если в модели нужны более глубокие пути |
| `Cmdbuild:HostBindingLookupEnabled` | Включает чтение `zabbix_main_hostid`/`ZabbixHostBinding` для update/delete перед fallback `host.get` | Отключать только для диагностики или пока audit model не подготовлена |
| `Cmdbuild:MainHostIdAttributeName` | Атрибут основного Zabbix hostid, default `zabbix_main_hostid` | Если audit model использует другое имя |
| `Cmdbuild:BindingClassName` | Служебный класс связей дополнительных профилей, default `ZabbixHostBinding` | Если audit model использует другое имя |
| `Cmdbuild:BindingLookupLimit` | Лимит чтения карточек binding-класса при поиске дополнительного профиля | При большом количестве дополнительных профилей |
| `ProcessingState:FilePath` | State-файл offset/объекта | Для отдельного окружения или volume |
| `ElkLogging:*` | Настройки логирования | При подключении ELK |

Rules-файл `rules/cmdbuild-to-zabbix-host-create.json` управляет:
- event routing create/update/delete;
- regex validation;
- lookup/reference/domain path conversion через `source.fields[].cmdbPath` и `resolve`;
- hostProfiles fan-out: один CMDB object -> один Zabbix host с несколькими interfaces[] или несколько Zabbix hosts;
- `hostProfiles[].createOnUpdateWhenMissing`: для update fallback разрешает создать отсутствующий дополнительный Zabbix host по `fallbackCreateParams`, если `host.get` не нашел host;
- количество IP задается rules: текущий плоский webhook/rules контракт поддерживает named fields, а не произвольный массив IP; для дополнительных IP добавляются новые `source.fields` и `hostProfiles[].interfaces` или отдельные `hostProfiles[]`;
- выбором groups/templates/interfaces/tags;
- расширенными Zabbix host параметрами: proxy, proxy group, interface profile, host status, TLS/PSK, host macros, inventory fields, maintenances, value maps;
- T4 templates для Zabbix JSON-RPC;
- чтение `zabbix_main_hostid`/`ZabbixHostBinding` перед fallback `host.get` для update/delete;
- fallback metadata для update/delete без найденного `hostid`, включая `hostProfile`.

При наличии `inventory` в rules/T4 payload необходимо использовать `inventory_mode=0` или другой разрешенный режим inventory. `inventory_mode=-1` отключает inventory, и Zabbix отклоняет такие запросы.

State-файл хранит последний успешно обработанный input offset. При старте consumer назначает позицию чтения `lastInputOffset + 1` для сохраненного topic/partition.

Сигнал перечитывания rules:
- `POST /admin/reload-rules` принимает только `Authorization: Bearer <Service:RulesReloadToken>`;
- `GET /admin/rules-status` возвращает текущие `schemaVersion`/`rulesVersion` на микросервисе и используется dashboard без принудительного reload;
- endpoint вызывает `IConversionRulesProvider.ReloadAsync`, поэтому смена Git на другое хранилище требует замены provider/config, а не UI/BFF-контракта;
- `monitoring-ui-api` хранит `Services:HealthEndpoints[].RulesReloadUrl`/`RulesReloadToken` и `RulesStatusUrl`/`RulesStatusToken`, вызывает endpoint из dashboard-карточки `cmdbkafka2zabbix`.

Пример prod overrides для lookup/reference/domain resolver:

```bash
Service__RulesReloadToken=<secret>
Cmdbuild__Enabled=true
Cmdbuild__BaseUrl=https://cmdbuild.example/cmdbuild/services/rest/v3
Cmdbuild__Username=<secret>
Cmdbuild__Password=<secret>
Cmdbuild__MaxPathDepth=2
Cmdbuild__HostBindingLookupEnabled=true
Cmdbuild__MainHostIdAttributeName=zabbix_main_hostid
Cmdbuild__BindingClassName=ZabbixHostBinding
```

## zabbixrequests2api

Файлы:
- `src/zabbixrequests2api/appsettings.json`;
- `src/zabbixrequests2api/appsettings.Development.json`.

Основные секции:

| Параметр | Назначение | Когда менять |
| --- | --- | --- |
| `Kafka:Input:Topic` | Входной topic JSON-RPC requests | Должен совпадать с output второго сервиса |
| `Kafka:Output:Topic` | Response topic | При смене схемы топиков |
| `Kafka:BindingOutput:Topic` | Topic событий `CMDBuild card/profile -> Zabbix hostid` | Должен совпадать с input `zabbixbindings2cmdbuild` |
| `Zabbix:ApiEndpoint` | Zabbix JSON-RPC URL | Для каждого окружения |
| `Zabbix:AuthMode` | `None`, `Token`, `Login`, `LoginOrToken` | По способу авторизации Zabbix |
| `Zabbix:ApiToken` | API token | Для token auth, задавать через secret/env |
| `Zabbix:User`/`Password` | Login credentials | Только dev или secret/env |
| `Zabbix:ValidateHostGroups` | Проверка host groups до вызова API | Отключать только для диагностики |
| `Zabbix:ValidateTemplates` | Проверка templates до вызова API | Отключать только для диагностики |
| `Zabbix:ValidateTemplateGroups` | Проверка template groups | Отключать только если Zabbix API ограничен |
| `Processing:DelayBetweenObjectsMs` | Gentle delay между объектами | Увеличивать при нагрузке на Zabbix |
| `Processing:MaxRetryAttempts` | Retry попытки | При нестабильном Zabbix/API |
| `ProcessingState:FilePath` | State-файл | Для отдельного окружения или volume |

Пример prod overrides:

```bash
Zabbix__ApiEndpoint=https://zabbix.example/api_jsonrpc.php
Zabbix__AuthMode=Token
Zabbix__ApiToken=<secret>
Kafka__Input__BootstrapServers=kafka01:9093,kafka02:9093
Kafka__Input__SecurityProtocol=SaslSsl
Kafka__Input__SaslMechanism=ScramSha512
Kafka__Input__Username=<secret>
Kafka__Input__Password=<secret>
```

State-файл `zabbixrequests2api` также используется для восстановления позиции Kafka consumer после рестарта: чтение начинается с `lastInputOffset + 1`.

## zabbixbindings2cmdbuild

Файлы:
- `src/zabbixbindings2cmdbuild/appsettings.json`;
- `src/zabbixbindings2cmdbuild/appsettings.Development.json`.

Основные секции:

| Параметр | Назначение | Когда менять |
| --- | --- | --- |
| `Kafka:Input:Topic` | Входной topic binding events | Должен совпадать с `zabbixrequests2api` `Kafka:BindingOutput:Topic` |
| `Kafka:Input:GroupId` | Consumer group | Менять при отдельном независимом потребителе |
| `Cmdbuild:BaseUrl` | CMDBuild REST v3 base URL | Для каждого окружения |
| `Cmdbuild:Username` / `Cmdbuild:Password` | Service account для записи `zabbix_main_hostid` и `ZabbixHostBinding` | Через secret/env в test/prod |
| `Cmdbuild:MainHostIdAttributeName` | Атрибут hostid основного профиля, default `zabbix_main_hostid` | Если модель CMDBuild использует другое имя |
| `Cmdbuild:BindingClassName` | Класс связей дополнительных профилей, default `ZabbixHostBinding` | Если audit model создан с другим именем |
| `Cmdbuild:BindingLookupLimit` | Лимит поиска существующих binding-карточек | При большом количестве дополнительных профилей |
| `ProcessingState:FilePath` | State-файл offset/binding event | Для отдельного окружения или volume |
| `ElkLogging:*` | Настройки логирования | При подключении ELK |

Пример prod overrides:

```bash
Cmdbuild__BaseUrl=https://cmdbuild.example/cmdbuild/services/rest/v3
Cmdbuild__Username=<secret>
Cmdbuild__Password=<secret>
Kafka__Input__BootstrapServers=kafka01:9093,kafka02:9093
Kafka__Input__Topic=zabbix.host.bindings
```

Base config не содержит пароль; `Development` config может содержать локальные значения стенда.

## monitoring-ui-api

Файлы:
- `src/monitoring-ui-api/config/appsettings.json`;
- `src/monitoring-ui-api/config/appsettings.Development.json`.

Компонент написан на Node.js и совмещает backend-for-frontend API со статическим frontend.
Браузер не должен обращаться напрямую к Kafka, CMDBuild или Zabbix.

Основные секции:

| Параметр | Назначение | Когда менять |
| --- | --- | --- |
| `Service:Host` | IP/interface для bind Node.js сервера | При запуске в контейнере/на сервере |
| `Service:Port` | HTTP port UI/API | При конфликте портов |
| `Service:PublicDir` | Папка статического frontend | При смене сборки UI |
| `UiSettings:FilePath` | Runtime settings JSON, куда UI сохраняет настройки | При смене расположения state-файла |
| `Auth:UseIdp` | Включение внешней авторизации | Для режимов `MS AD` и `IdP` |
| `Auth:UsersFilePath` | Файл локальных пользователей UI с hash/salt паролей | При смене расположения state-файла |
| `Auth:SessionCookieName` | Имя session cookie | При конфликте cookie |
| `Auth:SessionTimeoutMinutes` | Время жизни server-side session | По требованиям ИБ |
| `Auth:MaxSamlPostBytes` | Максимальный размер ACS POST | При больших SAML assertions |
| `Cmdbuild:Catalog:MaxTraversalDepth` | Максимальная глубина раскрытия CMDBuild `domain`/`reference`/`lookup` путей в UI, диапазон `2..5`, default `2` | При необходимости разрешить более глубокие цепочки после logout и CMDBuild catalog resync |
| `Idp:Provider` | `LDAP` для режима `MS AD`, `SAML2` или `OAuth2` для режима `IdP` | При выборе внешнего провайдера входа |
| `Idp:MetadataUrl` | URL IdP metadata XML | Если IdP публикует metadata |
| `Idp:EntityId` | IdP issuer/entityID | Для проверки issuer |
| `Idp:SsoUrl` | IdP SSO endpoint | Если metadata не используется |
| `Idp:SloUrl` | IdP SLO endpoint | При включении logout через IdP |
| `Idp:IdpX509Certificate` / `Idp:IdpX509CertificatePath` | IdP signing certificate | Обязательно для валидации SAMLResponse |
| `Idp:SpEntityId` | SP issuer/entityID | При регистрации SP в IdP |
| `Idp:AcsUrl` | ACS endpoint `/auth/saml2/acs` | При смене внешнего URL UI |
| `Idp:SloCallbackUrl` | SP logout callback | При смене внешнего URL UI |
| `Idp:SpCertificate` / `Idp:SpPrivateKey` | SP cert/key | Если нужно подписывать requests или расшифровывать assertions |
| `Idp:OAuth2:*` | Authorization/token/userinfo URL, client id/secret, redirect URI, scopes и claim names | Для OAuth2/OIDC provider |
| `Idp:Ldap:*` | LDAP/LDAPS host, port, Base DN, bind DN/password, user/group filters и AD attributes | Для режима MS AD и для чтения AD-групп в режиме IdP |
| `Idp:RoleMapping` | Маппинг групп AD/IdP в роли UI | При смене групп доступа |
| `Cmdbuild:BaseUrl` | CMDBuild REST base URL | Для каждого окружения |
| `Cmdbuild:Catalog:*` | Cache и validation настроек CMDBuild catalog | При смене cache policy |
| `Zabbix:ApiEndpoint` | Zabbix JSON-RPC URL | Для каждого окружения |
| `Zabbix:ApiToken` | Optional Zabbix API key для чтения catalog через BFF | Через secret/env в prod, если не хотим спрашивать login/password на сессию |
| `Zabbix:Catalog:*` | Cache и validation настроек Zabbix catalog | При смене cache policy |
| `Rules:ReadFromGit` | Галка `Использовать git как источник данных конвертации` в `Настройка git` UI | Для выбора чтения с диска проекта или локальной git working copy |
| `Rules:RepositoryPath` | Локальный путь к git working copy, например `rules-git-working-copy` | Чтобы UI мог загрузить/записать rules JSON и соседний `*.webhooks.json` без commit/push |
| `Rules:RepositoryUrl` | URL git repository с примером `https://git.example.org/cmdb2monitoring/conversion-rules.git` | Для оператора и согласования с config converter-сервиса; внутри repository ожидается файл по `Rules:RulesFilePath` |
| `Rules:RulesFilePath` | Путь к JSON rules-файлу; для dev/test `rules/cmdbuild-to-zabbix-host-create.json` | Если rules вынесены |
| `Rules:AllowUpload` | Разрешить прием локального rules JSON для validate/dry-run | Для editor/admin UI |
| `EventBrowser:*` | Read-only просмотр Kafka topics на вкладке Events | При смене Kafka, auth или списка topics |
| `Services:HealthEndpoints` | Health endpoints микросервисов, включая `zabbixbindings2cmdbuild`; для `cmdbkafka2zabbix` дополнительно `RulesReloadUrl`, `RulesReloadToken`, `RulesStatusUrl`, `RulesStatusToken` | При добавлении сервисов, reload-действий или read-only статуса правил |

Поддержанные env overrides `monitoring-ui-api`:

| Env | Конфиг |
| --- | --- |
| `PORT` | `Service:Port` |
| `MONITORING_UI_HOST` | `Service:Host` |
| `MONITORING_UI_SETTINGS_FILE` | `UiSettings:FilePath` |
| `MONITORING_UI_USERS_FILE` | `Auth:UsersFilePath` |
| `MONITORING_UI_USE_IDP` | `Auth:UseIdp` |
| `IDP_PROVIDER` | `Idp:Provider` |
| `SAML2_METADATA_URL` | `Idp:MetadataUrl` |
| `SAML2_ENTITY_ID` | `Idp:EntityId` |
| `SAML2_SSO_URL` | `Idp:SsoUrl` |
| `SAML2_SLO_URL` | `Idp:SloUrl` |
| `SAML2_IDP_CERT` | `Idp:IdpX509Certificate` |
| `SAML2_IDP_CERT_PATH` | `Idp:IdpX509CertificatePath` |
| `SAML2_SP_ENTITY_ID` | `Idp:SpEntityId` |
| `SAML2_ACS_URL` | `Idp:AcsUrl` |
| `SAML2_SP_CERT_PATH` | `Idp:SpCertificatePath` |
| `SAML2_SP_PRIVATE_KEY_PATH` | `Idp:SpPrivateKeyPath` |
| `OAUTH2_AUTHORIZATION_URL` | `Idp:OAuth2:AuthorizationUrl` |
| `OAUTH2_TOKEN_URL` | `Idp:OAuth2:TokenUrl` |
| `OAUTH2_USERINFO_URL` | `Idp:OAuth2:UserInfoUrl` |
| `OAUTH2_CLIENT_ID` | `Idp:OAuth2:ClientId` |
| `OAUTH2_CLIENT_SECRET` | `Idp:OAuth2:ClientSecret` |
| `OAUTH2_REDIRECT_URI` | `Idp:OAuth2:RedirectUri` |
| `OAUTH2_SCOPES` | `Idp:OAuth2:Scopes` |
| `OAUTH2_LOGIN_CLAIM` | `Idp:OAuth2:LoginClaim` |
| `OAUTH2_EMAIL_CLAIM` | `Idp:OAuth2:EmailClaim` |
| `OAUTH2_DISPLAY_NAME_CLAIM` | `Idp:OAuth2:DisplayNameClaim` |
| `OAUTH2_GROUPS_CLAIM` | `Idp:OAuth2:GroupsClaim` |
| `LDAP_PROTOCOL` | `Idp:Ldap:Protocol` |
| `LDAP_HOST` | `Idp:Ldap:Host` |
| `LDAP_PORT` | `Idp:Ldap:Port` |
| `LDAP_BASE_DN` | `Idp:Ldap:BaseDn` |
| `LDAP_BIND_DN` | `Idp:Ldap:BindDn` |
| `LDAP_BIND_PASSWORD` | `Idp:Ldap:BindPassword` |
| `LDAP_USER_DN_TEMPLATE` | `Idp:Ldap:UserDnTemplate` |
| `LDAP_USER_SEARCH_BASE` | `Idp:Ldap:UserSearchBase` |
| `LDAP_USER_FILTER` | `Idp:Ldap:UserFilter` |
| `LDAP_GROUP_SEARCH_BASE` | `Idp:Ldap:GroupSearchBase` |
| `LDAP_GROUP_FILTER` | `Idp:Ldap:GroupFilter` |
| `LDAP_GROUP_NAME_ATTRIBUTE` | `Idp:Ldap:GroupNameAttribute` |
| `LDAP_LOGIN_ATTRIBUTE` | `Idp:Ldap:LoginAttribute` |
| `LDAP_EMAIL_ATTRIBUTE` | `Idp:Ldap:EmailAttribute` |
| `LDAP_DISPLAY_NAME_ATTRIBUTE` | `Idp:Ldap:DisplayNameAttribute` |
| `LDAP_GROUPS_ATTRIBUTE` | `Idp:Ldap:GroupsAttribute` |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | `Idp:Ldap:TlsRejectUnauthorized` |
| `CMDBUILD_BASE_URL` | `Cmdbuild:BaseUrl` |
| `ZABBIX_API_ENDPOINT` | `Zabbix:ApiEndpoint` |
| `ZABBIX_API_TOKEN` | `Zabbix:ApiToken` |
| `RULES_READ_FROM_GIT` | `Rules:ReadFromGit` |
| `RULES_REPOSITORY_URL` | `Rules:RepositoryUrl` |
| `RULES_REPOSITORY_PATH` | `Rules:RepositoryPath` |
| `RULES_FILE_PATH` | `Rules:RulesFilePath` |
| `MONITORING_UI_EVENTS_ENABLED` | `EventBrowser:Enabled` |
| `MONITORING_UI_KAFKA_BOOTSTRAP_SERVERS` | `EventBrowser:BootstrapServers` |
| `MONITORING_UI_KAFKA_SECURITY_PROTOCOL` | `EventBrowser:SecurityProtocol` |
| `MONITORING_UI_KAFKA_SASL_MECHANISM` | `EventBrowser:SaslMechanism` |
| `MONITORING_UI_KAFKA_USERNAME` | `EventBrowser:Username` |
| `MONITORING_UI_KAFKA_PASSWORD` | `EventBrowser:Password` |
| `MONITORING_UI_EVENTS_MAX_MESSAGES` | `EventBrowser:MaxMessages` |
| `MONITORING_UI_EVENTS_READ_TIMEOUT_MS` | `EventBrowser:ReadTimeoutMs` |
| `MONITORING_UI_EVENTS_TOPICS` | `EventBrowser:Topics`, список через запятую или точку с запятой |

SAML2 endpoints:
- SP metadata: `GET /auth/saml2/metadata`;
- SP initiated login: `GET /auth/saml2/login`;
- ACS: `POST /auth/saml2/acs`;
- logout: `GET /auth/saml2/logout`.

OAuth2/OIDC endpoints:
- login redirect: `GET /auth/oauth2/login`;
- callback/code exchange: `GET /auth/oauth2/callback`.

Авторизация в UI имеет три режима:
- `Локальная`: `Auth:UseIdp=false`, вход по users-файлу;
- `MS AD`: `Auth:UseIdp=true`, `Idp:Provider=LDAP`, общий endpoint `POST /api/auth/login` проверяет login/password через LDAP bind и назначает роли по AD-группам;
- `IdP`: `Auth:UseIdp=true`, `Idp:Provider=SAML2` или `OAuth2`, IdP выполняет идентификацию, а BFF при настроенном LDAP service bind ищет login в MS AD и назначает роли по AD-группам. Если AD lookup не настроен, используется fallback по group claims из IdP.

Локальные UI-пользователи хранятся в `Auth:UsersFilePath` рядом с `UiSettings:FilePath`; при первом старте создаются `viewer`, `editor`, `admin` с PBKDF2-SHA256 hash/salt паролей. Для deployment начальные UI-пароли меняются после первого входа или через заранее подготовленный/mounted users-файл.
Если выбран режим `MS AD` или `IdP`, блок локальных пользователей в UI неактивен; роли внешних пользователей назначаются по таблице соответствия группам.

CMDBuild/Zabbix login/password не задаются в runtime config. Вход в UI выполняется локальным пользователем, через MS AD или через IdP, но эти credentials не используются для backend-доступа к CMDBuild/Zabbix. CMDBuild login/password запрашиваются только при первой операции с CMDBuild API и хранятся в памяти server-side session. Для Zabbix сначала используется `Zabbix:ApiToken`; если API key не задан, Zabbix login/password запрашиваются на session. Постоянный секрет для Zabbix допускается только как `Zabbix:ApiToken`.

Минимальные права по операциям:
- CMDBuild для UI/catalog sync: read-only REST-доступ к metadata classes/attributes/domains, lookup types/values, relations текущих карточек и cards целевых классов/reference/domain-цепочек.
- CMDBuild для `Настройка webhooks` / `Загрузить из CMDB`: read-доступ к ETL/webhook records через `/etl/webhook/?detailed=true`.
- CMDBuild для `Настройка webhooks` / `Загрузить в CMDB`: create/update/delete или эквивалентные modify-права на ETL/webhook records через `/etl/webhook/`.
- CMDBuild для `zabbixbindings2cmdbuild`: read/update права на карточки участвующих классов для `zabbix_main_hostid` и read/create/update права на класс `ZabbixHostBinding`.
- Ограничение записи managed-префиксом `cmdbwebhooks2kafka-*` выполняется приложением. Для `update`/`delete` BFF дополнительно перечитывает `/etl/webhook/?detailed=true` и применяет операцию к record, найденному по managed `code`, а не по `current.id` из browser payload. Это не заменяет CMDBuild permission model; учетную запись CMDBuild нужно ограничивать на стороне CMDBuild.
- Zabbix для UI/catalog sync: API access и read-only доступ к host groups, template groups, templates, hosts/tags и optional catalogs, читаемым через `*.get`, включая `template.get` subselects для item keys, LLD rules, inventory links, parent templates и template groups.
- Write-права Zabbix нужны не UI catalog sync, а сервису `zabbixrequests2api`, если он создает/обновляет/удаляет hosts.

## Conversion rules conflict handling

В `rules/cmdbuild-to-zabbix-host-create.json` блок `templateConflictRules` применяется после `templateSelectionRules`. Он нужен для случаев, когда несколько правил выбрали шаблоны Zabbix с одинаковыми item keys или конфликтующими inventory field links. В текущем dev-окружении `ICMP Ping` и agent-шаблоны удаляются при выборе `HP iLO by SNMP` или `Generic by SNMP`, чтобы Zabbix API не отклонял host payload из-за дублирующего key `icmpping` или inventory field `Name`.

`monitoring-ui-api` сохраняет Zabbix template metadata в cache вместе с каталогом: item keys, LLD rule keys, inventory links, parent templates, existing host templates и индекс конфликтов templates. Этот индекс используется страницей `Метаданные Zabbix`, редактором rules и Logical Control; runtime-защита в `zabbixrequests2api` остается обязательной.

Для update fallback rules формируют `templates_clear`. `zabbixrequests2api` получает текущие linked templates через `selectParentTemplates` и передает в Zabbix только те `templateid` из `templates_clear`, которые действительно привязаны к host.

Для `host.update` Zabbix writer сначала читает текущий host и объединяет внешние назначения с payload из rules: `groups[]` по `groupid`, `templates[]` по `templateid`, `tags[]` по `tag`, `macros[]` по `macro`, `inventory` по имени поля. Значения rules имеют приоритет над одноименными текущими значениями. `interfaces[]` не объединяются, потому что их состав должен быть однозначно задан rules; writer только добавляет существующие `interfaceid`.

Практический пример: если существующий host уже связан с `Windows by Zabbix agent`, добавление `HP iLO by SNMP` для дополнительного SNMP interface может быть отклонено Zabbix из-за общего inventory field `Name`. В этом случае rules должны оставить целевой SNMP template и передать конфликтующий agent template в `templates_clear`.

Имена CMDBuild classes, attributes и source fields задаются rules, а не кодом. Текущие dev-имена `Server`, `interface/interface2`, `profile/profile2`, `iLo/iLo2/mgmt/mgmt2` являются примером конкретной модели. Для другой модели можно указать любые source keys в `source.fields[].source` и связать их с реальными CMDBuild attributes через `source.fields[].cmdbAttribute` или `source.fields[].cmdbPath`; далее эти fields используются в `hostProfiles[].interfaces[].valueField`, regex/rules и T4.
Для reference/lookup/domain полей CMDBuild Body остается плоским: source key получает numeric id или scalar value, а полный путь хранится в rules как `source.fields[].cmdbPath`, например `Класс.АтрибутReference.АтрибутScalar`, `Класс.АтрибутReference1.АтрибутReference2.АтрибутScalar` или `Класс.{domain:СвязанныйКласс}.АтрибутScalar`.
Для осознанного отказа от мониторинга по атрибутам карточки используется `monitoringSuppressionRules`. Пример: source field `monitoringPolicy` читает `Класс.АтрибутMonitoringPolicy`; если значение равно `do_not_monitor`, `cmdbkafka2zabbix` для `create/update` фиксирует skip reason `monitoring_suppressed:*` и не отправляет Zabbix request. `delete` не подавляется, чтобы возможный ранее созданный host можно было снять с мониторинга.
Смена hostProfile name меняет вычисляемый Zabbix host suffix; ранее созданные дополнительные hosts со старыми suffix не переименовываются автоматически.

Events:
- `EventBrowser:Enabled=true` включает чтение Kafka topics через BFF;
- `EventBrowser:BootstrapServers` в dev равен `localhost:9092`;
- `EventBrowser:SecurityProtocol=Plaintext` для текущей локальной Kafka без авторизации;
- `EventBrowser:Topics` должен содержать используемые сервисами topics, включая request/response/log topics;
- `EventBrowser:MaxMessages` задает количество последних сообщений к выводу, например `5` означает 5 последних;
- `Runtime-настройки` сохраняют runtime overrides в `UiSettings:FilePath`, по умолчанию `src/monitoring-ui-api/state/ui-settings.json`.
- Изменение `Cmdbuild:Catalog:MaxTraversalDepth` через `Runtime-настройки` применяется к редактору правил после logout и пересинхронизации CMDBuild catalog; новый cache получает поле `maxTraversalDepth`.

Rules UI:
- `Управление правилами конвертации` показывает CMDBuild, rules и Zabbix в трех колонках;
- edit mode раскрывает reference attributes до scalar/lookup leaf-полей, не предлагает raw reference id как IP/DNS leaf и сохраняет путь в `cmdbPath`;
- при совпадении имени leaf в нескольких CMDBuild classes UI привязывает вариант к корню `cmdbPath` и создает отдельный source key для нового class, а не переиспользует уже настроенный field другого class;
- edit mode раскрывает CMDBuild domains как `Класс.{domain:СвязанныйКласс}.Атрибут`, но скрывает 1:N domains, уже представленные reference attribute выбранного class, и скрывает потенциально множественные domain fields для скалярных Zabbix structures;
- rules могут содержать `monitoringSuppressionRules` для случаев, когда атрибуты экземпляра запрещают постановку на мониторинг;
- edit mode позволяет добавлять rules в draft JSON, удалять rules по группам, выполнять undo/redo и сохранять draft через `Save file as`;
- `Save file as` дополнительно формирует текстовый файл CMDBuild webhook Body/DELETE-инструкций только по добавленным и удаленным в текущей UI-сессии rules/classes/source fields;
- перед сохранением проверяется IP/DNS binding: каждый мониторинговый класс из `source.entityClasses` или `className` regex должен иметь IP или DNS class attribute field, связанный с `interfaceAddressRules` или `hostProfiles[].interfaces`;
- `Логический контроль правил конвертации` подсвечивает только отсутствующие элементы и позволяет удалить выбранные элементы после подтверждения;
- удаление выбранных элементов формирует исправленный JSON в памяти и сохраняет его через браузер; backend rules-файл и git не изменяются.

Webhook Setup UI:
- раздел `Настройка webhooks` использует те же session-scoped CMDBuild credentials, что и catalog sync;
- `Загрузить из CMDB` читает `/etl/webhook/?detailed=true`;
- `Сохранить файл как` сохраняет только JSON-план через браузер;
- `Загрузить в CMDB` применяет выбранные create/update/delete операции к CMDBuild `/etl/webhook/` и требует у пользователя CMDBuild create/update/delete или эквивалентные modify-права на ETL/webhook records;
- apply ограничен managed-префиксом `cmdbwebhooks2kafka-`; для update/delete BFF сверяет операцию с актуальным CMDBuild record по `code`.

Runtime cache:
- `src/monitoring-ui-api/data/zabbix-catalog-cache.json`;
- `src/monitoring-ui-api/data/cmdbuild-catalog-cache.json`.

Runtime state:
- `src/monitoring-ui-api/state/ui-settings.json`;
- `src/monitoring-ui-api/state/users.json`.

Эти файлы не должны попадать в git.

Пример запуска:

```bash
cd src/monitoring-ui-api
npm start
```

Пример env override:

```bash
PORT=5090
CMDBUILD_BASE_URL=http://cmdbuild:8080/cmdbuild/services/rest/v3
ZABBIX_API_ENDPOINT=http://zabbix/api_jsonrpc.php
RULES_FILE_PATH=rules/cmdbuild-to-zabbix-host-create.json
MONITORING_UI_USE_IDP=true
IDP_PROVIDER=OAuth2
OAUTH2_AUTHORIZATION_URL=https://idp.example/oauth2/authorize
OAUTH2_TOKEN_URL=https://idp.example/oauth2/token
OAUTH2_USERINFO_URL=https://idp.example/oauth2/userinfo
OAUTH2_CLIENT_ID=cmdb2monitoring
OAUTH2_CLIENT_SECRET=<secret>
OAUTH2_REDIRECT_URI=https://cmdb2monitoring.example/auth/oauth2/callback
MONITORING_UI_KAFKA_BOOTSTRAP_SERVERS=kafka:29092
MONITORING_UI_EVENTS_TOPICS=cmdbuild.webhooks,zabbix.host.requests,zabbix.host.responses,zabbix.host.bindings
SAML2_METADATA_URL=https://idp.example/metadata
SAML2_IDP_CERT_PATH=/run/secrets/idp-signing.crt
ZABBIX_API_TOKEN=<secret>
```

## Проверка конфигов

Запуск:

```bash
./scripts/test-configs.sh
```

Скрипт проверяет:
- JSON syntax всех appsettings и rules;
- обязательные секции и параметры;
- связность Kafka topics между микросервисами;
- dev topics с суффиксом `.dev`;
- отсутствие production-секретов в base config;
- наличие обязательных архитектурных артефактов в `aa/`.
