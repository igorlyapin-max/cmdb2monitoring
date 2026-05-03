# План развития тестирования cmdb2monitoring

Дата актуализации: 2026-05-03.

## Цель

Снизить риск регрессий в базовой цепочке `CMDBuild catalog -> UI draft -> conversion rules -> converter -> Zabbix request`. Последняя ошибка с `source.entityClasses` без применимого `hostProfiles[]` показала, что живой E2E ловит проблему слишком поздно, а часть UI-кнопок может завершаться без видимого результата.

## Полный дополнительный набор

| Блок | Количество сценариев |
| --- | ---: |
| JS unit/regression для mapping/rules logic | 12+ |
| .NET unit для `cmdbkafka2zabbix` | 15 |
| .NET unit для `zabbixrequests2api` | 5 |
| JSON contract / fixture tests | 9 |
| Playwright UI tests для Mapping | 20 |
| Playwright UI tests для Webhooks | 10 |
| UI no-silent-action regression | 7 |
| Live E2E smoke для последней ошибки | 2 |
| **Итого** | **80+** |

## Первый пакет

Первый пакет должен ловить самые опасные регрессии без полного живого контура:

- JS unit/regression для mapping/rules logic;
- contract fixture tests для rules/catalog consistency;
- Playwright `No Silent Actions` для активных кнопок;
- несколько Playwright сценариев по Logical Control и Webhook Setup;
- два live smoke для `no_host_profile_matched`.

### Стартовая реализация

Уже начат первый подпакет JS unit/regression:

- pure mapping/rules logic вынесена из `public/app.js` в `public/lib/mapping-logic.mjs`;
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
