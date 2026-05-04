# План тестирования редактора правил конвертации

## Цель

Проверить, что через интерфейс `Управление правилами конвертации` можно создать весь поддержанный объем правил для произвольной CMDBuild-модели, а ошибочные сочетания CMDBuild source field и Zabbix target блокируются до сохранения rules.

В этом документе generic-примеры используют абстрактные имена:

- `Класс` - имя класса CMDBuild, а не экземпляр карточки.
- `Экземпляр` - конкретная карточка класса, которая приходит в webhook как `id`.
- `АтрибутScalar` - обычный читаемый scalar attribute.
- `АтрибутLookup` - attribute типа lookup.
- `АтрибутReference` - attribute типа reference на другой класс.
- `СвязанныйКласс` - класс второго конца CMDBuild domain.

## Где хранится результат тестирования

Все результаты живых прогонов и ручных сценариев фиксируются в `reports/`.

План развития автоматизированного покрытия хранится отдельно в `TESTING_DEVELOPMENT_PLAN.md`. В нем зафиксированы полный дополнительный набор на 80+ сценариев, первый пакет внедрения, UI-регрессия `No Silent Actions` и проверки визуального diff для `Настройка webhooks`.

Основной автоматизированный E2E runner пишет отчет в файл:

```text
reports/cmdbuild-demo-e2e-<timestamp>.md
```

Ручные проверки, не встроенные в runner, должны сохраняться рядом отдельными markdown-файлами с тем же timestamp или понятным префиксом сценария, например:

- `reports/zabbix-update-merge-<timestamp>.md`;
- `reports/webhook-ui-<timestamp>.md`;
- `reports/mapping-editor-ui-<timestamp>.md`.

## Тестовая CMDBuild-модель

Для воспроизводимой проверки используется отдельная demo-модель под существующим абстрактным классом `CI` / `КЕ`.

Скрипт создания схемы:

```bash
node scripts/cmdbuild-demo-schema.mjs --dry-run
node scripts/cmdbuild-demo-schema.mjs --apply
```

По умолчанию используются:

```bash
CMDBUILD_BASE_URL=http://localhost:8090/cmdbuild/services/rest/v3
CMDBUILD_USERNAME=admin
CMDBUILD_PASSWORD=admin
C2M_DEMO_PREFIX=C2MTest
```

Создаваемые классы:

| Класс | Родитель | Назначение |
| --- | --- | --- |
| `C2MTestCI` | `CI` | Основной тестовый КЕ |
| `C2MTestAddress` | `CI` | Связанный адрес или endpoint |
| `C2MTestReferenceLevel1` | `CI` | Первый уровень reference-цепочки |
| `C2MTestReferenceLevel2` | `CI` | Второй уровень reference-цепочки |

Создаваемые справочники:

| Lookup type | Назначение |
| --- | --- |
| `C2MTestLifecycleState` | production/test/retired/do_not_monitor |
| `C2MTestMonitoringPolicy` | monitor_always/monitor_business_hours/do_not_monitor |
| `C2MTestAddressRole` | primary/extra_interface/separate_profile/backup |
| `C2MTestAddressState` | active/standby/do_not_monitor |

Создаваемые связи:

| Связь | Назначение |
| --- | --- |
| `C2MTestCIAddressDomain` | N:N domain для проверки `Класс.{domain:СвязанныйКласс}.Атрибут` |
| `C2MTestAddressReferenceDomain` | Reference с основного КЕ на адрес |
| `C2MTestReferenceLevel1Domain` | Первый reference-переход |
| `C2MTestReferenceLevel2Domain` | Второй reference-переход |

## Матрица source path

| Сценарий | Абстрактный путь | Ожидаемое поведение UI |
| --- | --- | --- |
| Scalar | `Класс.АтрибутScalar` | Поле доступно для создания rules |
| Lookup | `Класс.АтрибутLookup` | Поле доступно, сохраняется lookup metadata |
| Reference -> scalar | `Класс.АтрибутReference.АтрибутScalar` | UI раскрывает target class reference |
| Reference -> lookup | `Класс.АтрибутReference.АтрибутLookup` | UI сохраняет `cmdbPath` и lookup leaf |
| Reference -> reference -> scalar | `Класс.АтрибутReference1.АтрибутReference2.АтрибутScalar` | UI поддерживает глубокую итерацию |
| Reference -> reference -> lookup | `Класс.АтрибутReference1.АтрибутReference2.АтрибутLookup` | UI поддерживает глубокую итерацию и lookup leaf |
| Domain -> scalar | `Класс.{domain:СвязанныйКласс}.АтрибутScalar` | UI создает domain path |
| Domain -> lookup | `Класс.{domain:СвязанныйКласс}.АтрибутLookup` | UI создает domain path с lookup leaf |
| Domain -> reference -> scalar | `Класс.{domain:СвязанныйКласс}.АтрибутReference.АтрибутScalar` | UI раскрывает reference после domain |
| Domain -> reference -> lookup | `Класс.{domain:СвязанныйКласс}.АтрибутReference.АтрибутLookup` | UI раскрывает reference после domain и сохраняет lookup leaf |

## Матрица Zabbix target

Обычные scalar/reference/lookup поля можно использовать в scalar и selection targets.

Domain path потенциально возвращает несколько значений, поэтому UI обязан:

- разрешать его для selection/list-like rules, где значение используется как условие выбора;
- запрещать для scalar Zabbix structures;
- разрешать scalar target только если поле уже заведено в rules вручную с `resolve.collectionMode=first`.

Скалярные target, где multi-value domain field должен блокироваться:

- `interfaceAddress`;
- `interface`;
- `proxies`;
- `proxyGroups`;
- `hostMacros`;
- `inventoryFields`;
- `interfaceProfiles`;
- `hostStatuses`;
- `tlsPskModes`;
- `valueMaps`.

Для `interfaceAddress` дополнительно проверяется semantic mode: IP-looking field должен быть доступен только для IP target `interfaces[].ip/useip=1`, а DNS/FQDN-looking field - только для DNS target `interfaces[].dns/useip=0`. Негативный тест: выбрать IP-атрибут класса как DNS target; форма должна подсветить field и target красным, показать причину и не дать сохранить rule.

Live E2E runner дополнительно проверяет, что созданные в Zabbix hosts действительно получили назначения из CMDBuild/rules:

- technical host name `host`;
- visible name `name`;
- `interfaces[]`;
- `groups[]`;
- `templates[]`;
- `tags[]`;
- `macros[]`;
- `inventory`;
- `status`;
- TLS/PSK mode.

Отдельные update-сценарии должны проверять сохранение внешних Zabbix назначений и явное отличие `interfaces[]` от merge-полей. Они описаны ниже в разделе `Update-сценарии Zabbix host`.

Zabbix `host.get` не возвращает PSK secret и в dev-контуре может не отдавать PSK identity, поэтому live assertion проверяет примененные поля TLS mode (`tls_connect`, `tls_accept`), а наличие PSK identity остается проверкой request payload/rules.

`proxy`/`proxy group` требуют заранее созданных Zabbix proxy objects, а `maintenance` и `value maps` требуют отдельных Zabbix API operations или dedicated catalog setup. Они не входят в текущий автоматический host-create runner и проверяются отдельными ручными или будущими dedicated E2E сценариями.

## Демонстрационные экземпляры

Порядок запуска, чтобы тестовые объекты появились в CMDBuild:

```bash
node scripts/cmdbuild-demo-schema.mjs --apply
node scripts/cmdbuild-demo-instances.mjs --apply
```

Первый скрипт создает классы, lookup-типы, attributes и domains. Второй создает или обновляет карточки с кодами `C2M-DEMO-*`. Скрипты идемпотентны: повторный запуск не должен плодить дубликаты.

Для предварительного просмотра без записи:

```bash
node scripts/cmdbuild-demo-schema.mjs --dry-run
node scripts/cmdbuild-demo-instances.mjs --dry-run
```

| Code | Что проверяет экземпляр |
| --- | --- |
| `C2M-DEMO-001-SCALAR` | Scalar attribute: путь `Класс.АтрибутScalar` |
| `C2M-DEMO-002-LOOKUP` | Lookup attribute: путь `Класс.АтрибутLookup` |
| `C2M-DEMO-003-REFERENCE-LEAF` | Reference -> scalar: `Класс.АтрибутReference.АтрибутScalar` |
| `C2M-DEMO-004-DEEP-REFERENCE` | Reference -> reference -> scalar/lookup |
| `C2M-DEMO-005-DOMAIN-SINGLE` | Domain -> scalar с одним связанным объектом |
| `C2M-DEMO-006-DOMAIN-MULTI` | Domain -> collection с двумя связанными объектами |
| `C2M-DEMO-007-MULTI-IP-SAME-HOST` | Несколько IP как несколько `interfaces[]` одного Zabbix host |
| `C2M-DEMO-008-SEPARATE-PROFILES` | Несколько IP как отдельные host profiles и отдельные Zabbix hosts |
| `C2M-DEMO-009-DONT-MONITOR-INSTANCE` | Экземпляр не должен ставиться на мониторинг |
| `C2M-DEMO-010-BUSINESS-HOURS` | Тестовая среда: мониторинг только 08:00-18:00 |
| `C2M-DEMO-011-DOMAIN-LEAF-DONT-MONITOR` | Связанный address существует, но leaf помечен как `do_not_monitor` |
| `C2M-DEMO-012-DISABLED-STATUS` | Zabbix host создается, но получает `status=1` через rule |
| `C2M-DEMO-013-DNS-ONLY` | PrimaryIp пустой, объект ставится на мониторинг по DNS hostname через `interfaces[].dns/useip=0` |

## E2E-прогон

После создания схемы и экземпляров можно запустить полный demo-прогон через локальные сервисы `cmdbwebhooks2kafka`, `cmdbkafka2zabbix`, `zabbixrequests2api`, Kafka и Zabbix:

```bash
node scripts/cmdbuild-demo-e2e.mjs --dry-run
node scripts/cmdbuild-demo-e2e.mjs --apply
```

Если нужно автоматически удалить старые demo-hosts `cmdb-c2mtestci-*` перед прогоном, добавляется `--cleanup-zabbix`. Если удаление выполняется вручную в CMDBuild/Zabbix, этот флаг не нужен.

Runner выполняет:

- перечитывание conversion rules через `POST /admin/reload-rules`;
- удаление старых demo-hosts `cmdb-c2mtestci-*` при `--cleanup-zabbix`;
- отправку `create` events в `POST /webhooks/cmdbuild`;
- ожидание Zabbix hosts;
- чтение из Zabbix назначенных `host`, `name`, `interfaces`, `groups`, `parentTemplates`, `tags`, `macros`, `inventory`, `status` и TLS mode;
- генерацию отчета в `reports/cmdbuild-demo-e2e-*.md`.

Ожидаемые Zabbix hosts:

- 12 основных hosts для `C2M-DEMO-001`, `002`, `003`, `004`, `005`, `006`, `007`, `008`, `010`, `011`, `012`, `013`;
- 2 отдельных hosts для `C2M-DEMO-008-SEPARATE-PROFILES`: `separate-profile-1` и `separate-profile-2`;
- host для `C2M-DEMO-009-DONT-MONITOR-INSTANCE` отсутствует.

Точечный запуск одного сценария выполняется через `--code`, например:

```bash
node scripts/cmdbuild-demo-e2e.mjs --apply --cleanup-zabbix --code C2M-DEMO-013-DNS-ONLY
```

Для `C2M-DEMO-013-DNS-ONLY` ожидается Zabbix host `cmdb-c2mtestci-c2m-demo-013-dns-only` с interface `dns=demo-dns-only.example.test`, `useip=0`.

## Update-сценарии Zabbix host

Эти сценарии проверяют последнее изменение поведения `zabbixrequests2api`: часть полей `host.update` должна объединяться с текущим состоянием Zabbix host, а `interfaces[]` остаются authoritative по rules.

Результат проверок сохраняется в `reports/zabbix-update-merge-<timestamp>.md`. Если сценарии запускаются как часть общего E2E runner, соответствующий раздел добавляется в `reports/cmdbuild-demo-e2e-<timestamp>.md`.

Предусловия:

- есть Zabbix host, созданный из demo rules, например основной host для `C2M-DEMO-001-SCALAR`;
- у host есть значения из rules: хотя бы одна group, template, tag, macro и inventory field;
- есть возможность перед update добавить к этому host внешние значения напрямую в Zabbix: дополнительную host group, linked template, tag, macro и inventory field, которых нет в rules.

Сценарий `UPDATE-MERGE-001`: сохранение внешних назначений.

1. Добавить на Zabbix host внешние значения: group, template, tag, macro и inventory field.
2. Выполнить update карточки CMDBuild так, чтобы `cmdbkafka2zabbix` сформировал `host.get -> host.update`.
3. Проверить, что `zabbixrequests2api` перед update прочитал текущий host через `host.get`.
4. Проверить итоговый Zabbix host: значения из rules присутствуют, внешние значения также остались.
5. Ключи с совпадением должны быть переопределены rules: group по `groupid`, template по `templateid`, tag по `tag`, macro по `macro`, inventory по имени поля.

Сценарий `UPDATE-MERGE-002`: `templates_clear` удаляет только реально привязанные конфликтующие templates.

1. Подготовить host с template, который должен быть удален по `templates_clear`.
2. Выполнить update, который выбирает конфликтующий целевой template и формирует `templates_clear`.
3. Проверить, что из Zabbix удален только template, реально привязанный к host и попавший в `templates_clear`.
4. Проверить, что unrelated templates, добавленные вручную и не указанные в `templates_clear`, остались на host.

Сценарий `UPDATE-MERGE-003`: прямой `host.update` с `hostid` и merge-полями.

1. Отправить в `zabbix.host.requests.dev` прямой JSON-RPC `host.update` с `hostid`, `groups[]`, `templates[]`, `tags[]`, `macros[]` или `inventory`.
2. Проверить, что сервис выполняет внутренний `host.get` по `hostids` перед фактическим update.
3. Проверить, что итоговый update сохраняет внешние значения так же, как fallback `host.get -> host.update`.
4. Проверить, что `host.get` с `hostids` проходит validation.

Сценарий `UPDATE-MERGE-004`: `interfaces[]` не являются merge-полем.

1. Добавить на Zabbix host внешний interface, которого нет в rules.
2. Выполнить update карточки CMDBuild.
3. Проверить, что итоговый состав `interfaces[]` соответствует rules, а не union текущих и желаемых interfaces.
4. Проверить, что для существующих interfaces writer переносит `interfaceid`, чтобы смена IP/DNS обновляла текущий interface, а не создавала новый host.

Сценарий `UPDATE-MERGE-005`: смена IP основного interface.

1. Создать host с исходным `PrimaryIp`.
2. Изменить `PrimaryIp` у карточки CMDBuild.
3. Выполнить update-событие.
4. Проверить, что host найден по technical host name, а не по IP.
5. Проверить, что первый существующий `interfaceid` использован для update и Zabbix host не задублирован.

## Проверка webhooks через UI

Цель: подтвердить, что `Настройка webhooks` создает и меняет только те CMDBuild webhook records, которые реально следуют из текущих rules, а события начинают поступать в систему после применения плана.

Предварительная очистка:

- удалить из CMDBuild все managed webhooks с префиксом `cmdbwebhooks2kafka-*`;
- удалить или сбросить тестовые rules/объекты, которые планируется пересоздавать в сценарии;
- оставить unmanaged webhooks без этого префикса нетронутыми;
- после очистки открыть `Настройка webhooks`, нажать `Загрузить из CMDB` и убедиться, что managed records отсутствуют либо не участвуют в плане.

Создание webhooks через интерфейс:

1. Подготовить rules через `Управление правилами конвертации` или загрузить проверяемый rules-файл.
2. Открыть `Настройка webhooks`.
3. Нажать `Загрузить из CMDB`.
4. Нажать `Проанализировать rules`.
5. Проверить, что для классов из текущих rules появились операции `Создать` на нужные события `create/update/delete`.
6. Проверить, что операции `Изменить` отсутствуют для классов, которые не менялись, и что unmanaged webhooks не предлагаются к изменению или удалению.
7. Проверить summary `Требования webhooks по rules`: количество классов и payload-полей должно соответствовать rules, а не всем атрибутам CMDBuild catalog.
8. Раскрыть payload и `Детали` для нескольких строк: body должен быть плоским, без duplicate keys с другим регистром или alias; в деталях должны быть видны `webhook requirements from rules` и, если payload неполный, `missing payload requirements` с именами правил.
9. Нажать `Загрузить в CMDB` и подтвердить применение.
10. Повторно нажать `Загрузить из CMDB` и `Проанализировать rules`.
11. Ожидаемый результат: план пуст, либо содержит только осознанные изменения текущего сценария; ранее созданные records не должны повторно предлагаться как `Изменить`.

Проверка поступления данных:

1. Через CMDBuild UI или demo script создать/изменить тестовую карточку проверяемого класса.
2. В `События` проверить появление сообщения в `cmdbuild.webhooks.dev`.
3. Проверить, что envelope содержит `className`, `eventType`, `id/code` и настроенные source keys.
4. Проверить дальнейший поток: `zabbix.host.requests.dev` получает request, а `zabbix.host.responses.dev` получает ответ Zabbix API.
5. Для delete-события проверить, что событие также приходит, а suppression rules для "не ставить на мониторинг" не блокируют снятие с мониторинга.

Регрессия "добавлен новый класс":

1. Взять состояние, где webhooks уже синхронизированы и повторный анализ дает пустой план.
2. Через `Управление правилами конвертации` добавить новый класс `НовыйКласс` и минимальный набор rules/source fields только для него.
3. Открыть `Настройка webhooks`, выполнить `Загрузить из CMDB` и `Проанализировать rules`.
4. Ожидаемый результат: план содержит `Создать` только для `НовыйКласс` и нужных событий.
5. Не должно быть `Изменить` для старых классов ни полностью, ни частично: body, event, target, method, url, headers, active и language старых records должны оставаться без diff.
6. Payload старых классов не должен получать поля, относящиеся к `НовыйКласс`, например `НовыйАтрибут` или reference/domain leaf другого класса.

Регрессия "добавлен атрибут в существующий класс":

1. Взять состояние, где webhooks уже синхронизированы и повторный анализ дает пустой план.
2. В CMDBuild добавить или выбрать атрибут `НовыйАтрибут` только у `КлассА`.
3. Через `Управление правилами конвертации` добавить source field и rule, которые используют `КлассА.НовыйАтрибут`.
4. Открыть `Настройка webhooks`, выполнить `Загрузить из CMDB` и `Проанализировать rules`.
5. Ожидаемый результат: `Изменить` появляется только для webhook records класса `КлассА` и только по body/payload части, где добавлен source key для `НовыйАтрибут`.
6. Для всех остальных классов план пуст: не должно быть добавления `НовыйАтрибут`, изменения lookup/reference/domain path или любых unrelated source fields.
7. После `Загрузить в CMDB` создать или изменить карточку `КлассА` и проверить, что новый source key приходит в `cmdbuild.webhooks.dev`.
8. Создать или изменить карточку другого класса и проверить, что новый source key в ее webhook payload отсутствует.

Регрессия "leaf через reference/domain":

1. В rules добавить source field `КлассА.АтрибутReference.АтрибутLeaf` и rule, который реально использует этот field.
2. Выполнить `Загрузить из CMDB` и `Проанализировать rules`.
3. Ожидаемый результат для reference/lookup path: в payload добавляется только source key этого field со значением `{card:АтрибутReference}`; конечный leaf не добавляется отдельным webhook placeholder.
4. В rules добавить source field `КлассА.{domain:КлассБ}.АтрибутLeaf` и rule, который его использует.
5. Ожидаемый результат для domain path: в payload добавляется source key этого field со значением `{card:Id}`, а `cmdbPath` остается metadata для converter.
6. В `Логический контроль правил конвертации` при уже загруженных CMDBuild webhooks должны появиться предупреждения, если managed webhook отсутствует или не передает payload-поля, требуемые rules.

## Сценарий отказа от мониторинга по атрибутам

Этот сценарий проверяет не отсутствие данных, а осознанное решение правил: экземпляр CMDBuild прочитан корректно, но по значениям его атрибутов мониторинг создавать нельзя.

Проверочный экземпляр:

- `C2M-DEMO-009-DONT-MONITOR-INSTANCE`;
- `MonitoringPolicy = do_not_monitor`;
- `LifecycleState = do_not_monitor`;
- `PrimaryIp` заполнен валидным IP, чтобы skip нельзя было спутать с ошибкой `missing_interface_address`.

Ожидаемое поведение:

- UI позволяет создать source fields для `Класс.АтрибутMonitoringPolicy` и `Класс.АтрибутLifecycleState`;
- rules сохраняют эти поля как обычные condition fields, при lookup-id из webhook рядом должен быть сохранен `cmdbPath/resolve`, чтобы converter получил code `do_not_monitor`;
- `monitoringSuppressionRules` срабатывает на `create/update`;
- `cmdbkafka2zabbix` возвращает skip reason `monitoring_suppressed:object-policy-do-not-monitor:object_policy_do_not_monitor`;
- сообщение в topic Zabbix requests не публикуется;
- в Zabbix не появляется host для этого экземпляра;
- `delete` не подавляется suppression rule, чтобы ранее созданный host можно было снять с мониторинга.

Отдельный leaf-сценарий:

- `C2M-DEMO-011-DOMAIN-LEAF-DONT-MONITOR`;
- основной КЕ разрешен к мониторингу, поэтому это не сценарий "не ставить на мониторинг" весь объект;
- связанный объект через domain имеет `AddressState = do_not_monitor`;
- правила должны использовать этот leaf как точку выбора: такой address не попадает в отдельный profile/interface, но сама карточка КЕ может продолжить обрабатываться по другим разрешенным адресам;
- этот leaf-флаг не должен "остановить мониторинг объекта": в Zabbix host должен присутствовать, а interface со связанным address должен отсутствовать.

Отдельный статусный сценарий:

- `C2M-DEMO-012-DISABLED-STATUS`;
- основной КЕ разрешен к мониторингу, поэтому suppression rule не должен сработать;
- `hostStatusSelectionRules` должен передать в Zabbix `status=1`;
- в отчете host присутствует, но его Zabbix status равен `disabled (1)`.

## Проверка через UI

1. Запустить schema script с `--apply`.
2. Запустить instances script с `--apply`.
3. В `monitoring-ui-api` выполнить `CMDBuild Catalog -> Sync`.
4. Открыть `Управление правилами конвертации`.
5. Включить edit mode и проверить, что нижний трехколоночный просмотр CMDBuild -> rules -> Zabbix скрыт.
6. Проверить меню классов: hierarchy отображается с отступами, superclass/prototype classes недоступны для выбора, а попытка открыть rule на superclass переводит форму на ближайший конкретный subclass.
7. Выбрать `C2MTestCI`.
8. Проверить наличие путей:
   - `C2MTestCI.PrimaryIp`;
   - `C2MTestCI.LifecycleState`;
   - `C2MTestCI.AddressRef.AddressValue`;
   - `C2MTestCI.Reference1.Reference2.LeafIp`;
   - `C2MTestCI.{domain:C2MTestAddress}.AddressValue`.
9. Для каждого path создать rule в подходящий Zabbix target.
10. Выбрать действие `Модификация правила` и проверить, что первое rule из списка не выбирается автоматически.
11. Начать модификацию не с rule, а с CMDBuild class; проверить, что списки rule/field/conversion structure/Zabbix target сузились до связанных значений, а единственный matching rule выбирается автоматически.
12. Повторить старт модификации с class attribute field и с conversion structure: связанные списки должны сужаться, неоднозначные варианты остаются для ручного выбора.
13. Открыть одно из созданных или demo rules, изменить target/priority/regex/name, сохранить и проверить изменение в draft JSON.
14. Проверить `Сбросить поля`: после ручных изменений в модификации должны очиститься выбранное rule, class, field, conversion structure и target; в режиме добавления должны очищаться leaf field и Zabbix target.
15. Проверить каскадную логику: смена class очищает leaf field и target, смена field фильтрует conversion structures, смена conversion structure фильтрует fields/targets.
16. Проверить статусы формы: зеленая рамка для совместимых значений, красная для обязательного выбора или конфликта, желтая для значения из rule, не подтвержденного текущим catalog/filter; `Сохранить изменения` активна только в валидном состоянии.
17. Проверить `Undo`: последнее изменение правила должно полностью откатиться в draft JSON, включая target/priority/regex/name и перенос между rule collections, если менялась conversion structure.
18. Проверить `Redo`: отмененное изменение должно полностью вернуться, список rules и выбранное rule должны соответствовать состоянию после модификации.
19. Проверить draft JSON: `source.fields[].cmdbPath`, `resolve.mode`, lookup metadata, `collectionMode`.
20. Проверить negative-сценарии: domain multi-value field не должен быть доступен для scalar targets.
21. Создать или проверить `monitoringSuppressionRules` для `MonitoringPolicy=do_not_monitor`.
22. Проверить negative-сценарий interface address: неподтвержденный адресный field не должен сохраняться как IP/DNS interface, пока не задано явное IP/DNS имя/source metadata или `validationRegex`.
23. Добавить rule для нового конкретного CMDBuild класса из текущего catalog, у которого в правилах еще нет `hostProfiles[]`: выбрать IP или DNS leaf, сохранить rule и проверить, что draft JSON получил `source.entityClasses`, `source.fields`, selection rule и минимальный `hostProfiles[]` с condition по `className`.
24. Добавить `Template rule` с виртуальным field `hostProfile`, regex по имени fan-out profile и выбранным template; проверить, что rule condition создана по `hostProfile`, а `source.fields.hostProfile` не появился в draft JSON.
25. Для дополнительного profile выбрать его в блоке `Профили мониторинга`, добавить `Template rule` с основным условием по обычному class attribute field, например `description` + regex `(?i).*`, включить `Ограничить правило выбранным hostProfile` и сохранить. Проверить, что счетчик `Назначения` у profile увеличился, а rule содержит оба условия `description` и `hostProfile`.
26. Удалить или временно отключить этот `hostProfiles[]` только в draft JSON и запустить логический контроль правил конвертации: класс должен подсветиться как ошибка rules с действием `Создать host profile`, а применение выбранного действия должно восстановить profile через общий undo/redo поток.
27. Запустить логический контроль правил конвертации.
28. Выполнить `Save file as` и проверить, что webhook body остается плоским, а path metadata сохраняется рядом с source key.

## Критерий приемки

Функция считается проверенной, когда для каждой строки матрицы выполнена цепочка:

```text
CMDBuild catalog -> Mapping editor option -> Add/Modify rule -> draft JSON -> validation -> webhook metadata -> converter dry-run/e2e
```

Отдельно должны быть подтверждены запреты:

- multi-value domain field не связывается со scalar Zabbix target;
- unrelated domain не показывается для выбранного класса;
- superclass/prototype class не выбирается как class правила;
- первое rule не выбирается автоматически при входе в `Модификация правила`;
- модификацию можно начать с rule, CMDBuild class, class attribute field или conversion structure; связанные списки фильтруются, единственный matching rule выбирается автоматически;
- новый конкретный CMDBuild class не остается только в `source.entityClasses`: для него создается или явно диагностируется недостающий `hostProfiles[]`, иначе converter пропустил бы событие с `no_host_profile_matched`;
- webhook-план после синхронизации пуст, а добавление нового класса или атрибута меняет только соответствующие managed webhooks;
- webhook payload старых классов не получает source keys нового класса или атрибута;
- CMDBuild события после применения webhooks приходят в `cmdbuild.webhooks.dev` и проходят дальше до Zabbix request/response topics;
- update Zabbix host сохраняет внешние `groups[]`, `templates[]`, `tags[]`, `macros[]` и `inventory`, если rules их явно не заменяют;
- `templates_clear` удаляет только реально linked templates, указанные как конфликтующие;
- прямой `host.update` с `hostid` и merge-полями проходит через внутренний `host.get` по `hostids`;
- `interfaces[]` остаются authoritative по rules и не объединяются с внешними interfaces;
- сохранение модификации недоступно, пока не выбран однозначный leaf/source field и совместимый Zabbix target;
- target, отсутствующий в Zabbix catalog/options, подсвечивается красным и блокирует сохранение как неконсистентная вторая сторона цепочки;
- `Сбросить поля` очищает выбранное rule и фильтры без побочных изменений draft JSON;
- `Undo` и `Redo` корректно откатывают и возвращают добавление, модификацию и удаление rules без потери draft JSON;
- reference path не раскрывается бесконечно при циклах;
- path глубже лимита не предлагается;
- экземпляры и связанные leaf-объекты с policy/state `do_not_monitor` используются как точки выбора для rules, а не как обязательные объекты мониторинга.
