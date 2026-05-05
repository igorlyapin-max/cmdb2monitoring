# Инструкция разработчика правил

Документ описывает, как проектировать и сопровождать conversion rules: от выбора CMDBuild leaf-полей до Zabbix host profiles, templates, groups, tags, suppression и webhooks.

## Базовые принципы

- Rules-файл не привязан к конкретным именам классов или атрибутов. В примерах используйте нейтральные имена: `КлассКЕ`, `АтрибутPrimaryIp`, `АтрибутReference`, `СвязанныйКласс`, `АтрибутLeaf`.
- Webhook body остается плоским. Для lookup/reference/domain в webhook обычно приходит id, а путь до реального leaf значения хранится в rules как `cmdbPath`.
- Любое новое поле правила должно иметь источник в CMDBuild webhook или resolver path.
- Сначала создается применимый `hostProfile`, затем назначаются templates/groups/tags/inventory/macros.
- Дополнительный profile - это отдельный Zabbix host, если ему нужны собственные имя, templates, groups или lifecycle.
- Несколько interfaces внутри одного Zabbix host используйте только когда это один объект мониторинга.
- Правила не должны скрыто создавать profiles: profiles управляются отдельным блоком `Профили мониторинга`.

## Перед началом работы

1. Войдите с ролью `editor` или `admin`.
2. Синхронизируйте CMDBuild catalog.
3. Синхронизируйте Zabbix catalog.
4. Синхронизируйте `Метаданные Zabbix`.
5. Убедитесь, что Runtime-настройки dynamic leaf соответствуют задаче:
   - `Разрешить динамическое расширение Zabbix Tags из CMDBuild leaf`;
   - `Разрешить динамическое создание Zabbix Host groups из CMDBuild leaf`.
6. Для host groups уточните у администратора, включено ли в `zabbixrequests2api` `Zabbix:AllowDynamicHostGroupCreate`.
7. Если создается новый class/attribute/domain в CMDBuild, попросите администратора повторить catalog sync и проверить webhooks.

## Source fields и leaf paths

Типовые формы путей:

| Сценарий | Пример пути |
| --- | --- |
| Атрибут исходной карточки | `КлассКЕ.АтрибутPrimaryIp` |
| Lookup leaf | `КлассКЕ.АтрибутLookup` |
| Reference leaf | `КлассКЕ.АтрибутReference.АтрибутLeaf` |
| Reference через несколько уровней | `КлассКЕ.АтрибутReference1.АтрибутReference2.АтрибутLeaf` |
| Domain leaf | `КлассКЕ.{domain:СвязанныйКласс}.АтрибутLeaf` |
| Domain + reference leaf | `КлассКЕ.{domain:СвязанныйКласс}.АтрибутReference.АтрибутLeaf` |

Правила выбора:
- выбирайте leaf, а не промежуточный reference объект;
- для lookup проверяйте, какое значение нужно использовать: id, code или display value;
- для domain проверяйте, что domain действительно связывает текущий class со `СвязанныйКласс`;
- если domain может вернуть несколько связанных карточек, не используйте такой путь для скалярного Zabbix поля;
- reference/domain leaf обновится на мониторинге только при событии исходной карточки, если нет отдельного процесса, который инициирует update для исходного объекта.

## Создание основного host profile

В меню `Управление правилами конвертации` используйте блок `Профили мониторинга`.

1. Выберите конкретный CMDBuild class, не superclass.
2. Выберите тип profile `Основной`.
3. Выберите leaf для IP или DNS.
4. Укажите режим address:
   - IP target для IP-адреса;
   - DNS target для DNS/FQDN;
   - не сохраняйте IP-looking field в DNS target и DNS-looking field в IP target.
5. Выберите профиль Zabbix `interfaces[]`.
6. Сохраните profile.

Если class участвует в правилах, но не имеет применимого profile, converter примет событие и пропустит его с `no_host_profile_matched`.

## Создание дополнительного host profile

Используйте дополнительный profile, когда адрес или endpoint должен стать отдельным Zabbix host.

1. В блоке `Профили мониторинга` выберите class.
2. Выберите тип profile `Дополнительный`.
3. Задайте понятное имя profile, например по роли endpoint, а не по временному названию атрибута.
4. Выберите leaf IP/DNS для дополнительного host.
5. Выберите Zabbix interface profile.
6. При необходимости включите `createOnUpdateWhenMissing`, чтобы update мог создать отсутствующий дополнительный host.
7. Сохраните profile.

Затем назначьте этому profile templates/groups/tags:
1. Выберите созданный profile в блоке `Профили мониторинга`.
2. Создайте `Правило template`, `Правило host group` или `Правило tag`.
3. Включите ограничение на выбранный `hostProfile` или используйте виртуальное поле `hostProfile`/`outputProfile`.
4. Выберите condition leaf, например `КлассКЕ.АтрибутРольEndpoint` или `КлассКЕ.{domain:СвязанныйКласс}.АтрибутТип`.
5. Выберите Zabbix target и сохраните rule.

Счетчик назначений profile считает только rules с явным ограничением по `hostProfile`. Если счетчик не меняется, проверьте, что правило действительно ограничено на нужный profile.

## Назначение host groups, templates и tags

Host groups:
- выбирайте существующую Zabbix host group из catalog;
- либо используйте dynamic target из CMDBuild leaf, если Runtime-галка включена;
- для dynamic host groups writer создаст отсутствующую group и сразу привяжет текущий host к ней, если `Zabbix:AllowDynamicHostGroupCreate=true`.

Templates:
- выбирайте template из Zabbix catalog;
- перед сохранением проверяйте подсветку конфликтов из `Метаданные Zabbix`;
- не пытайтесь использовать tags как способ выбрать template в блоке template rules. Используйте тот же CMDBuild field как condition для template rule.

Tags:
- tag/value попадают в Zabbix host payload и не требуют отдельного Zabbix catalog object;
- dynamic tag из leaf разрешайте только при контролируемом разнообразии значений.

Inventory/macros/extended fields:
- используйте только leaf с предсказуемым типом и форматом;
- для inventory убедитесь, что payload не отключает inventory mode;
- если поле может редактироваться вручную в Zabbix, договоритесь, кто является владельцем значения: rules или оператор Zabbix.

## Динамическое расширение из CMDBuild leaf

Dynamic target разрешен только для:
- `Правило tag`;
- `Правило host group`.

При включенной UI-галке редактор покажет target `Создавать/расширять из выбранного CMDBuild leaf`. Пустой target для templates, interfaces, inventory и macros остается ошибкой.

Перед включением dynamic leaf:
1. Выгрузите или просмотрите уникальные значения атрибута CMDBuild.
2. Проверьте орфографию и регистр значений.
3. По возможности используйте lookup вместо свободного текста.
4. Ограничьте rule regex-ом, если в поле могут быть служебные или временные значения.
5. Для host groups согласуйте с администратором право `hostgroup.create`.

Риск: если пользователи CMDBuild начнут вводить свободный текст, Zabbix получит такой же объем новых tags или host groups.

## Monitoring suppression

Используйте `monitoringSuppressionRules`, когда атрибуты самой исходной карточки означают "не ставить на мониторинг".

Пример:
- `КлассКЕ.АтрибутMonitoringPolicy = do_not_monitor`;
- create/update пропускаются с причиной `monitoring_suppressed:*`;
- delete не подавляется, потому что delete может означать "остановить мониторинг объекта".

Важно: `do_not_monitor` на связанной domain/leaf карточке не равно "остановить мониторинг объекта". Это означает "не использовать связанный endpoint". Исходная карточка может продолжать мониториться по другим адресам.

## Update и совместные правки

При update/delete host ищется в таком порядке:
1. explicit `zabbix_hostid` из webhook/source fields;
2. `zabbix_main_hostid` для основного profile или `ZabbixHostBinding` для дополнительного profile;
3. fallback `host.get` по technical host name.

Правила merge:
- `groups[]`, `templates[]`, `tags[]`, `macros[]`, `inventory` сливаются с текущим состоянием Zabbix host;
- внешние значения, которых нет в rules payload, сохраняются;
- совпадающие значения из rules становятся управляемыми rules и переопределяются;
- `templates_clear` удаляет только явно указанные конфликтующие templates;
- `interfaces[]` не сливаются как справочники: их состав считается результатом rules.

Проверяйте человеческий фактор:
- если Zabbix operator вручную добавил host group, она сохранится;
- если rules добавили другую host group из CMDBuild leaf, она добавится рядом;
- если старую group нужно убрать, нужен явный процесс очистки или изменение политики управления;
- если изменен IP/DNS interface в CMDBuild, update должен изменить interface, но техническое имя host должно оставаться стабильным;
- если переименовать `hostProfile`, ранее созданный дополнительный host не удалится автоматически.

## Webhooks для разработчика правил

После добавления или изменения source field:
1. Откройте `Настройка webhooks`.
2. `Загрузить из CMDB`.
3. `Проанализировать rules`.
4. Проверьте, что новый field появился только в нужном managed webhook.
5. Если другой class считается измененным без причины, вернитесь к rules и проверьте source field/class scope.
6. Передайте администратору план применения или примените его, если у вас есть права.

Помните:
- webhook payload плоский;
- для reference/lookup/domain webhook может передавать только числовой id;
- микросервис поднимет leaf по `cmdbPath`, если в rules включен resolver;
- если webhook field отсутствует, rule обычно не сработает, даже если путь есть в catalog.

## Логический контроль

Перед передачей правил администратору выполните:
1. `Логический контроль правил конвертации`.
2. Исправьте критичные ошибки.
3. Проверьте отсутствующие CMDBuild classes/attributes и Zabbix targets.
4. Проверьте, что у каждого мониторингового class есть применимый `hostProfiles[]`.
5. Проверьте template conflicts.
6. Проверьте rules, которые были созданы вручную вне UI.

Если rule частично неконсистентен, его можно удалить или отредактировать. Не удаляйте связанный rule только потому, что он находится рядом в tree: смотрите конкретную причину расхождения.

## Типовые сценарии

### Основной host по IP

1. Class: `КлассКЕ`.
2. Leaf: `КлассКЕ.АтрибутPrimaryIp`.
3. Host profile: `Основной`, IP target.
4. Host group: существующая group или dynamic leaf.
5. Template: совместимый template.
6. Webhook: содержит source key для `АтрибутPrimaryIp`.

### Основной host только по DNS

1. Class: `КлассКЕ`.
2. Leaf: `КлассКЕ.АтрибутDnsName`.
3. Host profile: `Основной`, DNS target.
4. Technical host name строится из стабильной идентичности карточки, а не из DNS, если DNS может изменяться.

### Reference leaf как interface

1. Source path: `КлассКЕ.АтрибутReference.АтрибутLeafIp`.
2. Webhook содержит id `АтрибутReference`.
3. Rules хранит `cmdbPath` до `АтрибутLeafIp`.
4. Converter при событии исходной карточки читает reference target и подставляет leaf.

### Domain leaf как host group

1. Source path: `КлассКЕ.{domain:СвязанныйКласс}.АтрибутГруппы`.
2. Включена UI-галка dynamic host groups.
3. В `zabbixrequests2api` включено `AllowDynamicHostGroupCreate`.
4. Rule target: dynamic from leaf.
5. При первом значении writer создает host group и привязывает host.

### Дополнительный profile для endpoint управления

1. Создайте дополнительный `hostProfile` по `КлассКЕ.АтрибутEndpointIp`.
2. Укажите suffix/profile name, например `management`.
3. Выберите SNMP или другой нужный interface profile.
4. Создайте template rule с ограничением на `hostProfile=management`.
5. Создайте host group/tag rules с тем же ограничением.
6. Проверьте, что в audit после успешного create появилась карточка `ZabbixHostBinding`.

### "Не ставить на мониторинг"

1. Source field: `КлассКЕ.АтрибутMonitoringPolicy`.
2. Rule: `monitoringSuppressionRules`.
3. Regex: значения вроде `do_not_monitor`, `not_monitored`, `false`, `0`.
4. Create/update должны дать skip, delete должен пройти.

## Чеклист перед сохранением rules

- `rulesVersion` обновлен и содержит дату/время.
- Все новые source fields имеют webhook plan.
- Каждый class имеет применимый host profile.
- Дополнительные profiles имеют явные assignments через `hostProfile`.
- Dynamic leaf включен только для Tags/Host groups и только после анализа значений.
- Templates проверены через metadata; conflicts исправлены.
- Domain paths не пишут множественные значения в скалярные Zabbix поля.
- Reference/domain leaf update не ожидается без события исходной карточки.
- Logical Control не показывает критичных ошибок.
- Save-as файл и webhook artifact переданы администратору или опубликованы в согласованном процессе.
