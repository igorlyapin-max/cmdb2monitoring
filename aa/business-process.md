# Бизнес-процесс

## Назначение

Процесс обеспечивает автоматическую постановку, обновление и снятие с мониторинга объектов CMDBuild класса `Computer` и наследников `Notebook`, `PC`, `Server`, `tk`.

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
| monitoring-ui-api | Frontend/BFF для оператора, rules, catalog sync, Events Kafka browser и SAML2 login |
| IdP SAML2 | Единая аутентификация для frontend, CMDBuild и Zabbix в целевой модели |
| Kafka | Асинхронная шина обмена и временный транспорт логов |
| Zabbix | Целевая система мониторинга |
| ELK | Целевая система логирования, пока отсутствует |

## Позитивные сценарии

### Create

1. Пользователь создает карточку `Computer`-наследника в CMDBuild.
2. CMDBuild отправляет webhook `card_create_after`.
3. `cmdbwebhooks2kafka` проверяет Bearer token, нормализует событие и публикует envelope в `cmdbuild.webhooks.*`.
4. `cmdbkafka2zabbix` читает событие, применяет JSON rules и T4-шаблон, публикует `host.create` в `zabbix.host.requests.*`.
5. `zabbixrequests2api` валидирует payload, проверяет host groups/templates/template groups и совместимость расширенных host-полей, вызывает Zabbix API.
6. Zabbix создает host.
7. `zabbixrequests2api` публикует результат в `zabbix.host.responses.*`.

### Update

1. Пользователь изменяет IP, OS, zabbixTag или другие поддерживаемые поля.
2. CMDBuild отправляет webhook `card_update_after`.
3. Если `zabbix_hostid` не передан, `cmdbkafka2zabbix` формирует fallback `host.get` с metadata `fallbackForMethod=host.update` и целевыми `fallbackUpdateParams`.
4. `zabbixrequests2api` выполняет `host.get`, получает `hostid` и `interfaceid`, затем выполняет `host.update`.
5. Результат публикуется в response topic.

### Delete

1. Пользователь удаляет карточку.
2. CMDBuild отправляет webhook `card_delete_after`.
3. Если `zabbix_hostid` не передан, `cmdbkafka2zabbix` формирует fallback `host.get` с metadata `fallbackForMethod=host.delete`.
4. `zabbixrequests2api` выполняет `host.get`, получает `hostid`, затем выполняет `host.delete`.
5. Результат публикуется в response topic.

### Operator UI

1. Оператор открывает `monitoring-ui-api`.
2. Если IdP отключен, оператор вводит CMDBuild и Zabbix credentials; они хранятся только в server-side session.
3. Если IdP включен, оператор проходит SAML2 login через `/auth/saml2/login`, IdP возвращает SAMLResponse на `/auth/saml2/acs`, BFF создает server-side session.
4. Оператор проверяет health микросервисов, синхронизирует Zabbix catalog и CMDBuild catalog, валидирует или загружает rules JSON.
5. Оператор просматривает настроенные Kafka topics на вкладке Events; чтение выполняет BFF, браузер не подключается к Kafka напрямую.
6. `monitoring-ui-api` не обращается из браузера напрямую к CMDBuild, Zabbix или Kafka; все интеграционные вызовы выполняются на стороне BFF.

## Негативные сценарии

| Сценарий | Поведение |
| --- | --- |
| Неверный Bearer token webhook | `cmdbwebhooks2kafka` отклоняет запрос |
| Webhook-сервис слушает только `localhost:5080` | CMDBuild в Docker не может вызвать webhook; dev bind должен быть `0.0.0.0:5080`, URL в CMDBuild `http://192.168.202.100:5080/webhooks/cmdbuild` |
| Некорректный JSON webhook | `cmdbwebhooks2kafka` возвращает ошибку и пишет лог |
| Неизвестный eventType | `cmdbkafka2zabbix` пропускает событие со state `skipReason` |
| Отсутствует обязательное поле | `cmdbkafka2zabbix` пропускает событие или `zabbixrequests2api` публикует validation error |
| Отсутствует Zabbix host group/template | `zabbixrequests2api` не вызывает host.create/host.update и публикует ошибку |
| Передан `inventory`, но `inventory_mode=-1` | Zabbix отклоняет запрос; rules должны использовать `inventory_mode=0` или не передавать inventory |
| Zabbix host не найден для update/delete | `zabbixrequests2api` публикует `host_not_found` |
| Zabbix API недоступен | retry по конфигу, затем error response |
| Kafka publish error | ошибка логируется, offset не коммитится до успешной обработки |
| SAML2 IdP не настроен | `/auth/saml2/login` возвращает конфигурационную ошибку, local login остается доступен только при `Auth:UseIdp=false` |
| SAMLResponse не подписан доверенным IdP cert | `monitoring-ui-api` отклоняет ACS POST и не создает session |
| SAML groups не попали в `RoleMapping` | Пользователь получает роль `readonly` |
| Catalog sync недоступен | UI показывает ошибку BFF, runtime cache не обновляется |

## Вспомогательные процессы

- Загрузка rules-файла из Git-managed JSON.
- Загрузка rules-файла через frontend с серверной валидацией и dry-run.
- Просмотр последних сообщений в настроенных Kafka topics через BFF Events.
- Синхронизация Zabbix catalog: templates, host groups, template groups, known tags.
- Синхронизация расширенного Zabbix catalog: proxies, proxy groups, macros, inventory fields, interface profiles, host statuses, maintenances, TLS/PSK modes, value maps.
- Синхронизация CMDBuild catalog: classes, attributes, lookup values.
- Ведение state-файлов последнего обработанного объекта и восстановление Kafka consumer с `lastInputOffset + 1`.
- Структурное логирование в Kafka topics для будущей интеграции с ELK.
- Проверка конфигураций скриптом `scripts/test-configs.sh`.

## Точки логирования

| Компонент | Событие |
| --- | --- |
| cmdbwebhooks2kafka | Получен webhook, ошибка авторизации, ошибка JSON, публикация в Kafka |
| cmdbkafka2zabbix | Загружены rules, событие сконвертировано, событие пропущено, Kafka publish |
| zabbixrequests2api | JSON-RPC принят, validation error, Zabbix API request/response, response опубликован |
| monitoring-ui-api | Login/logout, SAML2 ACS, settings update, rules validate/upload, catalog sync, Kafka Events read |
