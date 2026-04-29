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
| Kafka | Асинхронная шина обмена и временный транспорт логов |
| Zabbix | Целевая система мониторинга |
| ELK | Целевая система логирования, пока отсутствует |

## Позитивные сценарии

### Create

1. Пользователь создает карточку `Computer`-наследника в CMDBuild.
2. CMDBuild отправляет webhook `card_create_after`.
3. `cmdbwebhooks2kafka` проверяет Bearer token, нормализует событие и публикует envelope в `cmdbuild.webhooks.*`.
4. `cmdbkafka2zabbix` читает событие, применяет JSON rules и T4-шаблон, публикует `host.create` в `zabbix.host.requests.*`.
5. `zabbixrequests2api` валидирует payload, проверяет host groups/templates/template groups, вызывает Zabbix API.
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

## Негативные сценарии

| Сценарий | Поведение |
| --- | --- |
| Неверный Bearer token webhook | `cmdbwebhooks2kafka` отклоняет запрос |
| Некорректный JSON webhook | `cmdbwebhooks2kafka` возвращает ошибку и пишет лог |
| Неизвестный eventType | `cmdbkafka2zabbix` пропускает событие со state `skipReason` |
| Отсутствует обязательное поле | `cmdbkafka2zabbix` пропускает событие или `zabbixrequests2api` публикует validation error |
| Отсутствует Zabbix host group/template | `zabbixrequests2api` не вызывает host.create/host.update и публикует ошибку |
| Zabbix host не найден для update/delete | `zabbixrequests2api` публикует `host_not_found` |
| Zabbix API недоступен | retry по конфигу, затем error response |
| Kafka publish error | ошибка логируется, offset не коммитится до успешной обработки |

## Вспомогательные процессы

- Загрузка rules-файла из Git-managed JSON.
- Ведение state-файлов последнего обработанного объекта.
- Структурное логирование в Kafka topics для будущей интеграции с ELK.
- Проверка конфигураций скриптом `scripts/test-configs.sh`.

## Точки логирования

| Компонент | Событие |
| --- | --- |
| cmdbwebhooks2kafka | Получен webhook, ошибка авторизации, ошибка JSON, публикация в Kafka |
| cmdbkafka2zabbix | Загружены rules, событие сконвертировано, событие пропущено, Kafka publish |
| zabbixrequests2api | JSON-RPC принят, validation error, Zabbix API request/response, response опубликован |
