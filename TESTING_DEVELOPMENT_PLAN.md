# План развития тестирования cmdb2monitoring

Дата актуализации: 2026-05-04.

## Цель

Снизить риск регрессий в базовой цепочке `CMDBuild catalog -> UI draft -> conversion rules -> converter -> Zabbix request`. Последняя ошибка с `source.entityClasses` без применимого `hostProfiles[]` показала, что живой E2E ловит проблему слишком поздно, а часть UI-кнопок может завершаться без видимого результата.

## Полный дополнительный набор

| Блок | Количество сценариев |
| --- | ---: |
| JS unit/regression для mapping/rules logic | 15+ |
| .NET unit для `cmdbkafka2zabbix` | 15 |
| .NET unit для `zabbixrequests2api` | 8 |
| JSON contract / fixture tests | 10 |
| Playwright UI tests для Mapping | 20 |
| Playwright UI tests для Webhooks | 10 |
| Playwright UI tests для совместимости Zabbix templates | 5 |
| UI no-silent-action regression | 7 |
| Live E2E smoke для последней ошибки | 2 |
| **Итого** | **92+** |

## Первый пакет

Первый пакет должен ловить самые опасные регрессии без полного живого контура:

- JS unit/regression для mapping/rules logic;
- contract fixture tests для rules/catalog consistency;
- Playwright `No Silent Actions` для активных кнопок;
- несколько Playwright сценариев по Logical Control и Webhook Setup;
- два live smoke для `no_host_profile_matched`.

### Стартовая реализация

Уже начат первый подпакет JS unit/regression:

- pure mapping/rules logic вынесена из `public/app.js` в `public/lib/mapping-logic.js`;
- добавлены тесты `src/monitoring-ui-api/test/mapping-logic.test.mjs`;
- запуск: `npm test` или `npm run test:mapping` из `src/monitoring-ui-api`.

Покрытые стартовые сценарии:

1. IP field распознается по `validationRegex`.
2. DNS/FQDN field распознается по alias/metadata.
3. Lookup/reference leaf не принимается за interface address.
4. IP field блокируется для DNS target.
5. DNS field блокируется для IP target.
6. Unknown address field блокируется для IP/DNS target.
7. Совместимые IP/DNS target не блокируются.
8. Domain path считается multi-value.
9. `resolve.collectionMode=first` снимает multi-value запрет.
10. Новый класс с IP leaf получает минимальный `hostProfiles[]`.
11. Новый класс с DNS leaf получает DNS profile.
12. Существующий matching profile не дублируется.
13. Disabled profile не считается matching и может быть заменен.
14. Regex alternatives и global profile корректно матчят class.
15. Dynamic target разрешается только для `tags` и `hostGroups` при явных runtime-флагах.
16. Dynamic target сериализуется как `targetMode=dynamicFromLeaf`, а не как пустой Zabbix target.
17. Dynamic tag/host group helper формирует явный `valueField`, `createIfMissing` и T4 value/name template.
18. Виртуальные поля `hostProfile`/`outputProfile` доступны в add/modify редакторе rules, могут использоваться в `Template rule` как condition и не сериализуются в `source.fields`.

Добавлен .NET regression-набор `tests/cmdbresolver`, входящий в `scripts/test-configs.sh`. Он проверяет, что update исходной карточки перечитывает mutable CMDBuild data через один и тот же экземпляр resolver:

1. Lookup id повторно читается из lookup values и преобразуется в актуальный code.
2. Reference leaf card повторно читается и возвращает новое leaf-значение.
3. Domain leaf card повторно читается через relations и возвращает новое leaf-значение.
4. Обновленное domain leaf значение проходит через converter и попадает в итоговый JSON-RPC `groups[]` как dynamic host group.

Следующий подпакет для dynamic targets:

- Playwright Mapping: при выключенных галках пустой target для `Tag rule`/`Host group rule` не сохраняется, при включенных появляется явный режим `Создавать/расширять из CMDBuild leaf`;
- JSON contract: dynamic rules без `valueField` или с неподдерживаемой conversion structure считаются невалидными;
- configvalidation converter fixture: dynamic tag попадает в `tags[]`, dynamic host group попадает в `groups[]` как name/createIfMissing до Zabbix writer;
- configvalidation Zabbix writer fixture: при первом появлении leaf-группы `hostgroup.create` возвращает `groupid`, и этот `groupid` попадает в тот же `host.create/update` payload; dynamic tags остаются в том же host payload;
- live smoke: существующая host group находится по имени, отсутствующая создается только при `AllowDynamicHostGroupCreate=true`, при выключенном флаге возвращается `auto_expand_disabled`.

Следующий подпакет для Zabbix writer validation:

- .NET unit: конфликт одинакового item key в двух templates возвращает `template_conflict`, `zabbixRequestSent=false` и не вызывает `ExecuteAsync`;
- .NET unit: конфликт одинакового LLD rule key в двух templates возвращает `template_conflict`;
- .NET unit: конфликт одинакового `inventory_link` в двух templates возвращает `template_conflict`;
- .NET unit: update fallback проверяет совместимость уже после merge текущих и целевых templates с учетом `templates_clear`;
- JSON contract: `template_conflict` response содержит конфликтующий key или inventory link, template names/templateids и указание читать `PROJECT_DOCUMENTATION.md` / `PROJECT_DOCUMENTATION.en.md`, section `Zabbix template compatibility`.

Следующий подпакет для UI проверки несовместимых Zabbix templates:

- Playwright Mapping: попытка добавить template rule, который приводит к конфликту item key, LLD rule key или `inventory_link` внутри одного итогового host profile, подсвечивает цепочку красным, блокирует save и показывает конфликтующие templates;
- Playwright Mapping: если конфликт закрыт через `templateConflictRules`/`templates_clear` или выбран совместимый template set, красная подсветка снимается, save становится доступен, а `Undo`/`Redo` отражают изменение draft;
- Playwright Logical Control: существующий rules-файл с несовместимым итоговым template set показывает критичную неконсистентность, дает действия `Edit`, `Delete` и `Cancel` без молчаливого no-op;
- Playwright Zabbix metadata: UI использует metadata из Zabbix catalog/template metadata, а не hardcoded пары templates, и отдельно показывает конфликты item key, LLD rule key и `inventory_link`;
- Playwright Zabbix metadata: кнопки `Sync` и `Load` меняют таблицы/summary/status, показывают Zabbix version и не создают молчаливый no-op при пустом cache;
- Playwright Git Settings: `Read from git`, `RulesFilePath` и `Git repository URL` сохраняются отдельно от Runtime-настроек, `Проверить доступ` показывает resolved path, `schemaVersion` и `rulesVersion`, а уход со страницы с несохраненными изменениями предупреждает оператора;
- UI response view/Event status: response с `errorCode=template_conflict` и `zabbixRequestSent=false` виден оператору с конфликтующим key/template names и указанием читать `PROJECT_DOCUMENTATION.md` / `PROJECT_DOCUMENTATION.en.md`, section `Zabbix template compatibility`.

## UI Regression: No Silent Actions

Отдельное правило для UI-тестов: любая активная кнопка должна либо изменить состояние, либо показать объяснимую ошибку.

Проверяемые последствия:

- draft JSON изменился;
- появился toast/status message;
- изменилось состояние `Undo`/`Redo`/`Save file as`;
- выбранное поле очистилось;
- появилась красная/зеленая/желтая рамка;
- в result panel появился JSON результата;
- кнопка осталась disabled и рядом есть понятное объяснение.

Молчаливый no-op активной кнопки считается падением UI-теста.

Приоритетные кнопки Mapping:

- `Добавить`;
- `Сохранить изменения`;
- `Сбросить поля`;
- `Применить выбранное`;
- `Undo`;
- `Redo`;
- `Save file as`.

## UI Regression: Webhook Visual Diff

Проверить соответствие визуального состояния строк и payload diff логике операций:

- `Создать`: строка и добавляемые payload keys зеленые;
- `Изменить`: строка update, additions зеленые, removals красные, unchanged черные;
- `Удалить`: строка delete красная, delete operations не выбраны по умолчанию;
- раскрытие строки показывает details в ожидаемом месте и с тем же diff;
- `Редактировать` меняет только выбранную operation;
- `Undo/Redo` откатывает selection/edit-plan state;
- повторный analyze после синхронизации не должен массово превращать старые классы в `Изменить`.

## Правило для будущих багов

Каждый исправленный баг получает regression test на самом низком возможном уровне:

- pure function test, если ошибка в rules/mapping logic;
- contract fixture, если ошибка в структуре JSON rules/catalog;
- Playwright test, если ошибка в реакции UI или кнопке;
- live E2E smoke, если ошибка проявляется только в связке сервисов.
