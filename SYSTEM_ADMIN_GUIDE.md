# Инструкция администратора системы

Документ описывает подготовку и сопровождение `cmdb2monitoring` со стороны администратора системы: настройки сервисов, CMDBuild, Zabbix, webhooks, reverse binding-ов и контроль типовых ошибок человеческого фактора.

## Зоны ответственности

Администратор системы отвечает за:
- доступность микросервисов, Kafka topics, CMDBuild и Zabbix;
- runtime-настройки UI/BFF и микросервисов;
- учетные записи и минимальные права сервисов;
- подготовку модели CMDBuild для аудита постановки на мониторинг;
- загрузку и контроль CMDBuild webhooks;
- публикацию файла правил в выбранное продуктивное место хранения;
- нажатие `Перечитать правила конвертации` после публикации правил;
- контроль версий правил в Панели.

Разработчик правил отвечает за содержимое rules-файла: source fields, `cmdbPath`, host profiles, selection rules, templates, groups, tags, suppression и T4 payload. Администратор может технически загрузить файл, но не должен принимать смысловые решения по mapping без разработчика правил.

## Начальная подготовка

1. Проверьте совместимость окружения.
   - CMDBuild: `4.x` с REST API v3 и плоским webhook JSON.
   - Zabbix: `7.0.x LTS` или совместимая 7.x версия JSON-RPC.
   - Kafka: `3.x`, topics создаются внешней инфраструктурой.
   - Audit storage: PostgreSQL для средних и крупных инсталляций; SQLite допустим для разработки и небольших инсталляций.

2. Подготовьте Kafka topics.
   - CMDBuild events: topic для `cmdbwebhooks2kafka`.
   - Zabbix requests: topic для `cmdbkafka2zabbix -> zabbixrequests2api`.
   - Zabbix responses: topic для `zabbixrequests2api`.
   - Zabbix bindings: topic для `zabbixrequests2api -> zabbixbindings2cmdbuild`.
   - Logs topics для сервисов, если они включены в конфигурации.

3. Настройте микросервисы.
   - `cmdbwebhooks2kafka`: URL webhook, Bearer token, input Kafka.
   - `cmdbkafka2zabbix`: CMDBuild REST URL, rules provider, `HostBindingLookupEnabled`, Kafka input/output.
   - `zabbixrequests2api`: Zabbix API URL/token, validation settings, dynamic host group creation.
   - `zabbixbindings2cmdbuild`: CMDBuild REST URL, service account для записи binding-ов.
   - `monitoring-ui-api`: endpoints, Kafka Event Browser, auth, runtime settings, git settings.

4. Настройте роли UI.
   - `viewer`: Панель и События.
   - `editor`: все рабочие разделы правил, каталогов, webhooks и аудита без admin-настроек.
   - `admin`: все меню, включая Авторизацию, Runtime-настройки и Настройку git.
   - Если включены `MS AD` или `IdP`, роли назначаются через группы; локальные пользователи остаются резервным механизмом.

## Минимальные права

CMDBuild:
- UI catalog sync: read-only к metadata classes/attributes/domains, lookup types/values, карточкам целевых классов, reference/domain связанным классам и relations текущей карточки.
- Webhook Setup, `Загрузить из CMDB`: read к ETL/webhook records.
- Webhook Setup, `Загрузить в CMDB`: create/update/delete или эквивалентные modify-права на ETL/webhook records.
- Audit, `Применить подготовку CMDBuild`: права администратора модели на создание classes и attributes.
- `cmdbkafka2zabbix`: read-only к исходным карточкам и `ZabbixHostBinding`, если включен `Cmdbuild:HostBindingLookupEnabled`.
- `zabbixbindings2cmdbuild`: read/update на карточки участвующих классов для `zabbix_main_hostid`, read/create/update на `ZabbixHostBinding`.

Zabbix:
- UI catalog sync: API access и read-only к host groups, template groups, templates, hosts/tags и расширенным каталогам.
- `zabbixrequests2api`: host create/update/delete, чтение groups/templates, `hostgroup.create` если включено динамическое создание host groups.
- Если используется Zabbix API token, храните его как secret/env. Login/password не сохраняются в runtime state.

## Runtime-настройки

В меню `Runtime-настройки` задаются рабочие endpoints и параметры UI/BFF:
- CMDBuild URL;
- Zabbix API URL и optional API key;
- Kafka Event Browser topics/security;
- AuditStorage provider/connection string/schema;
- динамическое расширение Zabbix из CMDBuild leaf;
- health/reload endpoints сервисов.

AuditStorage:
- `postgresql` - основной вариант для средних и крупных инсталляций.
- `sqlite` - разработка и небольшие инсталляции. Ориентир: до 1000 объектов на мониторинге, допустимо до 2000 при умеренном потоке событий и коротком хранении аудита.
- Для высокой параллельности пользователей, длительного хранения аудита или большего количества объектов используйте PostgreSQL.

Важное разделение:
- настройки UI/BFF в `Runtime-настройках` не меняют автоматически конфигурацию микросервисов;
- настройки `cmdbkafka2zabbix`, `zabbixrequests2api`, `zabbixbindings2cmdbuild` живут в их `appsettings*.json` или env/secret;
- внешняя авторизация UI через MS AD/IdP не используется как credential для CMDBuild/Zabbix API.

## Настройка git и rules-файла

Меню `Настройка git` управляет только локальными копиями файла правил для системы управления. Микросервис `cmdbkafka2zabbix` читает правила по своей конфигурации `ConversionRules`.

Рекомендуемый поток:
1. Разработчик правил сохраняет JSON из браузера или через локальную git working copy.
2. Администратор проверяет diff.
3. Администратор публикует файл в согласованный git repository или локальный путь, используемый микросервисом.
4. В Панели нажимает `Перечитать правила конвертации`.
5. Сверяет две версии:
   - версия правил, загруженная на микросервисе;
   - версия файла, который видит UI управления.

`rulesVersion` должен включать дату и время, например `2026.05.05-1530-change-name`, чтобы визуально отличать редакции.

## Подготовка CMDBuild

### Catalog sync

Перед работой с правилами и аудитом выполните синхронизацию CMDBuild catalog в UI. После добавления класса, атрибута, lookup или domain синхронизацию нужно повторить.

### Атрибут основного Zabbix host

Для каждого конкретного CMDBuild class, участвующего в conversion rules, нужен строковый атрибут:

| Атрибут | Назначение |
| --- | --- |
| `zabbix_main_hostid` | `hostid` основного Zabbix host для конкретной карточки CMDBuild |

Рекомендуемый способ создания:
1. Откройте меню `Аудит`.
2. Нажмите `Проверить модель CMDBuild`.
3. Проверьте список участвующих классов.
4. Для администратора: нажмите `Применить подготовку CMDBuild`.

Ручной способ допустим, но хуже контролируется. Тип атрибута: string/text, длина до 64.

### Класс дополнительных профилей

Если одна карточка CMDBuild может создавать несколько Zabbix hosts через дополнительные `hostProfiles[]`, нужен служебный класс `ZabbixHostBinding`. Он применяется не только к объектам с текущими профилями, а как общая инфраструктура расширенной логики. Фактические карточки создаются для дополнительных профилей.

Атрибуты класса:

| Атрибут | Тип | Назначение |
| --- | --- | --- |
| `OwnerClass` | string 100 | CMDBuild class исходной карточки |
| `OwnerCardId` | string 64 | id исходной карточки |
| `OwnerCode` | string 100 | code исходной карточки |
| `HostProfile` | string 128 | имя `hostProfile` из rules |
| `ZabbixHostId` | string 64 | Zabbix `hostid` |
| `ZabbixHostName` | string 255 | техническое имя Zabbix host |
| `BindingStatus` | string 32 | `active` или `deleted` |
| `RulesVersion` | string 128 | версия правил, создавших binding |
| `LastSyncAt` | string 64 | timestamp последней записи |

Рекомендуемый способ создания - меню `Аудит`: администратор выбирает в дереве CMDBuild, где создать `ZabbixHostBinding`, затем применяет подготовку. Это уменьшает риск ошибки в типах и именах атрибутов.

## Настройка webhooks

Webhooks должны передавать плоский JSON. Reference/lookup/domain значения в webhook обычно остаются id, а путь до leaf хранится в rules как metadata `cmdbPath`.

Рабочий порядок:
1. Синхронизируйте CMDBuild catalog.
2. В меню `Настройка webhooks` нажмите `Загрузить из CMDB`.
3. Нажмите `Проанализировать rules`.
4. Раскройте payload по строкам и проверьте:
   - зеленое - добавляется;
   - красное - удаляется;
   - черное - текущее актуальное состояние.
5. При необходимости отредактируйте конкретный webhook.
6. Примените выбранные операции кнопкой `Загрузить в CMDB`.

Особенности:
- undo/redo в UI не откатывают уже выполненную загрузку в CMDBuild;
- `Save file as` может сохранять рядом с rules файл webhook-инструкций, но token/secret значения маскируются как `XXXXX`;
- если rule требует новый source field, а webhook не обновлен, converter получит пустое или отсутствующее поле и rule не сработает;
- после изменения правил всегда повторяйте анализ webhooks.

## Подготовка Zabbix

1. Создайте или проверьте host groups, template groups, templates, macros, inventory fields, proxies и другие объекты, которые будут использовать rules.
2. В UI выполните sync Zabbix catalog.
3. Выполните sync `Метаданные Zabbix`.
4. Проверьте template conflicts.

Runtime-защита:
- `zabbixrequests2api` перед `host.create/update` проверяет host groups, templates и template compatibility;
- при `template_conflict` сервис не отправляет запрос в Zabbix и пишет понятную ошибку;
- конфликты исправляются в rules, Zabbix templates или `templateConflictRules`.

## Динамическое расширение Zabbix из CMDBuild leaf

Есть два независимых уровня:
- UI Runtime-настройки: разрешают редактору правил сохранять dynamic target для Tags и Host groups.
- `zabbixrequests2api`: `Zabbix:AllowDynamicHostGroupCreate` разрешает writer создавать отсутствующие host groups.

Поведение:
- Tags не имеют отдельного справочника в Zabbix, tag/value попадает прямо в `params.tags[]`.
- Host group при update/create ищется через `hostgroup.get`; если отсутствует и создание разрешено, вызывается `hostgroup.create`, затем новый `groupid` сразу подставляется в тот же host payload.
- Если UI-галка включена, а writer creation выключен, правило можно сохранить, но выполнение даст ошибку `auto_expand_disabled`.

Используйте dynamic leaf только после анализа разнообразия значений. Неконтролируемый атрибут CMDBuild может создать большое количество host groups или tags.

## Поведение при update и совместных правках

Идентификация Zabbix host при update/delete:
1. explicit `zabbix_hostid` из webhook/source fields;
2. CMDBuild binding:
   - основной host: `zabbix_main_hostid`;
   - дополнительный hostProfile: `ZabbixHostBinding`;
3. fallback `host.get` по техническому имени host.

Слияние с ручными изменениями в Zabbix:
- `groups[]`, `templates[]`, `tags[]`, `macros[]`, `inventory` применяются как merge с текущим состоянием host;
- внешние значения, которых нет в rules payload, сохраняются;
- значения из rules добавляются или переопределяют совпадающие ключи;
- `templates_clear` - явная операция удаления конфликтующих templates;
- `interfaces[]` не работают как свободный merge: их состав считается результатом правил, writer только подставляет существующие `interfaceid` для update.

Практическое следствие:
- если другой администратор добавил дополнительную host group вручную, обычный update из rules ее не удалит;
- если rule меняет тот же tag/value, macro или inventory field, значение из rules станет управляемым и будет переопределяться;
- изменение набора interfaces надо делать через rules, а не вручную в Zabbix.

## Сценарии человеческого фактора

| Сценарий | Что произойдет | Как предотвратить |
| --- | --- | --- |
| Добавлен CMDBuild class/attribute, но catalog не пересинхронизирован | UI не увидит поле или покажет неконсистентность | Sync CMDBuild catalog перед редактированием правил |
| Добавлен Zabbix template/group, но catalog не пересинхронизирован | UI не даст выбрать объект или logical control покажет отсутствие | Sync Zabbix catalog и metadata |
| Rules сохранены в браузере, но не опубликованы туда, откуда читает микросервис | Панель покажет разные версии, converter продолжит старые правила | Проверять версии в Панели и нажимать reload после публикации |
| Rule требует новый webhook field, но webhook не обновлен | Converter не получит значение, mapping не сработает | После изменения rules анализировать и загружать webhooks |
| Изменен только связанный reference/domain объект, исходная карточка не менялась | Webhook исходного объекта не придет, мониторинг может не обновиться | Трогать исходную карточку, делать webhook для связанного класса или планировать отдельный процесс |
| Domain возвращает несколько связанных объектов, а rule пытается писать в скалярное поле Zabbix | UI должен запретить такой mapping; ручной JSON может дать неоднозначный результат | Использовать множественные структуры Zabbix или отдельные hostProfiles |
| Включен dynamic host group без контроля значений leaf | В Zabbix появится много групп | Сначала оценить значения, нормализовать lookup, ограничить regex |
| `zabbixbindings2cmdbuild` остановлен или нет прав | Host создастся, но `zabbix_main_hostid`/binding не запишутся; update пойдет через fallback | Проверять health 5083, logs и права CMDBuild |
| Переименован `hostProfile` | Вычисляемое имя дополнительного Zabbix host изменится; старый host не удалится автоматически | Переименование делать как миграцию: правила, cleanup, проверка bindings |
| Ручное переименование technical host в Zabbix при отсутствии binding-а | fallback `host.get` может не найти host | Не переименовывать technical host вручную или сначала добиться записи binding-а |
| Выбран superclass в правилах | UI должен заменить его ближайшим конкретным class или запретить выбор | Использовать только конкретные CMDBuild classes |
| Template conflict пропущен из-за устаревшей metadata | Runtime все равно заблокирует `host.create/update` | Sync metadata и исправить `templateConflictRules` |

## Операционный чеклист после изменения правил

1. Sync CMDBuild catalog, если менялась модель.
2. Sync Zabbix catalog и metadata, если менялись Zabbix объекты.
3. В `Управление правилами конвертации` проверить hostProfiles, assignments и dynamic targets.
4. В `Логический контроль правил конвертации` убрать критичные ошибки.
5. В `Настройка webhooks` построить план и применить изменения CMDBuild.
6. Сохранить rules JSON, проверить `rulesVersion`.
7. Опубликовать rules в согласованное место хранения.
8. Нажать `Перечитать правила конвертации`.
9. В Панели сверить версию на микросервисе и версию в UI.
10. Проверить Events: CMDBuild event -> Zabbix request -> Zabbix response -> binding event.
11. Для новых классов проверить, что `zabbix_main_hostid` или `ZabbixHostBinding` заполняются после успешного create/update.
