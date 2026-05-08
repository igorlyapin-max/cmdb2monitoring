# Бизнес-процесс

## Назначение

Процесс обеспечивает автоматическую постановку, обновление и снятие с мониторинга объектов CMDBuild, классы и атрибуты которых описаны в rules и webhook body. Текущие `Computer`, `Notebook`, `PC`, `Server`, `tk` являются примером dev-модели, а не встроенным ограничением продукта.

Пользователь работает с CMDBuild через веб-интерфейс. Микросервисы получают события не от пользователя напрямую, а через webhook CMDBuild.

## Участники

| Участник | Роль |
| --- | --- |
| Пользователь CMDBuild | Создает, изменяет или удаляет карточки оборудования |
| CMDBuild Web UI | Клиентское приложение пользователя |
| CMDBuild | Источник webhook-событий |
| cmdbwebhooks2kafka | Прием и нормализация webhook |
| cmdbkafka2zabbix | Конвертация CMDB-события в Zabbix JSON-RPC |
| zabbixrequests2api | Вызов Zabbix API и публикация результата |
| zabbixbindings2cmdbuild | Обратная запись связи CMDBuild card/profile -> Zabbix hostid |
| monitoring-ui-api | Frontend/BFF для оператора, rules, catalog sync, настройка CMDBuild webhooks, Events Kafka browser, authorization menu и runtime settings |
| IdP / MS AD | Внешняя аутентификация через SAML2, OAuth2/OIDC или LDAP/LDAPS; MS AD также дает группы для назначения ролей |
| Kafka | Асинхронная шина обмена и временный транспорт логов |
| Zabbix | Целевая система мониторинга |
| ELK | Целевая система логирования, пока отсутствует |

## Повторно используемые подпроцессы

| ID | Подпроцесс | Где используется |
| --- | --- | --- |
| SP-001 | Проверка Bearer token, нормализация CMDBuild webhook и публикация в Kafka | Create, Update, Delete |
| SP-002 | Чтение Kafka-события, подъем lookup/reference/domain leaf через `cmdbPath`, применение rules JSON, regex-выборов и T4-шаблонов | Create, Update, Delete |
| SP-003 | Валидация Zabbix payload по catalog cache: host groups, templates, template groups, tags и расширенные host-поля | Create, Update |
| SP-004 | Fallback-поиск Zabbix host через `host.get`, если `zabbix_hostid` отсутствует | Update, Delete |
| SP-005 | Вызов Zabbix JSON-RPC, публикация response topic, запись state-файла и offset | Create, Update, Delete |
| SP-006 | Синхронизация catalog cache CMDBuild/Zabbix через `monitoring-ui-api` | Operator UI, `Логический контроль правил конвертации`, `Управление правилами конвертации` |
| SP-007 | Валидация, dry-run, backup и сохранение rules JSON через `monitoring-ui-api` | Operator UI, `Логический контроль правил конвертации` |
| SP-008 | Визуальное управление rules: add/delete, reference drill-down, undo/redo, save-as draft/webhook instructions | `Управление правилами конвертации` |
| SP-009 | Локализация frontend: язык `ru/en`, Help и всплывающие подсказки | Login, меню UI, Help |
| SP-010 | Чтение CMDBuild ETL/webhooks, анализ rules и применение выбранного create/update/delete плана | `Настройка webhooks` |
| SP-011 | Публикация binding event и запись `zabbix_main_hostid`/`ZabbixHostBinding` в CMDBuild | Create, Update, Delete |

## Позитивные сценарии

### Create

1. Пользователь создает карточку CMDBuild класса, включенного в rules.
2. CMDBuild отправляет webhook `card_create_after`.
3. `cmdbwebhooks2kafka` проверяет Bearer token, нормализует событие и публикует envelope в `cmdbuild.webhooks.*`.
4. `cmdbkafka2zabbix` читает событие, при необходимости поднимает scalar/lookup/reference/domain leaf по `source.fields[].cmdbPath` через CMDBuild REST, применяет JSON rules, `hostProfiles[]` и T4-шаблон, публикует один или несколько `host.create` в `zabbix.host.requests.*`.
5. `zabbixrequests2api` валидирует payload, проверяет host groups/templates/template groups и совместимость расширенных host-полей, вызывает Zabbix API.
6. Zabbix создает host.
7. `zabbixrequests2api` публикует результат в `zabbix.host.responses.*` и binding event в `zabbix.host.bindings.*`.
8. `zabbixbindings2cmdbuild` записывает `zabbix_main_hostid` для основного профиля или карточку `ZabbixHostBinding` для дополнительного профиля.

### Update

1. Пользователь изменяет IP/DNS, lookup/reference/domain или другие поля, описанные в rules.
2. CMDBuild отправляет webhook `card_update_after`.
3. Если explicit `zabbix_hostid` не передан, `cmdbkafka2zabbix` сначала ищет hostid в CMDBuild: `zabbix_main_hostid` для основного профиля или `ZabbixHostBinding` для дополнительного профиля.
4. Если сохраненный hostid найден, `cmdbkafka2zabbix` формирует прямой `host.update`; если не найден, формирует fallback `host.get` с metadata `hostProfile`, `fallbackForMethod=host.update` и целевыми `fallbackUpdateParams`.
5. `zabbixrequests2api` выполняет прямой `host.update` или сначала `host.get`, получает `hostid`, существующие `interfaceid` и текущие назначения host. Затем он выполняет `host.update`: `interfaces[]` сопоставляются по type/ip/dns/port и остаются authoritative по rules, а `groups[]`, `templates[]`, `tags[]`, `macros[]` и `inventory` объединяются с текущими значениями Zabbix host, чтобы внешние назначения не удалялись.
6. Результат публикуется в response topic, а binding event обновляет audit-связь в CMDBuild.

### Delete

1. Пользователь удаляет карточку.
2. CMDBuild отправляет webhook `card_delete_after`.
3. Если explicit `zabbix_hostid` не передан, `cmdbkafka2zabbix` сначала ищет hostid в CMDBuild binding-данных.
4. Если сохраненный hostid найден, `cmdbkafka2zabbix` формирует прямой `host.delete`; если не найден, формирует fallback `host.get` с metadata `fallbackForMethod=host.delete`.
5. `zabbixrequests2api` выполняет прямой `host.delete` или сначала `host.get`, получает `hostid`, затем выполняет `host.delete`.
6. Результат публикуется в response topic, а binding event очищает `zabbix_main_hostid` или помечает дополнительную связь как `deleted`.

### Operator UI

1. Оператор открывает `monitoring-ui-api`.
2. В режиме `Локальная` оператор входит пользователем `viewer`, `editor` или `admin`; CMDBuild/Zabbix credentials запрашиваются только при первой операции с соответствующим API и хранятся в server-side session.
3. В режиме `MS AD` оператор вводит login/password в UI, BFF проверяет их через LDAP/LDAPS bind и назначает роли по AD-группам.
4. В режиме `IdP` оператор проходит SAML2 `/auth/saml2/login` -> `/auth/saml2/acs` или OAuth2 `/auth/oauth2/login` -> `/auth/oauth2/callback`; IdP идентифицирует пользователя, а BFF при настроенном LDAP service bind читает AD-группы для назначения роли.
4. Оператор выбирает язык интерфейса на форме входа; выбор сохраняется в cookie и применяется к меню, Help и всплывающим подсказкам.
5. Оператор проверяет health микросервисов, синхронизирует Zabbix catalog и CMDBuild catalog, валидирует или загружает rules JSON в пределах своей роли.
6. Оператор просматривает настроенные Kafka topics на вкладке Events; чтение выполняет BFF, браузер не подключается к Kafka напрямую.
7. Оператор использует `Управление правилами конвертации` для добавления или удаления rules в draft JSON, раскрывает reference attributes и domain-связи до leaf-полей, проверяет IP/DNS consistency и сохраняет draft через `Save file as`.
8. `Save file as` формирует два локальных файла: draft rules JSON и `*-webhook-bodies.txt` только по добавленным/удаленным в текущей сессии rules/classes/source fields. Для reference/lookup/domain webhook Body остается плоским, а путь leaf сохраняется в `source.fields[].cmdbPath`.
9. Оператор роли `editor` или `admin` открывает `Настройка webhooks`, загружает текущие CMDBuild webhooks, анализирует rules, выбирает операции create/update/delete и при необходимости нажимает `Загрузить в CMDB`. Только эта команда действительно меняет CMDBuild webhook records.
10. Оператор роли `editor` или `admin` может нажать `Перечитать правила конвертации` в карточке `cmdbkafka2zabbix`; BFF отправляет Bearer-authorized reload signal на `cmdbkafka2zabbix`.
11. `monitoring-ui-api` не обращается из браузера напрямую к CMDBuild, Zabbix или Kafka; все интеграционные вызовы выполняются на стороне BFF.

## Негативные сценарии

| Сценарий | Поведение |
| --- | --- |
| Неверный или отсутствующий Bearer token webhook | `cmdbwebhooks2kafka` возвращает `401` и не публикует событие в Kafka |
| Webhook-сервис слушает только `localhost:5080` | CMDBuild в Docker не может вызвать webhook; dev bind должен быть `0.0.0.0:5080`, URL в CMDBuild `http://192.168.202.100:5080/webhooks/cmdbuild` |
| Некорректный JSON webhook | `cmdbwebhooks2kafka` возвращает ошибку и пишет лог |
| Неизвестный eventType | `cmdbkafka2zabbix` пропускает событие со state `skipReason` |
| Отсутствует обязательное поле | `cmdbkafka2zabbix` пропускает событие или `zabbixrequests2api` публикует validation error |
| Отсутствует Zabbix host group/template | `zabbixrequests2api` не вызывает host.create/host.update и публикует ошибку |
| Передан `inventory`, но `inventory_mode=-1` | Zabbix отклоняет запрос; rules должны использовать `inventory_mode=0` или не передавать inventory |
| Zabbix host не найден для update | Если request metadata содержит `createOnUpdateWhenMissing=true` и `fallbackCreateParams`, `zabbixrequests2api` выполняет `host.create`; иначе публикует `host_not_found` |
| Zabbix host не найден для delete | `zabbixrequests2api` публикует `host_not_found` |
| Zabbix API недоступен | retry по конфигу, затем error response |
| Kafka publish error | ошибка логируется, offset не коммитится до успешной обработки |
| Binding event не опубликован после успешного Zabbix API | ошибка логируется, основной response/offset не откатывается, чтобы не повторить Zabbix write; восстановление binding выполняется операционно |
| CMDBuild недоступен для `zabbixbindings2cmdbuild` | binding offset не коммитится, событие повторяется после восстановления сервиса/CMDBuild |
| CMDBuild resolver не настроен для `cmdbPath` | `cmdbkafka2zabbix` пишет warning и оставляет исходный numeric id/scalar value |
| Reference/domain path содержит цикл или глубже `Cmdbuild:MaxPathDepth` | `cmdbkafka2zabbix` пишет warning по полю и продолжает обработку с исходным значением |
| Rules reload token не настроен или неверный | `cmdbkafka2zabbix` отклоняет `POST /admin/reload-rules`, BFF показывает ошибку оператору |
| Git pull при reload не прошел | Reload endpoint возвращает ошибку, текущий cached rules остается последней успешно загруженной версией |
| Rules reload прошел, но UI не может перечитать текущий rules-файл | BFF возвращает ошибку чтения `/api/rules/current`, действие на Панели не завершается как "готово" до обновления данных файла |
| IdP не настроен | SAML2/OAuth2 endpoint или LDAP login возвращает конфигурационную ошибку, local login остается доступен только при `Auth:UseIdp=false` |
| SAMLResponse не подписан доверенным IdP cert | `monitoring-ui-api` отклоняет ACS POST и не создает session |
| AD/IdP группы не найдены или группы не попали в `RoleMapping` | Пользователь получает роль `viewer` |
| Catalog sync недоступен | UI показывает ошибку BFF, runtime cache не обновляется |
| Применение webhooks без CMDBuild modify прав | BFF возвращает ошибку CMDBuild API; план остается в UI и может быть сохранен через браузер |
| План webhooks содержит чужой code без префикса `cmdbwebhooks2kafka-` | Backend отклоняет apply, чтобы не изменить посторонние CMDBuild webhooks |
| План webhooks подменяет `current.id` для update/delete | Backend перед применением перечитывает CMDBuild `/etl/webhook/?detailed=true` и применяет операцию только к найденной managed-записи с тем же `code` |
| Правило в `Управление правилами конвертации` добавляет класс без IP/DNS binding | UI показывает предупреждение save validation; `Save file as` требует подтверждения перед сохранением |
| CMDBuild class name записан как `NetworkDevice`, а catalog содержит `Network device` | UI нормализует имя класса и предпочитает отображение из CMDBuild catalog |
| Переключен язык интерфейса | Меню, Help и всплывающие подсказки перестраиваются по словарю `ru/en`; серверные контракты не меняются |

## Вспомогательные процессы

- Загрузка rules-файла из Git-managed JSON.
- Загрузка rules-файла через frontend с серверной валидацией и dry-run.
- Просмотр последних сообщений в настроенных Kafka topics через BFF Events.
- Синхронизация Zabbix catalog: templates, host groups, template groups, known tags.
- Синхронизация расширенного Zabbix catalog: proxies, proxy groups, macros, inventory fields, interface profiles, host statuses, maintenances, TLS/PSK modes, value maps.
- Синхронизация CMDBuild catalog: classes, attributes, lookup values.
- `Управление правилами конвертации`: добавление rules, удаление rules по группам, раскрытие reference attributes до leaf-полей, undo/redo, локальный save-as draft JSON и webhook-инструкций.
- `Логический контроль правил конвертации`: проверка rules против актуальных catalog cache и удаление выбранных некорректных элементов после подтверждения.
- `Настройка webhooks`: чтение текущих CMDBuild webhooks, построение плана create/update/delete по rules, локальный save-as JSON-плана и явное применение выбранных операций в CMDBuild.
- Переключение языка интерфейса `ru/en` с сохранением в cookie и синхронным переводом Help/tooltip-текстов.
- Перечитывание conversion rules через provider abstraction и dashboard-кнопку `Перечитать правила конвертации`.
- Обратная запись binding-ов `CMDBuild card/profile -> Zabbix hostid` в CMDBuild после успешной записи в Zabbix.
- Назначение UI-ролей по таблице соответствия `admin/editor/viewer` группам IdP/AD.
- Ведение state-файлов последнего обработанного объекта и восстановление Kafka consumer с `lastInputOffset + 1`.
- Структурное логирование в Kafka topics для будущей интеграции с ELK.
- Проверка конфигураций скриптом `scripts/test-configs.sh`.

## Точки логирования

| Компонент | Событие |
| --- | --- |
| cmdbwebhooks2kafka | Получен webhook, ошибка авторизации, ошибка JSON, публикация в Kafka |
| cmdbkafka2zabbix | Загружены rules, событие сконвертировано, событие пропущено, Kafka publish |
| zabbixrequests2api | JSON-RPC принят, validation error, Zabbix API request/response, response опубликован, binding event опубликован/пропущен |
| zabbixbindings2cmdbuild | Binding event принят, `zabbix_main_hostid` записан/очищен, `ZabbixHostBinding` создан/обновлен, ошибка CMDBuild write |
| monitoring-ui-api | Login/logout, SAML2 ACS, OAuth2 callback, LDAP login, settings update, rules validate/upload, rules reload signal, catalog sync, Kafka Events read |
