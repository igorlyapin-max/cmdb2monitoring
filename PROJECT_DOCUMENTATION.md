# Документация проекта cmdb2monitoring

Версия документации: `0.8.0`.
Дата актуализации: 2026-05-05.

## Назначение

`cmdb2monitoring` - monorepo интеграции CMDBuild, Kafka и Zabbix.
Основной поток: CMDBuild webhook -> Kafka -> rules/T4 conversion -> Kafka -> Zabbix API -> Kafka response.
После успешного `host.create/update/delete` отдельный поток пишет в CMDBuild обратную связь `CMDBuild card/profile -> Zabbix hostid` для аудита и будущей точной идентификации.

Дополнительный компонент `monitoring-ui-api` предоставляет frontend/BFF для оператора:
- health dashboard микросервисов;
- загрузка, валидация и dry-run rules JSON;
- визуальное управление правилами конвертации и логический контроль правил конвертации с подсветкой связей CMDBuild -> rules -> Zabbix;
- режим `Управление правилами конвертации`: добавление, модификация и удаление rules в draft JSON, undo/redo, save-as без записи на backend;
- безопасное удаление отсутствующих элементов из rules с сохранением исправленного JSON через браузер;
- раздел `Настройка webhooks`: загрузка текущих CMDBuild webhooks, анализ rules, план create/update/delete и применение выбранных операций в CMDBuild для ролей `editor`/`admin`;
- просмотр последних сообщений Kafka topics на вкладке Events;
- синхронизация справочников Zabbix и CMDBuild;
- раздел `Метаданные Zabbix`: templates, item keys, LLD rule keys, inventory bindings и индекс конфликтов templates для редактора и логического контроля;
- подменю `Runtime-настройки` для endpoint/topic параметров;
- подменю `Настройка git` для параметров чтения файла правил с диска или из git working copy;
- подменю `Авторизация` для локального входа, MS AD и IdP;
- выбор русского или английского языка интерфейса на экране входа; меню, Help и базовые подсказки должны использовать выбранный язык;
- local login;
- внешний вход через MS AD (`LDAP/LDAPS`) или IdP provider `SAML2`/`OAuth2/OIDC`; для IdP входа группы ролей могут читаться из MS AD.

## Состав репозитория

| Путь | Назначение |
| --- | --- |
| `src/cmdbwebhooks2kafka` | Прием CMDBuild webhook и публикация normalized event в Kafka |
| `src/cmdbkafka2zabbix` | Чтение CMDB events, применение JSON/T4 rules и `hostProfiles[]`, публикация одного или нескольких Zabbix JSON-RPC requests |
| `src/zabbixrequests2api` | Чтение Zabbix requests, вызов Zabbix API, публикация responses |
| `src/zabbixbindings2cmdbuild` | Чтение Zabbix binding events и запись `zabbix_main_hostid`/`ZabbixHostBinding` в CMDBuild |
| `src/monitoring-ui-api` | Node.js frontend/BFF |
| `rules/cmdbuild-to-zabbix-host-create.json` | Пример правил конвертации настроенных CMDBuild events в Zabbix JSON-RPC |
| `rules/cmdbuild-to-zabbix-host-create.production-empty.json` | Чистый no-op starter правил для production: без demo-классов и без публикации до заполнения правил оператором |
| `rules/cmdbuild-to-zabbix-host-create.dev-empty.json` | Чистый no-op starter правил для dev: база как при инсталляции, но с dev topic и Zabbix API URL |
| `SYSTEM_ADMIN_GUIDE.md` / `SYSTEM_ADMIN_GUIDE.en.md` | Инструкция администратора: runtime, CMDBuild/Zabbix подготовка, webhooks, bindings и операционные риски |
| `RULE_DEVELOPER_GUIDE.md` / `RULE_DEVELOPER_GUIDE.en.md` | Инструкция разработчика правил: host profiles, leaf paths, dynamic targets, suppression, update и webhook checks |
| `DEPLOYMENT_LOCAL_REGISTRY.md` / `DEPLOYMENT_LOCAL_REGISTRY.en.md` | Инструкция сборки Docker images микросервисов/UI и публикации в локальный registry |
| `deploy/dockerfiles/` | Dockerfile для `cmdbwebhooks2kafka`, `cmdbkafka2zabbix`, `zabbixrequests2api`, `zabbixbindings2cmdbuild`, `monitoring-ui-api` |
| `aa/` | Архитектурные артефакты, диаграммы, OpenAPI/AsyncAPI, карты |
| `tests/configvalidation` | Проверки конфигураций и обязательных артефактов |
| `scripts/test-configs.sh` | Быстрый общий валидатор конфигов |
| `scripts/build-local-registry-images.sh` | Сборка и push всех Docker images в локальный registry |

## Dev endpoints

| Компонент | URL |
| --- | --- |
| `cmdbwebhooks2kafka` | `http://localhost:5080`, bind `http://0.0.0.0:5080` |
| `cmdbkafka2zabbix` | `http://localhost:5081` |
| `zabbixrequests2api` | `http://localhost:5082` |
| `zabbixbindings2cmdbuild` | `http://localhost:5083` |
| `monitoring-ui-api` | `http://localhost:5090` |
| CMDBuild | `http://localhost:8090/cmdbuild` |
| Zabbix UI/API | `http://localhost:8081`, `http://localhost:8081/api_jsonrpc.php` |
| Kafka host access | `localhost:9092` |
| Kafka docker network access | `kafka:29092` |

CMDBuild работает в Docker, поэтому webhook URL в CMDBuild должен указывать на адрес host-сервиса, доступный из Docker-сети:

```text
http://192.168.202.100:5080/webhooks/cmdbuild
```

Для локального запуска `cmdbwebhooks2kafka` слушает `0.0.0.0:5080`; если запустить его только на `localhost:5080`, CMDBuild-контейнер не сможет вызвать webhook.

## Совместимость

Подтвержденная матрица dev-окружения на 2026-05-02:

| Компонент | Версия | Примечание |
| --- | --- | --- |
| CMDBuild | `4.1.0` | Образ `itmicus/cmdbuild:4.1.0`, WAR manifest `CMDBuild-Version: 4.1.0`; используется REST API v3 и webhook JSON |
| Zabbix | `7.0.25` | `apiinfo.version=7.0.25`; контейнеры `zabbix-*-pgsql:alpine-7.0-latest` фактически собраны как `7.0.25` |
| Kafka | `3.9.2` | Образ `apache/kafka:3.9.2`, dev KRaft/PLAINTEXT |
| CMDBuild DB | PostgreSQL `17.9`, PostGIS `3.5.x` | Наши сервисы напрямую к этой БД не подключаются |
| Zabbix DB | PostgreSQL `16.13` | Наши сервисы напрямую к этой БД не подключаются |
| Audit storage | PostgreSQL `16/17`, SQLite `3.x` | PostgreSQL - целевое хранилище для средних и крупных инсталляций; SQLite допустим для разработки и небольших инсталляций через тот же контракт хранения |
| .NET | SDK `10.0.203`, target `net10.0` | Используется wrapper `scripts/dotnet` |
| Node.js | `>=22` | Требуется для `monitoring-ui-api` |

Поддерживаемым считается не имя Docker tag, а сохранение контрактов:
- CMDBuild webhook body остается плоским JSON, а catalog/reference/lookup/domain чтение доступно через REST v3;
- Zabbix предоставляет JSON-RPC `/api_jsonrpc.php` с методами и payload structures, которые используют rules/T4;
- Kafka topics созданы внешней инфраструктурой, а broker доступен по настроенному protocol/security.

Ожидаемо совместимые версии: CMDBuild `4.x` с REST v3, Zabbix `7.0.x LTS` и более новые 7.x версии, сохраняющие `template.get` subselects `selectTemplateGroups`, `selectItems`, `selectDiscoveryRules`, Kafka `3.x`. Все остальные major/minor переходы требуют отдельного smoke: health, catalog sync, rules dry-run и create/update/delete цепочка.

## Kafka topics

| Dev topic | Base/prod topic | Producer | Consumer |
| --- | --- | --- | --- |
| `cmdbuild.webhooks.dev` | `cmdbuild.webhooks` | `cmdbwebhooks2kafka` | `cmdbkafka2zabbix` |
| `zabbix.host.requests.dev` | `zabbix.host.requests` | `cmdbkafka2zabbix` | `zabbixrequests2api` |
| `zabbix.host.responses.dev` | `zabbix.host.responses` | `zabbixrequests2api` | будущий status/UI consumer |
| `zabbix.host.bindings.dev` | `zabbix.host.bindings` | `zabbixrequests2api` | `zabbixbindings2cmdbuild` |
| `cmdbwebhooks2kafka.logs.dev` | `cmdbwebhooks2kafka.logs` | `cmdbwebhooks2kafka` | будущий ELK shipper |
| `cmdbkafka2zabbix.logs.dev` | `cmdbkafka2zabbix.logs` | `cmdbkafka2zabbix` | будущий ELK shipper |
| `zabbixrequests2api.logs.dev` | `zabbixrequests2api.logs` | `zabbixrequests2api` | будущий ELK shipper |
| `zabbixbindings2cmdbuild.logs.dev` | `zabbixbindings2cmdbuild.logs` | `zabbixbindings2cmdbuild` | будущий ELK shipper |

Topics создаются внешней инфраструктурой. Код сервисов не создает topics при старте.

## Конфигурация: общие правила

Base config не должен содержать production secrets.
Dev config может содержать локальные значения для стенда.
Production secrets задаются через env, secret storage или local config, исключенный из git.
Дополнительно поддержан provider корпоративного хранилища `IndeedPamAapm`: чувствительное строковое поле может содержать `secret://id` или `aapm://id`, а фактическое значение запрашивается из `Secrets:References`/`Secrets:IndeedPamAapm` при старте сервиса и подставляется только в память процесса. Bootstrap-секрет `Secrets:IndeedPamAapm:ApplicationToken`, `ApplicationTokenFile` или `ApplicationUsername`/`ApplicationPassword` передается deployment-слоем через Docker/Kubernetes secret, защищенный mount или env aliases `PAMURL`/`PAMUSERNAME`/`PAMPASSWORD`. Для Kafka SASL поддержан совместимый формат `SASLUSERNAME`/`SASLPASSWORD`/`SASLPASSWORDSECRET`; `SASLPASSWORDSECRET=AAA.LOCAL\PROD.contractorProfiles` разбирается как `AccountPath=AAA.LOCAL\PROD`, `AccountName=contractorProfiles`.

.NET-сервисы используют env override с `__`, например:

```bash
Kafka__Input__BootstrapServers=kafka01:9093,kafka02:9093
Zabbix__AuthMode=Token
Zabbix__ApiToken=<secret>
```

Node.js `monitoring-ui-api` использует `config/appsettings*.json` и поддержанные env vars, перечисленные ниже.

## cmdbwebhooks2kafka

Файлы:
- `src/cmdbwebhooks2kafka/appsettings.json`;
- `src/cmdbwebhooks2kafka/appsettings.Development.json`.

Что вносить:

| Секция | Что задавать |
| --- | --- |
| `Service` | Имя сервиса и health route |
| `CmdbWebhook:Route` | URL приема webhook, сейчас `/webhooks/cmdbuild` |
| `CmdbWebhook:AuthorizationMode`, `CmdbWebhook:BearerToken` | Проверка входящего `Authorization: Bearer ...`; в production token задавать через env/secret storage, например `CmdbWebhook__BearerToken` |
| `CmdbWebhook:*Fields` | Поля, по которым сервис ищет event type, class и id в webhook body |
| `Kafka` | Bootstrap servers, output topic, client id, auth/security |
| `ElkLogging` | Kafka log sink или будущий ELK endpoint |
| `Secrets` | `None` или `IndeedPamAapm`; mapping `secret://id` на Indeed PAM/AAPM account path/name |

Для локального Docker Kafka внутри сети использовать:

```bash
Kafka__BootstrapServers=kafka:29092
```

Dev launch profile сервиса использует:

```text
http://0.0.0.0:5080
```

Это нужно, чтобы CMDBuild в Docker мог обратиться к webhook через host IP и порт `5080`.

## cmdbkafka2zabbix

Файлы:
- `src/cmdbkafka2zabbix/appsettings.json`;
- `src/cmdbkafka2zabbix/appsettings.Development.json`.

Что вносить:

| Секция | Что задавать |
| --- | --- |
| `Service` | Имя сервиса, health route, rules reload route и Bearer token |
| `Kafka:Input` | Topic `cmdbuild.webhooks.*`, group id, consumer auth/security |
| `Kafka:Output` | Topic `zabbix.host.requests.*`, producer auth/security, `ProfileHeaderName` |
| `ConversionRules` | `ReadFromGit`, repository URL/path, rules file path, git pull behavior, reload behavior, template engine |
| `Cmdbuild` | CMDBuild REST base URL, lookup/reference/domain resolver limits, `HostBindingLookupEnabled`, `MainHostIdAttributeName`, `BindingClassName`, `BindingLookupLimit` |
| `ProcessingState` | State-файл последнего обработанного объекта |
| `ElkLogging` | Kafka log topic или будущий ELK |
| `Secrets` | `None` или `IndeedPamAapm`; mapping `secret://id` на сервисные секреты CMDBuild/Kafka/reload-token |

Rules-файл отвечает за:
- `schemaVersion` совместимости формата и `rulesVersion` визуальной редакции конкретного набора правил;
- `create/update/delete` routing;
- regex validation;
- lookup/reference/domain path conversion: `source.fields[].cmdbPath` хранит путь CMDBuild, а `resolve` задает, нужно ли поднять leaf через REST;
- выбор host profiles, host groups/templates/interfaces/tags;
- динамическое расширение только для `tags` и `hostGroups`: rule с `targetMode=dynamicFromLeaf` читает выбранный CMDBuild leaf через `valueField`; для tags формируется `tags[]`, для host groups формируется `groups[]` с name/createIfMissing до этапа Zabbix writer, а после resolve/create текущий host payload получает те же группы уже как `groupid`;
- выбор proxy, proxy group, профилей Zabbix interfaces[], host status, TLS/PSK, host macros, inventory fields, maintenances и value maps;
- `monitoringSuppressionRules` для случаев, когда по атрибутам CMDBuild-карточки объект не должен ставиться на мониторинг;
- T4 templates для JSON-RPC;
- fallback `host.get -> host.update/delete`, если Zabbix hostid не найден во входном событии или в CMDBuild binding-данных;
- optional update upsert: `host.get -> host.create`, если profile включает `createOnUpdateWhenMissing` и host еще не существует.

Идентификация Zabbix host при `update/delete`:

- приоритет 1: explicit `zabbix_hostid` из webhook payload или `source.fields.zabbixHostId`; для конкретного `hostProfiles[]` также учитывается `hostProfiles[].zabbixHostIdField`;
- приоритет 2: сохраненная обратная связь в CMDBuild. Для основного профиля `cmdbkafka2zabbix` читает исходную карточку и берет `Cmdbuild:MainHostIdAttributeName`, default `zabbix_main_hostid`. Для дополнительного профиля читает `Cmdbuild:BindingClassName`, default `ZabbixHostBinding`, и ищет активную карточку по `OwnerClass + OwnerCardId + HostProfile`;
- приоритет 3: fallback `host.get` по вычисленному technical host name. Имя строится rules-блоком `normalization.hostName` или `hostProfiles[].hostNameTemplate` и должно опираться на стабильную CMDBuild-идентичность: класс, `id`, неизменяемый `code`, имя profile. IP/DNS не должны быть частью идентификатора host, если допускается их изменение;
- после `host.get` сервис `zabbixrequests2api` берет найденный `hostid`, существующие interfaces/templates и собирает фактический `host.update` или `host.delete`;
- при смене IP основного interface host находится по имени, затем новый IP применяется как изменение interface. Для первого interface при отсутствии точного совпадения используется первый существующий `interfaceid`, поэтому смена основного IP обновляет существующий Zabbix host. Для дополнительных interfaces надежность зависит от правил профиля и совпадения type/port/address;
- если чтение CMDBuild binding-данных недоступно или возвращает пустое значение, converter пишет warning/debug и использует fallback `host.get`, если он настроен в route. Значит второй этап не ломает старые правила, но уменьшает зависимость update/delete от имени host там, где `zabbixbindings2cmdbuild` уже успел записать hostid.
- тег `cmdb.id` записывается в Zabbix как полезная metadata, но текущий fallback lookup ищет host не по тегу, а по technical host name. State-файлы сервисов хранят прогресс обработки, а не реестр соответствий `CMDBuild id -> Zabbix hostid`.

Rules reload:
- `POST /admin/reload-rules` в `cmdbkafka2zabbix` перечитывает conversion rules через `IConversionRulesProvider`;
- `GET /admin/rules-status` возвращает текущие `name`, `schemaVersion`, `rulesVersion`, location и git/version текущего provider без reload;
- endpoint не содержит Git-логики: текущий provider делает `git pull --ff-only` только если включены `ConversionRules:ReadFromGit=true` и `ConversionRules:PullOnReload=true`;
- авторизация endpoint выполняется через `Authorization: Bearer <Service:RulesReloadToken>`;
- `monitoring-ui-api` вызывает этот endpoint из dashboard-карточки `cmdbkafka2zabbix` кнопкой `Перечитать правила конвертации` для ролей `editor` и `admin`; рядом с кнопкой показываются две версии: `rulesVersion/schemaVersion` на микросервисе из `GET /admin/rules-status` и `rulesVersion/schemaVersion` текущего rules-файла, который читает система управления;
- при смене места хранения правил нужно заменить/настроить provider, не меняя HTTP-контракт кнопки и BFF.

Публикация rules выполняется вне `monitoring-ui-api`: оператор сохраняет JSON через браузер или через `Настройка git` записывает локальную копию, проверяет diff, кладет файл в выбранный git repository и после публикации нажимает `Перечитать правила конвертации`.
В `Настройка git` UI отображаются `RulesFilePath`, галка `Использовать git как источник данных конвертации`, `RepositoryPath` локальной working copy и `Git repository URL` с примером URL. Для нашей dev/test системы режим по умолчанию - читать с диска, файл `rules/cmdbuild-to-zabbix-host-create.json`. При включении чтения из git внутри repository ожидается файл правил по тому же пути или по пути, явно указанному в `RulesFilePath`; рядом с ним UI может записать согласованный webhook artifact `*.webhooks.json`. Этот artifact строится из текущих rules и CMDBuild catalog/current webhooks, но все token/password/secret/API key/Authorization значения заменяются на `XXXXX`. Эти поля управляют настройками UI/BFF для чтения локального файла правил и проверки `schemaVersion`/`rulesVersion`; приложение не выполняет commit/push. Для converter-сервиса аналогичный переключатель находится в `src/cmdbkafka2zabbix/appsettings*.json` в секции `ConversionRules`; именно эта секция определяет, будет ли микросервис читать локальный файл как есть или перед reload/startup выполнять git pull из уже подготовленной working copy.
`rulesVersion` должен включать дату и время изменения в человекочитаемом виде, например `2026.05.03-2027-serveri-webhook-fix`, чтобы в Панели и git diff было видно не только назначение редакции, но и момент выпуска файла.

В `Runtime-настройки` также есть две независимые галки для редактора правил: `Разрешить динамическое расширение Zabbix Tags из CMDBuild leaf` и `Разрешить динамическое создание Zabbix Host groups из CMDBuild leaf`. При выключенной галке редактор требует выбрать существующий Zabbix target. При включенной галке для соответствующей conversion structure появляется явный target `Создавать/расширять из выбранного CMDBuild leaf`; сохраненный rule содержит `targetMode=dynamicFromLeaf`, `valueField` и `createIfMissing`. Этот режим намеренно не распространяется на templates, interfaces, inventory и macros; macros остаются возможностью развития. Для host groups это означает не только создание/поиск справочника: при первом появлении leaf-значения writer создает отсутствующую group, подставляет полученный `groupid` в тот же `host.create`/`host.update` payload и тем самым сразу привязывает текущий host к этой group. Динамическое расширение нужно включать только после анализа разнообразия leaf-значений: неконтролируемые изменения атрибутов CMDBuild, по которым выполняется mapping, дадут такой же объем динамических изменений в Zabbix.

Раздел `Метаданные Zabbix` доступен ролям `editor` и `admin`. Он строится из Zabbix catalog sync и хранит templates с `itemKeys`, `discoveryRuleKeys`, `inventoryLinks`, linked parent templates, существующие host templates, версию Zabbix и индекс конфликтов templates. Конфликтом считается совпадающий item key, LLD rule key или `inventory_link` у двух и более templates. `Управление правилами конвертации` использует эти данные до сохранения rule и подсвечивает конфликтующий template target красным. `Логический контроль правил конвертации` показывает существующие rules, итоговый template set которых остается несовместимым после применения `templateConflictRules`. Runtime-проверка в `zabbixrequests2api` остается обязательной и блокирует отправку `host.create/update`, если UI/catalog устарел или rules изменили вне интерфейса.

При наличии блока `inventory` в Zabbix payload `inventory_mode` должен быть `0` или другим разрешенным режимом inventory. Значение `-1` отключает inventory и несовместимо с передачей inventory fields.

`ProcessingState` читается при старте. После назначения Kafka partition сервис стартует чтение с `lastInputOffset + 1`, чтобы после рестарта не переобрабатывать уже обработанные сообщения.

Webhook payload остается плоским. Для reference-полей CMDBuild webhook передает только numeric id первого reference attribute, например `АтрибутReference: 12345`; полный путь хранится в rules как `cmdbPath`, например `Класс.АтрибутReference.АтрибутLeaf`. `cmdbkafka2zabbix` по этому пути итеративно читает карточки CMDBuild REST и подставляет leaf-значение перед применением regex/T4. Для lookup leaf применяется тот же механизм, но результатом по умолчанию становится lookup `code`.

Для CMDBuild domains, включая N:N связи без attribute в карточке, используется специальный сегмент `Класс.{domain:СвязанныйКласс}.АтрибутLeaf`: `Класс` - имя класса текущей карточки, `domain` - ключевое слово, `СвязанныйКласс` - класс второго конца связи, `АтрибутLeaf` - leaf attribute связанной карточки. UI catalog sync читает не только `/domains`, но и detailed `/domains/{domain}`, потому что список domains в CMDBuild может не содержать `source`/`destination`, без которых редактор не может предложить N:N domain path. Converter читает `/classes/{class}/cards/{id}/relations`, проверяет принадлежность связи текущему классу и классу второго конца, затем поднимает leaf тем же reference/lookup resolver. Если найдено несколько связанных карточек, по умолчанию значения склеиваются через `resolve.collectionSeparator` (`; `); для скалярного Zabbix target в UI такие fields не предлагаются, кроме явно настроенного `resolve.collectionMode=first`.
Если domain path не смог поднять leaf, converter не должен использовать id текущей карточки как значение leaf: такое поле считается отсутствующим, чтобы dynamic host group/tag не создавались из технического id. Relations не кэшируются между событиями, потому что связи могут появиться или измениться уже после `card_create_after`, а последующий `card_update_after` должен читать актуальный набор связей.
Runtime cache карточек CMDBuild и lookup-значений действует только внутри одного события resolver. Поэтому при модификации исходной карточки и поступлении `card_update_after` converter заново читает leaf-значения по lookup, reference и domain путям. Это позволяет обновить Zabbix по изменившимся связанным значениям, если событие update пришло именно по исходной карточке. Одна только модификация связанной карточки или domain-связи без webhook/event исходной карточки не запускает пересчет мониторинга.

Максимальная глубина итеративного раскрытия `domain`/`reference`/`lookup` путей задается в `Runtime-настройки` как `Максимальная глубина рекурсии domains&reference&lookups`, диапазон `2..5`, значение по умолчанию `2`. Изменение параметра применяется к UI после logout и пересинхронизации CMDBuild catalog; новый sync записывает глубину в catalog cache, а новые `cmdbPath` fields получают соответствующий `resolve.maxDepth`.

Состояние `do_not_monitor` у связанной leaf-карточки через domain не равно решению "не ставить на мониторинг" весь исходный объект. Это отдельный сценарий выбора endpoint. Например, исходный объект `Класс` имеет собственный разрешенный адрес `АтрибутPrimaryIp`, а через domain связан объект `СвязанныйКласс` с leaf-полями `АтрибутАдреса` и `АтрибутСостоянияАдреса`. Если путь `Класс.{domain:СвязанныйКласс}.АтрибутСостоянияАдреса` возвращает `do_not_monitor`, rules не должны использовать `Класс.{domain:СвязанныйКласс}.АтрибутАдреса` как Zabbix interface или отдельный hostProfile. При этом исходная карточка продолжает обрабатываться по другим разрешенным адресам, и Zabbix host может быть создан или обновлен. Такой leaf-флаг означает "не использовать связанный адрес/endpoint", а не "остановить мониторинг объекта".

В demo E2E это проверяет карточка `C2M-DEMO-011-DOMAIN-LEAF-DONT-MONITOR`: основной КЕ разрешен к мониторингу и имеет основной IP, связанный через domain address имеет `AddressState=do_not_monitor`, поэтому host присутствует в Zabbix, но interface с leaf IP связанного address отсутствует.

Если атрибуты самой исходной карточки означают, что экземпляр нужно "не ставить на мониторинг", это задается отдельным блоком `monitoringSuppressionRules`. Например, source field `monitoringPolicy` может читать lookup `Класс.АтрибутMonitoringPolicy`; при значении `do_not_monitor` converter для `create/update` возвращает skip reason `monitoring_suppressed:*` и не публикует сообщение в Zabbix request topic. `delete` такими правилами не подавляется: событие удаления может означать требование "остановить мониторинг объекта", поэтому ранее созданный host должен иметь возможность пройти cleanup/fallback обработку.

## zabbixrequests2api

Файлы:
- `src/zabbixrequests2api/appsettings.json`;
- `src/zabbixrequests2api/appsettings.Development.json`.

Что вносить:

| Секция | Что задавать |
| --- | --- |
| `Kafka:Input` | Topic `zabbix.host.requests.*`, group id, consumer auth/security |
| `Kafka:Output` | Topic `zabbix.host.responses.*`, producer auth/security |
| `Kafka:BindingOutput` | Topic `zabbix.host.bindings.*`, producer auth/security, headers `binding-event-type`, `binding-host-profile`, `binding-status` |
| `Zabbix:ApiEndpoint` | URL Zabbix JSON-RPC API |
| `Zabbix:AuthMode` | `Token`, `Login`, `LoginOrToken` или `None` |
| `Zabbix:ApiToken` | Token для production, через secret/env |
| `Zabbix:User` / `Zabbix:Password` | Login credentials, только dev или secret/env |
| `Zabbix:Validate*` | Проверки host groups/templates/template groups до API call |
| `Zabbix:AllowDynamicHostGroupCreate` | Разрешение Zabbix writer создавать отсутствующие host groups, пришедшие из dynamic `targetMode=dynamicFromLeaf` rules; в поставляемых конфигах включено |
| `Processing` | Gentle delay, retries и retry delay |
| `ProcessingState` | State-файл последнего обработанного объекта |
| `Secrets` | `None` или `IndeedPamAapm`; mapping `secret://id` на Zabbix/Kafka/ELK секреты |

`Processing:DelayBetweenObjectsMs` по умолчанию 2000, чтобы не отправлять объекты в Zabbix слишком резко.

`ProcessingState` работает по тому же правилу, что и во втором сервисе: state-файл хранит последний успешно обработанный input offset, а consumer при старте начинает с `lastInputOffset + 1`.

`zabbixrequests2api` валидирует не только базовые `host.create/update/delete`, но и расширенные host поля, используемые rules: `status`, `macros`, `inventory`, TLS/PSK параметры. Также зарезервирована обработка Zabbix API methods для следующих задач: `maintenance.*`, `usermacro.*`, `proxy.*`, `valuemap.*`.

Для dynamic host groups writer перед `host.create/host.update` ищет group по имени через `hostgroup.get`. Если group уже существует, в payload подставляется `groupid`. Если group отсутствует и `Zabbix:AllowDynamicHostGroupCreate=true`, writer вызывает `hostgroup.create`, затем подставляет новый `groupid` в тот же запрос, поэтому host сразу попадает в newly created group. Если group отсутствует, но создание выключено, запрос не отправляется в Zabbix и возвращается явная ошибка `auto_expand_disabled`. Для tags отдельного Zabbix-справочника нет: dynamic tag сразу попадает в `params.tags[]` текущего host payload.

После успешного и реально отправленного в Zabbix `host.create`, `host.update` или `host.delete` сервис публикует binding event в `Kafka:BindingOutput`. Событие содержит `sourceClass`, `sourceCardId`, `sourceCode`, `hostProfile`, `isMainProfile`, `zabbixHostId`, `zabbixHostName`, `bindingStatus`, `rulesVersion`, `schemaVersion` и input offset. Если не хватает source class/card id или `hostid`, событие не публикуется и пишется warning. Ошибка публикации binding event не откатывает уже выполненную запись в Zabbix и не блокирует response/commit основного offset, чтобы не создавать повторный `host.create/update/delete`.

## zabbixbindings2cmdbuild

Файлы:
- `src/zabbixbindings2cmdbuild/appsettings.json`;
- `src/zabbixbindings2cmdbuild/appsettings.Development.json`.

Что вносить:

| Секция | Что задавать |
| --- | --- |
| `Kafka:Input` | Topic `zabbix.host.bindings.*`, group id, consumer auth/security |
| `Cmdbuild:BaseUrl` | CMDBuild REST v3 base URL |
| `Cmdbuild:Username` / `Cmdbuild:Password` | Service account для записи audit binding-ов, через secret/env в test/prod |
| `Cmdbuild:MainHostIdAttributeName` | Атрибут основного hostid, default `zabbix_main_hostid` |
| `Cmdbuild:BindingClassName` | Служебный класс дополнительных профилей, default `ZabbixHostBinding` |
| `Cmdbuild:BindingLookupLimit` | Лимит поиска существующих binding-карточек |
| `ProcessingState` | State-файл последнего обработанного binding event |
| `ElkLogging` | Kafka log topic или будущий ELK |
| `Secrets` | `None` или `IndeedPamAapm`; mapping `secret://id` на CMDBuild/Kafka/ELK секреты |

Сервис читает `zabbix.host.bindings.*` и применяет обратную запись:
- для `isMainProfile=true` выполняет `PUT /classes/{sourceClass}/cards/{sourceCardId}` и записывает `zabbix_main_hostid=<hostid>`; при `host.delete` значение очищается;
- для дополнительных `hostProfiles` ищет карточку класса `ZabbixHostBinding` по `OwnerClass + OwnerCardId + HostProfile` и создает или обновляет ее полями `OwnerClass`, `OwnerCardId`, `OwnerCode`, `HostProfile`, `ZabbixHostId`, `ZabbixHostName`, `BindingStatus`, `RulesVersion`, `LastSyncAt`;
- invalid JSON считается poison message: пишется warning, state/offset фиксируются, сообщение пропускается;
- ошибка записи в CMDBuild не коммитит Kafka offset, поэтому событие будет повторено после восстановления сервиса/CMDBuild.

Начиная со второго этапа эти данные используются `cmdbkafka2zabbix` как приоритетный источник `hostid` перед fallback `host.get`: основной профиль читает `zabbix_main_hostid`, дополнительные профили читают `ZabbixHostBinding`.

## monitoring-ui-api

Файлы:
- `src/monitoring-ui-api/config/appsettings.json`;
- `src/monitoring-ui-api/config/appsettings.Development.json`;
- `src/monitoring-ui-api/package.json`;
- `src/monitoring-ui-api/package-lock.json`.

Что вносить:

| Секция | Что задавать |
| --- | --- |
| `Service` | Host, port, health route, public frontend dir |
| `UiSettings` | Путь к runtime settings JSON, который сохраняет UI |
| `Auth` | Режим внешней авторизации, users file, session cookie, session timeout, SAML POST limit |
| `Idp` | Настройки SAML2/OAuth2 IdP, LDAP/LDAPS/MS AD и маппинг групп в роли |
| `Cmdbuild` | CMDBuild REST base URL и catalog cache |
| `Zabbix` | Zabbix API endpoint, optional API key и catalog cache |
| `Rules` | Rules path, local JSON validate/dry-run policy |
| `AuditStorage` | Provider `postgresql`/`sqlite`, connection string, schema, auto-migrate и timeout для будущего раздела аудита |
| `EventBrowser` | Kafka read-only browser для вкладки Events: bootstrap, auth, topics, limits |
| `Services:HealthEndpoints` | Health endpoints микросервисов для dashboard; optional rules reload URL/token для converter |
| `Secrets` | `None` или `IndeedPamAapm`; mapping `secret://id` на Zabbix API token, Kafka Event Browser password, LDAP/OAuth2/Audit DB секреты и rules reload tokens |

SAML2 endpoints:
- `GET /auth/saml2/metadata` - SP metadata для регистрации в IdP;
- `GET /auth/saml2/login` - SP-initiated login;
- `POST /auth/saml2/acs` - ACS endpoint для SAMLResponse;
- `GET /auth/saml2/logout` - local logout и optional SLO.

OAuth2/OIDC endpoints:
- `GET /auth/oauth2/login` - Authorization Code redirect;
- `GET /auth/oauth2/callback` - code exchange, userinfo/JWT claims и создание session.

Режимы авторизации UI:
- `Локальная`: `Auth:UseIdp=false` / `Idp:Enabled=false`, вход выполняется по users-файлу;
- `MS AD`: `Auth:UseIdp=true`, `Idp:Provider=LDAP`, login/password проверяются через LDAP/LDAPS bind;
- `IdP`: `Auth:UseIdp=true`, `Idp:Provider=SAML2` или `OAuth2`; IdP отвечает за идентификацию, а группы для ролей читаются из MS AD, если задан LDAP service bind.

IdP/MS AD настройки:
- для SAML2 задать `Idp:MetadataUrl` или вручную `Idp:EntityId`, `Idp:SsoUrl`, `Idp:SloUrl`; `Idp:IdpX509Certificate` или `Idp:IdpX509CertificatePath` обязателен для проверки подписи;
- для OAuth2/OIDC задать authorization/token/userinfo URL, client id/secret, redirect URI и claim names для login/email/displayName/groups;
- для LDAP/LDAPS/MS AD задать protocol, host/port, Base DN, bind DN/password или user DN template, user/group filters и атрибуты login/email/displayName/groups; в режиме IdP service bind нужен для чтения AD-групп по login;
- задать `Idp:RoleMapping`, чтобы группы AD/IdP превращались в роли `admin`, `editor`, `viewer`; если совпадений нет, применяется `viewer`;
- для Zabbix можно задать `Zabbix:ApiToken`; CMDBuild/Zabbix login/password в runtime config не задаются и при необходимости запрашиваются на сессию.
- если `Zabbix:ApiToken`, `EventBrowser:Password`, LDAP/OAuth2 секреты или Audit DB connection string заданы как `secret://id`, UI/BFF резолвит их через Indeed PAM/AAPM и в интерфейсе показывает ссылку, а не фактическое значение.

Local users and roles:
- при первом старте `monitoring-ui-api` создает `src/monitoring-ui-api/state/users.json` рядом с `ui-settings.json`;
- стартовые пользователи: `viewer/viewer`, `editor/editor`, `admin/admin`;
- пароли хранятся только как PBKDF2-SHA256 hash/salt, plaintext в state-файл не пишется;
- роли: `viewer` видит только `Панель` и `События`; `editor` видит все кроме `Авторизация`, `Runtime-настройки` и `Настройка git`; `admin` видит все;
- пользователь может сменить свой пароль в UI, а администратор может сбросить пароль в подменю `Авторизация`.
- если выбран режим `MS AD` или `IdP`, блок локальных пользователей в UI становится неактивным; локальный users-файл остается аварийным/служебным механизмом и не участвует в назначении ролей внешним пользователям.
- для deployment начальные UI-пароли меняются после первого входа или через заранее подготовленный/mounted `state/users.json`; CMDBuild/Zabbix default passwords не задаются.

Runtime settings:
- подменю `Runtime-настройки` читает текущие значения из merged config и runtime-файла;
- `Save runtime` пишет overrides в `src/monitoring-ui-api/state/ui-settings.json`;
- настройки UI разделены на три admin-подменю: `Авторизация`, `Runtime-настройки` и `Настройка git`;
- `AuditStorage` в Runtime-настройках задает СУБД аудита: `postgresql` для средних и крупных продуктивных инсталляций и `sqlite` для разработки или небольших инсталляций. Ориентир для SQLite: до 1000 объектов на мониторинге, допустимо до 2000 объектов при умеренном потоке событий и коротком сроке хранения аудита; при большем объеме, высокой параллельности пользователей или длительном хранении аудита следует использовать PostgreSQL. Поля: provider, connection string, schema для PostgreSQL, `AutoMigrate`, `CommandTimeoutSeconds`. Код аудита должен работать через общий слой хранения и проверяться на обеих СУБД, без SQL, привязанного только к SQLite или только к PostgreSQL;
- `Настройка git` пишет только настройки `rules` в `src/monitoring-ui-api/state/ui-settings.json`, показывает resolved path, `schemaVersion`, `rulesVersion` текущего файла и при включенном git-режиме может записать rules JSON плюс соседний `*.webhooks.json` в локальную working copy без commit/push;
- runtime-файл и файл пользователей не коммитятся и могут содержать dev secrets;
- dev config не заполняет CMDBuild/Zabbix пароли по умолчанию;
- текущий dev `EventBrowser` смотрит Kafka `localhost:9092` и topics `*.dev`.

Audit model:
- раздел `Аудит` готовит CMDBuild model для обратной связи с Zabbix. Проверка строит план без изменений, а применение от имени администратора создает недостающие элементы в управляемой CMDBuild;
- в карточку каждого класса, участвующего в conversion rules, добавляется атрибут `zabbix_main_hostid`. Он хранит `hostid` основного Zabbix host для конкретной карточки CMDBuild и нужен для прямой диагностики, какая карточка уже поставлена на мониторинг. Этот атрибут относится только к основному host profile и не описывает дополнительные профили;
- для расширенной логики создается служебный класс `ZabbixHostBinding`. Одна карточка этого класса описывает связь `CMDBuild class + card id + hostProfile -> Zabbix host`. Это нужно, когда одна карточка CMDBuild порождает несколько Zabbix hosts через дополнительные `hostProfiles`;
- администратор в дереве CMDBuild выбирает, где создать класс `ZabbixHostBinding`. Базовый набор атрибутов класса: `OwnerClass`, `OwnerCardId`, `OwnerCode`, `HostProfile`, `ZabbixHostId`, `ZabbixHostName`, `BindingStatus`, `RulesVersion`, `LastSyncAt`;
- назначение атрибутов `ZabbixHostBinding`: `OwnerClass`/`OwnerCardId`/`OwnerCode` указывают исходную карточку, `HostProfile` указывает профиль из rules, `ZabbixHostId`/`ZabbixHostName` указывают объект Zabbix, `BindingStatus` хранит состояние связи, `RulesVersion` фиксирует версию правил, `LastSyncAt` фиксирует время последней успешной синхронизации.
- `zabbixbindings2cmdbuild` заполняет эти элементы автоматически после успешной записи в Zabbix: основной профиль пишет `zabbix_main_hostid` в исходную карточку, дополнительные профили пишут отдельные карточки `ZabbixHostBinding`.
- быстрый аудит в разделе `Аудит` выполняет read-only сверку выбранных классов CMDBuild с Zabbix: по текущим conversion rules вычисляет ожидаемые host/profile, binding (`zabbix_main_hostid` или `ZabbixHostBinding`), interface address, host groups, templates, maintenance и status, затем сравнивает их с `host.get` и bulk `maintenance.get`. Он не выполняет автоисправления и предназначен для первого обнаружения расхождений перед полным аудитом. Карточки CMDBuild читаются пакетами через `limit/offset`: `Запустить быстрый аудит` читает текущий offset, `Следующий пакет` увеличивает offset на текущий лимит карточек на класс;

CMDBuild/Zabbix credentials:
- Zabbix catalog sync использует `Zabbix:ApiToken`, если он заполнен;
- если Zabbix API key не заполнен, UI запрашивает Zabbix login/password при первой операции и хранит их только в server-side session;
- CMDBuild всегда запрашивает login/password при первой backend-операции и хранит их только в server-side session;
- внешняя авторизация UI (`Локальная`, `MS AD`, `IdP/SAML2/OAuth2`) не используется как credential для backend-доступа к CMDBuild или Zabbix: технически эти системы не принимают данные авторизации UI/AD/IdP как API credentials в нашем окружении;
- runtime-флаги `Cmdbuild:UseIdp` и `Zabbix:UseIdp` не используются и не отображаются в UI.
- при развертывании продукта CMDBuild/Zabbix пароли по умолчанию не задаются: постоянный секрет допустим только как Zabbix API key, а login/password вводятся пользователем в момент операции и не пишутся в runtime state.

Минимальные права по операциям:
- CMDBuild user для UI/catalog sync должен иметь доступ к REST API и read-only права на metadata classes/attributes/domains, lookup types/values и карточки целевых классов, включая классы, до которых ведут reference-атрибуты и domain-связи; для domain path также нужен read-only доступ к relations текущей карточки. Create/update/delete на карточках CMDBuild для catalog sync не нужны.
- CMDBuild user для `Настройка webhooks` должен иметь read-доступ к ETL/webhook records через REST v3 `/etl/webhook/?detailed=true` для `Загрузить из CMDB` и анализа текущего состояния.
- CMDBuild user, который нажимает `Загрузить в CMDB`, дополнительно должен иметь create/update/delete или эквивалентные modify-права на ETL/webhook records REST v3 `/etl/webhook/`. Эти права нужны только оператору, который реально применяет webhook-план в CMDBuild; они не нужны viewer и не нужны для обычного catalog sync.
- CMDBuild user для быстрого аудита должен иметь read-only доступ к metadata classes/attributes, карточкам выбранных классов и классу `ZabbixHostBinding`; Zabbix user/API token должен иметь read-only `host.get` с groups, parent templates и interfaces, а также `maintenance.get` для проверки membership по ожидаемым maintenance.
- CMDBuild user, который нажимает `Применить подготовку CMDBuild` в разделе `Аудит`, должен иметь права администратора модели CMDBuild на создание класса и атрибутов: `POST /classes?scope=service` и `POST /classes/{class}/attributes`. Эти права не нужны для обычной проверки плана аудита.
- CMDBuild service account для `cmdbkafka2zabbix` должен иметь read-only права на исходные карточки и `ZabbixHostBinding`, если включено `Cmdbuild:HostBindingLookupEnabled`; эти права дополняют уже нужные права resolver-а на attributes/cards/relations/lookups при `cmdbPath`.
- CMDBuild service account для `zabbixbindings2cmdbuild` должен иметь read/update права на карточки классов, участвующих в conversion rules, чтобы записывать/очищать `zabbix_main_hostid`; а также read/create/update права на служебный класс `ZabbixHostBinding`. Если используются дополнительные профили, сервису нужен read list cards на этот класс для поиска существующей связи.
- Backend ограничивает запись managed-префиксом `cmdbwebhooks2kafka-*`, а для `Изменить`/`Удалить` перед применением заново читает `/etl/webhook/?detailed=true` и выбирает CMDBuild record по managed `code`; `current.id` из browser payload не используется как источник истины. Это защитное ограничение приложения, а не замена правам CMDBuild. CMDBuild service account все равно должен быть ограничен на уровне CMDBuild настолько узко, насколько позволяет модель прав.
- Zabbix user/API token для UI/catalog sync должен иметь API access и read-only доступ к используемым host groups, template groups, templates, hosts/tags и справочникам, которые UI читает через `*.get` методы (`hostgroup.get`, `templategroup.get`, `template.get` с subselects item keys/LLD/inventory/template groups, `host.get`, optional `proxy*.get`, `globalmacro.get`, `usermacro.get`, `maintenance.get`, `valuemap.get`); host create/update/delete для чтения каталогов не нужны.
- Отдельный сервис `zabbixrequests2api`, который реально применяет мониторинг, требует уже write-права на host create/update/delete и чтение связанных groups/templates. Так как `Zabbix:AllowDynamicHostGroupCreate` в поставляемых конфигах включен, этому API user также нужно право на `hostgroup.create`.

Events:
- вкладка Events читает Kafka topics только через BFF;
- браузер не имеет прямого доступа к Kafka;
- список topics берется из `EventBrowser:Topics` и может быть изменен через `Runtime-настройки`;
- для SASL/TLS заполняются `EventBrowser:SecurityProtocol`, `SaslMechanism`, `Username`, `Password`.
- вывод по умолчанию показывает последние сообщения выбранного topic, сортировка выполняется от более новых сообщений к более старым;
- раскрытие topic показывает timestamp, сводку service/partition/offset/key и value.

Управление правилами конвертации:
- левая колонка показывает CMDBuild classes/attributes/lookups;
- reference attributes раскрываются итеративно до читаемых leaf-полей; сам raw reference id не предлагается как IP/DNS leaf, а выбранное leaf-поле сохраняет `source.fields[].cmdbPath`;
- если разные CMDBuild classes имеют leaf с одинаковым именем, редактор сравнивает корень `cmdbPath` с выбранным class и для нового class генерирует отдельный `source.fields` key, чтобы `Application.hostname` не переиспользовал уже настроенный `serveri.hostname`; в выпадающих списках такие fields показываются как читаемый путь `mgmt -> ipAddr / routeCore`, а внутренний key вроде `routeCoreMgmtIpAddr` остается только в JSON/tooltip;
- domains раскрываются как `Класс.{domain:СвязанныйКласс}.Атрибут`; 1:N domains, которые CMDBuild уже показывает как reference attribute текущего class, в списке leaf-полей скрываются, чтобы не дублировать те же attributes через reference и domain; настоящие N:N relations остаются доступными;
- центральная колонка показывает conversion fields, regex, selection rules и T4 blocks;
- Host profiles в центральной колонке показывают fan-out и конкретные связи `профиль Zabbix interfaces[]`/`valueField`;
- редактор правил добавления/модификации показывает виртуальные поля `hostProfile` и `outputProfile`: converter заполняет их для каждого `hostProfiles[]`, поэтому по ним можно ограничить template/group/tag rule конкретным fan-out profile;
- правая колонка показывает Zabbix catalog entities;
- повторное нажатие на элемент снимает выделение;
- для lookup выделяется только конкретная связка class + lookup + value;
- блоки списков скрываются, если не участвуют в выделении, и могут быть раскрыты пользователем.
- Zabbix catalog sections закрыты по умолчанию и лениво загружаются по `+` или при попадании в выделенную цепочку;
- edit mode скрывает нижний трехколоночный просмотр и имеет действия `Добавление правила`, `Модификация правила` и `Удаление правила`;
- выпадающий список CMDBuild classes показывает hierarchy с отступами; superclass/prototype классы недоступны для выбора, а уже выбранный superclass заменяется ближайшим конкретным subclass;
- добавление правила выбирает CMDBuild class, class attribute field, conversion structure, Zabbix object/payload, priority и regex;
- модификация правила начинается без автоматически выбранного rule; оператор может начать с rule, CMDBuild class, class attribute field или conversion structure, связанные списки фильтруются, а если найден единственный matching rule, он выбирается автоматически и загружается в ту же форму;
- при изменении class зависимый leaf field и Zabbix target очищаются до нового однозначного выбора; при изменении field фильтруются совместимые conversion structures, при изменении conversion structure фильтруются fields и Zabbix targets, а несовместимые значения подсвечиваются красной рамкой;
- для `interfaceAddress` редактор проверяет семантику target: IP-looking CMDBuild attribute нельзя сохранить в DNS target `interfaces[].dns/useip=0`, DNS/FQDN-looking attribute нельзя сохранить в IP target `interfaces[].ip/useip=1`, а неподтвержденное адресное поле нужно явно описать именем/source metadata или `validationRegex`; для `cmdbPath` адресность определяется по финальному leaf, а не по имени reference-ветки;
- для `Правило tag` и `Правило host group` редактор может сохранять dynamic target из CMDBuild leaf только если соответствующая runtime-галка включена; в UI это отдельный вариант target, а не пустое поле. Для templates, interfaces, inventory и macros пустой target остается ошибкой;
- для `Правило template` редактор использует `Метаданные Zabbix` и блокирует сохранение, если выбранный template вместе с defaults/выбранными templates после применения `templateConflictRules` оставляет duplicate item key, duplicate LLD rule key или duplicate inventory link;
- кнопка `Сбросить поля` в модификации очищает выбранное rule и все фильтры, возвращая форму к пустому старту, а в добавлении очищает leaf field и target; зеленая рамка означает совместимость, красная - обязательный выбор или конфликт, желтая - значение из rule не подтверждено текущим catalog/filter, но доступно для осознанного редактирования;
- `Current rule target / отсутствует в Zabbix catalog` считается неконсистентной второй стороной цепочки, подсвечивается красным и блокирует сохранение так же, как отсутствующий class/attribute на стороне CMDBuild;
- удаление правила показывает tree-группировки `Дерево CMDBuild`, `Дерево Zabbix` и `Дерево rules`; группы закрыты через `+`, а checkbox на группе отмечает все rules внутри;
- `Дерево CMDBuild` позволяет удалить все rules для конкретного CMDBuild class или class attribute field;
- `Дерево Zabbix` позволяет удалить все rules для конкретного Zabbix payload field, Zabbix object group, отдельного host group/template/tag/расширенного Zabbix object или целой conversion structure;
- удаление меняет только выбранные rules в draft JSON и оставляет classes/source fields без автоматической чистки, чтобы не удалить источник, который может использоваться другими правилами;
- undo/redo работают только с draft текущей browser-сессии;
- `Save file as` сохраняет draft JSON и второй текстовый файл с CMDBuild webhook Body/DELETE-инструкциями только по добавленным и удаленным в текущей сессии rules/classes/source fields;
- webhook-инструкции показывают path metadata, но сам CMDBuild Body остается плоским и содержит только source key со значением/id;
- перед сохранением проверяется, что каждый мониторинговый класс из `source.entityClasses` или `className` regex имеет IP или DNS class attribute field, связанный с `interfaceAddressRules` или `hostProfiles[].interfaces`, и применимый `hostProfiles[]`, иначе converter примет событие, но пропустит его с `no_host_profile_matched`;
- блок `Профили мониторинга` отдельно управляет `hostProfiles[]`: оператор выбирает CMDBuild class, тип profile `Основной`/`Дополнительный`, IP/DNS leaf, режим IP/DNS, локальный профиль Zabbix `interfaces[]` и `createOnUpdateWhenMissing`;
- добавление/модификация обычного conversion rule больше не создает `hostProfiles[]` скрыто; если class не имеет применимого profile, logical control покажет риск `no_host_profile_matched`, а profile нужно создать в отдельном блоке;
- дополнительный profile создается как отдельный fan-out profile с suffix `HostProfileName`, условием выбора по заполненному leaf или `delete`, собственным `interfaces[].valueField` и выбранным `interfaceProfileRef`; при update существующего profile UI переименовывает точные условия `hostProfile` в связанных rules;
- удаление profile в отдельном блоке удаляет `hostProfiles[]` и rules, явно ограниченные этим `hostProfile`; это не удаляет Zabbix host в управляемой системе;
- шаблоны, группы и tags для дополнительного profile назначаются отдельными rules через виртуальное поле `hostProfile` или через чекбокс `Ограничить правило выбранным hostProfile` в форме добавления/модификации: например, после создания profile `класс-профиль` выберите этот profile в блоке `Профили мониторинга`, добавьте `Правило template` по нужному class attribute field (`description`, lookup, domain leaf и т.д.) и включите ограничение hostProfile; счетчик `Назначения` считает только rules с явным условием `hostProfile`;
- имена классов CMDBuild нормализуются для UI: например, `NetworkDevice` и `Network device` считаются одним классом, а отображение предпочитает имя/описание из CMDBuild catalog.

Логический контроль правил конвертации:
- интерактивно не строит цепочки, а подсвечивает только отсутствующие элементы в CMDBuild/Zabbix источниках;
- для отсутствующих элементов выводятся checkbox;
- если класс есть в `source.entityClasses`, но не имеет применимого `hostProfiles[]`, раздел показывает это как ошибку rules и предлагает действие `Создать host profile`;
- если применимый `hostProfiles[]` уже есть, но его `interfaces[].valueField` указывает на raw reference id или другой неподходящий адресный field, раздел предлагает заменить его на class-scoped IP/DNS leaf;
- если template rule оставляет несовместимый набор Zabbix templates после применения `templateConflictRules`, раздел показывает критическую ошибку по этому rule и подсвечивает конфликтующие Zabbix templates;
- если в текущей UI-сессии уже загружены CMDBuild webhooks, раздел строит тот же rule-based webhook plan и показывает warning по отсутствующим managed webhooks или payload-полям, которые нужны rules, но не передаются webhook;
- кнопка `Применить выбранное` формирует исправленный rules JSON в памяти; для удалений используется проверка mixed rule, а создание недостающего `hostProfile` или замена address leaf добавляются в общий undo/redo поток;
- backend rules-файл и git при этом не изменяются.
- этот раздел не предназначен для интерактивной подсветки связей, а только для поиска отсутствующих классов, атрибутов и Zabbix-ссылок.

Настройка webhooks:
- доступна ролям `editor` и `admin`;
- пользоваться этим разделом не обязательно: оператор может самостоятельно настроить webhooks в CMDBuild или использовать webhook-файлы, которые сохраняются при сохранении файла конвертации;
- `Загрузить из CMDB` читает текущие CMDBuild ETL webhooks через BFF и session-scoped CMDBuild credentials;
- после одной только загрузки из CMDB текущие webhooks показываются справочно; план create/update/delete строится отдельной командой `Проанализировать rules`;
- `Проанализировать rules` каждый раз заново читает актуальные conversion rules и CMDBuild catalog cache, считает conversion rules источником правды для webhook payload и строит `webhook requirements` по всем используемым source fields;
- желаемое состояние CMDBuild webhooks является производным артефактом `webhook requirements`: если rules начинают использовать leaf через lookup/reference/domain, в webhook payload добавляется только ближайший нужный CMDBuild placeholder для текущей карточки, а converter потом поднимает leaf по metadata `cmdbPath`;
- новые webhook records предлагаются как `Создать`, существующие с отличающимся body/event/target/method/url/headers/active/language - как `Изменить`, управляемые `cmdbwebhooks2kafka-*`, которые больше не нужны по rules, - как `Удалить`;
- если в существующем CMDBuild webhook отсутствуют payload-поля, которые нужны rules этого класса, summary, детали строки и причина операции показывают конкретные ключи payload и правила, из-за которых эти ключи нужны; без применения операции или ручного обновления webhook эти значения не попадут в Kafka event и не будут доступны converter-у;
- каждая строка таблицы может раскрыть payload: зеленым показывается добавляемое значение, красным удаляемое, черным актуальное значение;
- нажатие на значение в столбце `Действие` открывает блок деталей под этой же строкой; общий блок `Детали` находится под таблицей и использует ту же подсветку текста для current/desired/delete;
- кнопка `Редактировать` на строке открывает JSON конкретного webhook; сохранение правки меняет только текущий план, а для строки из загруженного CMDB создает выбранную `update`-операцию;
- при анализе rules для существующего webhook сохраняется уже загруженное body, а новые optional source fields добавляются только если они реально нужны правилам этого класса; это исключает массовые `Изменить` при добавлении независимого класса;
- при анализе существующего webhook UI не должен добавлять duplicate key с другим регистром или alias, например `OS` рядом с уже существующим `os`;
- `cmdbPath` с корневым классом другого класса, например `ДругойКласс.Атрибут1.Атрибут2`, не должен порождать placeholder в webhook текущего класса;
- удаление по умолчанию не выбирается автоматически, чтобы оператор явно подтвердил снятие старых managed webhooks;
- кнопка `Удалить выбранные` применяет только отмеченные операции `Удалить` и не отправляет операции `Создать`/`Изменить`; остальные изменения применяются через общую кнопку `Загрузить в CMDB`;
- `Undo`/`Redo` работают с выбором операций в текущей browser-сессии;
- `Undo`/`Redo` не откатывают уже выполненную команду `Загрузить в CMDB`, потому что она меняет управляемую систему;
- `Сохранить файл как` выгружает JSON-план webhooks через браузер и не меняет CMDBuild, backend rules-файл или git; token/password/secret/API key/Authorization значения в export заменяются на `XXXXX`;
- `Загрузить в CMDB` применяет только выбранные операции и действительно меняет CMDBuild records через REST v3 `/etl/webhook/`; backend ограничивает операции managed-префиксом `cmdbwebhooks2kafka-`, а для `update`/`delete` перечитывает текущие CMDBuild webhooks и применяет действие только к найденной managed-записи с тем же `code`.

Поддержанные env vars:

```bash
PORT=5090
MONITORING_UI_HOST=0.0.0.0
MONITORING_UI_SETTINGS_FILE=state/ui-settings.json
MONITORING_UI_USE_IDP=true
IDP_PROVIDER=SAML2
SAML2_METADATA_URL=https://idp.example/metadata
SAML2_ENTITY_ID=https://idp.example/entity
SAML2_SSO_URL=https://idp.example/sso
SAML2_SLO_URL=https://idp.example/slo
SAML2_IDP_CERT_PATH=/run/secrets/idp-signing.crt
SAML2_SP_ENTITY_ID=cmdb2monitoring-monitoring-ui
SAML2_ACS_URL=https://cmdb2monitoring.example/auth/saml2/acs
SAML2_SP_CERT_PATH=/run/secrets/sp.crt
SAML2_SP_PRIVATE_KEY_PATH=/run/secrets/sp.key
OAUTH2_AUTHORIZATION_URL=https://idp.example/oauth2/authorize
OAUTH2_TOKEN_URL=https://idp.example/oauth2/token
OAUTH2_USERINFO_URL=https://idp.example/oauth2/userinfo
OAUTH2_CLIENT_ID=cmdb2monitoring
OAUTH2_CLIENT_SECRET=<secret>
OAUTH2_REDIRECT_URI=https://cmdb2monitoring.example/auth/oauth2/callback
OAUTH2_SCOPES="openid profile email"
OAUTH2_LOGIN_CLAIM=preferred_username
OAUTH2_GROUPS_CLAIM=groups
LDAP_PROTOCOL=ldaps
LDAP_HOST=ad.example.local
LDAP_PORT=636
LDAP_BASE_DN=DC=example,DC=local
LDAP_BIND_DN=CN=cmdb2monitoring,OU=Service Accounts,DC=example,DC=local
LDAP_BIND_PASSWORD=<secret>
LDAP_USER_FILTER="(|(sAMAccountName={login})(userPrincipalName={login}))"
LDAP_GROUP_FILTER="(member={dn})"
CMDBUILD_BASE_URL=https://cmdbuild.example/cmdbuild/services/rest/v3
ZABBIX_API_ENDPOINT=https://zabbix.example/api_jsonrpc.php
ZABBIX_API_TOKEN=<secret>
RULES_FILE_PATH=rules/cmdbuild-to-zabbix-host-create.json
MONITORING_UI_EVENTS_ENABLED=true
MONITORING_UI_KAFKA_BOOTSTRAP_SERVERS=kafka:29092
MONITORING_UI_KAFKA_SECURITY_PROTOCOL=SaslSsl
MONITORING_UI_KAFKA_SASL_MECHANISM=ScramSha512
MONITORING_UI_KAFKA_USERNAME=<secret>
MONITORING_UI_KAFKA_PASSWORD=<secret>
MONITORING_UI_EVENTS_TOPICS=cmdbuild.webhooks,zabbix.host.requests,zabbix.host.responses,zabbix.host.bindings
```

Runtime cache/state:
- `src/monitoring-ui-api/data/*.json` - catalog cache, не коммитить;
- `src/monitoring-ui-api/state/ui-settings.json` - persisted UI settings, не коммитить;
- `src/monitoring-ui-api/state/users.json` - local UI users с PBKDF2-SHA256 hash/salt, не коммитить.

## Rules conversion model

`Model.*` в T4-шаблонах - это промежуточная модель `cmdbkafka2zabbix`, а не прямой объект CMDBuild или Zabbix.

Поддержанные группы данных:
- базовые поля: `EntityId`, `Code`, `ClassName`, `Host`, `VisibleName`, `HostProfileName`, `IpAddress`, `Description`, `OperatingSystem`, `ZabbixTag`, `EventType`;
- dynamic source fields: `Model.Field("fieldName")` читает поле из `source.fields` rules;
- Zabbix interfaces: `Interface` для обратной совместимости и `Interfaces` для нескольких `interfaces[]` в одном host;
- Zabbix host identity: technical `Host` и visible `VisibleName`;
- Zabbix host links: `Groups`, `Templates`, `Tags`;
- расширенные host параметры: `Status`, `ProxyId`, `ProxyGroupId`, `TlsPsk`, `Macros`, `InventoryFields`, `Maintenances`, `ValueMaps`.

Для прямого `host.create`/`host.update` live smoke должен подтверждать назначения technical host name, visible name, `Groups`, `Templates`, `Tags`, `Interfaces`, `Status`, `TlsPsk`, `Macros` и `InventoryFields` на самом Zabbix host. Для TLS/PSK Zabbix `host.get` подтверждает примененный mode (`tls_connect`, `tls_accept`), но не возвращает PSK secret и может не отдавать PSK identity. `Maintenances` и `ValueMaps` считаются отдельными Zabbix-операциями, пока они не добавлены в T4 host payload или отдельный worker.

`hostProfiles[]` в rules управляет двумя сценариями:
- один CMDB object -> один Zabbix host с несколькими `interfaces[]`, если несколько IP относятся к одному объекту мониторинга;
- один CMDB object -> несколько Zabbix hosts, если основной сервер и дополнительный profile object должны иметь разные host names, templates, groups или lifecycle.

Имена классов CMDBuild, attributes и source fields не являются ограничением кода. Оператор задает их в CMDBuild webhook body и rules: `source.fields`, `source.fields[].source`, `source.fields[].cmdbAttribute`, `source.fields[].cmdbPath`, `hostProfiles[].interfaces[].valueField`, selection rules и T4.

Активный demo/e2e файл `rules/cmdbuild-to-zabbix-host-create.json` сейчас собран из чистого dev starter под абстрактную тестовую модель `C2MTestCI`. Старые dev-классы `Computer`, `Notebook`, `PC`, `Server`, `tk` и старые поля `zabbixTag`, `iLo`, `iLo2`, `mgmt`, `mgmt2`, `interface`, `interface2`, `profile`, `profile2` в активный rules-файл больше не входят. Они могут встречаться только в документационных примерах как иллюстрация того, что продукт не привязан к конкретной CMDBuild/Zabbix модели.

Для `C2MTestCI` в demo/e2e rules настроены оба сценария multi-address обработки:
- основной profile `main` создает один Zabbix host: `ip_address` берется из `C2MTestCI.PrimaryIp`, `dns_name` берется из `C2MTestCI.DnsName`;
- `C2MTestCI.ExtraInterface1Ip` и `C2MTestCI.ExtraInterface2Ip` попадают как дополнительные SNMP `interfaces[]` того же Zabbix host;
- `C2MTestCI.AddressRef.AddressValue`, `C2MTestCI.Reference1.Reference2.LeafIp` и `C2MTestCI.{domain:C2MTestAddress}.AddressValue` проверяют reference/domain leaf-пути и тоже могут стать дополнительными interfaces, если selection rules разрешают их использовать;
- `C2MTestCI.SeparateProfile1Ip` и `C2MTestCI.SeparateProfile2Ip` создают отдельные Zabbix hosts с suffix `-separate-profile-1` и `-separate-profile-2`.

Webhook body для этой demo-схемы остается плоским: `ip_address`, `dns_name`, `ExtraInterface1Ip`, `ExtraInterface2Ip`, `SeparateProfile1Ip`, `SeparateProfile2Ip`, `AddressRef`, `Reference1`. Глубокие reference/domain/lookup пути хранятся в `source.fields[].cmdbPath`, а не разворачиваются в вложенный webhook JSON. Если в другой CMDBuild-модели реальные attributes называются иначе, можно либо оставить нейтральные source keys и связать их через `cmdbAttribute`/`cmdbPath`, либо назвать source keys так же, как attributes, и указать эти имена в `source.fields[].source`.
Переименование hostProfile меняет вычисляемое имя Zabbix host. Ранее созданные дополнительные hosts со старыми suffix автоматически не переименовываются; оператор должен удалить, отключить или мигрировать их отдельно.

Дополнительные SNMP interfaces используют порт `:161`; `main` с дополнительными SNMP interfaces получает `HP iLO by SNMP`, а отдельные `separate-profile-1`/`separate-profile-2` получают `Generic by SNMP`. Блок `templateConflictRules` в rules-файле удаляет `ICMP Ping` и agent-шаблоны, если выбран `HP iLO by SNMP` или `Generic by SNMP`, потому что эти SNMP-шаблоны уже содержат item key `icmpping` и заполняют inventory field `Name`.
На update через `host.get` микросервис передает `templates_clear`; `zabbixrequests2api` читает текущие linked templates через `selectParentTemplates` и очищает только реально привязанные конфликтующие templateid.

При `host.update` поля `groups[]`, `templates[]`, `tags[]`, `macros[]` и `inventory` применяются как слияние с текущим состоянием Zabbix host. `zabbixrequests2api` сначала читает текущий host, сохраняет внешние значения, которых нет в rules payload, и добавляет или переопределяет только значения, пришедшие из rules: группы по `groupid`, шаблоны по `templateid`, tags по паре `tag/value`, macros по `macro`, inventory по имени поля. `templates_clear` остается явной операцией удаления конфликтующих шаблонов и отфильтровывается только по реально привязанным templateid. `interfaces[]` специально не переводятся в режим слияния: их состав остается результатом правил, а writer только подставляет существующие `interfaceid` для корректного update.

Совместимость шаблонов Zabbix. Перед `host.create` и перед фактическим `host.update` после merge/fallback `zabbixrequests2api` при `Zabbix:ValidateTemplateCompatibility=true` читает выбранные templates через Zabbix `template.get` с `selectTemplateGroups`, `selectItems` и `selectDiscoveryRules`. Это 7+ контракт без deprecated subselects. Если итоговый набор templates содержит одинаковый item key, одинаковый LLD rule key или одинаковую inventory-привязку `inventory_link` в двух и более шаблонах, сервис возвращает ошибку `template_conflict`, ставит `zabbixRequestSent=false` и не вызывает `host.create/update`. В `errorMessage` перечисляются конфликтующий key или inventory link, имена/templateid шаблонов, действие по исправлению и ссылка на этот раздел: `PROJECT_DOCUMENTATION.md` / `PROJECT_DOCUMENTATION.en.md`, section `Zabbix template compatibility`. Исправление выполняется в rules: выбрать другой набор templates, добавить/исправить `templateConflictRules`, передать конфликтующий template в `templates_clear` для update или изменить сами templates в Zabbix.

Пример несовместимости templates: существующий Zabbix host `cmdb-server-srv13` имел agent-шаблон `Windows by Zabbix agent`, а update добавил `HP iLO by SNMP` для дополнительного SNMP interface. Zabbix отклонил `host.update`, потому что оба шаблона заполняют inventory field `Name` (`system.hostname` и `system.name`). Поэтому rules выбирают SNMP template как целевой и передают agent template в `templates_clear` для update fallback.

Ограничения по количеству IP:
- в коде `cmdbkafka2zabbix` нет отдельного числового лимита на `Model.Interfaces`: сервис рендерит столько interfaces, сколько выбрано правилами `hostProfiles[].interfaces`;
- фактический лимит конкретной поставки задается rules и плоским webhook body; текущая demo-схема как пример дает `main` основной IP/DNS и несколько дополнительных interface source fields, а `separate-profile-1` и `separate-profile-2` являются двумя отдельными дополнительными host profiles по одному IP каждый;
- в одном Zabbix host допустимо несколько interfaces, но для каждого Zabbix interface type должен быть только один основной interface с `main=1`; дополнительные interfaces того же type должны иметь `main=0`, иначе Zabbix может отклонить или некорректно применить payload;
- чтобы добавить еще один фиксированный IP в основной host, нужно добавить CMDBuild attribute, webhook field, `source.fields` и новый элемент `hostProfiles[].interfaces`; если это еще один SNMP interface, его профиль Zabbix interfaces[] должен быть не-main (`main=0`), кроме одного выбранного основного SNMP interface;
- чтобы добавить еще один отдельный monitoring profile, нужно добавить новый named source field и отдельный `hostProfile` с собственным suffix, например `separate-profile-3`; через UI это делается в блоке `Профили мониторинга`, затем templates/groups/tags назначаются отдельными rules через виртуальное поле `hostProfile`; при необходимости upsert на update включается `createOnUpdateWhenMissing=true`;
- произвольное или заранее неизвестное количество IP в одном поле webhook сейчас не поддерживается: текущая модель ожидает плоские именованные поля, а не массив адресов. Для безлимитного списка потребуется отдельное расширение контракта webhook/rules/T4, например массив interfaces или profiles с итерацией.

Пример настройки другой модели: если в конкретной CMDBuild-модели класс называется `КлассКЕ`, два дополнительных интерфейса называются `АтрибутИнтерфейс1`/`АтрибутИнтерфейс2`, а два адреса управления `АтрибутПрофиль1`/`АтрибутПрофиль2` нужно вынести в отдельные Zabbix hosts, в rules добавляются source fields для этих четырех attributes; `АтрибутИнтерфейс1`/`АтрибутИнтерфейс2` подключаются как дополнительные `hostProfiles[].interfaces` основного profile, а для `АтрибутПрофиль1`/`АтрибутПрофиль2` создаются два отдельных `hostProfiles[]` с собственными suffix, templates/groups/tags и lifecycle.

Поведение при пустых дополнительных адресах:
- если заполнен только `ip_address`, profile `main` все равно создает или обновляет основной host с одним agent interface;
- пустые `ExtraInterface1Ip` и `ExtraInterface2Ip` просто не попадают в `interfaces[]`; когда они позже появятся в update-событии, `main` сформирует update payload уже с дополнительными SNMP interfaces;
- пустые `SeparateProfile1Ip` и `SeparateProfile2Ip` на create/update не выбирают profiles `separate-profile-1` и `separate-profile-2`, поэтому отдельные hosts не создаются и запросы по ним не публикуются;
- для profiles с `createOnUpdateWhenMissing=true` новое значение `SeparateProfile1Ip` или `SeparateProfile2Ip`, появившееся только на update, обрабатывается как upsert: `zabbixrequests2api` выполняет `host.get`, при найденном host делает `host.update`, а при отсутствующем host валидирует `fallbackCreateParams` и делает `host.create`;
- если отдельный profile address очищен после того, как дополнительный host уже был создан, автоматического удаления нет: необходимо самостоятельно принять решение по соответствующему объекту мониторинга Zabbix, например оставить, отключить или удалить его отдельным процессом;
- delete-событие пытается удалить `main`, `separate-profile-1` и `separate-profile-2` profiles по вычисленным именам даже при пустых адресах, чтобы удалить ранее созданные дополнительные hosts; если такого host нет, в response будет `host_not_found`.

При наличии нескольких host profiles `cmdbkafka2zabbix` публикует несколько сообщений в `zabbix.host.requests.*`. State входного Kafka offset записывается только после успешной публикации всех сообщений по одному CMDB event.

Расширение rules для новых CMDBuild атрибутов возможно без изменения кода, если:
- атрибут уже приходит в webhook body;
- атрибут добавлен в `source.fields`;
- rules/T4 используют существующие механизмы `Model.Field(...)` или `Model.Source(...)`;
- для создания/обновления Zabbix host остается настроен IP или DNS через `interfaceAddressRules` или `hostProfiles[].interfaces`.

Для нового CMDBuild класса дополнительно нужны:
- класс в CMDBuild catalog и webhook-записи на нужные события;
- добавление класса в `source.entityClasses` или rule condition по `className`;
- обязательная связь IP/DNS class attribute field с Zabbix interface structure;
- применимый `hostProfiles[]` с условием на этот класс; без него событие будет пропущено converter как `no_host_profile_matched`;
- актуализированный CMDBuild catalog cache в UI через `CMDBuild Catalog -> Sync`.

Без переписывания микросервисов можно менять JSON rules:
- `source.fields` для уже приходящих CMDBuild атрибутов;
- `source.fields[].cmdbPath` для путей вида `Класс.АтрибутReference.АтрибутScalar`, `Класс.АтрибутReference1.АтрибутReference2.АтрибутScalar`, `Класс.АтрибутReference1.АтрибутReference2.АтрибутLookup` или `Класс.{domain:СвязанныйКласс}.АтрибутScalar`;
- regex validation и selection rules;
- `monitoringSuppressionRules`, когда по атрибутам экземпляра нужно осознанно отказаться от создания/обновления мониторинга;
- ссылки на существующие Zabbix host groups/templates/template groups/tags;
- T4 templates, если итоговый JSON-RPC остается валидным для Zabbix.

Переписывание микросервисов потребуется, если нужно добавить принципиально новый тип Zabbix API operation, новый способ чтения source payload или новую runtime-интеграцию.

## ELK logging

Пока ELK нет, каждый .NET-сервис пишет structured JSON logs в Kafka log topic.
Когда ELK появится:
- задать `ElkLogging:Mode=Elk` или включить `ElkLogging:Elk:Enabled`;
- заполнить `ElkLogging:Elk:Endpoint`, `Index`, `ApiKey`;
- при необходимости отключить Kafka log sink.

## Extended debug logging

Все .NET-микросервисы поддерживают секцию `DebugLogging`:

```json
"DebugLogging": {
  "Enabled": false,
  "Level": "Basic"
}
```

Поддержанные уровни: `Basic` и `Verbose`. События расширенного режима пишутся через обычный `ILogger` на уровне `Information`, поэтому попадают в Docker stdout/stderr, Kafka log topic при `ElkLogging:Mode=Kafka`, ELK при включенном ELK sink и в syslog, если Docker настроен с syslog logging driver.

`Basic` включает диагностическую трассу прохождения события между webhook, Kafka, converter, Zabbix API и обратной записью binding в CMDBuild. `Verbose` дополнительно пишет payload/request/response JSON и должен включаться только на время диагностики: в этих сообщениях могут быть значения CMDBuild attributes, Zabbix request/response и другие операционные данные.

## Проверки перед commit/push

```bash
./scripts/test-configs.sh
./scripts/dotnet build src/cmdbwebhooks2kafka/cmdbwebhooks2kafka.csproj -v minimal
./scripts/dotnet build src/cmdbkafka2zabbix/cmdbkafka2zabbix.csproj -v minimal
./scripts/dotnet build src/zabbixrequests2api/zabbixrequests2api.csproj -v minimal
./scripts/dotnet build src/zabbixbindings2cmdbuild/zabbixbindings2cmdbuild.csproj -v minimal
./scripts/dotnet build tests/configvalidation/configvalidation.csproj -v minimal
./scripts/dotnet build tests/cmdbresolver/cmdbresolver.csproj -v minimal
node src/monitoring-ui-api/scripts/validate-config.mjs
git diff --check
```

Smoke-проверки цепочки:
- `create`: CMDBuild -> Kafka -> Zabbix `host.create` -> response topic -> host есть в Zabbix;
- `update`: CMDBuild -> Kafka -> fallback `host.get -> host.update` -> response topic -> поля изменились в Zabbix;
- `update` с новым `profile`/`profile2`: CMDBuild -> Kafka -> fallback `host.get -> host.create` при включенном `createOnUpdateWhenMissing` -> дополнительный host появился в Zabbix;
- `delete`: CMDBuild -> Kafka -> fallback `host.get -> host.delete` -> response topic -> host удален из Zabbix;
- binding: успешный `host.create/update/delete` -> `zabbix.host.bindings.*` -> `zabbixbindings2cmdbuild` -> `zabbix_main_hostid` или карточка `ZabbixHostBinding` обновлены в CMDBuild.

Fast regression-набор `tests/cmdbresolver` входит в `./scripts/test-configs.sh` и не требует живых CMDBuild/Zabbix/Kafka. Он проверяет, что два последовательных update события с одним экземпляром resolver заново читают CMDBuild lookup values, reference leaf cards и domain leaf cards. Отдельный сценарий проверяет весь путь до converter output: обновленное domain leaf значение должно попасть в dynamic `groups[]` как host group с `createIfMissing=true`.

Проверка полноты редактора правил описана отдельно в `TEST_PLAN_MAPPING_EDITOR.md`. Для нее подготовлены воспроизводимые scripts:
- `node scripts/cmdbuild-demo-schema.mjs --apply` - создает абстрактную demo-модель под `CI` / `КЕ`;
- `node scripts/cmdbuild-demo-instances.mjs --apply` - создает карточки, каждая из которых описывает проверяемый сценарий.
- `node scripts/cmdbuild-demo-e2e.mjs --apply` - отправляет demo events через локальную цепочку webhook -> Kafka -> converter -> Zabbix API, проверяет Zabbix hosts и пишет отчет в `reports/`. Отчет читает из Zabbix назначенные `host`, `name`, `interfaces`, `groups`, `parentTemplates`, `tags`, `macros`, `inventory`, `status` и TLS mode.

Минимальный порядок демонстрации:
```bash
node scripts/cmdbuild-demo-schema.mjs --apply
node scripts/cmdbuild-demo-instances.mjs --apply
node scripts/cmdbuild-demo-e2e.mjs --apply
```

`--cleanup-zabbix` у E2E опционален и удаляет только старые demo-hosts `cmdb-c2mtestci-*`; если удаление выполняется вручную, флаг не нужен.

Базовый live E2E проверяет host payload, который реально применяется текущим create/update runner. `proxy`/`proxy group` требуют отдельной подготовки proxy objects в Zabbix, а `maintenance` и `value maps` требуют dedicated Zabbix API operations или отдельного catalog setup, поэтому они остаются отдельными тестовыми сценариями.

Файл `rules/cmdbuild-to-zabbix-host-create.json` остается demo/e2e-набором правил, использованным для проверки, и активный `RulesFilePath` по умолчанию указывает именно на него. Базовый dev-набор построен вокруг абстрактной тестовой модели `C2MTest*`, но в ходе проверки в него можно добавлять любые конкретные классы текущего CMDBuild catalog: это не ограничение продукта и не признак жесткой привязки к именам модели. Для каждого такого класса должны быть заполнены `source.entityClasses`, source field для IP/DNS leaf, применимый `hostProfiles[]` и webhooks. Чистый production starter лежит рядом: `rules/cmdbuild-to-zabbix-host-create.production-empty.json`. Чистый dev starter лежит рядом: `rules/cmdbuild-to-zabbix-host-create.dev-empty.json`; он создан из пустого installation profile, но уже указывает `cmdbuild.webhooks.dev` и `http://localhost:8081/api_jsonrpc.php`. Оба starter-файла безопасны для запуска как no-op: routes имеют `publish=false`, а оператор должен заполнить классы, source fields, host profiles, Zabbix catalog IDs, T4 templates и включить публикацию только после проверки. Чтобы работать именно с пустым dev starter, его нужно загрузить в UI или указать в `Rules.RulesFilePath` через config/env или `Runtime-настройки`.

В UI раздела `Правила` кнопка `Создать пустой` формирует такой starter из текущего окружения: endpoint Zabbix, topic CMDBuild events, справочники Zabbix и компактный снимок CMDBuild metadata берутся из runtime config/catalog cache. Если CMDBuild cache не содержит классы/атрибуты или Zabbix cache не содержит host groups/templates, backend возвращает ошибку и starter не создается. Сгенерированный JSON попадает в область локального файла и сохраняется только через браузер; публикация в git выполняется оператором вне приложения.

## Git и артефакты

В один коммит должны попадать связанные изменения:
- код;
- конфиги;
- `TZ_cmdb2monitoring.txt`;
- английские companion-документы для неархитектурной документации;
- `aa/`;
- проверки/тесты;
- документация.

Не коммитить:
- `bin/`, `obj/`;
- `state/`;
- `.dotnet/`, `.nuget/`;
- `.env*`;
- runtime caches и production secrets.
