import {
  canonicalSourceField,
  classHasHostProfile,
  cmdbPathIncludesDomain,
  ensureMinimalHostProfileForClass,
  escapeRegex,
  interfaceAddressCompatibilityIssue,
  minimalHostProfileInterfaceMode,
  normalizeRuleName,
  normalizeToken,
  regexLiteralValues,
  ruleClassConditions,
  sameNormalized,
  sourceFieldMayReturnMultiple,
  uniqueTokens
} from './lib/mapping-logic.js';

const state = {
  currentRules: null,
  uploadedRulesText: null,
  runtimeSettings: null,
  mappingMode: 'view',
  mappingEditAction: 'add',
  mappingDeleteView: 'cmdbuild',
  mappingDraftRules: null,
  mappingHistory: [],
  mappingHistoryIndex: -1,
  mappingCmdbuildCatalog: null,
  mappingZabbixCatalog: null,
  mappingEditorFieldOptions: new Map(),
  mappingEditorFieldOptionStates: new Map(),
  mappingEditorTargetOptionStates: new Map(),
  mappingLoaded: false,
  validateMappingLoaded: false,
  validateMappingRules: null,
  validateMappingHistory: [],
  validateMappingHistoryIndex: -1,
  validateMappingZabbixCatalog: null,
  validateMappingCmdbuildCatalog: null,
  validationRuleDialog: null,
  webhooksLoaded: false,
  webhooksCurrent: [],
  webhooksOperations: [],
  webhooksHistory: [],
  webhooksHistoryIndex: -1,
  webhooksCmdbuildCatalog: null,
  webhooksSelectedIndex: -1,
  webhooksExpandedRows: {
    operations: {},
    current: {}
  },
  webhooksDetailRow: {
    kind: '',
    index: -1
  },
  webhookEditDialog: null,
  language: 'ru',
  authenticated: false,
  user: null,
  users: [],
  credentialPrompt: null
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const languageCookieName = 'c2m_lang';
const defaultEventMaxMessages = 5;
const defaultConversionRulesFilePath = 'rules/cmdbuild-to-zabbix-host-create.json';
const helpShowDelayMs = 900;
const largeMappingSectionLimit = 500;
const roleViews = {
  viewer: ['dashboard', 'events'],
  editor: ['dashboard', 'events', 'rules', 'mapping', 'validateMapping', 'webhooks', 'zabbix', 'cmdbuild', 'about', 'help'],
  admin: ['dashboard', 'events', 'rules', 'mapping', 'validateMapping', 'webhooks', 'zabbix', 'cmdbuild', 'authSettings', 'runtimeSettings', 'about', 'help']
};
const managedWebhookPrefix = 'cmdbwebhooks2kafka-';
const defaultCmdbuildWebhookUrl = 'http://192.168.202.100:5080/webhooks/cmdbuild';
let helpShowTimer = null;
let pendingHelpTarget = null;
const zabbixCatalogSections = [
  {
    key: 'templates',
    title: 'Templates',
    headers: ['ID', 'Name', 'Host'],
    row: item => [item.templateid, item.name, item.host]
  },
  {
    key: 'hostGroups',
    title: 'Host groups',
    headers: ['ID', 'Name'],
    row: item => [item.groupid, item.name]
  },
  {
    key: 'templateGroups',
    title: 'Template groups',
    headers: ['ID', 'Name'],
    row: item => [item.groupid, item.name]
  },
  {
    key: 'tags',
    title: 'Tags',
    headers: ['Tag', 'Value'],
    row: item => [item.tag, item.value]
  },
  {
    key: 'proxies',
    title: 'Proxies',
    headers: ['ID', 'Name', 'Mode'],
    row: item => [item.proxyid, item.name, item.operating_mode ?? '']
  },
  {
    key: 'proxyGroups',
    title: 'Proxy groups',
    headers: ['ID', 'Name', 'Failover'],
    row: item => [item.proxy_groupid, item.name, item.failover_delay ?? '']
  },
  {
    key: 'globalMacros',
    title: 'Global macros',
    headers: ['ID', 'Macro', 'Description'],
    row: item => [item.globalmacroid, item.macro, item.description ?? '']
  },
  {
    key: 'hostMacros',
    title: 'Host macros',
    headers: ['ID', 'Macro', 'Host'],
    row: item => [item.hostmacroid, item.macro, hostMacroHost(item)]
  },
  {
    key: 'inventoryFields',
    title: 'Inventory fields',
    headers: ['Name'],
    row: item => [item.name]
  },
  {
    key: 'interfaceProfiles',
    title: 'Interface profiles',
    headers: ['Name', 'Type', 'Port'],
    row: item => [item.name, item.type, item.defaultPort]
  },
  {
    key: 'hostStatuses',
    title: 'Host status',
    headers: ['Status', 'Name'],
    row: item => [item.status, item.name]
  },
  {
    key: 'maintenances',
    title: 'Maintenances',
    headers: ['ID', 'Name', 'Type'],
    row: item => [item.maintenanceid, item.name, item.maintenance_type ?? '']
  },
  {
    key: 'tlsPskModes',
    title: 'TLS/PSK modes',
    headers: ['Name', 'Connect', 'Accept'],
    row: item => [item.name, item.tls_connect, item.tls_accept]
  },
  {
    key: 'valueMaps',
    title: 'Value maps',
    headers: ['ID', 'Name', 'Mappings'],
    row: item => [item.valuemapid, item.name, String(item.mappings?.length ?? 0)]
  }
];
const mappingEditorFormControlSelectors = [
  '#mappingModifyRule',
  '#mappingEditClass',
  '#mappingEditField',
  '#mappingEditTargetType',
  '#mappingEditZabbixObject',
  '#mappingEditPriority',
  '#mappingEditRegex',
  '#mappingEditRuleName'
];
const zabbixExtensionDefinitions = [
  {
    title: 'Proxies',
    rulesKey: 'proxies',
    selectionRulesKey: 'proxySelectionRules',
    catalogKey: 'proxies',
    idField: 'proxyid',
    lazyCatalogPath: 'proxies',
    label: item => item.name || item.proxyid,
    meta: item => `proxyid ${item.proxyid ?? '-'}${item.operating_mode !== undefined ? ` | mode ${item.operating_mode}` : ''}`,
    help: 'Zabbix proxy можно использовать как будущий результат правил выбора proxy для host.create/host.update. Объект должен существовать в Zabbix; правила должны только выбирать proxy.'
  },
  {
    title: 'Proxy groups',
    rulesKey: 'proxyGroups',
    selectionRulesKey: 'proxyGroupSelectionRules',
    catalogKey: 'proxyGroups',
    idField: 'proxy_groupid',
    lazyCatalogPath: 'proxy-groups',
    label: item => item.name || item.proxy_groupid,
    meta: item => `proxy_groupid ${item.proxy_groupid ?? '-'}`,
    help: 'Zabbix proxy group можно использовать как будущую зону failover для proxy. Это справочник Zabbix; правила выбирают существующую группу.'
  },
  {
    title: 'Global macros',
    rulesKey: 'globalMacros',
    selectionRulesKey: 'globalMacroSelectionRules',
    catalogKey: 'globalMacros',
    idField: 'globalmacroid',
    lazyCatalogPath: 'global-macros',
    label: item => item.macro || item.name || item.globalmacroid,
    meta: item => item.description || item.value || '',
    help: 'Global macro - существующий macro в Zabbix. В rules его целесообразно использовать как ссылку или значение для host macros, не как замену class attribute fields.'
  },
  {
    title: 'Host macros',
    rulesKey: 'hostMacros',
    selectionRulesKey: 'hostMacroSelectionRules',
    catalogKey: 'hostMacros',
    idField: 'hostmacroid',
    requiresCatalog: false,
    lazyCatalogPath: 'host-macros',
    label: item => item.macro || item.name || item.hostmacroid,
    meta: item => hostMacroHost(item) || item.value || '',
    help: 'Host macro может формироваться из CMDB данных и попадать в macros[] payload. Это полезно для параметров templates: thresholds, SNMP community, ports, environment.'
  },
  {
    title: 'Inventory fields',
    rulesKey: 'inventoryFields',
    selectionRulesKey: 'inventorySelectionRules',
    catalogKey: 'inventoryFields',
    idField: 'name',
    lazyCatalogPath: 'inventory-fields',
    label: item => item.name,
    meta: () => 'host inventory',
    help: 'Inventory field - стандартное поле Zabbix host inventory. Хорошая зона для CMDB данных: owner, location, serial, asset tag, OS.'
  },
  {
    title: 'Interface profiles',
    rulesKey: 'interfaceProfiles',
    selectionRulesKey: 'interfaceProfileSelectionRules',
    catalogKey: 'interfaceProfiles',
    idField: 'name',
    lazyCatalogPath: 'interface-profiles',
    label: item => item.name,
    meta: item => `type ${item.type ?? '-'} | port ${item.defaultPort ?? item.port ?? '-'}`,
    help: 'Interface profile описывает тип интерфейса мониторинга: agent, SNMP, IPMI или JMX. Это не отдельный Zabbix object, а управляемый профиль для interfaces[]. В hostProfiles один profile может использовать несколько interface profiles для одного host или разные interface profiles для fan-out hosts.'
  },
  {
    title: 'Host status',
    rulesKey: 'hostStatuses',
    selectionRulesKey: 'hostStatusSelectionRules',
    catalogKey: 'hostStatuses',
    idField: 'status',
    lazyCatalogPath: 'host-statuses',
    label: item => item.name || item.status,
    meta: item => `status ${item.status}`,
    help: 'Host status управляет monitored/unmonitored. Его можно выбирать правилами по CMDB статусу, но payload должен оставаться совместимым с host.create/host.update.'
  },
  {
    title: 'Maintenances',
    rulesKey: 'maintenances',
    selectionRulesKey: 'maintenanceSelectionRules',
    catalogKey: 'maintenances',
    idField: 'maintenanceid',
    lazyCatalogPath: 'maintenances',
    label: item => item.name || item.maintenanceid,
    meta: item => `maintenanceid ${item.maintenanceid ?? '-'}`,
    help: 'Maintenance - отдельная сущность Zabbix. Использовать ее из CMDB можно, но это обычно отдельная API-операция, а не только host.create/update payload.'
  },
  {
    title: 'TLS/PSK modes',
    rulesKey: 'tlsPskModes',
    selectionRulesKey: 'tlsPskSelectionRules',
    catalogKey: 'tlsPskModes',
    idField: 'name',
    lazyCatalogPath: 'tls-psk-modes',
    label: item => item.name,
    meta: item => `connect ${item.tls_connect ?? '-'} | accept ${item.tls_accept ?? '-'}`,
    help: 'TLS/PSK mode описывает параметры безопасного подключения агента. Для реальной отправки нужны поля tls_connect, tls_accept, tls_psk_identity и tls_psk в payload.'
  },
  {
    title: 'Value maps',
    rulesKey: 'valueMaps',
    selectionRulesKey: 'valueMapSelectionRules',
    catalogKey: 'valueMaps',
    idField: 'valuemapid',
    lazyCatalogPath: 'value-maps',
    label: item => item.name || item.valuemapid,
    meta: item => `${item.mappings?.length ?? 0} mappings`,
    help: 'Value map - объект Zabbix для отображения значений items. В CMDB->host conversion обычно справочный, применять его напрямую к host payload нужно осторожно.'
  }
];
const translations = {
  ru: {
    'login.title': 'Вход',
    'login.language': 'Язык интерфейса',
    'login.idp': 'Войти через IdP',
    'login.username': 'Пользователь',
    'login.password': 'Пароль',
    'login.cmdbuildLogin': 'CMDBuild логин',
    'login.cmdbuildPassword': 'CMDBuild пароль',
    'login.zabbixLogin': 'Zabbix логин',
    'login.zabbixPassword': 'Zabbix пароль',
    'login.submit': 'Войти',
    'dashboard.reloadRules': 'Перечитать правила конвертации',
    'account.changePassword': 'Сменить пароль',
    'account.currentPassword': 'Текущий пароль',
    'account.newPassword': 'Новый пароль',
    'account.confirmPassword': 'Повтор нового пароля',
    'account.savePassword': 'Сохранить пароль',
    'credentials.title': 'Нужны учетные данные',
    'credentials.baseUrl': 'CMDBuild URL',
    'credentials.apiEndpoint': 'Zabbix API',
    'credentials.username': 'Логин',
    'credentials.password': 'Пароль',
    'credentials.save': 'Запомнить на сессию',
    'mapping.referenceWarning': 'Внимание: при пользовании итеративными запросами атрибутов через reference/domain типы, в случае отсутствия модификации самой карточки объекта, модификация атрибутов reference или связанных domain-карточек не приведет к изменениям на мониторинге.',
    'mapping.loadingData': 'загрузка данных',
    'mapping.loadingLightZabbix': 'Загрузка легкого Zabbix catalog',
    'mapping.loadingLightZabbixMeta': 'CMDBuild и Conversion Rules уже доступны; полный Zabbix catalog не загружается в управление правилами конвертации',
    'mapping.lazyLoadingMeta': 'данные раздела загружаются по требованию',
    'mapping.loadErrorTitle': 'Ошибка загрузки управления правилами конвертации',
    'mapping.loadErrorHelp': 'Ошибка показана здесь, чтобы не искать ее в console браузера.',
    'validation.deleteFromRules': 'Удалить из правил',
    'validation.deleteFromRulesHelp': 'Отметьте, чтобы удалить эту отсутствующую ссылку из JSON правил.',
    'validation.createHostProfile': 'Создать host profile',
    'validation.createHostProfileHelp': 'Отметьте, чтобы автоматически добавить минимальный host profile для этого класса в draft JSON.',
    'validation.applySelected': 'Применить выбранное',
    'validation.confirmDeleteSelected': 'Удалить выбранные элементы из JSON правил ({count}) и сохранить исправленный файл через браузер? Backend rules-файл не изменится.',
    'validation.review.title': 'Проверка удаления правила',
    'validation.review.message': 'Правило "{name}" содержит одновременно консистентные и неконсистентные части. Проверьте JSON: можно сохранить правку, удалить правило целиком или отказаться.',
    'validation.review.applyEdit': 'Сохранить правку',
    'validation.review.deleteAnyway': 'Удалить все равно',
    'validation.review.cancel': 'Отказаться',
    'validation.review.invalidJson': 'JSON правила не разобран: {message}',
    'validation.review.cancelled': 'Удаление правил отменено.',
    'validation.review.noRules': 'Для выбранных расхождений не найдено rules, которые можно удалить целиком.',
    'webhooks.analyze': 'Проанализировать rules',
    'webhooks.loadFromCmdb': 'Загрузить из CMDB',
    'webhooks.applyToCmdb': 'Загрузить в CMDB',
    'webhooks.operations': 'Операции',
    'webhooks.details': 'Детали',
    'webhooks.selected': 'Выбрано',
    'webhooks.action': 'Действие',
    'webhooks.code': 'Code',
    'webhooks.target': 'Класс',
    'webhooks.event': 'Событие',
    'webhooks.reason': 'Причина',
    'webhooks.noOperations': 'Операций нет. Текущие webhooks соответствуют rules.',
    'webhooks.noData': 'Загрузите webhooks из CMDB и выполните анализ rules.',
    'webhooks.summary': 'CMDB webhooks: {current}. План операций: создать {create}, изменить {update}, удалить {delete}. Выбрано: {selected}.',
    'webhooks.summaryEmpty': 'План операций пуст. Загружено CMDB webhooks: {current}.',
    'webhooks.statusLoaded': 'Webhooks загружены из CMDB: {count}.',
    'webhooks.statusAnalyzed': 'Анализ rules выполнен. Операций: {count}.',
    'webhooks.statusSelectionChanged': 'Выбор операций изменен.',
    'webhooks.statusApplied': 'Операции применены в CMDB: {count}.',
    'webhooks.confirmApply': 'Применить выбранные операции к CMDBuild webhooks? Это изменит управляемую систему. Операций: {count}.',
    'webhooks.confirmNoSelection': 'Выберите хотя бы одну операцию.',
    'webhooks.reasonMissing': 'webhook отсутствует в CMDB',
    'webhooks.reasonChanged': 'конфигурация отличается: {fields}',
    'webhooks.reasonObsolete': 'управляемый webhook больше не нужен по rules',
    'webhooks.actionCreate': 'Создать',
    'webhooks.actionUpdate': 'Изменить',
    'webhooks.actionDelete': 'Удалить',
    'webhooks.actionCurrent': 'Текущий',
    'webhooks.reasonCurrent': 'загружен из CMDB',
    'webhooks.payload': 'Payload',
    'webhooks.edit': 'Редактировать',
    'webhooks.expandPayload': 'Раскрыть',
    'webhooks.collapsePayload': 'Свернуть',
    'webhooks.editTitle': 'Редактирование webhook',
    'webhooks.editHelp': 'Измените JSON конкретного webhook. Для строки текущего CMDB webhook будет создана update-операция в плане; загрузка в CMDB выполняется только кнопкой "Загрузить в CMDB".',
    'webhooks.saveEdit': 'Сохранить правку',
    'webhooks.invalidJson': 'JSON webhook не разобран: {message}',
    'webhooks.statusEdited': 'Webhook изменен в текущем плане.',
    'webhooks.payloadEmpty': 'Payload пустой.',
    'webhooks.payloadCurrent': 'актуальное',
    'webhooks.payloadAdded': 'добавляется',
    'webhooks.payloadDeleted': 'удаляется',
    'webhooks.detailsHint': 'Нажмите значение в столбце "Действие", чтобы открыть детали под строкой; общий блок деталей находится под таблицей.',
    'webhooks.currentDetailsHint': 'Загруженные из CMDB webhooks показаны ниже. Нажмите "Проанализировать rules", чтобы построить план операций.',
    'webhooks.summaryLoaded': 'CMDB webhooks загружены: {current}. План операций еще не построен.',
    'nav.dashboard': 'Панель',
    'nav.events': 'События',
    'nav.rules': 'Правила',
    'nav.mapping': 'Управление правилами конвертации',
    'nav.validateMapping': 'Логический контроль правил конвертации',
    'nav.webhooks': 'Настройка webhooks',
    'nav.zabbix': 'Каталог Zabbix',
    'nav.cmdbuild': 'Каталог CMDBuild',
    'nav.settings': 'Настройки',
    'nav.authSettings': 'Авторизация',
    'nav.runtimeSettings': 'Runtime-настройки',
    'nav.about': 'About',
    'nav.help': 'Справка',
    'nav.logout': 'Выйти',
    'settings.runtimeConnections': 'Runtime-настройки подключений',
    'settings.settingsFile': 'Файл настроек',
    'settings.usersFile': 'Файл пользователей',
    'settings.cmdbuildUrl': 'CMDBuild URL',
    'settings.maxTraversalDepth': 'Максимальная глубина рекурсии domains&reference&lookups',
    'settings.maxTraversalDepthNote': 'Изменение заработает только после logout и пересинхронизации CMDBuild catalog.',
    'settings.zabbixApi': 'Zabbix API',
    'settings.zabbixApiKey': 'Zabbix API key',
    'settings.rulesStorage': 'Файл правил конвертации',
    'settings.rulesFilePath': 'Путь к файлу правил',
    'settings.rulesFilePathPlaceholder': 'rules/cmdbuild-to-zabbix-host-create.json',
    'settings.rulesReadFromGit': 'Читать из git',
    'settings.rulesRepositoryUrl': 'Git repository URL',
    'settings.rulesRepositoryUrlPlaceholder': 'https://git.example.org/cmdb2monitoring/conversion-rules.git',
    'settings.rulesReadModeDisk': 'Для нашей тестовой системы: читать с диска, файл {path}.',
    'settings.rulesReadModeGit': 'Режим git: URL указывает на repository, внутри него ожидается файл {path}.',
    'settings.rulesGitFileNote': 'При включении git внутри repository ожидается файл правил по пути, указанному выше.',
    'settings.rulesStorageNote': 'UI сохраняет rules через браузер; публикация в git выполняется оператором вне приложения.',
    'settings.kafkaEvents': 'Kafka Events',
    'settings.idp': 'IdP/SAML2/OAuth2/LDAP',
    'settings.authModeTitle': 'Режим авторизации',
    'settings.authMode': 'Режим авторизации',
    'settings.authModeLocal': 'Локальная',
    'settings.authModeMsad': 'MS AD',
    'settings.authModeIdp': 'IdP',
    'settings.saveAuth': 'Сохранить авторизацию',
    'settings.saveRuntime': 'Сохранить runtime',
    'settings.idpProvider': 'Протокол IdP',
    'settings.roleMapping': 'Соответствие ролей группам',
    'settings.groupsColumn': 'Группы IdP / AD',
    'settings.users': 'Локальные пользователи и роли',
    'settings.localUsersActive': 'Локальные пользователи активны',
    'settings.resetUser': 'Пользователь',
    'settings.resetPassword': 'Новый пароль',
    'settings.mustChangePassword': 'Потребовать смену при входе',
    'settings.loadUsers': 'Загрузить пользователей',
    'settings.resetUserPassword': 'Сбросить пароль',
    'settings.userColumn': 'Пользователь',
    'settings.roleColumn': 'Роль',
    'settings.mustChangeColumn': 'Смена пароля',
    'toast.runtimeSaved': 'Runtime-настройки сохранены',
    'toast.runtimeSavedResyncRequired': 'Runtime-настройки сохранены. Новая глубина заработает только после logout и пересинхронизации CMDBuild catalog.',
    'toast.maxTraversalDepthChanged': 'Новая глубина заработает только после logout и пересинхронизации CMDBuild catalog.',
    'toast.idpSaved': 'Настройки авторизации сохранены',
    'toast.rulesReloaded': 'Правила конвертации перечитаны',
    'toast.validationSelectMissing': 'Выберите отсутствующие элементы для удаления из правил',
    'toast.rulesChangedSaveCancelled': 'Rules изменены в памяти, сохранение файла отменено',
    'toast.rulesFileSaved': 'Файл rules сохранен: {name}',
    'toast.rulesNotChanged': 'Rules не изменены',
    'toast.rulesValidationFailed': 'Rules после правки не прошли проверку',
    'toast.validationDraftChanged': 'Rules изменены в памяти. Используйте "Сохранить файл как", когда закончите правки.',
    'rules.createEmpty': 'Создать пустой',
    'toast.emptyRulesCreated': 'Пустой starter правил создан в окне загрузки',
    'toast.emptyRulesFailed': 'Не удалось создать пустой starter правил',
    'about.title': 'About',
    'about.text': 'Спроектировано и овеществлено Игорем Ляпиным email:igor.lyapin@gmail.com 2026\nПод лицензией GNU GPLv3.',
    'common.clearSelection': 'Снять выделение',
    'common.close': 'Закрыть',
    'common.load': 'Загрузить',
    'common.undo': 'Отменить',
    'common.redo': 'Вернуть',
    'common.saveFileAs': 'Сохранить файл как',
    'common.selectAll': 'Выбрать все',
    'common.clear': 'Очистить',
    'common.refresh': 'Обновить',
    'common.validate': 'Проверить',
    'common.dryRun': 'Пробный запуск',
    'common.sync': 'Синхронизировать',
    'common.delete': 'Удалить',
    'common.saveFileNamePrompt': 'Имя файла для сохранения {description}',
    'common.loading': 'Загрузка',
    'mapping.mode': 'Режим',
    'mapping.modeView': 'Режим просмотра',
    'mapping.modeEdit': 'Режим редактирования',
    'mapping.action': 'Действие',
    'mapping.actionAdd': 'Добавление правила',
    'mapping.actionModify': 'Модификация правила',
    'mapping.actionDelete': 'Удаление правил и классов',
    'mapping.modifyRule': 'Правило для изменения',
    'mapping.cmdbClass': 'Класс CMDBuild',
    'mapping.classField': 'Атрибут класса',
    'mapping.structure': 'Структура конвертации',
    'mapping.zabbixTarget': 'Объект/payload Zabbix',
    'mapping.priority': 'Приоритет',
    'mapping.regex': 'Regex',
    'mapping.ruleName': 'Имя правила',
    'mapping.ruleNameAuto': 'автоматически',
    'mapping.resetFields': 'Сбросить поля',
    'mapping.addRule': 'Добавить правило конвертации',
    'mapping.saveRuleChanges': 'Сохранить изменения правила',
    'mapping.grouping': 'Группировка',
    'mapping.deleteTreeCmdbuild': 'Дерево CMDBuild',
    'mapping.deleteTreeZabbix': 'Дерево Zabbix',
    'mapping.deleteTreeRules': 'Дерево правил',
    'mapping.deleteSelectedRules': 'Удалить выбранные правила',
    'mapping.delete.noRulesInDraft': 'В draft JSON нет правил, которые можно удалить через этот режим.',
    'mapping.confirm.deleteRulesTitle': 'Удалить выбранные правила из draft JSON ({count})?',
    'mapping.confirm.deleteRulesKeepSources': 'Классы и class attribute fields останутся в rules, чтобы не удалить источник, который может использоваться другими правилами.',
    'mapping.confirm.deleteRulesUndo': 'Действие можно отменить через Undo.',
    'mapping.confirm.saveIpDnsTitle': 'В rules найдены проблемы связи IP/DNS class attribute field с Zabbix interface structure.',
    'mapping.confirm.saveIpDnsMore': '... еще {count}',
    'mapping.confirm.saveAnyway': 'Сохранить файлы несмотря на ошибки?',
    'mapping.status.modifyStart': 'Выберите правило для модификации или начните с класса, атрибута или структуры конвертации.',
    'mapping.status.beforeSave': 'Перед сохранением проверьте логический контроль правил конвертации: для создания/обновления host должен приходить ipAddress или dnsName.',
    'mapping.status.actionDelete': 'Выберите правила в дереве удаления: по CMDBuild class/attribute, Zabbix payload/object group или коллекциям правил. Классы и class attribute fields не удаляются автоматически.',
    'mapping.status.actionModify': 'Начните с правила, класса, атрибута или структуры конвертации. Связанные списки будут сужаться автоматически.',
    'mapping.status.actionAdd': 'Добавьте новое правило конвертации. После добавления будет сразу выполнена проверка IP/DNS для host binding.',
    'mapping.status.defaultAction': 'Добавьте или измените правило конвертации.',
    'mapping.status.autoSelected': 'Правило выбрано автоматически: {name}.',
    'mapping.status.resetModify': 'Поля модификации сброшены. Начните с правила, класса, атрибута или структуры конвертации.',
    'mapping.status.resetAdd': 'Поля формы очищены. Выберите leaf field и Zabbix target.',
    'mapping.status.noModifyRule': 'Выберите правило для модификации.',
    'mapping.status.ruleResetNeeded': 'Форма совпадает с выбранным правилом: измените поле или нажмите "Сбросить поля".',
    'mapping.status.noRuleChanges': 'Изменений для сохранения нет: правило совпадает с текущим draft JSON.',
    'mapping.status.canModify': 'Можно редактировать: цепочка однозначна, target совместим, изменения готовы к сохранению.',
    'mapping.status.canAdd': 'Можно добавить правило: цепочка однозначна и target совместим.',
    'mapping.status.undoDone': 'Отмена выполнена.',
    'mapping.status.redoDone': 'Возврат выполнен.',
    'mapping.status.loadMappingFirst': 'Сначала загрузите управление правилами конвертации.',
    'mapping.status.selectRulesForDelete': 'Выберите хотя бы одно правило для удаления.',
    'mapping.status.deletedRulesMissing': 'Выбранные правила уже не найдены в текущем draft JSON.',
    'mapping.status.deletedRules': 'Удалено правил: {count}. Классы и class attribute fields не удалялись автоматически.',
    'mapping.status.chooseCompatibleFieldAdd': 'Выберите совместимое CMDBuild field для нового правила.',
    'mapping.status.chooseCompatibleFieldModify': 'Выберите совместимое CMDBuild field для изменения правила.',
    'mapping.status.classFieldMissing': 'В классе "{className}" нет атрибута для "{field}". Добавьте атрибут в CMDBuild или выберите существующий class attribute field.',
    'mapping.status.multiValueScalarNotAllowed': 'Поле "{field}" может вернуть несколько значений через CMDBuild domain path. Для скалярной Zabbix structure "{target}" выберите обычный scalar/reference leaf или настройте source field с resolve.collectionMode=first.',
    'mapping.status.addedRule': 'Добавлено правило "{name}".',
    'mapping.status.addedRuleWithProfile': 'Добавлено правило "{name}". Автоматически создан host profile "{profile}" для класса "{className}".',
    'mapping.status.modifiedRule': 'Изменено правило "{name}".',
    'mapping.status.modifiedRuleWithProfile': 'Изменено правило "{name}". Автоматически создан host profile "{profile}" для класса "{className}".',
    'mapping.status.modifyRuleMissing': 'Выбранное правило больше не найдено в draft JSON.',
    'mapping.status.readyButStale': 'Можно редактировать, но {details}',
    'mapping.status.ruleForModifySelected': 'Правило для модификации выбрано.',
    'mapping.status.classSelected': 'Класс CMDBuild выбран.',
    'mapping.status.noClassRestriction': 'Правило без ограничения по className.',
    'mapping.status.leafSelected': 'Leaf/source field выбран.',
    'mapping.status.structureCompatible': 'Conversion structure совместима с выбранным field.',
    'mapping.status.targetSelected': 'Zabbix target выбран.',
    'mapping.status.prioritySet': 'Priority задан.',
    'mapping.status.regexSaved': 'Regex будет сохранен в rule condition.',
    'mapping.status.ruleNameSetOrAuto': 'Rule name задан или будет сгенерирован автоматически.',
    'mapping.status.modifyNeedsRule': 'Модификация начинается без выбранного rule; выберите rule явно.',
    'mapping.status.selectConcreteClass': 'Выберите конкретный subclass вместо superclass/prototype class.',
    'mapping.status.superclassNotAllowed': 'Superclass/prototype class нельзя использовать как class правила.',
    'mapping.status.chooseLeafField': 'Выберите конечный leaf/source field.',
    'mapping.status.fieldMissingInClass': 'Field "{field}" не найден в выбранном CMDBuild class/path.',
    'mapping.status.fieldMultiValueIncompatible': 'Field "{field}" может вернуть несколько значений и несовместим с "{target}".',
    'mapping.status.chooseStructureForField': 'Выберите structure, допускающую выбранный field, или выберите другой field.',
    'mapping.status.fieldIncompatible': 'Field "{field}" несовместим с "{target}".',
    'mapping.status.ipFieldForDnsTarget': 'Атрибут "{field}" выглядит как IP-адрес, поэтому его нельзя использовать для DNS interface (interfaces[].dns/useip=0). Выберите IP target или DNS/FQDN атрибут.',
    'mapping.status.dnsFieldForIpTarget': 'Атрибут "{field}" выглядит как DNS/FQDN, поэтому его нельзя использовать для IP interface (interfaces[].ip/useip=1). Выберите DNS target или IP атрибут.',
    'mapping.status.lookupFieldForInterfaceTarget': 'Lookup/reference value "{field}" нельзя напрямую использовать как адрес Zabbix interface. Выберите scalar IP/DNS leaf field или другую structure.',
    'mapping.status.unknownFieldForInterfaceTarget': 'Не удалось подтвердить, что "{field}" является адресом типа {target}. Для Zabbix interface выберите IP/DNS leaf field с явным именем, типом или validationRegex.',
    'mapping.status.fieldStale': 'Field "{field}" загружен из rule, но не подтвержден текущим catalog/filter.',
    'mapping.status.fieldStaleShort': 'Field "{field}" не подтвержден текущим catalog/filter.',
    'mapping.status.chooseStructure': 'Выберите conversion structure.',
    'mapping.status.chooseTarget': 'Выберите Zabbix object / payload.',
    'mapping.status.targetMissing': 'Target загружен из rule, но не найден в Zabbix catalog/options.',
    'mapping.status.targetMissingSummary': 'Zabbix target не найден в catalog/options: это неконсистентная вторая сторона цепочки.',
    'mapping.status.targetStale': 'Target загружен из rule, но не подтвержден текущим Zabbix catalog/options.',
    'mapping.status.targetStaleShort': 'Zabbix target не подтвержден текущим catalog/options.',
    'mapping.status.priorityPositive': 'Priority должен быть положительным числом.',
    'mapping.status.saveIpDnsInconsistent': 'Save file as: найдена неконсистентность IP/DNS binding. Изменений для webhook-файла: {count}.',
    'mapping.status.saveReady': 'Save file as: rules JSON и webhook-файл будут сохранены. Изменений для webhook-файла: {count}.',
    'mapping.status.saveCancelledFixIpDns': 'Сохранение отменено: сначала исправьте связь IP/DNS с Zabbix interface structure.',
    'mapping.status.saveCancelled': 'Сохранение отменено.',
    'mapping.status.rulesFileSavedWebhookNotSaved': 'Файл rules сохранен: {name}. Второй файл webhook bodies не сохранен.',
    'mapping.status.filesSaved': 'Файлы сохранены: {rulesName}, {webhookName}.{warning}',
    'mapping.status.saveWarnings': ' Есть предупреждения: {count}.',
    'mapping.option.anyClass': 'Любой класс',
    'mapping.option.chooseRule': 'Выберите правило для модификации',
    'mapping.option.noRulesToModify': 'Нет правил, доступных для модификации',
    'mapping.option.chooseClassFilter': 'Выберите класс CMDBuild или оставьте фильтр пустым',
    'mapping.option.chooseFieldFilter': 'Выберите атрибут класса или оставьте фильтр пустым',
    'mapping.option.chooseStructureFilter': 'Выберите структуру конвертации или оставьте фильтр пустым',
    'mapping.option.chooseTargetFilter': 'Выберите объект/payload Zabbix или оставьте фильтр пустым',
    'mapping.option.chooseLeaf': 'Выберите leaf/source field',
    'mapping.option.chooseStructure': 'Выберите структуру конвертации',
    'mapping.option.chooseTarget': 'Выберите объект/payload Zabbix',
    'mapping.option.noCompatibleFields': 'Нет совместимых CMDBuild fields для {target}',
    'mapping.option.noFields': 'Нет доступных CMDBuild fields',
    'mapping.option.currentFieldMissing': 'Текущее поле rule: {field} / не подтверждено catalog',
    'mapping.option.currentTargetMissing': 'Текущий target rule / отсутствует в Zabbix catalog',
    'mapping.option.currentTargetMissingChooseNew': 'Текущий target rule отсутствует в Zabbix catalog: выберите новый target',
    'mapping.option.currentFieldMissingMeta': 'Значение загружено из существующего rule, но не найдено в текущих совместимых CMDBuild fields.',
    'mapping.option.currentTargetMissingMeta': 'Target загружен из существующего rule, но не найден в текущем Zabbix catalog/options. Поле оставлено пустым для выбора нового target.',
    'mapping.option.chooseLeafMeta': 'Сохранение доступно после выбора конечного leaf/source field.',
    'mapping.option.chooseStructureMeta': 'Сохранение доступно после выбора conversion structure.',
    'mapping.option.chooseTargetMeta': 'Сохранение доступно после выбора совместимого Zabbix target.',
    'mapping.option.modifyStartsWithoutRuleMeta': 'Модификация начинается без выбранного rule.',
    'mapping.option.loadingZabbix': 'Загрузка Zabbix catalog...',
    'mapping.option.loadError': 'Ошибка загрузки: {message}',
    'mapping.option.ipAddress': 'IP-адрес -> interfaces[].ip / useip=1',
    'mapping.option.dnsName': 'DNS-имя -> interfaces[].dns / useip=0',
    'mapping.option.agentInterface': 'Agent interface',
    'mapping.option.snmpInterface': 'SNMP interface',
    'mapping.option.monitoringSuppression': 'Пропустить create/update при совпадении атрибута',
    'mapping.option.profilePrefix': 'Профиль: {name}',
    'mapping.option.newHostMacro': 'Новый host macro из class attribute field',
    'mapping.option.inventoryFromField': 'Inventory field из class attribute field',
    'mapping.target.hostGroups': 'Правило host group',
    'mapping.target.templates': 'Правило template',
    'mapping.target.tags': 'Правило tag',
    'mapping.target.interfaceAddress': 'Правило адреса interface',
    'mapping.target.interface': 'Правило interface',
    'mapping.target.monitoringSuppression': 'Правило исключения из мониторинга',
    'session.notAuthenticated': 'не авторизован',
    'help.general.title': 'Общий принцип',
    'help.general.1': 'Браузер работает только с monitoring-ui-api; прямых подключений из браузера к CMDBuild, Zabbix или Kafka нет.',
    'help.general.2': 'Адреса, Zabbix API key, Kafka topics и параметры чтения Events настраиваются во внешних конфигурационных файлах или через Runtime-настройки. Авторизация настраивается отдельно: локальная, MS AD или IdP с группами AD для ролей.',
    'help.general.3': 'Всплывающие подсказки показываются при наведении или фокусе на элементе интерфейса.',
    'help.dashboard.title': 'Панель и события',
    'help.dashboard.1': 'Панель показывает доступность cmdbwebhooks2kafka, cmdbkafka2zabbix, zabbixrequests2api и самого BFF.',
    'help.dashboard.2': 'События читают последние сообщения из настроенных Kafka topics через backend-адаптер.',
    'help.dashboard.3': 'Количество в событиях означает последние N сообщений; по умолчанию выводятся 5 последних.',
    'help.rules.title': 'Правила',
    'help.rules.1': 'Load загружает текущий JSON правил конвертации.',
    'help.rules.2': 'Validate проверяет структуру правил на backend.',
    'help.rules.3': 'Dry-run применяет правила к тестовому CMDBuild payload без сохранения.',
    'help.rules.4': 'Save file as сохраняет JSON правил через браузер; backend rules-файл и git не изменяются.',
    'help.rules.5': 'Создать пустой формирует production starter из текущего окружения: endpoints/topics и справочники CMDBuild/Zabbix берутся из runtime config и catalog cache, routes остаются publish=false до осознанного включения. Если CMDBuild или Zabbix cache пустой, backend возвращает ошибку и предлагает сначала синхронизировать каталог.',
    'help.mapping.title': 'Управление правилами конвертации',
    'help.mapping.1': 'Страница показывает цепочку CMDBuild -> Conversion Rules -> Zabbix.',
    'help.mapping.2': 'Режим просмотра показывает выбранную цепочку и скрывает лишние атрибуты классов, другие rule-подблоки и несвязанные элементы списков Zabbix.',
    'help.mapping.3': 'Снять выделение доступно в режиме просмотра и возвращает обычный обзор без подсветки цепочки.',
    'help.mapping.4': 'Режим редактирования скрывает нижний просмотр и меняет draft JSON текущей сессии: можно начать с любого узла формы, а зависимые поля фильтруются и подсвечиваются.',
    'help.mapping.5': 'Действие Модификация правила начинается без автоматически выбранного rule: можно начать с rule, class, field или conversion structure. Связанные списки фильтруются, единственный найденный rule выбирается автоматически, а Сбросить поля возвращает форму к пустым фильтрам. Target, отсутствующий в Zabbix catalog, считается неконсистентным и блокирует сохранение.',
    'help.mapping.6': 'Действие Удаление правил и классов показывает rules текущего draft JSON деревом по CMDBuild, Zabbix или коллекциям правил. Можно отметить весь класс, атрибут CMDBuild, Zabbix payload field, Zabbix object group или отдельное rule; source classes/class attribute fields очищаются через логический контроль правил конвертации.',
    'help.mapping.7': 'Undo и Redo работают с историей изменений текущей сессии, а Save file as сохраняет draft в отдельный JSON-файл без отправки на backend.',
    'help.mapping.8': 'Save file as дополнительно проверяет, что каждый настроенный класс имеет IP или DNS class attribute field, связанный с Zabbix interface rules или hostProfiles[].interfaces.',
    'help.mapping.9': 'Повторное нажатие на выбранный элемент снимает выделение.',
    'help.mapping.10': 'Interface address rules выбирают, чем заполнить Zabbix interface: IP target пишет в interfaces[].ip/useip=1, DNS target пишет в interfaces[].dns/useip=0. Редактор блокирует явное использование IP-атрибута как DNS и DNS/FQDN-атрибута как IP.',
    'help.mapping.11': 'Host profiles описывают два режима: несколько interfaces[] внутри одного Zabbix host или несколько Zabbix hosts из одного CMDB object.',
    'help.mapping.12': 'Внутри host profile interface profile выбирает тип мониторинга agent/SNMP/IPMI/JMX, а valueField указывает, какой CMDB атрибут станет IP или DNS.',
    'help.mapping.13': 'Source keys webhook могут отличаться от имен CMDBuild attributes; связь задается через cmdbAttribute или cmdbPath и не добавляет скрытые alias в обработку payload.',
    'help.mapping.14': 'Для lookup выделяется только конкретная связка класса, lookup и значения, например Notebook.zabbixTag.tag1.',
    'help.mapping.15': 'Regex в правилах показывает, по каким class attribute fields выбираются группы, шаблоны, tags и расширенные Zabbix-объекты.',
    'help.mapping.16': 'Domain path вида Класс.{domain:СвязанныйКласс}.Атрибут читает связанные карточки через CMDBuild relations; поля, которые могут вернуть несколько значений, недоступны для скалярных Zabbix structures.',
    'help.mapping.17': 'monitoringSuppressionRules используется, когда атрибуты экземпляра означают осознанный отказ от постановки на мониторинг; create/update пропускаются, delete не блокируется.',
    'help.validate.title': 'Логический контроль правил конвертации',
    'help.validate.1': 'Страница не строит интерактивную цепочку, а подсвечивает только отсутствующие сущности.',
    'help.validate.2': 'Красным отмечаются классы и атрибуты, отсутствующие в CMDBuild catalog, а также Zabbix-ссылки, которых нет в Zabbix catalog.',
    'help.validate.3': 'Checkbox над отсутствующим элементом включает его в удаление из rules JSON.',
    'help.validate.4': 'Delete спрашивает подтверждение, сохраняет предыдущую версию и исправляет выбранные ссылки в правилах.',
    'help.webhooks.title': 'Настройка webhooks',
    'help.webhooks.1': 'Страница доступна ролям Редактирование правил и Администрирование.',
    'help.webhooks.2': 'Загрузить из CMDB читает текущие CMDBuild webhooks через backend; браузер не подключается к CMDBuild напрямую.',
    'help.webhooks.3': 'Проанализировать rules строит желаемые webhooks по текущим conversion rules: новые предлагаются к созданию, отличающиеся к изменению, управляемые лишние к удалению.',
    'help.webhooks.4': 'Сохранить файл как выгружает только JSON-план через браузер и не меняет CMDBuild, backend rules-файл или git.',
    'help.webhooks.5': 'Загрузить в CMDB применяет только выбранные операции и действительно меняет webhooks в управляемой системе.',
    'help.webhooks.6': 'Пользоваться этим пунктом не обязательно: webhooks можно настроить вручную в CMDBuild или использовать webhook-файлы, которые сохраняются вместе с файлом правил конвертации.',
    'help.webhooks.7': 'Undo/Redo отменяют только выбор операций в текущем плане и не откатывают уже выполненную загрузку конфигурации в CMDBuild.',
    'help.webhooks.8': 'В таблице можно раскрыть payload каждой строки: зеленым показано добавление, красным удаление, черным актуальное значение. Нажатие на значение в столбце "Действие" открывает детали под этой строкой, а общий блок деталей находится под таблицей и использует ту же подсветку. Редактировать меняет JSON конкретного webhook в текущем плане.',
    'help.catalogs.title': 'Каталоги и настройки',
    'help.catalogs.1': 'Zabbix Catalog загружает templates, host groups, template groups, tags и расширенные справочники Zabbix.',
    'help.catalogs.2': 'CMDBuild Catalog загружает классы, атрибуты, domains и lookup-значения.',
    'help.catalogs.3': 'Runtime-настройки сохраняют подключения и Events Kafka browser; Авторизация сохраняет локальный режим, MS AD, IdP/SAML2/OAuth2 и привязку AD-групп к ролям.',
    'help.catalogs.4': 'Справочники источников лучше менять в CMDBuild/Zabbix, а правила конвертации менять в JSON rules.',
    'help.catalogs.5': 'Для тестовой системы rules читаются с диска из rules/cmdbuild-to-zabbix-host-create.json; если включено чтение из git, этот файл ожидается внутри repository по тому же пути.',
    'tooltip.brand': 'Название приложения cmdb2monitoring.',
    'tooltip.sessionSummary': 'Текущий пользователь и способ авторизации.',
    'tooltip.idpLoginButton': 'Запускает вход через выбранный внешний IdP.',
    'tooltip.logoutButton': 'Завершает текущую пользовательскую сессию.',
    'tooltip.changePasswordOpen': 'Открывает смену пароля текущего локального пользователя.',
    'tooltip.refreshDashboard': 'Повторно проверяет доступность сервисов.',
    'tooltip.eventsMaxMessages': 'Количество последних сообщений Kafka, которое будет выведено снизу.',
    'tooltip.refreshEvents': 'Загружает список топиков и последние сообщения выбранного топика.',
    'tooltip.loadRules': 'Загружает текущий JSON правил конвертации.',
    'tooltip.validateRules': 'Проверяет JSON правил по серверной схеме.',
    'tooltip.createEmptyRules': 'Создает чистый starter правил с базовым наполнением текущего окружения. Требует загруженные CMDBuild и Zabbix catalog cache; файл сохраняется только через браузер.',
    'tooltip.rulesFile': 'Выбор локального JSON-файла правил для проверки, dry-run или сохранения через браузер.',
    'tooltip.rulesFilePath': 'Для тестовой системы: rules/cmdbuild-to-zabbix-host-create.json. При чтении из git этот же путь ожидается внутри repository checkout.',
    'tooltip.rulesReadFromGit': 'Переключает режим отображения storage: выключено - читать с диска; включено - читать из git working copy при соответствующей настройке converter-сервиса.',
    'tooltip.rulesRepositoryUrl': 'URL repository с правилами. Внутри ожидается файл rules/cmdbuild-to-zabbix-host-create.json или путь, указанный в поле "Путь к файлу правил".',
    'tooltip.dryRunPayload': 'Тестовый CMDBuild payload для dry-run конвертации.',
    'tooltip.dryRunRules': 'Выполняет пробную конвертацию без сохранения правил.',
    'tooltip.saveRulesAs': 'Сохраняет текущий JSON правил через браузер. Backend rules-файл, git commit и git push не выполняются.',
    'tooltip.loadMapping': 'Загружает визуальную карту связей Zabbix, правил и CMDBuild.',
    'tooltip.mappingMode': 'Переключает управление правилами конвертации между просмотром и редактированием draft-правил текущей сессии.',
    'tooltip.mappingEditAction': 'Переключает действие редактора: добавление, модификация или удаление rules из draft JSON.',
    'tooltip.mappingClearSelection': 'Снимает выделение цепочки и возвращает обычный обзор.',
    'tooltip.mappingUndo': 'Отменяет последнее изменение draft-правил текущей сессии.',
    'tooltip.mappingRedo': 'Возвращает отмененное изменение draft-правил.',
    'tooltip.mappingSaveAs': 'Сохраняет текущий draft JSON правил без отправки на backend. Вторым файлом формируются только webhook Body/DELETE-инструкции по добавленным и удаленным правилам текущей сессии.',
    'tooltip.mappingAddRule': 'Добавляет новое правило или сохраняет изменения выбранного правила в draft JSON.',
    'tooltip.mappingResetForm': 'В режиме модификации очищает выбранное rule и фильтры; в режиме добавления очищает leaf field и target.',
    'tooltip.mappingDeleteSelectAll': 'Отмечает все rules в режиме удаления.',
    'tooltip.mappingDeleteClear': 'Снимает отметки со всех rules в режиме удаления.',
    'tooltip.mappingDeleteSelected': 'Удаляет отмеченные rules из draft JSON после подтверждения. Классы и class attribute fields остаются на месте.',
    'tooltip.mappingDeleteView': 'Выбирает дерево удаления: по CMDBuild class/attribute, по Zabbix payload/object group или по коллекциям rules.',
    'tooltip.loadValidateMapping': 'Запускает логический контроль правил против текущих каталогов Zabbix и CMDBuild.',
    'tooltip.webhooksUndo': 'Отменяет последнее изменение выбора операций webhooks в текущей сессии.',
    'tooltip.webhooksRedo': 'Возвращает отмененное изменение выбора операций webhooks.',
    'tooltip.webhooksAnalyze': 'Строит план CMDBuild webhooks по текущим conversion rules и загруженному каталогу CMDBuild.',
    'tooltip.webhooksLoadCmdb': 'Загружает текущие CMDBuild webhooks из управляемой системы.',
    'tooltip.webhooksSaveAs': 'Сохраняет JSON-план webhooks через браузер. CMDBuild, backend rules-файл и git не изменяются.',
    'tooltip.webhooksApplyCmdb': 'Применяет выбранные операции create/update/delete к CMDBuild webhooks. Это изменяет управляемую систему.',
    'tooltip.webhooksSelectAll': 'Выбирает все операции плана webhooks.',
    'tooltip.webhooksClear': 'Снимает выбор со всех операций плана webhooks.',
    'tooltip.syncZabbix': 'Обновляет каталог Zabbix из API Zabbix.',
    'tooltip.loadZabbix': 'Загружает сохраненный каталог Zabbix.',
    'tooltip.syncCmdbuild': 'Обновляет каталог CMDBuild через API CMDBuild.',
    'tooltip.loadCmdbuild': 'Загружает сохраненный каталог CMDBuild.',
    'tooltip.loadRuntimeSettings': 'Загружает runtime-настройки из внешнего файла.',
    'tooltip.loadAuthSettings': 'Загружает настройки авторизации и локальных пользователей.',
    'tooltip.saveRuntimeSettings': 'Сохраняет runtime-настройки во внешний файл.',
    'tooltip.saveIdp': 'Сохраняет режим авторизации, IdP/MS AD параметры и соответствие ролей группам.',
    'tooltip.loadUsers': 'Загружает список локальных пользователей и ролей.',
    'tooltip.resetUserPassword': 'Сбрасывает пароль выбранного пользователя. Хэш сохраняется в файле пользователей.',
    'tooltip.helpPopoverClose': 'Закрывает открытую подсказку.',
    'tooltip.field': 'Поле "{label}". Значение используется соответствующим разделом интерфейса или сохраняется во внешний конфигурационный файл.',
    'tooltip.tableColumn': 'Колонка таблицы "{label}".'
  },
  en: {
    'login.title': 'Login',
    'login.language': 'Interface language',
    'login.idp': 'Sign in with IdP',
    'login.username': 'User',
    'login.password': 'Password',
    'login.cmdbuildLogin': 'CMDBuild login',
    'login.cmdbuildPassword': 'CMDBuild password',
    'login.zabbixLogin': 'Zabbix login',
    'login.zabbixPassword': 'Zabbix password',
    'login.submit': 'Login',
    'dashboard.reloadRules': 'Reload conversion rules',
    'account.changePassword': 'Change password',
    'account.currentPassword': 'Current password',
    'account.newPassword': 'New password',
    'account.confirmPassword': 'Confirm new password',
    'account.savePassword': 'Save password',
    'credentials.title': 'Credentials required',
    'credentials.baseUrl': 'CMDBuild URL',
    'credentials.apiEndpoint': 'Zabbix API',
    'credentials.username': 'Login',
    'credentials.password': 'Password',
    'credentials.save': 'Remember for session',
    'mapping.referenceWarning': 'Warning: when iterative attribute requests use reference/domain types, changes in referenced attributes or related domain cards will not update monitoring unless the source object card itself is modified.',
    'mapping.loadingData': 'loading data',
    'mapping.loadingLightZabbix': 'Loading lightweight Zabbix catalog',
    'mapping.loadingLightZabbixMeta': 'CMDBuild and Conversion Rules are already available; the full Zabbix catalog is not loaded in Conversion Rules Management',
    'mapping.lazyLoadingMeta': 'section data is loaded on demand',
    'mapping.loadErrorTitle': 'Conversion Rules Management load error',
    'mapping.loadErrorHelp': 'The error is shown here so you do not have to look for it in the browser console.',
    'validation.deleteFromRules': 'Remove from rules',
    'validation.deleteFromRulesHelp': 'Check this to remove the missing reference from the rules JSON.',
    'validation.createHostProfile': 'Create host profile',
    'validation.createHostProfileHelp': 'Check this to automatically add a minimal host profile for this class to the draft JSON.',
    'validation.applySelected': 'Apply selected',
    'validation.confirmDeleteSelected': 'Remove selected items from rules JSON ({count}) and save the fixed file through the browser? The backend rules file will not change.',
    'validation.review.title': 'Rule Deletion Review',
    'validation.review.message': 'Rule "{name}" contains both consistent and inconsistent parts. Review the JSON: you can save an edit, delete the whole rule anyway, or cancel.',
    'validation.review.applyEdit': 'Save edit',
    'validation.review.deleteAnyway': 'Delete anyway',
    'validation.review.cancel': 'Cancel',
    'validation.review.invalidJson': 'Rule JSON could not be parsed: {message}',
    'validation.review.cancelled': 'Rule deletion was cancelled.',
    'validation.review.noRules': 'No rules that can be deleted whole were found for the selected mismatches.',
    'webhooks.analyze': 'Analyze rules',
    'webhooks.loadFromCmdb': 'Load from CMDB',
    'webhooks.applyToCmdb': 'Load into CMDB',
    'webhooks.operations': 'Operations',
    'webhooks.details': 'Details',
    'webhooks.selected': 'Selected',
    'webhooks.action': 'Action',
    'webhooks.code': 'Code',
    'webhooks.target': 'Class',
    'webhooks.event': 'Event',
    'webhooks.reason': 'Reason',
    'webhooks.noOperations': 'No operations. Current webhooks match the rules.',
    'webhooks.noData': 'Load webhooks from CMDB and analyze rules.',
    'webhooks.summary': 'CMDB webhooks: {current}. Operation plan: create {create}, update {update}, delete {delete}. Selected: {selected}.',
    'webhooks.summaryEmpty': 'Operation plan is empty. Loaded CMDB webhooks: {current}.',
    'webhooks.statusLoaded': 'Webhooks loaded from CMDB: {count}.',
    'webhooks.statusAnalyzed': 'Rules analysis completed. Operations: {count}.',
    'webhooks.statusSelectionChanged': 'Operation selection changed.',
    'webhooks.statusApplied': 'Operations applied to CMDB: {count}.',
    'webhooks.confirmApply': 'Apply selected operations to CMDBuild webhooks? This changes the managed system. Operations: {count}.',
    'webhooks.confirmNoSelection': 'Select at least one operation.',
    'webhooks.reasonMissing': 'webhook is missing in CMDB',
    'webhooks.reasonChanged': 'configuration differs: {fields}',
    'webhooks.reasonObsolete': 'managed webhook is no longer required by rules',
    'webhooks.actionCreate': 'Create',
    'webhooks.actionUpdate': 'Update',
    'webhooks.actionDelete': 'Delete',
    'webhooks.actionCurrent': 'Current',
    'webhooks.reasonCurrent': 'loaded from CMDB',
    'webhooks.payload': 'Payload',
    'webhooks.edit': 'Edit',
    'webhooks.expandPayload': 'Expand',
    'webhooks.collapsePayload': 'Collapse',
    'webhooks.editTitle': 'Edit webhook',
    'webhooks.editHelp': 'Edit JSON for this webhook. For a current CMDB webhook row, the UI will create an update operation in the plan; CMDB changes happen only through "Load into CMDB".',
    'webhooks.saveEdit': 'Save edit',
    'webhooks.invalidJson': 'Webhook JSON cannot be parsed: {message}',
    'webhooks.statusEdited': 'Webhook changed in the current plan.',
    'webhooks.payloadEmpty': 'Payload is empty.',
    'webhooks.payloadCurrent': 'current',
    'webhooks.payloadAdded': 'added',
    'webhooks.payloadDeleted': 'deleted',
    'webhooks.detailsHint': 'Click the Action value to open details under that row; the shared details panel is below the table.',
    'webhooks.currentDetailsHint': 'Loaded CMDB webhooks are shown below. Click "Analyze rules" to build the operation plan.',
    'webhooks.summaryLoaded': 'CMDB webhooks loaded: {current}. The operation plan has not been built yet.',
    'nav.dashboard': 'Dashboard',
    'nav.events': 'Events',
    'nav.rules': 'Rules',
    'nav.mapping': 'Conversion Rules Management',
    'nav.validateMapping': 'Conversion Rules Logical Control',
    'nav.webhooks': 'Webhook Setup',
    'nav.zabbix': 'Zabbix Catalog',
    'nav.cmdbuild': 'CMDBuild Catalog',
    'nav.settings': 'Settings',
    'nav.authSettings': 'Authorization',
    'nav.runtimeSettings': 'Runtime settings',
    'nav.about': 'About',
    'nav.help': 'Help',
    'nav.logout': 'Logout',
    'settings.runtimeConnections': 'Runtime connection settings',
    'settings.settingsFile': 'Settings file',
    'settings.usersFile': 'Users file',
    'settings.cmdbuildUrl': 'CMDBuild URL',
    'settings.maxTraversalDepth': 'Max recursion depth for domains&reference&lookups',
    'settings.maxTraversalDepthNote': 'The change takes effect only after logout and CMDBuild catalog resync.',
    'settings.zabbixApi': 'Zabbix API',
    'settings.zabbixApiKey': 'Zabbix API key',
    'settings.rulesStorage': 'Conversion rules file',
    'settings.rulesFilePath': 'Rules file path',
    'settings.rulesFilePathPlaceholder': 'rules/cmdbuild-to-zabbix-host-create.json',
    'settings.rulesReadFromGit': 'Read from git',
    'settings.rulesRepositoryUrl': 'Git repository URL',
    'settings.rulesRepositoryUrlPlaceholder': 'https://git.example.org/cmdb2monitoring/conversion-rules.git',
    'settings.rulesReadModeDisk': 'For the test system: read from disk, file {path}.',
    'settings.rulesReadModeGit': 'Git mode: the URL points to the repository, and file {path} is expected inside it.',
    'settings.rulesGitFileNote': 'When git is enabled, the rules file is expected inside the repository at the path shown above.',
    'settings.rulesStorageNote': 'The UI saves rules through the browser; publishing to git is done by the operator outside the application.',
    'settings.kafkaEvents': 'Kafka Events',
    'settings.idp': 'IdP/SAML2/OAuth2/LDAP',
    'settings.authModeTitle': 'Authorization mode',
    'settings.authMode': 'Authorization mode',
    'settings.authModeLocal': 'Local',
    'settings.authModeMsad': 'MS AD',
    'settings.authModeIdp': 'IdP',
    'settings.saveAuth': 'Save authorization',
    'settings.saveRuntime': 'Save runtime',
    'settings.idpProvider': 'IdP protocol',
    'settings.roleMapping': 'Role to groups mapping',
    'settings.groupsColumn': 'IdP / AD groups',
    'settings.users': 'Local users and roles',
    'settings.localUsersActive': 'Local users active',
    'settings.resetUser': 'User',
    'settings.resetPassword': 'New password',
    'settings.mustChangePassword': 'Require change at login',
    'settings.loadUsers': 'Load users',
    'settings.resetUserPassword': 'Reset password',
    'settings.userColumn': 'User',
    'settings.roleColumn': 'Role',
    'settings.mustChangeColumn': 'Password change',
    'toast.runtimeSaved': 'Runtime settings saved',
    'toast.runtimeSavedResyncRequired': 'Runtime settings saved. The new depth takes effect only after logout and CMDBuild catalog resync.',
    'toast.maxTraversalDepthChanged': 'The new depth takes effect only after logout and CMDBuild catalog resync.',
    'toast.idpSaved': 'Authorization settings saved',
    'toast.rulesReloaded': 'Conversion rules reloaded',
    'toast.validationSelectMissing': 'Choose missing items to remove from rules',
    'toast.rulesChangedSaveCancelled': 'Rules were changed in memory, file save was cancelled',
    'toast.rulesFileSaved': 'Rules file saved: {name}',
    'toast.rulesNotChanged': 'Rules were not changed',
    'toast.rulesValidationFailed': 'Rules did not pass validation after the edit',
    'toast.validationDraftChanged': 'Rules were changed in memory. Use "Save file as" when edits are finished.',
    'rules.createEmpty': 'Create empty',
    'toast.emptyRulesCreated': 'Empty rules starter created in the local file area',
    'toast.emptyRulesFailed': 'Could not create empty rules starter',
    'about.title': 'About',
    'about.text': 'Designed and materialized by Igor Lyapin email:igor.lyapin@gmail.com 2026\nLicensed under GNU GPLv3.',
    'common.clearSelection': 'Clear selection',
    'common.close': 'Close',
    'common.load': 'Load',
    'common.undo': 'Undo',
    'common.redo': 'Redo',
    'common.saveFileAs': 'Save file as',
    'common.selectAll': 'Select all',
    'common.clear': 'Clear',
    'common.refresh': 'Refresh',
    'common.validate': 'Validate',
    'common.dryRun': 'Dry-run',
    'common.sync': 'Sync',
    'common.delete': 'Delete',
    'common.saveFileNamePrompt': 'File name for saving {description}',
    'common.loading': 'Loading',
    'mapping.mode': 'Mode',
    'mapping.modeView': 'View mode',
    'mapping.modeEdit': 'Edit mode',
    'mapping.action': 'Action',
    'mapping.actionAdd': 'Add rule',
    'mapping.actionModify': 'Modify rule',
    'mapping.actionDelete': 'Delete rule & classes',
    'mapping.modifyRule': 'Rule to modify',
    'mapping.cmdbClass': 'CMDBuild class',
    'mapping.classField': 'Class attribute field',
    'mapping.structure': 'Conversion structure',
    'mapping.zabbixTarget': 'Zabbix object / payload',
    'mapping.priority': 'Priority',
    'mapping.regex': 'Regex',
    'mapping.ruleName': 'Rule name',
    'mapping.ruleNameAuto': 'auto-generated',
    'mapping.resetFields': 'Reset fields',
    'mapping.addRule': 'Add conversion rule',
    'mapping.saveRuleChanges': 'Save rule changes',
    'mapping.grouping': 'Grouping',
    'mapping.deleteTreeCmdbuild': 'CMDBuild tree',
    'mapping.deleteTreeZabbix': 'Zabbix tree',
    'mapping.deleteTreeRules': 'Rules tree',
    'mapping.deleteSelectedRules': 'Delete selected rules',
    'mapping.delete.noRulesInDraft': 'The draft JSON has no rules that can be deleted in this mode.',
    'mapping.confirm.deleteRulesTitle': 'Delete selected rules from draft JSON ({count})?',
    'mapping.confirm.deleteRulesKeepSources': 'Classes and class attribute fields will remain in rules so a source used by other rules is not removed.',
    'mapping.confirm.deleteRulesUndo': 'This action can be undone through Undo.',
    'mapping.confirm.saveIpDnsTitle': 'Rules contain IP/DNS class attribute field links with Zabbix interface structure problems.',
    'mapping.confirm.saveIpDnsMore': '... {count} more',
    'mapping.confirm.saveAnyway': 'Save files despite the errors?',
    'mapping.status.modifyStart': 'Choose a rule to modify or start from a class, field, or conversion structure.',
    'mapping.status.beforeSave': 'Before saving, run logical control of conversion rules: create/update host must receive ipAddress or dnsName.',
    'mapping.status.actionDelete': 'Choose rules in the delete tree: by CMDBuild class/attribute, Zabbix payload/object group, or rule collections. Classes and class attribute fields are not removed automatically.',
    'mapping.status.actionModify': 'Start from a rule, class, attribute, or conversion structure. Linked lists will narrow automatically.',
    'mapping.status.actionAdd': 'Add a new conversion rule. IP/DNS host binding validation runs immediately after adding.',
    'mapping.status.defaultAction': 'Add or modify a conversion rule.',
    'mapping.status.autoSelected': 'Rule selected automatically: {name}.',
    'mapping.status.resetModify': 'Modification fields were reset. Start from a rule, class, attribute, or conversion structure.',
    'mapping.status.resetAdd': 'Form fields were cleared. Choose a leaf field and Zabbix target.',
    'mapping.status.noModifyRule': 'Choose a rule to modify.',
    'mapping.status.ruleResetNeeded': 'The form matches the selected rule: change a field or press "Reset fields".',
    'mapping.status.noRuleChanges': 'There are no changes to save: the rule matches the current draft JSON.',
    'mapping.status.canModify': 'Ready to edit: the chain is unambiguous, the target is compatible, and changes can be saved.',
    'mapping.status.canAdd': 'Ready to add a rule: the chain is unambiguous and the target is compatible.',
    'mapping.status.undoDone': 'Undo completed.',
    'mapping.status.redoDone': 'Redo completed.',
    'mapping.status.loadMappingFirst': 'Load Conversion Rules Management first.',
    'mapping.status.selectRulesForDelete': 'Select at least one rule to delete.',
    'mapping.status.deletedRulesMissing': 'The selected rules are no longer found in the current draft JSON.',
    'mapping.status.deletedRules': 'Deleted rules: {count}. Classes and class attribute fields were not removed automatically.',
    'mapping.status.chooseCompatibleFieldAdd': 'Choose a compatible CMDBuild field for the new rule.',
    'mapping.status.chooseCompatibleFieldModify': 'Choose a compatible CMDBuild field for changing the rule.',
    'mapping.status.classFieldMissing': 'Class "{className}" has no attribute for "{field}". Add the attribute in CMDBuild or choose an existing class attribute field.',
    'mapping.status.multiValueScalarNotAllowed': 'Field "{field}" can return multiple values through a CMDBuild domain path. For scalar Zabbix structure "{target}", choose a regular scalar/reference leaf or configure the source field with resolve.collectionMode=first.',
    'mapping.status.addedRule': 'Added rule "{name}".',
    'mapping.status.addedRuleWithProfile': 'Added rule "{name}". Automatically created host profile "{profile}" for class "{className}".',
    'mapping.status.modifiedRule': 'Modified rule "{name}".',
    'mapping.status.modifiedRuleWithProfile': 'Modified rule "{name}". Automatically created host profile "{profile}" for class "{className}".',
    'mapping.status.modifyRuleMissing': 'The selected rule is no longer found in the draft JSON.',
    'mapping.status.readyButStale': 'Ready to edit, but {details}',
    'mapping.status.ruleForModifySelected': 'Rule to modify is selected.',
    'mapping.status.classSelected': 'CMDBuild class is selected.',
    'mapping.status.noClassRestriction': 'Rule without a className restriction.',
    'mapping.status.leafSelected': 'Leaf/source field is selected.',
    'mapping.status.structureCompatible': 'Conversion structure is compatible with the selected field.',
    'mapping.status.targetSelected': 'Zabbix target is selected.',
    'mapping.status.prioritySet': 'Priority is set.',
    'mapping.status.regexSaved': 'Regex will be saved in the rule condition.',
    'mapping.status.ruleNameSetOrAuto': 'Rule name is set or will be generated automatically.',
    'mapping.status.modifyNeedsRule': 'Modification starts without a selected rule; choose a rule explicitly.',
    'mapping.status.selectConcreteClass': 'Choose a concrete subclass instead of a superclass/prototype class.',
    'mapping.status.superclassNotAllowed': 'Superclass/prototype class cannot be used as a rule class.',
    'mapping.status.chooseLeafField': 'Choose the final leaf/source field.',
    'mapping.status.fieldMissingInClass': 'Field "{field}" was not found in the selected CMDBuild class/path.',
    'mapping.status.fieldMultiValueIncompatible': 'Field "{field}" can return multiple values and is incompatible with "{target}".',
    'mapping.status.chooseStructureForField': 'Choose a structure that allows the selected field, or choose another field.',
    'mapping.status.fieldIncompatible': 'Field "{field}" is incompatible with "{target}".',
    'mapping.status.ipFieldForDnsTarget': 'Attribute "{field}" looks like an IP address, so it cannot be used for a DNS interface (interfaces[].dns/useip=0). Choose the IP target or a DNS/FQDN attribute.',
    'mapping.status.dnsFieldForIpTarget': 'Attribute "{field}" looks like DNS/FQDN, so it cannot be used for an IP interface (interfaces[].ip/useip=1). Choose the DNS target or an IP attribute.',
    'mapping.status.lookupFieldForInterfaceTarget': 'Lookup/reference value "{field}" cannot be used directly as a Zabbix interface address. Choose a scalar IP/DNS leaf field or another structure.',
    'mapping.status.unknownFieldForInterfaceTarget': 'Could not confirm that "{field}" is a {target} address. For a Zabbix interface, choose an IP/DNS leaf field with an explicit name, type, or validationRegex.',
    'mapping.status.fieldStale': 'Field "{field}" was loaded from the rule but is not confirmed by the current catalog/filter.',
    'mapping.status.fieldStaleShort': 'Field "{field}" is not confirmed by the current catalog/filter.',
    'mapping.status.chooseStructure': 'Choose a conversion structure.',
    'mapping.status.chooseTarget': 'Choose a Zabbix object / payload.',
    'mapping.status.targetMissing': 'Target was loaded from the rule but was not found in the Zabbix catalog/options.',
    'mapping.status.targetMissingSummary': 'Zabbix target was not found in catalog/options: the second side of the chain is inconsistent.',
    'mapping.status.targetStale': 'Target was loaded from the rule but is not confirmed by the current Zabbix catalog/options.',
    'mapping.status.targetStaleShort': 'Zabbix target is not confirmed by the current catalog/options.',
    'mapping.status.priorityPositive': 'Priority must be a positive number.',
    'mapping.status.saveIpDnsInconsistent': 'Save file as: inconsistent IP/DNS binding found. Changes for the webhook file: {count}.',
    'mapping.status.saveReady': 'Save file as: rules JSON and webhook file will be saved. Changes for the webhook file: {count}.',
    'mapping.status.saveCancelledFixIpDns': 'Save cancelled: fix the IP/DNS link to the Zabbix interface structure first.',
    'mapping.status.saveCancelled': 'Save cancelled.',
    'mapping.status.rulesFileSavedWebhookNotSaved': 'Rules file saved: {name}. The second webhook bodies file was not saved.',
    'mapping.status.filesSaved': 'Files saved: {rulesName}, {webhookName}.{warning}',
    'mapping.status.saveWarnings': ' Warnings: {count}.',
    'mapping.option.anyClass': 'Any class',
    'mapping.option.chooseRule': 'Choose a rule to modify',
    'mapping.option.noRulesToModify': 'No rules available for modification',
    'mapping.option.chooseClassFilter': 'Choose CMDBuild class or leave the filter empty',
    'mapping.option.chooseFieldFilter': 'Choose class attribute field or leave the filter empty',
    'mapping.option.chooseStructureFilter': 'Choose conversion structure or leave the filter empty',
    'mapping.option.chooseTargetFilter': 'Choose Zabbix object / payload or leave the filter empty',
    'mapping.option.chooseLeaf': 'Choose leaf / source field',
    'mapping.option.chooseStructure': 'Choose conversion structure',
    'mapping.option.chooseTarget': 'Choose Zabbix object / payload',
    'mapping.option.noCompatibleFields': 'No compatible CMDBuild fields for {target}',
    'mapping.option.noFields': 'No available CMDBuild fields',
    'mapping.option.currentFieldMissing': 'Current rule field: {field} / not confirmed by catalog',
    'mapping.option.currentTargetMissing': 'Current rule target / missing from Zabbix catalog',
    'mapping.option.currentTargetMissingChooseNew': 'Current rule target is missing from the Zabbix catalog: choose a new target',
    'mapping.option.currentFieldMissingMeta': 'The value was loaded from an existing rule but was not found in the current compatible CMDBuild fields.',
    'mapping.option.currentTargetMissingMeta': 'Target was loaded from an existing rule but was not found in the current Zabbix catalog/options. The field is left empty so a new target can be chosen.',
    'mapping.option.chooseLeafMeta': 'Saving is available after choosing the final leaf/source field.',
    'mapping.option.chooseStructureMeta': 'Saving is available after choosing a conversion structure.',
    'mapping.option.chooseTargetMeta': 'Saving is available after choosing a compatible Zabbix target.',
    'mapping.option.modifyStartsWithoutRuleMeta': 'Modification starts without a selected rule.',
    'mapping.option.loadingZabbix': 'Loading Zabbix catalog...',
    'mapping.option.loadError': 'Load error: {message}',
    'mapping.option.ipAddress': 'IP address -> interfaces[].ip / useip=1',
    'mapping.option.dnsName': 'DNS name -> interfaces[].dns / useip=0',
    'mapping.option.agentInterface': 'Agent interface',
    'mapping.option.snmpInterface': 'SNMP interface',
    'mapping.option.monitoringSuppression': 'Skip create/update when attribute matches',
    'mapping.option.profilePrefix': 'Profile: {name}',
    'mapping.option.newHostMacro': 'New host macro from class attribute field',
    'mapping.option.inventoryFromField': 'Inventory field from class attribute field',
    'mapping.target.hostGroups': 'Host group rule',
    'mapping.target.templates': 'Template rule',
    'mapping.target.tags': 'Tag rule',
    'mapping.target.interfaceAddress': 'Interface address rule',
    'mapping.target.interface': 'Interface rule',
    'mapping.target.monitoringSuppression': 'Monitoring suppression rule',
    'session.notAuthenticated': 'not authenticated',
    'help.general.title': 'General Principle',
    'help.general.1': 'The browser works only with monitoring-ui-api; it does not connect directly to CMDBuild, Zabbix, or Kafka.',
    'help.general.2': 'Addresses, Zabbix API key, Kafka topics, and Events read settings are configured externally or through Runtime settings. Authorization is configured separately: local, MS AD, or IdP with AD groups mapped to roles.',
    'help.general.3': 'Tooltips are shown when you hover or focus interface elements.',
    'help.dashboard.title': 'Dashboard And Events',
    'help.dashboard.1': 'Dashboard shows availability for cmdbwebhooks2kafka, cmdbkafka2zabbix, zabbixrequests2api, and the BFF itself.',
    'help.dashboard.2': 'Events reads the latest messages from configured Kafka topics through the backend adapter.',
    'help.dashboard.3': 'The Events count means the last N messages; by default, the last 5 messages are shown.',
    'help.rules.title': 'Rules',
    'help.rules.1': 'Load fetches the current conversion rules JSON.',
    'help.rules.2': 'Validate checks the rules structure on the backend.',
    'help.rules.3': 'Dry-run applies rules to a test CMDBuild payload without saving.',
    'help.rules.4': 'Save file as saves the rules JSON through the browser; the backend rules file and git are not changed.',
    'help.rules.5': 'Create empty generates a production starter from the current environment: endpoints/topics and CMDBuild/Zabbix references come from runtime config and catalog cache, while routes stay publish=false until explicitly enabled. If the CMDBuild or Zabbix cache is empty, the backend returns an error and asks to sync the catalog first.',
    'help.mapping.title': 'Conversion Rules Management',
    'help.mapping.1': 'The page shows the CMDBuild -> Conversion Rules -> Zabbix chain.',
    'help.mapping.2': 'View mode shows the selected chain and hides unrelated class attributes, rule sub-blocks, and Zabbix list items.',
    'help.mapping.3': 'Clear selection is available in view mode and returns the page to the normal overview.',
    'help.mapping.4': 'Edit mode hides the lower preview and changes the current session draft JSON: you can start from any form node, while dependent fields are filtered and highlighted.',
    'help.mapping.5': 'Modify rule starts without an automatically selected rule: you can start from a rule, class, field, or conversion structure. Linked lists are filtered, a single matching rule is selected automatically, and Reset fields returns the form to empty filters. A target missing from the Zabbix catalog is inconsistent and blocks saving.',
    'help.mapping.6': 'The Delete rule & classes action shows current draft rules as a CMDBuild, Zabbix, or rules tree. You can check a whole class, CMDBuild attribute, Zabbix payload field, Zabbix object group, or a single rule; source classes/class attribute fields are cleaned through Conversion Rules Logical Control.',
    'help.mapping.7': 'Undo and Redo work with the current session history, and Save file as saves the draft to a separate JSON file without sending it to the backend.',
    'help.mapping.8': 'Save file as also checks that every configured class has an IP or DNS class attribute field linked to Zabbix interface rules or hostProfiles[].interfaces.',
    'help.mapping.9': 'Clicking the selected item again clears the selection.',
    'help.mapping.10': 'Interface address rules choose how to fill the Zabbix interface: the IP target writes interfaces[].ip/useip=1, and the DNS target writes interfaces[].dns/useip=0. The editor blocks explicit IP attributes as DNS and DNS/FQDN attributes as IP.',
    'help.mapping.11': 'Host profiles describe two modes: multiple interfaces[] inside one Zabbix host, or several Zabbix hosts from one CMDB object.',
    'help.mapping.12': 'Inside a host profile, interface profile selects agent/SNMP/IPMI/JMX monitoring type, and valueField points to the CMDB attribute used as IP or DNS.',
    'help.mapping.13': 'Webhook source keys may differ from CMDBuild attribute names; the link is declared through cmdbAttribute or cmdbPath and does not add hidden aliases to payload processing.',
    'help.mapping.14': 'For lookup values, only the exact class + lookup + value link is highlighted, for example Notebook.zabbixTag.tag1.',
    'help.mapping.15': 'Regex rules show which class attribute fields select groups, templates, tags, and extended Zabbix objects.',
    'help.mapping.16': 'A domain path such as Class.{domain:RelatedClass}.Attribute reads related cards through CMDBuild relations; fields that may return multiple values are unavailable for scalar Zabbix structures.',
    'help.mapping.17': 'monitoringSuppressionRules is used when instance attributes intentionally block monitoring; create/update are skipped, while delete is not blocked.',
    'help.validate.title': 'Conversion Rules Logical Control',
    'help.validate.1': 'The page does not build an interactive chain; it highlights only missing entities.',
    'help.validate.2': 'Red marks classes and attributes missing from the CMDBuild catalog, as well as Zabbix references missing from the Zabbix catalog.',
    'help.validate.3': 'A checkbox above a missing item includes it in removal from the rules JSON.',
    'help.validate.4': 'Delete asks for confirmation, saves the previous version, and fixes the selected references in rules.',
    'help.webhooks.title': 'Webhook Setup',
    'help.webhooks.1': 'The page is available to the Editor and Administrator roles.',
    'help.webhooks.2': 'Load from CMDB reads current CMDBuild webhooks through the backend; the browser does not connect to CMDBuild directly.',
    'help.webhooks.3': 'Analyze rules builds desired webhooks from current conversion rules: missing webhooks are proposed for creation, changed ones for update, and obsolete managed ones for deletion.',
    'help.webhooks.4': 'Save file as exports only the JSON plan through the browser and does not change CMDBuild, the backend rules file, or git.',
    'help.webhooks.5': 'Load into CMDB applies only selected operations and really changes webhooks in the managed system.',
    'help.webhooks.6': 'Using this page is optional: webhooks can be configured manually in CMDBuild, or operators can use the webhook files saved together with the conversion rules file.',
    'help.webhooks.7': 'Undo/Redo only changes the current plan selection and does not roll back configuration already loaded into CMDBuild.',
    'help.webhooks.8': 'Each table row can expand its payload: green means added, red means deleted, and black means current value. Clicking the Action value opens details under that row, while the shared details panel is below the table and uses the same highlighting. Edit changes JSON for that concrete webhook in the current plan.',
    'help.catalogs.title': 'Catalogs And Settings',
    'help.catalogs.1': 'Zabbix Catalog loads templates, host groups, template groups, tags, and extended Zabbix catalogs.',
    'help.catalogs.2': 'CMDBuild Catalog loads classes, attributes, domains, and lookup values.',
    'help.catalogs.3': 'Runtime settings saves connections and the Events Kafka browser; Authorization saves local mode, MS AD, IdP/SAML2/OAuth2, and AD group-to-role mapping.',
    'help.catalogs.4': 'Source catalogs should usually be changed in CMDBuild/Zabbix, while conversion behavior is changed in JSON rules.',
    'help.catalogs.5': 'For the test system, rules are read from disk at rules/cmdbuild-to-zabbix-host-create.json; when git reading is enabled, the same file is expected inside the repository at that path.',
    'tooltip.brand': 'Application name: cmdb2monitoring.',
    'tooltip.sessionSummary': 'Current user and authentication method.',
    'tooltip.idpLoginButton': 'Starts login through the selected external IdP.',
    'tooltip.logoutButton': 'Ends the current user session.',
    'tooltip.changePasswordOpen': 'Opens password change for the current local user.',
    'tooltip.refreshDashboard': 'Checks service availability again.',
    'tooltip.eventsMaxMessages': 'Number of latest Kafka messages shown below.',
    'tooltip.refreshEvents': 'Loads the topic list and latest messages for the selected topic.',
    'tooltip.loadRules': 'Loads the current conversion rules JSON.',
    'tooltip.validateRules': 'Validates rules JSON against the backend schema.',
    'tooltip.createEmptyRules': 'Creates a clean rules starter with current-environment baseline data. Loaded CMDBuild and Zabbix catalog caches are required; it is saved only through the browser.',
    'tooltip.rulesFile': 'Selects a local rules JSON file for validation, dry-run, or browser save.',
    'tooltip.rulesFilePath': 'For the test system: rules/cmdbuild-to-zabbix-host-create.json. When reading from git, the same path is expected inside the repository checkout.',
    'tooltip.rulesReadFromGit': 'Switches the displayed storage mode: off means read from disk; on means read from a git working copy when the converter service is configured accordingly.',
    'tooltip.rulesRepositoryUrl': 'Repository URL with rules. The expected file inside it is rules/cmdbuild-to-zabbix-host-create.json, or the path configured in Rules file path.',
    'tooltip.dryRunPayload': 'Test CMDBuild payload for dry-run conversion.',
    'tooltip.dryRunRules': 'Runs a trial conversion without saving rules.',
    'tooltip.saveRulesAs': 'Saves the current rules JSON through the browser. The backend rules file, git commit, and git push are not changed.',
    'tooltip.loadMapping': 'Loads the visual map of Zabbix, rules, and CMDBuild links.',
    'tooltip.mappingMode': 'Switches conversion rules management between view and current-session draft editing.',
    'tooltip.mappingEditAction': 'Switches the editor action: add, modify, or delete rules from draft JSON.',
    'tooltip.mappingClearSelection': 'Clears the highlighted chain and returns the normal overview.',
    'tooltip.mappingUndo': 'Undoes the latest draft-rules change in the current session.',
    'tooltip.mappingRedo': 'Restores the reverted draft-rules change.',
    'tooltip.mappingSaveAs': 'Saves the current draft rules JSON without sending it to the backend. A second file contains only webhook Body/DELETE instructions for rules added or removed in the current session.',
    'tooltip.mappingAddRule': 'Adds a new rule or saves changes to the selected rule in draft JSON.',
    'tooltip.mappingResetForm': 'In modify mode, clears the selected rule and filters; in add mode, clears the leaf field and target.',
    'tooltip.mappingDeleteSelectAll': 'Checks all rules in delete mode.',
    'tooltip.mappingDeleteClear': 'Clears all rule checks in delete mode.',
    'tooltip.mappingDeleteSelected': 'Deletes checked rules from draft JSON after confirmation. Classes and class attribute fields remain in place.',
    'tooltip.mappingDeleteView': 'Chooses the delete tree: by CMDBuild class/attribute, by Zabbix payload/object group, or by rule collections.',
    'tooltip.loadValidateMapping': 'Runs logical control of rules against current Zabbix and CMDBuild catalogs.',
    'tooltip.webhooksUndo': 'Undoes the latest webhook operation selection change in the current session.',
    'tooltip.webhooksRedo': 'Restores the reverted webhook operation selection change.',
    'tooltip.webhooksAnalyze': 'Builds the CMDBuild webhook plan from current conversion rules and the loaded CMDBuild catalog.',
    'tooltip.webhooksLoadCmdb': 'Loads current CMDBuild webhooks from the managed system.',
    'tooltip.webhooksSaveAs': 'Saves the webhook JSON plan through the browser. CMDBuild, backend rules file, and git are not changed.',
    'tooltip.webhooksApplyCmdb': 'Applies selected create/update/delete operations to CMDBuild webhooks. This changes the managed system.',
    'tooltip.webhooksSelectAll': 'Selects all webhook plan operations.',
    'tooltip.webhooksClear': 'Clears all webhook plan operation selections.',
    'tooltip.syncZabbix': 'Refreshes the Zabbix catalog from the Zabbix API.',
    'tooltip.loadZabbix': 'Loads the saved Zabbix catalog.',
    'tooltip.syncCmdbuild': 'Refreshes the CMDBuild catalog through the CMDBuild API.',
    'tooltip.loadCmdbuild': 'Loads the saved CMDBuild catalog.',
    'tooltip.loadRuntimeSettings': 'Loads runtime settings from the external file.',
    'tooltip.loadAuthSettings': 'Loads authorization settings and local users.',
    'tooltip.saveRuntimeSettings': 'Saves runtime settings to the external file.',
    'tooltip.saveIdp': 'Saves authorization mode, IdP/MS AD parameters, and role-to-group mapping.',
    'tooltip.loadUsers': 'Loads local users and roles.',
    'tooltip.resetUserPassword': 'Resets the selected user password. The hash is stored in the users file.',
    'tooltip.helpPopoverClose': 'Closes the open tooltip.',
    'tooltip.field': 'Field "{label}". The value is used by the relevant interface section or saved to an external configuration file.',
    'tooltip.tableColumn': 'Table column "{label}".'
  }
};

const viewDescriptions = {
  ru: {
    dashboard: 'Показывает состояние доступности сервисов и быстрые проверки текущего окружения.',
    events: 'Показывает используемые Kafka-топики и последние сообщения выбранного топика.',
    rules: 'Загружает текущий JSON правил, проверяет его, выполняет dry-run и сохраняет файл через браузер.',
    mapping: 'Показывает цепочку CMDBuild -> conversion rules -> Zabbix. Host profiles показывают fan-out и набор interfaces; Template rules выбирают templates, Tag rules формируют tags. Template conflicts могут удалить template из результата при конфликте item key или inventory field.',
    validateMapping: 'Проверяет правила против каталогов Zabbix и CMDBuild; красным отмечаются только отсутствующие сущности в источниках. Template rules не назначают tags, а Tag rules не назначают templates; смешивать результат этих блоков нецелесообразно.',
    webhooks: 'Пользоваться этим пунктом не обязательно: можно самостоятельно настроить webhooks в CMDBuild или использовать webhook-файлы, которые сохраняются при сохранении файла конвертации. Здесь можно загрузить текущие CMDBuild webhooks, построить план create/update/delete по rules и явно загрузить выбранные операции в CMDBuild. Undo/Redo не откатывают уже выполненную загрузку конфигурации в CMDBuild.',
    zabbix: 'Показывает templates, host groups, template groups, tags и расширенные Zabbix-справочники: proxies, macros, inventory fields, interface profiles, statuses, maintenance, TLS/PSK и value maps.',
    cmdbuild: 'Показывает классы, атрибуты, domains и lookup-справочники, загруженные из CMDBuild.',
    authSettings: 'Управляет режимом авторизации: локальная, MS AD или IdP. В IdP режиме MS AD используется для сопоставления групп с ролями.',
    runtimeSettings: 'Содержит runtime-настройки подключений, Zabbix API key и Kafka Events.',
    about: 'Информация об авторстве и свободном использовании.',
    help: 'Содержит справку по разделам интерфейса, управлению правилами конвертации, логическому контролю правил конвертации и настройкам.'
  },
  en: {
    dashboard: 'Shows service availability and quick checks for the current environment.',
    events: 'Shows configured Kafka topics and the latest messages from the selected topic.',
    rules: 'Loads the current rules JSON, validates it, runs dry-run, and saves a rules file through the browser.',
    mapping: 'Shows the CMDBuild -> conversion rules -> Zabbix chain. Host profiles show fan-out and interfaces; Template rules select templates; Tag rules create tags.',
    validateMapping: 'Validates rules against Zabbix and CMDBuild catalogs; only missing source entities are highlighted.',
    webhooks: 'Using this page is optional: webhooks can be configured manually in CMDBuild, or operators can use the webhook files saved with the conversion rules file. This page loads current CMDBuild webhooks, builds a create/update/delete plan from rules, and explicitly loads selected operations into CMDBuild. Undo/Redo does not roll back configuration already loaded into CMDBuild.',
    zabbix: 'Shows templates, host groups, template groups, tags, and extended Zabbix catalogs.',
    cmdbuild: 'Shows classes, attributes, domains, and lookup catalogs loaded from CMDBuild.',
    authSettings: 'Manages authorization mode: local, MS AD, or IdP. In IdP mode, MS AD is used for group-to-role mapping.',
    runtimeSettings: 'Contains runtime connection settings, Zabbix API key, and Kafka Events.',
    about: 'Authorship and free-use information.',
    help: 'Contains help for UI sections, Conversion Rules Management, Conversion Rules Logical Control, and settings.'
  }
};

const defaultPayload = {
  source: 'cmdbuild',
  eventType: 'update',
  className: 'Server',
  id: '109921',
  code: 's1',
  ip_address: '1.1.1.2',
  interface: '1.1.1.101',
  interface2: '1.1.1.102',
  profile: '1.1.1.201',
  profile2: '1.1.1.202',
  dns_name: 's1.example.local',
  profile_dns: 's1-profile.example.local',
  description: 's1',
  os: '105146',
  zabbixTag: '106852'
};

initializeLanguage();
applyLanguage();
$('#dryRunPayload').value = JSON.stringify(defaultPayload, null, 2);

await initialize();

async function initialize() {
  bindNavigation();
  bindForms();
  bindHelp();
  applyViewDescriptions();
  applyHelpText();
  const status = await api('/api/auth/status');
  renderAuth(status);
  if (status.authenticated) {
    await loadDashboard();
    if (canUseRules()) {
      await loadRules();
    }
    if (currentRole() === 'admin') {
      await loadRuntimeSettings();
    }
  }
}

function bindNavigation() {
  $$('.nav-item[data-view]').forEach(button => {
    button.addEventListener('click', async () => {
      if (!canView(button.dataset.view)) {
        return;
      }

      showView(button.dataset.view);
      if (button.dataset.view === 'mapping' && !state.mappingLoaded) {
        await loadMapping();
      }
      if (button.dataset.view === 'validateMapping' && !state.validateMappingLoaded) {
        await loadValidateMapping();
      }
      if (button.dataset.view === 'webhooks' && !state.webhooksLoaded) {
        await loadCmdbuildWebhooks();
      }
      if (button.dataset.view === 'runtimeSettings') {
        await loadRuntimeSettings();
      }
      if (button.dataset.view === 'authSettings') {
        await loadAuthSettings();
      }
    });
  });
}

function showView(viewId) {
  const targetView = canView(viewId) ? viewId : defaultViewForRole();
  $$('.nav-item[data-view]').forEach(item => item.classList.toggle('active', item.dataset.view === targetView));
  $$('.view').forEach(view => view.classList.toggle('active', view.id === targetView));
  updateViewDescription(targetView);
}

function applyRoleAccess() {
  $$('.nav-item[data-view]').forEach(button => {
    button.classList.toggle('hidden', state.authenticated && !canView(button.dataset.view));
  });

  const activeView = $('.view.active')?.id ?? 'dashboard';
  if (state.authenticated && !canView(activeView)) {
    showView(defaultViewForRole());
  }
}

function currentRole() {
  return state.user?.role ?? state.user?.roles?.[0] ?? 'viewer';
}

function canView(viewId) {
  return (roleViews[currentRole()] ?? roleViews.viewer).includes(viewId);
}

function defaultViewForRole() {
  return (roleViews[currentRole()] ?? roleViews.viewer)[0] ?? 'dashboard';
}

function canUseRules() {
  return ['editor', 'admin'].includes(currentRole());
}

function currentAuthMode() {
  const provider = currentIdpProvider();
  if (!state.auth?.useIdp && !state.idp?.enabled) {
    return 'local';
  }

  return provider === 'ldap' ? 'msad' : 'idp';
}

function currentIdpProvider() {
  return normalizeIdpProvider(state.idp?.provider ?? state.auth?.provider ?? 'saml2');
}

function normalizeIdpProvider(value) {
  const provider = String(value ?? 'saml2').trim().toLowerCase();
  if (['oauth2', 'oauth', 'oidc', 'openidconnect'].includes(provider)) {
    return 'oauth2';
  }
  if (['ldap', 'ldaps', 'msad', 'ad', 'active-directory', 'activedirectory'].includes(provider)) {
    return 'ldap';
  }
  return 'saml2';
}

function isRedirectIdp() {
  return currentAuthMode() === 'idp' && ['saml2', 'oauth2'].includes(currentIdpProvider());
}

function idpLoginRoute() {
  return currentIdpProvider() === 'oauth2' ? '/auth/oauth2/login' : '/auth/saml2/login';
}

function applyViewDescriptions() {
  for (const view of $$('.view')) {
    ensureViewDescription(view);
  }
  updateViewDescription($('.view.active')?.id ?? 'dashboard');
}

function ensureViewDescription(view) {
  const header = view.querySelector('.view-header');
  const title = header?.querySelector('h1');
  if (!header || !title) {
    return null;
  }

  let titleBlock = header.querySelector('.view-title-block');
  if (!titleBlock) {
    titleBlock = el('div', 'view-title-block', '');
    header.insertBefore(titleBlock, title);
    titleBlock.append(title);
  }

  let description = titleBlock.querySelector('.view-description');
  if (!description) {
    description = el('p', 'view-description', '');
    titleBlock.append(description);
  }

  description.textContent = viewDescription(view.id);
  return description;
}

function updateViewDescription(viewId) {
  const view = document.getElementById(viewId);
  if (!view) {
    return;
  }
  ensureViewDescription(view);
}

function initializeLanguage() {
  state.language = normalizeLanguage(readCookie(languageCookieName));
  document.documentElement.lang = state.language;
  const selector = $('#interfaceLanguage');
  if (selector) {
    selector.value = state.language;
  }
}

function setLanguage(value) {
  state.language = normalizeLanguage(value);
  writeCookie(languageCookieName, state.language, 365);
  hideHelp();
  applyLanguage();
}

function applyLanguage() {
  document.documentElement.lang = state.language;
  const selector = $('#interfaceLanguage');
  if (selector && selector.value !== state.language) {
    selector.value = state.language;
  }

  $$('[data-i18n]').forEach(node => {
    node.textContent = t(node.dataset.i18n);
  });
  $$('[data-i18n-placeholder]').forEach(node => {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  });
  $$('[data-help-key]').forEach(node => {
    setHelp(node, t(node.dataset.helpKey));
  });
  $$('.view').forEach(ensureViewDescription);
  updateSessionSummary();
  updateLocalizedDynamicUi();
  applyHelpText();
}

function t(key) {
  return translations[state.language]?.[key] ?? translations.ru[key] ?? key;
}

function tf(key, values = {}) {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value ?? ''),
    t(key));
}

function updateLocalizedDynamicUi() {
  updateMappingEditorControls();
  updateRuntimeRulesUiState();
  if (state.mappingLoaded && state.mappingMode === 'edit') {
    refreshMappingEditorLocalizedControls();
    setMappingEditorStatusForDraft(mappingEditorActionStatus());
  }
  if (state.webhooksLoaded) {
    renderWebhooks();
  }
}

function viewDescription(viewId) {
  return viewDescriptions[state.language]?.[viewId]
    ?? viewDescriptions.ru[viewId]
    ?? '';
}

function normalizeLanguage(value) {
  return ['ru', 'en'].includes(value) ? value : 'ru';
}

function readCookie(name) {
  const prefix = `${encodeURIComponent(name)}=`;
  return document.cookie
    .split(';')
    .map(item => item.trim())
    .find(item => item.startsWith(prefix))
    ?.slice(prefix.length) ?? '';
}

function writeCookie(name, value, maxAgeDays) {
  const maxAge = Math.max(1, Number(maxAgeDays) || 365) * 24 * 60 * 60;
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
}

function updateSessionSummary() {
  const summary = $('#sessionSummary');
  if (!summary) {
    return;
  }

  summary.textContent = state.authenticated
    ? `${state.user?.identity?.displayName ?? state.user?.identity?.login ?? 'user'} | ${state.user?.roleLabel ?? currentRole()} | ${state.user?.authMethod ?? 'local'}`
    : t('session.notAuthenticated');

  $('#changePasswordOpen')?.classList.toggle('hidden', !state.authenticated || state.user?.authMethod !== 'local');
}

function bindForms() {
  $('#interfaceLanguage')?.addEventListener('change', event => {
    setLanguage(event.target.value);
  });

  $('#loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (isRedirectIdp()) {
      location.href = idpLoginRoute();
      return;
    }

    $('#loginError').textContent = '';
    const form = new FormData(event.currentTarget);
    try {
      const result = await api('/api/auth/login', {
        method: 'POST',
        body: {
          username: form.get('username'),
          password: form.get('password')
        }
      });
      renderAuth({ authenticated: true, user: result.user });
      await loadDashboard();
      if (canUseRules()) {
        await loadRules();
      }
    } catch (error) {
      $('#loginError').textContent = error.message;
    }
  });

  $('#idpLoginButton').addEventListener('click', () => {
    location.href = idpLoginRoute();
  });

  $('#logoutButton').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} });
    location.reload();
  });

  $('#refreshDashboard').addEventListener('click', loadDashboard);
  $('#refreshEvents').addEventListener('click', loadEvents);
  $('#eventsTopic').addEventListener('change', loadEvents);
  $('#loadRules').addEventListener('click', loadRules);
  $('#createEmptyRules').addEventListener('click', createEmptyRulesStarter);
  $('#loadMapping').addEventListener('click', loadMapping);
  $('#mappingClearSelection').addEventListener('click', () => clearMappingHighlight($('#mapping')));
  $('#mappingMode').addEventListener('change', updateMappingMode);
  $('#mappingEditAction').addEventListener('change', updateMappingEditorAction);
  $('#mappingModifyRule')?.addEventListener('change', () => {
    if ($('#mappingModifyRule').value) {
      loadSelectedMappingRuleIntoEditor();
      refreshMappingEditorDependentControls();
      return;
    }

    clearMappingEditorRuleForm();
    populateMappingModifyFilterControls({ autoSelect: false });
    setMappingEditorStatus(t('mapping.status.noModifyRule'));
  });
  $('#mappingUndo').addEventListener('click', undoMappingEdit);
  $('#mappingRedo').addEventListener('click', redoMappingEdit);
  $('#mappingSaveAs').addEventListener('click', saveMappingDraftAsFile);
  $('#mappingEditTargetType').addEventListener('change', handleMappingEditorStructureChange);
  $('#mappingEditClass').addEventListener('change', handleMappingEditorClassChange);
  $('#mappingEditField').addEventListener('change', handleMappingEditorFieldChange);
  $('#mappingEditZabbixObject').addEventListener('change', handleMappingEditorTargetChange);
  $('#mappingEditRegex').addEventListener('input', handleMappingEditorLeafChange);
  $('#mappingEditPriority').addEventListener('input', handleMappingEditorLeafChange);
  $('#mappingEditRuleName').addEventListener('input', handleMappingEditorLeafChange);
  $('#mappingResetForm').addEventListener('click', resetMappingEditorForm);
  $('#mappingAddRule').addEventListener('click', applyMappingEditorRule);
  $('#mappingDeleteView')?.addEventListener('change', () => {
    state.mappingDeleteView = $('#mappingDeleteView').value;
    renderMappingDeleteRules();
  });
  $('#mappingDeleteSelectAll').addEventListener('click', () => setMappingDeleteSelection(true));
  $('#mappingDeleteClear').addEventListener('click', () => setMappingDeleteSelection(false));
  $('#mappingDeleteSelected').addEventListener('click', deleteSelectedMappingRules);
  $('#mappingDeleteRules').addEventListener('change', event => {
    if (event.target.matches('.mapping-delete-checkbox')) {
      updateMappingDeleteControls();
    } else if (event.target.matches('.mapping-delete-group-checkbox')) {
      setMappingDeleteGroupSelection(event.target);
    }
  });
  $('#loadValidateMapping').addEventListener('click', loadValidateMapping);
  $('#validateMappingUndo')?.addEventListener('click', undoValidateMappingEdit);
  $('#validateMappingRedo')?.addEventListener('click', redoValidateMappingEdit);
  $('#validateMappingSaveAs')?.addEventListener('click', saveValidateMappingDraftAsFile);
  $('#webhooksUndo')?.addEventListener('click', undoWebhooksEdit);
  $('#webhooksRedo')?.addEventListener('click', redoWebhooksEdit);
  $('#webhooksAnalyze')?.addEventListener('click', analyzeCmdbuildWebhooks);
  $('#webhooksLoadCmdb')?.addEventListener('click', loadCmdbuildWebhooks);
  $('#webhooksSaveAs')?.addEventListener('click', saveWebhooksAsFile);
  $('#webhooksApplyCmdb')?.addEventListener('click', applyCmdbuildWebhooks);
  $('#webhooksSelectAll')?.addEventListener('click', () => setWebhookOperationsSelection(true));
  $('#webhooksClear')?.addEventListener('click', () => setWebhookOperationsSelection(false));
  $('#deleteValidateMappingSelected').addEventListener('click', deleteSelectedValidationFixes);
  $('#validateRules').addEventListener('click', validateRules);
  $('#dryRunRules').addEventListener('click', dryRunRules);
  $('#saveRulesAs').addEventListener('click', saveRulesAsFile);
  $('#syncZabbix').addEventListener('click', syncZabbix);
  $('#loadZabbix').addEventListener('click', loadZabbix);
  $('#syncCmdbuild').addEventListener('click', syncCmdbuild);
  $('#loadCmdbuild').addEventListener('click', loadCmdbuild);
  $('#loadRuntimeSettings').addEventListener('click', loadRuntimeSettings);
  $('#loadAuthSettings').addEventListener('click', loadAuthSettings);
  $('#saveRuntimeSettings').addEventListener('click', saveRuntimeSettings);
  $('#saveIdp').addEventListener('click', saveIdp);
  $('#idpForm')?.addEventListener('change', event => {
    if (event.target.matches('[name="authMode"], [name="provider"]')) {
      updateIdpUiState();
    }
  });
  $('#runtimeSettingsForm')?.addEventListener('change', event => {
    if (event.target.matches('[name="cmdbuildMaxTraversalDepth"]')) {
      toast(t('toast.maxTraversalDepthChanged'));
    }
    if (event.target.matches('[name="rulesReadFromGit"], [name="rulesFilePath"]')) {
      updateRuntimeRulesUiState();
    }
  });
  $('#changePasswordOpen')?.addEventListener('click', openPasswordDialog);
  $('#passwordCancel')?.addEventListener('click', closePasswordDialog);
  $('#passwordForm')?.addEventListener('submit', changeOwnPassword);
  $('#credentialsCancel')?.addEventListener('click', cancelCredentialPrompt);
  $('#credentialsForm')?.addEventListener('submit', submitSessionCredentials);
  $('#validationRuleApplyEdit')?.addEventListener('click', applyValidationRuleDialogEdit);
  $('#validationRuleDeleteAnyway')?.addEventListener('click', deleteValidationRuleDialogAnyway);
  $('#validationRuleCancel')?.addEventListener('click', cancelValidationRuleDialog);
  $('#webhookEditApply')?.addEventListener('click', applyWebhookEditDialog);
  $('#webhookEditCancel')?.addEventListener('click', closeWebhookEditDialog);
  $('#loadUsers')?.addEventListener('click', loadUsers);
  $('#resetUserPassword')?.addEventListener('click', resetUserPassword);
  $('#rulesFile').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    state.uploadedRulesText = file ? await file.text() : null;
    toast(file ? `Loaded ${file.name}` : 'Rules file cleared');
  });
  $('#validateMapping').addEventListener('change', event => {
    if (event.target.matches('.validation-fix-checkbox')) {
      updateValidationSelectionControls();
    }
  });
  $('#webhooks')?.addEventListener('change', event => {
    if (event.target.matches('.webhook-operation-checkbox')) {
      updateWebhookOperationSelection(event.target);
    }
  });
  $('#webhooks')?.addEventListener('click', event => {
    const detailCell = event.target.closest('[data-webhook-detail-kind]');
    if (detailCell) {
      toggleWebhookDetails(detailCell.dataset.webhookDetailKind, Number(detailCell.dataset.webhookIndex));
      return;
    }

    const expandButton = event.target.closest('[data-webhook-expand-kind]');
    if (expandButton) {
      toggleWebhookPayload(expandButton.dataset.webhookExpandKind, Number(expandButton.dataset.webhookIndex));
      return;
    }

    const editButton = event.target.closest('[data-webhook-edit-kind]');
    if (editButton) {
      openWebhookEditDialog(editButton.dataset.webhookEditKind, Number(editButton.dataset.webhookIndex));
      return;
    }

    const row = event.target.closest('[data-webhook-operation-index]');
    if (row) {
      renderWebhookOperationDetails(Number(row.dataset.webhookOperationIndex));
      return;
    }

    const currentRow = event.target.closest('[data-current-webhook-index]');
    if (currentRow) {
      renderCurrentWebhookDetails(Number(currentRow.dataset.currentWebhookIndex));
    }
  });
  $$('[data-validation-select]').forEach(button => {
    button.addEventListener('click', () => setValidationColumnSelection(button.dataset.validationSelect, true));
  });
  $$('[data-validation-clear]').forEach(button => {
    button.addEventListener('click', () => setValidationColumnSelection(button.dataset.validationClear, false));
  });
  $('#helpPopoverClose').addEventListener('click', hideHelp);
}

function renderAuth(status) {
  state.auth = status.auth ?? {};
  state.idp = status.idp ?? null;
  state.authenticated = Boolean(status.authenticated);
  state.user = status.user ?? null;
  $('#loginView').classList.toggle('hidden', status.authenticated);
  $('#appView').classList.toggle('hidden', !status.authenticated);
  $('#idpLoginBlock').classList.toggle('hidden', !isRedirectIdp() || status.authenticated);
  $('#localCredentials').classList.toggle('hidden', isRedirectIdp());
  $('#localLoginActions').classList.toggle('hidden', isRedirectIdp());
  updateSessionSummary();
  applyRoleAccess();
  if (status.authenticated) {
    if (status.idp) {
      fillIdpForm(status.idp);
    }
    updateIdpUiState();
  }
  if (status.authenticated && status.user?.passwordChangeRequired) {
    openPasswordDialog();
  }
}

async function loadDashboard() {
  const health = await api('/api/services/health');
  const grid = $('#healthGrid');
  clear(grid);
  for (const item of health.items) {
    const node = document.createElement('div');
    node.className = 'metric';
    node.append(
      el('div', 'metric-title', item.name),
      el('div', `metric-value ${item.ok ? 'status-ok' : 'status-bad'}`, item.ok ? 'OK' : 'FAIL'),
      el('div', 'metric-detail', `${item.statusCode ?? '-'} | ${item.latencyMs} ms | ${item.url}`)
    );
    if (item.rulesReloadSupported && canUseRules()) {
      const actions = el('div', 'metric-actions', '');
      const reloadButton = el('button', 'secondary', t('dashboard.reloadRules'));
      reloadButton.type = 'button';
      reloadButton.addEventListener('click', () => reloadConversionRules(item.name, reloadButton));
      actions.append(reloadButton);
      node.append(actions);
    }
    setHelp(node, `Проверка сервиса "${item.name}". Показывает HTTP-статус, задержку и проверяемый URL.`);
    grid.append(node);
  }
}

async function reloadConversionRules(serviceName, button) {
  const originalText = button?.textContent ?? '';
  if (button) {
    button.disabled = true;
    button.textContent = '...';
  }

  try {
    await api(`/api/services/${encodeURIComponent(serviceName)}/reload-rules`, {
      method: 'POST',
      body: {}
    });
    toast(t('toast.rulesReloaded'));
    await loadDashboard();
  } catch (error) {
    toast(error.message);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function loadEvents() {
  const params = new URLSearchParams();
  const selectedTopic = $('#eventsTopic').value;
  const maxMessages = $('#eventsMaxMessages').value || String(defaultEventMaxMessages);
  if (selectedTopic) {
    params.set('topic', selectedTopic);
  }
  if (maxMessages) {
    params.set('maxMessages', maxMessages);
  }

  const events = await api(`/api/events${params.size ? `?${params}` : ''}`);
  renderEventTopics(events.topics ?? [], events.selectedTopic);
  const eventItems = events.items.length ? [...events.items].sort(compareEventsByNewestTimestamp) : [{
    topic: events.selectedTopic ?? events.source,
    service: '',
    partition: '',
    offset: '',
    timestamp: '',
    key: '',
    value: events.message || 'empty'
  }];
  renderRows($('#eventsTable'), eventItems, item => [
    item.timestamp,
    eventDetailsNode(item),
    eventValueNode(item.value)
  ]);
}

function compareEventsByNewestTimestamp(left, right) {
  const leftTime = Date.parse(left.timestamp ?? '') || 0;
  const rightTime = Date.parse(right.timestamp ?? '') || 0;
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  const offsetDelta = eventOffset(right.offset) - eventOffset(left.offset);
  return offsetDelta > 0n ? 1 : offsetDelta < 0n ? -1 : 0;
}

function eventOffset(value) {
  try {
    return BigInt(value ?? 0);
  } catch {
    return 0n;
  }
}

function renderEventTopics(topics, selectedTopic) {
  const select = $('#eventsTopic');
  const current = selectedTopic || select.value;
  clear(select);
  for (const topic of topics) {
    const option = document.createElement('option');
    option.value = topic.name;
    option.textContent = topic.name;
    option.selected = topic.name === current;
    select.append(option);
  }

  renderRows($('#eventsTopicsTable'), topics, item => [
    topicLink(item.name),
    item.service,
    item.direction,
    item.description
  ]);
}

function topicLink(topicName) {
  if (!topicName) {
    return '';
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link-button';
  button.textContent = topicName;
  setHelp(button, `Открыть последние сообщения Kafka-топика "${topicName}".`);
  button.addEventListener('click', async () => {
    const selector = $('#eventsTopic');
    if (![...selector.options].some(option => option.value === topicName)) {
      const option = document.createElement('option');
      option.value = topicName;
      option.textContent = topicName;
      selector.append(option);
    }

    selector.value = topicName;
    $('#eventsMaxMessages').value ||= String(defaultEventMaxMessages);
    await loadEvents();
    $('#eventsTable').closest('.surface')?.scrollIntoView({ block: 'start' });
  });
  return button;
}

function eventDetailsNode(item) {
  const node = el('div', 'event-details', '');
  setHelp(node, 'Сводная информация о Kafka-сообщении: сервис, partition, offset и key.');
  node.replaceChildren(...[
    ['Service', item.service],
    ['Partition', item.partition],
    ['Offset', item.offset],
    ['Key', item.key]
  ].map(([name, value]) => {
    const row = el('div', 'event-detail-row', '');
    row.append(el('span', 'event-detail-name', name), el('span', 'event-detail-value', value ?? ''));
    return row;
  }));
  return node;
}

function eventValueNode(value) {
  return setHelp(el('pre', 'event-value', formatEventValue(value)), 'Value Kafka-сообщения. JSON форматируется для чтения, если его удалось разобрать.');
}

function formatEventValue(value) {
  if (typeof value !== 'string') {
    return value ?? '';
  }

  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

async function loadRules() {
  state.currentRules = await api('/api/rules/current');
  renderDefinitionList($('#rulesSummary'), {
    path: state.currentRules.path,
    name: state.currentRules.name,
    schemaVersion: state.currentRules.schemaVersion,
    rulesVersion: state.currentRules.rulesVersion,
    valid: state.currentRules.validation.valid
  });
  $('#rulesPreview').textContent = JSON.stringify(state.currentRules.content, null, 2);
}

async function validateRules() {
  const payload = state.uploadedRulesText
    ? { content: state.uploadedRulesText }
    : { content: state.currentRules?.content };
  const result = await api('/api/rules/validate', { method: 'POST', body: payload });
  $('#rulesResult').textContent = JSON.stringify(result, null, 2);
}

async function createEmptyRulesStarter() {
  try {
    const result = await api('/api/rules/starter', { method: 'POST', body: {} });
    state.uploadedRulesText = JSON.stringify(result.content, null, 2);
    $('#rulesPreview').textContent = state.uploadedRulesText;
    $('#rulesResult').textContent = JSON.stringify({
      generatedAt: result.generatedAt,
      saved: result.saved,
      templatePath: result.templatePath,
      targetPath: result.targetPath,
      source: result.source,
      validation: result.validation,
      next: 'Review generated JSON, then use Save file as and publish it to the rules git repository outside the application.'
    }, null, 2);
    toast(t('toast.emptyRulesCreated'));
  } catch (error) {
    $('#rulesResult').textContent = JSON.stringify(error.payload ?? {
      error: 'starter_failed',
      message: error.message
    }, null, 2);
    toast(`${t('toast.emptyRulesFailed')}: ${error.message}`);
  }
}

async function dryRunRules() {
  const payload = JSON.parse($('#dryRunPayload').value);
  const body = state.uploadedRulesText
    ? { rules: JSON.parse(state.uploadedRulesText), payload }
    : { payload };
  const result = await api('/api/rules/dry-run', { method: 'POST', body });
  $('#rulesResult').textContent = JSON.stringify(result, null, 2);
}

async function saveRulesAsFile() {
  const rules = state.uploadedRulesText
    ? JSON.parse(state.uploadedRulesText)
    : state.currentRules?.content;
  if (!rules) {
    toast('Rules JSON is not loaded');
    return;
  }

  const validation = await api('/api/rules/validate', {
    method: 'POST',
    body: { content: rules }
  });
  $('#rulesResult').textContent = JSON.stringify({
    saved: false,
    note: 'Rules JSON saved through the browser only. Publish the file to git outside the application, then reload rules on the microservice.',
    validation
  }, null, 2);
  if (!validation.valid) {
    const confirmed = window.confirm('Rules JSON has validation errors. Save file anyway?');
    if (!confirmed) {
      return;
    }
  }

  const defaultName = `${normalizeRuleName(rules.name || 'cmdbuild-to-zabbix-rules')}.json`;
  const content = `${JSON.stringify(rules, null, 2)}\n`;
  const result = await saveTextAsFile(content, defaultName, 'JSON rules', { 'application/json': ['.json'] });
  if (!result.cancelled) {
    toast(`Rules file saved: ${result.name}`);
  }
}

async function syncZabbix() {
  const result = await api('/api/zabbix/catalog/sync', { method: 'POST', body: {} });
  renderZabbix(result);
  toast('Zabbix catalog synced');
}

async function loadZabbix() {
  renderZabbix(await api('/api/zabbix/catalog'));
}

function renderZabbix(catalog) {
  const menu = $('#zabbixCatalogMenu');
  const content = $('#zabbixCatalogContent');
  clear(menu);
  clear(content);

  for (const definition of zabbixCatalogSections) {
    const items = catalog[definition.key] ?? [];
    menu.append(zabbixCatalogMenuItem(definition, items.length));
    content.append(zabbixCatalogSection(definition, items));
  }
}

function zabbixCatalogMenuItem(definition, count) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'zabbix-catalog-menu-item';
  button.dataset.zabbixCatalogKey = definition.key;
  button.append(
    el('span', 'zabbix-catalog-menu-title', definition.title),
    el('span', 'zabbix-catalog-count', String(count))
  );
  setHelp(button, `Открыть или закрыть раздел Zabbix Catalog "${definition.title}". В разделе ${count} элементов.`);
  button.addEventListener('click', () => toggleZabbixCatalogSection(definition.key));
  return button;
}

function zabbixCatalogSection(definition, items) {
  const section = document.createElement('section');
  section.className = 'surface zabbix-catalog-section is-collapsed';
  section.dataset.zabbixCatalogKey = definition.key;
  section.dataset.rendered = 'false';
  const header = el('div', 'zabbix-catalog-section-header', '');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'zabbix-catalog-section-toggle';
  toggle.textContent = '+';
  const title = el('h2', '', definition.title);
  const count = el('span', 'zabbix-catalog-count', String(items.length));
  header.append(toggle, title, count);
  setHelp(header, `Раздел Zabbix Catalog "${definition.title}". Нажмите, чтобы раскрыть или свернуть таблицу.`);
  header.addEventListener('click', () => toggleZabbixCatalogSection(definition.key));
  const body = el('div', 'zabbix-catalog-section-body', '');
  section.append(header, body);
  section.renderBody = () => renderZabbixCatalogSectionBody(section, definition, items);
  return section;
}

function toggleZabbixCatalogSection(key) {
  const section = $(`.zabbix-catalog-section[data-zabbix-catalog-key="${key}"]`);
  if (!section) {
    return;
  }

  const expand = section.classList.contains('is-collapsed');
  if (expand && section.dataset.rendered !== 'true' && typeof section.renderBody === 'function') {
    section.renderBody();
  }

  section.classList.toggle('is-collapsed', !expand);
  const toggle = section.querySelector('.zabbix-catalog-section-toggle');
  if (toggle) {
    toggle.textContent = expand ? '-' : '+';
  }

  const menuItem = $(`.zabbix-catalog-menu-item[data-zabbix-catalog-key="${key}"]`);
  menuItem?.classList.toggle('is-open', expand);
  if (expand) {
    section.scrollIntoView({ block: 'nearest' });
  }
}

function renderZabbixCatalogSectionBody(section, definition, items) {
  const body = section.querySelector('.zabbix-catalog-section-body');
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const header of definition.headers) {
    headerRow.append(el('th', '', header));
  }
  thead.append(headerRow);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  renderRows(tbody, items, definition.row);
  const nodes = [table];
  if (items.length > 250) {
    nodes.push(el('p', 'zabbix-catalog-note', `Показаны первые 250 из ${items.length}.`));
  }
  body.replaceChildren(...nodes);
  section.dataset.rendered = 'true';
}

function hostMacroHost(item) {
  const host = item.hosts?.[0];
  return host?.name ?? host?.host ?? item.hostid ?? '';
}

async function syncCmdbuild() {
  const result = await api('/api/cmdbuild/catalog/sync', { method: 'POST', body: {} });
  renderCmdbuild(result);
  toast('CMDBuild catalog synced');
}

async function loadCmdbuild() {
  renderCmdbuild(await api('/api/cmdbuild/catalog'));
}

function renderCmdbuild(catalog) {
  renderRows($('#cmdbClasses'), catalog.classes ?? [], item => [
    item.name,
    item.active === false ? 'false' : 'true',
    item.description
  ]);
  renderRows($('#cmdbAttributes'), catalog.attributes ?? [], item => [
    item.className,
    String(item.items?.length ?? 0),
    item.error ?? 'ok'
  ]);
  renderRows($('#cmdbDomains'), catalog.domains ?? [], item => [
    item.name,
    cmdbDomainEndpointClass(item, 'source'),
    cmdbDomainEndpointClass(item, 'destination')
  ]);
}

async function loadMapping() {
  renderMappingLoading();
  let rulesDocument;
  let cmdbuildCatalog;
  try {
    [rulesDocument, cmdbuildCatalog] = await Promise.all([
      api('/api/rules/current'),
      api('/api/cmdbuild/catalog')
    ]);
  } catch (error) {
    renderMappingLoadError(error);
    state.mappingLoaded = false;
    return;
  }

  state.currentRules = rulesDocument;
  state.mappingCmdbuildCatalog = cmdbuildCatalog;
  state.mappingZabbixCatalog = null;
  initializeMappingDraft(rulesDocument.content);
  renderMapping(state.mappingDraftRules, null, cmdbuildCatalog);
  state.mappingLoaded = true;
  updateMappingEditor();
  window.setTimeout(() => loadMappingZabbix(), 200);
}

async function loadMappingZabbix() {
  const zabbixContainer = $('#mappingZabbix');
  try {
    const zabbixCatalog = await api('/api/zabbix/catalog/mapping');
    state.mappingZabbixCatalog = zabbixCatalog;
    const rules = currentMappingRules();
    window.setTimeout(() => {
      renderMappingColumn(zabbixContainer, 'Zabbix', () => renderMappingZabbix(zabbixContainer, rules, zabbixCatalog));
      updateMappingEditor();
      refreshMappingSelection($('#mapping'));
    }, 0);
  } catch (error) {
    renderMappingColumn(zabbixContainer, 'Zabbix', () => {
      throw error;
    });
  }
}

function renderMappingLoading() {
  const loadingNode = label => mappingNode({
    label,
    meta: t('mapping.loadingData'),
    level: 1,
    kind: 'rule'
  });
  for (const [container, title] of [
    [$('#mappingCmdbuild'), 'CMDBuild'],
    [$('#mappingRules'), 'Conversion Rules'],
    [$('#mappingZabbix'), 'Zabbix']
  ]) {
    clear(container);
    appendMappingSection(container, title, [loadingNode(t('common.loading'))]);
  }
}

function renderMappingLoadError(error) {
  const message = error.message ?? String(error);
  for (const [container, title] of [
    [$('#mappingCmdbuild'), 'CMDBuild load error'],
    [$('#mappingRules'), 'Conversion Rules load error'],
    [$('#mappingZabbix'), 'Zabbix load skipped']
  ]) {
    clear(container);
    appendMappingSection(container, title, [
      mappingNode({
        label: t('mapping.loadErrorTitle'),
        meta: message,
        level: 1,
        kind: 'rule',
        status: 'error',
        help: t('mapping.loadErrorHelp')
      })
    ], { status: 'error' });
  }
}

function renderMapping(rules, zabbixCatalog, cmdbuildCatalog) {
  const cmdbuildContainer = $('#mappingCmdbuild');
  const rulesContainer = $('#mappingRules');
  const zabbixContainer = $('#mappingZabbix');

  renderMappingColumn(cmdbuildContainer, 'CMDBuild', () => renderMappingCmdbuild(cmdbuildContainer, rules, cmdbuildCatalog));
  renderMappingColumn(rulesContainer, 'Conversion Rules', () => renderMappingRules(rulesContainer, rules, cmdbuildCatalog));
  updateMappingEditorControls();
  clear(zabbixContainer);
  appendMappingSection(zabbixContainer, 'Zabbix', [
    mappingNode({
      label: t('mapping.loadingLightZabbix'),
      meta: t('mapping.loadingLightZabbixMeta'),
      level: 1,
      kind: 'zabbix'
    })
  ]);
  if (zabbixCatalog) {
    window.setTimeout(() => {
      renderMappingColumn(zabbixContainer, 'Zabbix', () => renderMappingZabbix(zabbixContainer, rules, zabbixCatalog));
      refreshMappingSelection($('#mapping'));
    }, 0);
  }
  updateMappingSectionVisibility($('#mapping'));
}

function renderMappingColumn(container, name, render) {
  try {
    render();
  } catch (error) {
    console.error(`Conversion rules render failed for ${name}`, error);
    clear(container);
    appendMappingSection(container, `${name} render error`, [
      mappingNode({
        label: 'Ошибка отрисовки',
        meta: error.message ?? String(error),
        level: 1,
        kind: 'rule',
        status: 'error',
        help: `Колонка "${name}" не отрисовалась из-за клиентской ошибки. Остальные колонки управления правилами конвертации продолжают работать.`
      })
    ], { status: 'error' });
  }
}

function initializeMappingDraft(rules) {
  state.mappingDraftRules = cloneJson(rules);
  state.mappingHistory = [cloneJson(state.mappingDraftRules)];
  state.mappingHistoryIndex = 0;
  updateMappingEditorControls();
}

function currentMappingRules() {
  return state.mappingDraftRules ?? state.currentRules?.content ?? {};
}

function pushMappingHistory(nextRules) {
  state.mappingDraftRules = cloneJson(nextRules);
  state.mappingHistory = state.mappingHistory.slice(0, state.mappingHistoryIndex + 1);
  state.mappingHistory.push(cloneJson(state.mappingDraftRules));
  state.mappingHistoryIndex = state.mappingHistory.length - 1;
  updateMappingEditorControls();
}

function undoMappingEdit() {
  if (state.mappingHistoryIndex <= 0) {
    return;
  }

  state.mappingHistoryIndex -= 1;
  state.mappingDraftRules = cloneJson(state.mappingHistory[state.mappingHistoryIndex]);
  rerenderMappingDraft(t('mapping.status.undoDone'));
}

function redoMappingEdit() {
  if (state.mappingHistoryIndex >= state.mappingHistory.length - 1) {
    return;
  }

  state.mappingHistoryIndex += 1;
  state.mappingDraftRules = cloneJson(state.mappingHistory[state.mappingHistoryIndex]);
  rerenderMappingDraft(t('mapping.status.redoDone'));
}

function rerenderMappingDraft(message = '') {
  if (state.currentRules) {
    state.currentRules.content = state.mappingDraftRules;
  }
  renderMapping(state.mappingDraftRules, state.mappingZabbixCatalog, state.mappingCmdbuildCatalog);
  updateMappingEditor(message);
}

function initializeValidateMappingHistory(rules) {
  state.validateMappingRules = cloneJson(rules);
  state.validateMappingHistory = [cloneJson(state.validateMappingRules)];
  state.validateMappingHistoryIndex = 0;
  updateValidateMappingHistoryControls();
}

function pushValidateMappingHistory(nextRules) {
  state.validateMappingRules = cloneJson(nextRules);
  state.validateMappingHistory = state.validateMappingHistory.slice(0, state.validateMappingHistoryIndex + 1);
  state.validateMappingHistory.push(cloneJson(state.validateMappingRules));
  state.validateMappingHistoryIndex = state.validateMappingHistory.length - 1;
  updateValidateMappingHistoryControls();
}

function undoValidateMappingEdit() {
  if (state.validateMappingHistoryIndex <= 0) {
    return;
  }

  state.validateMappingHistoryIndex -= 1;
  state.validateMappingRules = cloneJson(state.validateMappingHistory[state.validateMappingHistoryIndex]);
  rerenderValidateMappingDraft(t('mapping.status.undoDone'));
}

function redoValidateMappingEdit() {
  if (state.validateMappingHistoryIndex >= state.validateMappingHistory.length - 1) {
    return;
  }

  state.validateMappingHistoryIndex += 1;
  state.validateMappingRules = cloneJson(state.validateMappingHistory[state.validateMappingHistoryIndex]);
  rerenderValidateMappingDraft(t('mapping.status.redoDone'));
}

function rerenderValidateMappingDraft(message = '') {
  if (state.currentRules) {
    state.currentRules.content = state.validateMappingRules;
  }
  renderValidateMapping(
    state.validateMappingRules,
    state.validateMappingZabbixCatalog ?? {},
    state.validateMappingCmdbuildCatalog ?? {}
  );
  if (message) {
    toast(message);
  }
}

function updateValidateMappingHistoryControls() {
  const hasDraft = Boolean(state.validateMappingRules);
  const undoButton = $('#validateMappingUndo');
  const redoButton = $('#validateMappingRedo');
  const saveButton = $('#validateMappingSaveAs');
  if (undoButton) {
    undoButton.disabled = !hasDraft || state.validateMappingHistoryIndex <= 0;
  }
  if (redoButton) {
    redoButton.disabled = !hasDraft || state.validateMappingHistoryIndex >= state.validateMappingHistory.length - 1;
  }
  if (saveButton) {
    saveButton.disabled = !hasDraft;
  }
}

async function loadCmdbuildWebhooks() {
  const result = await api('/api/cmdbuild/webhooks');
  state.webhooksCurrent = result.items ?? [];
  state.webhooksOperations = [];
  state.webhooksHistory = [];
  state.webhooksHistoryIndex = -1;
  state.webhooksSelectedIndex = -1;
  state.webhooksDetailRow = { kind: '', index: -1 };
  state.webhooksLoaded = true;
  renderWebhooks(tf('webhooks.statusLoaded', { count: state.webhooksCurrent.length }));
}

async function analyzeCmdbuildWebhooks() {
  if (!state.currentRules?.content) {
    state.currentRules = await api('/api/rules/current');
  }
  if (!state.webhooksLoaded) {
    const result = await api('/api/cmdbuild/webhooks');
    state.webhooksCurrent = result.items ?? [];
    state.webhooksLoaded = true;
  }
  if (!state.webhooksCmdbuildCatalog) {
    state.webhooksCmdbuildCatalog = await api('/api/cmdbuild/catalog');
  }

  const operations = buildCmdbuildWebhookOperations(
    state.currentRules.content ?? {},
    state.webhooksCmdbuildCatalog ?? {},
    state.webhooksCurrent
  );
  initializeWebhooksHistory(operations);
  renderWebhooks(tf('webhooks.statusAnalyzed', { count: operations.length }));
}

function initializeWebhooksHistory(operations) {
  state.webhooksOperations = cloneJson(operations);
  state.webhooksHistory = [cloneJson(state.webhooksOperations)];
  state.webhooksHistoryIndex = 0;
  state.webhooksSelectedIndex = operations.length > 0 ? 0 : -1;
  state.webhooksDetailRow = operations.length > 0 ? { kind: 'operation', index: 0 } : { kind: '', index: -1 };
  updateWebhooksHistoryControls();
}

function pushWebhooksHistory(operations, message = '') {
  state.webhooksOperations = cloneJson(operations);
  state.webhooksHistory = state.webhooksHistory.slice(0, state.webhooksHistoryIndex + 1);
  state.webhooksHistory.push(cloneJson(state.webhooksOperations));
  state.webhooksHistoryIndex = state.webhooksHistory.length - 1;
  renderWebhooks(message);
}

function undoWebhooksEdit() {
  if (state.webhooksHistoryIndex <= 0) {
    return;
  }

  state.webhooksHistoryIndex -= 1;
  state.webhooksOperations = cloneJson(state.webhooksHistory[state.webhooksHistoryIndex]);
  renderWebhooks(t('mapping.status.undoDone'));
}

function redoWebhooksEdit() {
  if (state.webhooksHistoryIndex >= state.webhooksHistory.length - 1) {
    return;
  }

  state.webhooksHistoryIndex += 1;
  state.webhooksOperations = cloneJson(state.webhooksHistory[state.webhooksHistoryIndex]);
  renderWebhooks(t('mapping.status.redoDone'));
}

function updateWebhookOperationSelection(checkbox) {
  const index = Number(checkbox.dataset.webhookOperationIndex);
  if (!Number.isInteger(index) || !state.webhooksOperations[index]) {
    return;
  }

  const operations = cloneJson(state.webhooksOperations);
  operations[index].selected = checkbox.checked;
  state.webhooksSelectedIndex = index;
  pushWebhooksHistory(operations, t('webhooks.statusSelectionChanged'));
}

function setWebhookOperationsSelection(selected) {
  if (state.webhooksOperations.length === 0) {
    return;
  }

  const operations = state.webhooksOperations.map(operation => ({
    ...operation,
    selected
  }));
  pushWebhooksHistory(operations, t('webhooks.statusSelectionChanged'));
}

function updateWebhooksHistoryControls() {
  const hasPlan = state.webhooksHistoryIndex >= 0;
  const selectedCount = selectedWebhookOperations().length;
  $('#webhooksUndo').disabled = !hasPlan || state.webhooksHistoryIndex <= 0;
  $('#webhooksRedo').disabled = !hasPlan || state.webhooksHistoryIndex >= state.webhooksHistory.length - 1;
  $('#webhooksSaveAs').disabled = !hasPlan;
  $('#webhooksApplyCmdb').disabled = selectedCount === 0;
  $('#webhooksSelectAll').disabled = state.webhooksOperations.length === 0;
  $('#webhooksClear').disabled = state.webhooksOperations.length === 0;
}

function selectedWebhookOperations() {
  return state.webhooksOperations.filter(operation => operation.selected !== false);
}

function renderWebhooks(message = '') {
  renderWebhooksSummary();
  renderWebhooksOperations();
  renderSelectedWebhookDetails();
  updateWebhooksHistoryControls();
  const status = $('#webhooksStatus');
  if (status && message) {
    status.textContent = message;
  }
}

function renderWebhooksSummary() {
  const container = $('#webhooksSummary');
  clear(container);
  const counts = webhookOperationCounts(state.webhooksOperations);
  const selectedCount = selectedWebhookOperations().length;
  const hasPlan = state.webhooksHistoryIndex >= 0;
  const summaryText = state.webhooksOperations.length > 0
    ? tf('webhooks.summary', {
      current: state.webhooksCurrent.length,
      create: counts.create,
      update: counts.update,
      delete: counts.delete,
      selected: selectedCount
    })
    : hasPlan
      ? tf('webhooks.summaryEmpty', { current: state.webhooksCurrent.length })
      : state.webhooksCurrent.length > 0
        ? tf('webhooks.summaryLoaded', { current: state.webhooksCurrent.length })
        : t('webhooks.noData');
  container.append(el('div', 'validation-summary-line', summaryText));
  container.append(el('div', 'validation-summary-detail', hasPlan
    ? t('webhooks.noOperations')
    : state.webhooksCurrent.length > 0
      ? t('webhooks.currentDetailsHint')
      : t('webhooks.noData')));
}

function webhookOperationCounts(operations) {
  return operations.reduce((counts, operation) => {
    counts[operation.action] = (counts[operation.action] ?? 0) + 1;
    return counts;
  }, { create: 0, update: 0, delete: 0 });
}

function renderWebhooksOperations() {
  const tbody = $('#webhooksOperationsTable');
  clear(tbody);

  if (state.webhooksOperations.length === 0) {
    if (state.webhooksCurrent.length > 0) {
      state.webhooksCurrent.forEach((hook, index) => {
        const row = document.createElement('tr');
        row.dataset.currentWebhookIndex = String(index);
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.disabled = true;
        const selectedCell = el('td', 'webhook-check-cell', '');
        selectedCell.append(checkbox);
        row.append(
          selectedCell,
          webhookActionTableCell('current', index, t('webhooks.actionCurrent'), 'webhook-action'),
          el('td', '', hook.code ?? ''),
          el('td', '', hook.target ?? ''),
          el('td', '', `${zabbixEventTypeFromCmdbEvent(hook.event) || ''} / ${hook.event ?? ''}`),
          el('td', '', t('webhooks.reasonCurrent')),
          webhookPayloadButtonCell('current', index),
          webhookEditButtonCell('current', index)
        );
        tbody.append(row);
        if (isWebhookDetailRow('current', index)) {
          tbody.append(webhookDetailsTableRow('current', hook));
        }
        if (isWebhookPayloadExpanded('current', index)) {
          tbody.append(webhookPayloadRow('current', hook));
        }
      });
      return;
    }

    const row = document.createElement('tr');
    const cell = el('td', '', state.webhooksHistoryIndex >= 0 ? t('webhooks.noOperations') : t('webhooks.noData'));
    cell.colSpan = 8;
    row.append(cell);
    tbody.append(row);
    return;
  }

  state.webhooksOperations.forEach((operation, index) => {
    const row = document.createElement('tr');
    row.dataset.webhookOperationIndex = String(index);
    row.classList.toggle('webhook-operation-selected', index === state.webhooksSelectedIndex);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'webhook-operation-checkbox';
    checkbox.checked = operation.selected !== false;
    checkbox.dataset.webhookOperationIndex = String(index);

    const selectedCell = el('td', 'webhook-check-cell', '');
    selectedCell.append(checkbox);
    row.append(
      selectedCell,
      webhookActionTableCell('operation', index, webhookActionLabel(operation.action), `webhook-action webhook-action-${operation.action}`),
      el('td', '', operation.code ?? ''),
      el('td', '', operation.target ?? ''),
      el('td', '', `${operation.eventType ?? ''} / ${operation.event ?? ''}`),
      el('td', '', webhookOperationReason(operation)),
      webhookPayloadButtonCell('operation', index),
      webhookEditButtonCell('operation', index)
    );
    tbody.append(row);
    if (isWebhookDetailRow('operation', index)) {
      tbody.append(webhookDetailsTableRow('operation', operation));
    }
    if (isWebhookPayloadExpanded('operation', index)) {
      tbody.append(webhookPayloadRow('operation', operation));
    }
  });
}

function renderWebhookOperationDetails(index) {
  const details = $('#webhooksDetails');
  if (!details) {
    return;
  }
  clear(details);

  if (!Number.isInteger(index) || !state.webhooksOperations[index]) {
    state.webhooksSelectedIndex = -1;
    if (state.webhooksCurrent.length > 0) {
      details.append(webhookDetailsNode('summary', {
        note: t('webhooks.currentDetailsHint'),
        currentWebhooks: state.webhooksCurrent
      }));
      return;
    }
    details.textContent = t('webhooks.detailsHint');
    return;
  }

  state.webhooksSelectedIndex = index;
  $$('#webhooksOperationsTable tr[data-webhook-operation-index]').forEach(row => {
    row.classList.toggle('webhook-operation-selected', Number(row.dataset.webhookOperationIndex) === index);
  });
  const operation = state.webhooksOperations[index];
  details.append(webhookDetailsNode('operation', operation));
}

function renderSelectedWebhookDetails() {
  if (state.webhooksDetailRow.kind === 'current') {
    renderCurrentWebhookDetails(state.webhooksDetailRow.index);
    return;
  }
  renderWebhookOperationDetails(
    state.webhooksDetailRow.kind === 'operation'
      ? state.webhooksDetailRow.index
      : state.webhooksSelectedIndex
  );
}

function webhookActionTableCell(kind, index, text, className) {
  const cell = el('td', className, text);
  cell.dataset.webhookDetailKind = kind;
  cell.dataset.webhookIndex = String(index);
  return cell;
}

function toggleWebhookDetails(kind, index) {
  const same = state.webhooksDetailRow.kind === kind && state.webhooksDetailRow.index === index;
  state.webhooksDetailRow = same ? { kind: '', index: -1 } : { kind, index };
  if (!same && kind === 'operation') {
    state.webhooksSelectedIndex = index;
  }
  renderWebhooks();
}

function isWebhookDetailRow(kind, index) {
  return state.webhooksDetailRow.kind === kind && state.webhooksDetailRow.index === index;
}

function webhookDetailsTableRow(kind, item) {
  const row = document.createElement('tr');
  row.className = 'webhook-details-row';
  const cell = el('td', '', '');
  cell.colSpan = 8;
  cell.append(webhookDetailsNode(kind, item));
  row.append(cell);
  return row;
}

function webhookDetailsNode(kind, item) {
  const wrapper = el('div', 'webhook-details-inline', '');
  if (kind === 'operation') {
    const operation = item ?? {};
    const nodes = [
      webhookDetailLine('current', `${webhookActionLabel(operation.action)} | ${operation.code ?? ''} | ${webhookOperationReason(operation)}`),
      webhookDetailLine('current', `diff: ${(operation.diff ?? []).join(', ') || '-'}`),
      webhookPayloadNode('operation', operation)
    ];
    if (operation.current) {
      nodes.push(webhookJsonSection(operation.action === 'delete' ? 'deleted' : 'current', 'current', operation.current));
    }
    if (operation.desired) {
      nodes.push(webhookJsonSection('added', 'desired', operation.desired));
    }
    wrapper.append(...nodes);
    return wrapper;
  }

  if (kind === 'current') {
    wrapper.append(
      webhookDetailLine('current', `${item?.code ?? ''} | ${item?.target ?? ''} | ${item?.event ?? ''}`),
      webhookPayloadNode('current', item),
      webhookJsonSection('current', 'current', item)
    );
    return wrapper;
  }

  wrapper.append(webhookJsonSection('current', 'details', item));
  return wrapper;
}

function webhookJsonSection(status, title, value) {
  const section = el('div', `webhook-details-json webhook-payload-${status}`, '');
  section.append(
    el('div', 'webhook-details-json-title', title),
    el('pre', '', JSON.stringify(value ?? null, null, 2))
  );
  return section;
}

function webhookDetailLine(status, text) {
  return el('div', `webhook-detail-line webhook-payload-${status}`, text);
}

function webhookPayloadButtonCell(kind, index) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary webhook-row-button';
  button.dataset.webhookExpandKind = kind;
  button.dataset.webhookIndex = String(index);
  button.textContent = isWebhookPayloadExpanded(kind, index)
    ? t('webhooks.collapsePayload')
    : t('webhooks.expandPayload');
  const cell = el('td', '', '');
  cell.append(button);
  return cell;
}

function webhookEditButtonCell(kind, index) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary webhook-row-button';
  button.dataset.webhookEditKind = kind;
  button.dataset.webhookIndex = String(index);
  button.textContent = t('webhooks.edit');
  const cell = el('td', '', '');
  cell.append(button);
  return cell;
}

function isWebhookPayloadExpanded(kind, index) {
  return Boolean(state.webhooksExpandedRows?.[webhookExpandedBucket(kind)]?.[String(index)]);
}

function toggleWebhookPayload(kind, index) {
  const bucket = webhookExpandedBucket(kind);
  state.webhooksExpandedRows[bucket] = {
    ...(state.webhooksExpandedRows[bucket] ?? {}),
    [String(index)]: !isWebhookPayloadExpanded(kind, index)
  };
  renderWebhooks();
}

function webhookExpandedBucket(kind) {
  return kind === 'current' ? 'current' : 'operations';
}

function webhookPayloadRow(kind, item) {
  const row = document.createElement('tr');
  row.className = 'webhook-payload-row';
  const cell = el('td', '', '');
  cell.colSpan = 8;
  cell.append(webhookPayloadNode(kind, item));
  row.append(cell);
  return row;
}

function webhookPayloadNode(kind, item) {
  const wrapper = el('div', 'webhook-payload-box', '');
  const title = el('div', 'webhook-payload-title', t('webhooks.payload'));
  const lines = el('div', 'webhook-payload-lines', '');
  const payloadLines = kind === 'current'
    ? currentWebhookPayloadLines(item)
    : operationWebhookPayloadLines(item);
  if (payloadLines.length === 0) {
    lines.append(el('div', 'webhook-payload-line webhook-payload-current', t('webhooks.payloadEmpty')));
  } else {
    for (const line of payloadLines) {
      lines.append(webhookPayloadLineNode(line));
    }
  }
  wrapper.append(title, lines);
  return wrapper;
}

function currentWebhookPayloadLines(hook) {
  const body = plainObjectOrEmpty(hook?.body);
  return Object.keys(body)
    .sort(compareText)
    .map(key => ({ status: 'current', key, value: body[key] }));
}

function operationWebhookPayloadLines(operation) {
  if (operation.action === 'create') {
    return Object.keys(plainObjectOrEmpty(operation.desired?.body))
      .sort(compareText)
      .map(key => ({ status: 'added', key, value: operation.desired.body[key] }));
  }
  if (operation.action === 'delete') {
    return Object.keys(plainObjectOrEmpty(operation.current?.body))
      .sort(compareText)
      .map(key => ({ status: 'deleted', key, value: operation.current.body[key] }));
  }

  const currentBody = plainObjectOrEmpty(operation.current?.body);
  const desiredBody = plainObjectOrEmpty(operation.desired?.body);
  const lines = [];
  for (const key of uniqueTokens([...Object.keys(currentBody), ...Object.keys(desiredBody)]).sort(compareText)) {
    const hasCurrent = Object.prototype.hasOwnProperty.call(currentBody, key);
    const hasDesired = Object.prototype.hasOwnProperty.call(desiredBody, key);
    if (hasCurrent && !hasDesired) {
      lines.push({ status: 'deleted', key, value: currentBody[key] });
    } else if (!hasCurrent && hasDesired) {
      lines.push({ status: 'added', key, value: desiredBody[key] });
    } else if (stableJson(currentBody[key]) !== stableJson(desiredBody[key])) {
      lines.push({ status: 'deleted', key, value: currentBody[key] });
      lines.push({ status: 'added', key, value: desiredBody[key] });
    } else {
      lines.push({ status: 'current', key, value: currentBody[key] });
    }
  }
  return lines;
}

function webhookPayloadLineNode(line) {
  const node = el('div', `webhook-payload-line webhook-payload-${line.status}`, '');
  const marker = {
    added: '+',
    deleted: '-',
    current: ' '
  }[line.status] ?? ' ';
  const label = {
    added: t('webhooks.payloadAdded'),
    deleted: t('webhooks.payloadDeleted'),
    current: t('webhooks.payloadCurrent')
  }[line.status] ?? '';
  node.textContent = `${marker} ${line.key}: ${formatWebhookPayloadValue(line.value)}  ${label}`;
  return node;
}

function formatWebhookPayloadValue(value) {
  return value && typeof value === 'object'
    ? stableJson(value)
    : JSON.stringify(value);
}

function renderCurrentWebhookDetails(index) {
  const details = $('#webhooksDetails');
  if (!details) {
    return;
  }
  clear(details);

  $$('#webhooksOperationsTable tr[data-current-webhook-index]').forEach(row => {
    row.classList.toggle('webhook-operation-selected', Number(row.dataset.currentWebhookIndex) === index);
  });

  const hook = state.webhooksCurrent[index];
  details.append(hook
    ? webhookDetailsNode('current', hook)
    : webhookDetailsNode('summary', {
      note: t('webhooks.currentDetailsHint'),
      currentWebhooks: state.webhooksCurrent
    }));
}

function openWebhookEditDialog(kind, index) {
  const item = webhookEditableItem(kind, index);
  if (!item) {
    return;
  }

  state.webhookEditDialog = { kind, index };
  $('#webhookEditJson').value = JSON.stringify(item, null, 2);
  $('#webhookEditError').textContent = '';
  $('#webhookEditDialog').classList.remove('hidden');
}

function webhookEditableItem(kind, index) {
  if (kind === 'current') {
    return cloneJson(state.webhooksCurrent[index]);
  }

  const operation = state.webhooksOperations[index];
  if (!operation) {
    return null;
  }

  return cloneJson(operation.desired ?? operation.current ?? {});
}

function closeWebhookEditDialog() {
  state.webhookEditDialog = null;
  $('#webhookEditDialog')?.classList.add('hidden');
  $('#webhookEditError').textContent = '';
}

function applyWebhookEditDialog() {
  const dialog = state.webhookEditDialog;
  if (!dialog) {
    return;
  }

  let edited;
  try {
    edited = normalizeWebhookItem(JSON.parse($('#webhookEditJson').value));
  } catch (error) {
    $('#webhookEditError').textContent = tf('webhooks.invalidJson', {
      message: error instanceof Error ? error.message : 'invalid JSON'
    });
    return;
  }

  if (!edited.code) {
    $('#webhookEditError').textContent = tf('webhooks.invalidJson', {
      message: 'code is required'
    });
    return;
  }

  const operations = cloneJson(state.webhooksOperations);
  if (dialog.kind === 'current') {
    const current = normalizeWebhookItem(state.webhooksCurrent[dialog.index] ?? {});
    upsertWebhookEditOperation(operations, current, edited);
  } else {
    const operation = operations[dialog.index];
    if (!operation) {
      closeWebhookEditDialog();
      return;
    }

    operations[dialog.index] = editedWebhookOperation(operation, edited);
    state.webhooksSelectedIndex = dialog.index;
  }

  closeWebhookEditDialog();
  pushWebhooksHistory(operations, t('webhooks.statusEdited'));
}

function upsertWebhookEditOperation(operations, current, desired) {
  const operation = editedWebhookOperation({
    action: 'update',
    selected: true,
    current,
    desired
  }, desired);
  const existingIndex = operations.findIndex(item => normalizeWebhookCode(item.code) === normalizeWebhookCode(operation.code));
  if (existingIndex >= 0) {
    operations[existingIndex] = operation;
    state.webhooksSelectedIndex = existingIndex;
  } else {
    operations.push(operation);
    state.webhooksSelectedIndex = operations.length - 1;
  }
}

function editedWebhookOperation(operation, desired) {
  const current = normalizeWebhookItem(operation.current ?? desired);
  const action = operation.action === 'create' ? 'create' : 'update';
  return {
    ...operation,
    action,
    selected: true,
    code: desired.code,
    target: desired.target,
    event: desired.event,
    eventType: desired.eventType ?? zabbixEventTypeFromCmdbEvent(desired.event),
    reasonKey: action === 'create' ? 'webhooks.reasonMissing' : 'webhooks.reasonChanged',
    diff: action === 'create' ? [] : webhookDiffFields(current, desired),
    current: action === 'create' ? null : current,
    desired
  };
}

function webhookActionLabel(action) {
  return {
    create: t('webhooks.actionCreate'),
    update: t('webhooks.actionUpdate'),
    delete: t('webhooks.actionDelete')
  }[action] ?? action;
}

function webhookOperationReason(operation) {
  if (operation.reasonKey === 'webhooks.reasonChanged') {
    return tf(operation.reasonKey, { fields: (operation.diff ?? []).join(', ') });
  }
  return t(operation.reasonKey ?? 'webhooks.reasonChanged');
}

async function saveWebhooksAsFile() {
  const plan = {
    generatedAt: new Date().toISOString(),
    rules: {
      name: state.currentRules?.name ?? state.currentRules?.content?.name ?? '',
      schemaVersion: state.currentRules?.schemaVersion ?? state.currentRules?.content?.schemaVersion ?? '',
      rulesVersion: state.currentRules?.rulesVersion ?? state.currentRules?.content?.rulesVersion ?? ''
    },
    managedPrefix: managedWebhookPrefix,
    note: 'This file is exported by the browser only. Apply to CMDBuild from the UI or review and apply manually.',
    operations: state.webhooksOperations
  };
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  const result = await saveTextAsFile(content, 'cmdbuild-webhooks-plan.json', 'CMDBuild webhooks plan', {
    'application/json': ['.json']
  });
  if (!result.cancelled) {
    toast(tf('toast.rulesFileSaved', { name: result.name }));
  }
}

async function applyCmdbuildWebhooks() {
  const operations = selectedWebhookOperations();
  if (operations.length === 0) {
    toast(t('webhooks.confirmNoSelection'));
    return;
  }

  if (!window.confirm(tf('webhooks.confirmApply', { count: operations.length }))) {
    return;
  }

  const result = await api('/api/cmdbuild/webhooks/apply', {
    method: 'POST',
    body: { operations }
  });
  toast(tf('webhooks.statusApplied', { count: result.count ?? operations.length }));
  await loadCmdbuildWebhooks();
  await analyzeCmdbuildWebhooks();
}

function buildCmdbuildWebhookOperations(rules, cmdbuildCatalog, currentHooks) {
  const desired = buildDesiredCmdbuildWebhooks(rules, cmdbuildCatalog, currentHooks);
  const currentByCode = new Map(currentHooks.map(hook => [normalizeWebhookCode(hook.code), normalizeWebhookItem(hook)]));
  const desiredByCode = new Map(desired.map(hook => [normalizeWebhookCode(hook.code), normalizeWebhookItem(hook)]));
  const operations = [];

  for (const desiredHook of desired) {
    const currentHook = currentByCode.get(normalizeWebhookCode(desiredHook.code));
    if (!currentHook) {
      operations.push({
        action: 'create',
        selected: true,
        code: desiredHook.code,
        target: desiredHook.target,
        event: desiredHook.event,
        eventType: desiredHook.eventType,
        reasonKey: 'webhooks.reasonMissing',
        current: null,
        desired: desiredHook
      });
      continue;
    }

    const diff = webhookDiffFields(currentHook, desiredHook);
    if (diff.length > 0) {
      operations.push({
        action: 'update',
        selected: true,
        code: desiredHook.code,
        target: desiredHook.target,
        event: desiredHook.event,
        eventType: desiredHook.eventType,
        reasonKey: 'webhooks.reasonChanged',
        diff,
        current: currentHook,
        desired: desiredHook
      });
    }
  }

  for (const currentHook of currentHooks.map(normalizeWebhookItem)) {
    if (!isManagedWebhook(currentHook) || desiredByCode.has(normalizeWebhookCode(currentHook.code))) {
      continue;
    }

    operations.push({
      action: 'delete',
      selected: false,
      code: currentHook.code,
      target: currentHook.target,
      event: currentHook.event,
      eventType: zabbixEventTypeFromCmdbEvent(currentHook.event),
      reasonKey: 'webhooks.reasonObsolete',
      current: currentHook,
      desired: null
    });
  }

  return operations.sort((left, right) =>
    compareText(left.target, right.target)
    || compareText(left.eventType, right.eventType)
    || compareText(left.action, right.action)
    || compareText(left.code, right.code));
}

function buildDesiredCmdbuildWebhooks(rules, cmdbuildCatalog, currentHooks) {
  const classes = allWebhookClasses(rules, cmdbuildCatalog);
  const events = webhookEventsForRules(rules);
  const defaults = currentWebhookDefaults(currentHooks);
  const currentByCode = new Map(currentHooks.map(hook => [normalizeWebhookCode(hook.code), normalizeWebhookItem(hook)]));
  const desired = [];

  for (const className of classes) {
    for (const event of events) {
      const code = cmdbuildWebhookCode(className, event.eventType);
      const current = currentByCode.get(normalizeWebhookCode(code));
      const prefix = currentWebhookPlaceholderPrefix(current) || defaults.placeholderPrefix;
      desired.push(normalizeWebhookItem({
        code,
        description: current?.description || `cmdb2monitoring ${className} ${event.eventType}`,
        event: event.cmdbuildEvent,
        eventType: event.eventType,
        target: className,
        method: current?.method || defaults.method,
        url: current?.url || defaults.url,
        headers: current?.headers ?? defaults.headers,
        body: webhookBodyForClassEventCmdb(rules, cmdbuildCatalog, className, event, prefix, current?.body),
        language: current?.language ?? defaults.language,
        active: current?.active ?? true
      }));
    }
  }

  return desired;
}

function currentWebhookDefaults(currentHooks) {
  const managed = currentHooks.map(normalizeWebhookItem).filter(isManagedWebhook);
  const sample = managed.find(hook => hook.url) ?? managed[0] ?? {};
  return {
    method: sample.method || 'post',
    url: sample.url || defaultCmdbuildWebhookUrl,
    headers: sample.headers ?? {},
    language: sample.language ?? '',
    placeholderPrefix: currentWebhookPlaceholderPrefix(sample) || 'server'
  };
}

function webhookBodyForClassEventCmdb(rules, cmdbuildCatalog, className, event, prefix, baseBody = {}) {
  const catalogClass = findCatalogClass(cmdbuildCatalog ?? {}, className);
  const attributes = catalogAttributesForClass(cmdbuildCatalog ?? {}, catalogClass ?? className);
  const usedFields = webhookSourceFieldsForClass(rules, className);
  const body = {
    ...plainObjectOrEmpty(baseBody),
    source: 'cmdbuild',
    eventType: event.eventType,
    cmdbuildEvent: event.cmdbuildEvent,
    className
  };

  for (const [fieldKey, field] of Object.entries(rules.source?.fields ?? {})) {
    const bodyKey = webhookBodyKeyForField(fieldKey, field);
    if (!bodyKey || webhookBodyHasField(body, fieldKey, field)) {
      continue;
    }
    if (!webhookSourceFieldIsUsed(usedFields, fieldKey) && !field.required) {
      continue;
    }
    if (field.cmdbPath && !cmdbPathRootAppliesToClass(field.cmdbPath, className, cmdbuildCatalog, rules)) {
      continue;
    }

    const value = webhookBodyValueForFieldCmdb(className, event, attributes, fieldKey, field, prefix);
    if (value !== undefined) {
      body[bodyKey] = value;
    }
  }

  return body;
}

function webhookSourceFieldsForClass(rules, className) {
  const fields = new Set(['entityId', 'code', 'className', 'eventType'].map(normalizeToken));
  for (const [fieldKey, field] of Object.entries(rules.source?.fields ?? {})) {
    if (field.required) {
      fields.add(normalizeToken(fieldKey));
      fields.add(normalizeToken(canonicalSourceField(fieldKey)));
    }
  }

  addWebhookSourceFields(fields, sourceFieldsFromSerializedValue(rules.t4Templates ?? {}));
  addWebhookSourceFields(fields, sourceFieldsFromSerializedValue(rules.normalization ?? {}));
  for (const collection of mappingRuleCollections()) {
    for (const rule of asArray(rules[collection.key])) {
      addWebhookSourceFields(fields, sourceFieldsForClassScopedRule(rule, className));
    }
  }

  return fields;
}

function addWebhookSourceFields(target, fields) {
  for (const field of fields) {
    target.add(normalizeToken(field));
    target.add(normalizeToken(canonicalSourceField(field)));
  }
}

function webhookSourceFieldIsUsed(fields, fieldKey) {
  return fields.has(normalizeToken(fieldKey)) || fields.has(normalizeToken(canonicalSourceField(fieldKey)));
}

function webhookBodyHasField(body, fieldKey, field) {
  const candidates = uniqueTokens([
    webhookBodyKeyForField(fieldKey, field),
    fieldKey,
    canonicalSourceField(fieldKey),
    ...sourceFieldSources(field),
    ...sourceFieldCatalogSources(field)
  ].filter(Boolean));
  const existingKeys = Object.keys(plainObjectOrEmpty(body));
  return candidates.some(candidate => existingKeys.some(key =>
    equalsIgnoreCase(key, candidate) || normalizeToken(key) === normalizeToken(candidate)));
}

function webhookRuleAppliesToClass(rule, className) {
  const matchers = {
    all: asArray(rule?.when?.allRegex).filter(matcher => canonicalSourceField(matcher.field) === 'className'),
    any: asArray(rule?.when?.anyRegex).filter(matcher => canonicalSourceField(matcher.field) === 'className'),
    anyOther: asArray(rule?.when?.anyRegex).filter(matcher => canonicalSourceField(matcher.field) !== 'className')
  };
  if (matchers.all.length === 0 && matchers.any.length === 0) {
    return true;
  }

  const matchesClass = matcher => {
    try {
      return compileRuleRegex(matcher.pattern).test(className);
    } catch {
      return false;
    }
  };

  if (matchers.all.length > 0 && !matchers.all.every(matchesClass)) {
    return false;
  }

  return matchers.any.length === 0
    || matchers.anyOther.length > 0
    || matchers.any.some(matchesClass);
}

function cmdbPathRootAppliesToClass(cmdbPath, className, cmdbuildCatalog, rules) {
  const segments = String(cmdbPath ?? '').split('.').map(segment => segment.trim()).filter(Boolean);
  if (segments.length < 2) {
    return true;
  }

  const root = segments[0];
  if (!root || root.toLowerCase().startsWith('{domain:')) {
    return true;
  }

  const knownClass = findCatalogClass(cmdbuildCatalog ?? {}, root)
    || asArray(rules.source?.entityClasses).some(item => normalizeClassName(item) === normalizeClassName(root));
  return !knownClass || normalizeClassName(root) === normalizeClassName(className);
}

function sourceFieldsFromSerializedValue(value) {
  return sourceFieldsForRule({ serializedValue: value });
}

function sourceFieldsForClassScopedRule(value, className) {
  const result = [];
  collectSourceFieldsForClassScopedNode(value, className, true, result);
  return uniqueTokens(result.map(canonicalSourceField));
}

function collectSourceFieldsForClassScopedNode(value, className, parentApplies, result) {
  if (Array.isArray(value)) {
    value.forEach(item => collectSourceFieldsForClassScopedNode(item, className, parentApplies, result));
    return result;
  }
  if (typeof value === 'string') {
    result.push(...sourceFieldsFromTemplateText(value));
    return result;
  }
  if (!value || typeof value !== 'object') {
    return result;
  }

  const applies = parentApplies && webhookRuleAppliesToClass(value, className);
  if (!applies) {
    return result;
  }

  result.push(...sourceFieldsForRuleOwnScope(value));
  for (const [key, item] of Object.entries(value)) {
    if (key === 'when') {
      continue;
    }
    collectSourceFieldsForClassScopedNode(item, className, applies, result);
  }
  return result;
}

function sourceFieldsForRuleOwnScope(rule = {}) {
  const when = rule.when ?? {};
  const fields = [
    ...(when.anyRegex ?? []).map(matcher => matcher.field),
    ...(when.allRegex ?? []).map(matcher => matcher.field),
    when.fieldExists,
    ...(Array.isArray(when.fieldsExist) ? when.fieldsExist : []),
    rule.field,
    rule.valueField,
    rule.sourceField,
    rule.fieldName
  ].filter(Boolean);

  for (const [key, value] of Object.entries(rule)) {
    if (key === 'when') {
      continue;
    }
    if (typeof value === 'string') {
      fields.push(...sourceFieldsFromTemplateText(value));
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          fields.push(...sourceFieldsFromTemplateText(item));
        }
      }
    }
  }

  return uniqueTokens(fields.map(canonicalSourceField));
}

function sourceFieldsFromTemplateText(text) {
  const fields = [];
  const serialized = String(text ?? '');
  for (const match of serialized.matchAll(/Model\.Source\(["']([^"']+)["']\)/g)) {
    fields.push(match[1]);
  }
  for (const match of serialized.matchAll(/Model\.Field\(["']([^"']+)["']\)/g)) {
    fields.push(match[1]);
  }
  for (const match of serialized.matchAll(/Model\.([A-Za-z0-9_]+)/g)) {
    if (!['Source', 'Field'].includes(match[1])) {
      fields.push(match[1]);
    }
  }
  return uniqueTokens(fields);
}

function sourceFieldNamesFromObject(value, result = []) {
  if (Array.isArray(value)) {
    value.forEach(item => sourceFieldNamesFromObject(item, result));
    return result;
  }
  if (!value || typeof value !== 'object') {
    return result;
  }

  for (const [key, item] of Object.entries(value)) {
    if (['field', 'valueField', 'sourceField', 'fieldName'].includes(key) && typeof item === 'string') {
      result.push(item);
    } else {
      sourceFieldNamesFromObject(item, result);
    }
  }
  return uniqueTokens(result);
}

function webhookBodyValueForFieldCmdb(className, event, attributes, fieldKey, field, prefix) {
  const canonical = canonicalSourceField(fieldKey);
  if (canonical === 'eventType') {
    return event.eventType;
  }
  if (canonical === 'className') {
    return className;
  }
  if (field.cmdbPath) {
    return webhookBodyValueForCmdbPath(className, attributes, field.cmdbPath, prefix);
  }

  const attribute = findCatalogAttributeForField(attributes, field, fieldKey);
  if (attribute) {
    return cmdbuildPlaceholder(prefix, attribute.name);
  }
  if (canonical === 'entityId') {
    return cmdbuildPlaceholder(prefix, 'Id');
  }
  if (canonical === 'code') {
    return cmdbuildPlaceholder(prefix, 'Code');
  }

  return undefined;
}

function webhookBodyValueForCmdbPath(className, attributes, cmdbPath, prefix) {
  const segments = String(cmdbPath ?? '').split('.').map(segment => segment.trim()).filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }

  let currentSegments = segments;
  if (normalizeClassName(currentSegments[0]) === normalizeClassName(className)) {
    currentSegments = currentSegments.slice(1);
  }

  const firstSegment = currentSegments[0] ?? '';
  if (!firstSegment || firstSegment.toLowerCase().startsWith('{domain:')) {
    return cmdbuildPlaceholder(prefix, 'Id');
  }

  const attribute = findCatalogAttribute(attributes, firstSegment, firstSegment);
  return cmdbuildPlaceholder(prefix, attribute?.name ?? firstSegment);
}

function cmdbuildPlaceholder(prefix, attributeName) {
  return `{${prefix}:${attributeName}}`;
}

function cmdbuildWebhookCode(className, eventType) {
  return `${managedWebhookPrefix}${normalizeRuleName(className)}-${normalizeRuleName(eventType)}`;
}

function normalizeWebhookItem(item = {}) {
  return {
    _id: item._id ?? item.id ?? item.code ?? '',
    id: item.id ?? item._id ?? item.code ?? '',
    code: item.code ?? item._id ?? item.id ?? '',
    description: item.description ?? '',
    event: item.event ?? '',
    eventType: item.eventType ?? zabbixEventTypeFromCmdbEvent(item.event),
    target: item.target ?? '',
    method: String(item.method ?? 'post').toLowerCase(),
    url: item.url ?? '',
    headers: plainObjectOrEmpty(item.headers),
    body: plainObjectOrEmpty(item.body),
    language: item.language ?? '',
    active: item.active !== false,
    raw: item.raw ?? undefined
  };
}

function plainObjectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeWebhookCode(code) {
  return normalizeRuleName(code);
}

function isManagedWebhook(hook) {
  return String(hook?.code ?? '').startsWith(managedWebhookPrefix);
}

function webhookDiffFields(current, desired) {
  const currentComparable = webhookComparable(current);
  const desiredComparable = webhookComparable(desired);
  return Object.keys(desiredComparable).filter(key => stableJson(currentComparable[key]) !== stableJson(desiredComparable[key]));
}

function webhookComparable(hook) {
  const normalized = normalizeWebhookItem(hook);
  return {
    description: normalized.description,
    event: normalized.event,
    target: normalized.target,
    method: normalized.method,
    url: normalized.url,
    headers: normalized.headers,
    body: normalized.body,
    language: normalized.language,
    active: normalized.active
  };
}

function currentWebhookPlaceholderPrefix(hook) {
  const values = [];
  collectWebhookBodyValues(hook?.body, values);
  for (const value of values) {
    const match = String(value).match(/^\{([^}:]+):[^}]+\}$/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return '';
}

function collectWebhookBodyValues(value, result) {
  if (Array.isArray(value)) {
    value.forEach(item => collectWebhookBodyValues(item, result));
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(item => collectWebhookBodyValues(item, result));
    return;
  }
  result.push(value);
}

function zabbixEventTypeFromCmdbEvent(eventName) {
  const text = String(eventName ?? '').toLowerCase();
  if (text.includes('create')) {
    return 'create';
  }
  if (text.includes('update')) {
    return 'update';
  }
  if (text.includes('delete')) {
    return 'delete';
  }
  return text.replace(/^card_/, '').replace(/_after$/, '') || '';
}

function updateMappingEditorControls() {
  const hasDraft = Boolean(state.mappingDraftRules);
  const editMode = state.mappingMode === 'edit';
  const action = $('#mappingEditAction')?.value ?? state.mappingEditAction ?? 'add';
  state.mappingEditAction = action;
  $('#mappingUndo').disabled = !hasDraft || state.mappingHistoryIndex <= 0;
  $('#mappingRedo').disabled = !hasDraft || state.mappingHistoryIndex >= state.mappingHistory.length - 1;
  $('#mappingSaveAs').disabled = !hasDraft;
  updateMappingClearSelectionButton();
  $('#mapping')?.classList.toggle('mapping-edit-mode', editMode);
  $('#mappingEditor')?.classList.toggle('hidden', !editMode);
  $('#mappingAddPanel')?.classList.toggle('hidden', !editMode || !['add', 'modify'].includes(action));
  $('#mappingModifyRuleField')?.classList.toggle('hidden', !editMode || action !== 'modify');
  $('#mappingDeletePanel')?.classList.toggle('hidden', !editMode || action !== 'delete');
  $('#mappingResetForm')?.classList.toggle('hidden', !editMode || !['add', 'modify'].includes(action));
  if ($('#mappingAddRule')) {
    $('#mappingAddRule').textContent = action === 'modify'
      ? t('mapping.saveRuleChanges')
      : t('mapping.addRule');
  }
  if ($('#mappingDeleteView') && $('#mappingDeleteView').value !== state.mappingDeleteView) {
    $('#mappingDeleteView').value = state.mappingDeleteView;
  }
  updateMappingDeleteControls();
  updateMappingEditorFormState();
}

function updateMappingEditor(message = '') {
  updateMappingEditorControls();
  if (state.mappingMode !== 'edit') {
    return;
  }

  populateMappingEditorClasses();
  populateMappingEditorStructures();
  if (state.mappingEditAction === 'modify') {
    populateMappingModifyRules();
    if ($('#mappingModifyRule').value) {
      loadSelectedMappingRuleIntoEditor({ silent: true });
      populateMappingEditorStructures({
        selectedValue: $('#mappingEditTargetType').value,
        fieldValue: state.mappingModifyFieldValue || $('#mappingEditField').value
      });
    } else {
      clearMappingEditorRuleForm();
      populateMappingModifyFilterControls({ autoSelect: false });
      renderMappingDeleteRules();
      updateMappingEditorSuggestedName();
      setMappingEditorStatusForDraft(message || t('mapping.status.modifyStart'));
      updateMappingEditorFormState();
      return;
    }
  }
  populateMappingEditorFields();
  populateMappingEditorTargets();
  renderMappingDeleteRules();
  updateMappingEditorSuggestedName();
  setMappingEditorStatusForDraft(message || t('mapping.status.beforeSave'));
  updateMappingEditorFormState();
}

function refreshMappingEditorLocalizedControls() {
  const selectedRule = $('#mappingModifyRule')?.value ?? '';
  const selectedField = $('#mappingEditField')?.value ?? '';
  const selectedType = $('#mappingEditTargetType')?.value ?? '';
  const selectedTarget = $('#mappingEditZabbixObject')?.value ?? '';

  if (state.mappingEditAction === 'delete') {
    renderMappingDeleteRules();
    return;
  }

  if (state.mappingEditAction === 'modify' && !selectedRule) {
    populateMappingModifyFilterControls({ autoSelect: false });
    return;
  }

  if (state.mappingEditAction === 'modify') {
    populateMappingModifyRules({ selectedValue: selectedRule });
  }

  populateMappingEditorClasses();
  populateMappingEditorStructures({ selectedValue: selectedType, fieldValue: selectedField });
  populateMappingEditorFields({ selectedValue: selectedField });
  populateMappingEditorTargets({ selectedValue: selectedTarget });
  updateMappingEditorSuggestedName();
  updateMappingEditorFormState();
}

function mappingEditorActionStatus() {
  return {
    delete: t('mapping.status.actionDelete'),
    modify: t('mapping.status.actionModify'),
    add: t('mapping.status.actionAdd')
  }[state.mappingEditAction] ?? t('mapping.status.defaultAction');
}

function updateMappingEditorAction() {
  state.mappingEditAction = $('#mappingEditAction')?.value ?? 'add';
  updateMappingEditorControls();
  if (state.mappingEditAction === 'delete') {
    renderMappingDeleteRules();
  } else if (state.mappingEditAction === 'modify') {
    clearMappingEditorRuleForm();
    populateMappingModifyFilterControls({ autoSelect: false });
  } else {
    updateMappingEditorSuggestedName();
  }
  setMappingEditorStatusForDraft(mappingEditorActionStatus());
  updateMappingEditorFormState();
}

function handleMappingEditorClassChange() {
  if (isMappingModifyFilterMode()) {
    populateMappingModifyFilterControls({ autoSelect: true, changed: 'className' });
    return;
  }

  $('#mappingEditField').value = '';
  $('#mappingEditZabbixObject').value = '';
  state.mappingModifyFieldValue = '';
  state.mappingModifyTargetValue = '';
  refreshMappingEditorDependentControls({ selectedField: '', selectedTarget: '' });
}

function handleMappingEditorFieldChange() {
  if (isMappingModifyFilterMode()) {
    populateMappingModifyFilterControls({ autoSelect: true, changed: 'field' });
    return;
  }

  const previousType = $('#mappingEditTargetType').value;
  populateMappingEditorStructures({ selectedValue: previousType });
  const targetValue = $('#mappingEditTargetType').value === previousType
    ? $('#mappingEditZabbixObject').value
    : '';
  populateMappingEditorTargets({ selectedValue: targetValue });
  updateMappingEditorSuggestedName();
  updateMappingEditorFormState();
}

function handleMappingEditorStructureChange() {
  if (isMappingModifyFilterMode()) {
    populateMappingModifyFilterControls({ autoSelect: true, changed: 'type' });
    return;
  }

  $('#mappingEditZabbixObject').value = '';
  state.mappingModifyTargetValue = '';
  populateMappingEditorFields({ selectedValue: $('#mappingEditField').value });
  populateMappingEditorTargets({ selectedValue: '' });
  updateMappingEditorSuggestedName();
  updateMappingEditorFormState();
}

function handleMappingEditorTargetChange() {
  if (isMappingModifyFilterMode()) {
    populateMappingModifyFilterControls({ autoSelect: true, changed: 'target' });
    return;
  }

  updateMappingEditorSuggestedName();
  updateMappingEditorFormState();
}

function handleMappingEditorLeafChange() {
  updateMappingEditorSuggestedName();
  updateMappingEditorFormState();
}

function isMappingModifyFilterMode() {
  return state.mappingEditAction === 'modify' && !($('#mappingModifyRule')?.value);
}

function refreshMappingEditorDependentControls(options = {}) {
  const selectedField = options.selectedField ?? state.mappingModifyFieldValue ?? $('#mappingEditField').value;
  populateMappingEditorStructures({
    selectedValue: options.selectedType ?? $('#mappingEditTargetType').value,
    fieldValue: selectedField
  });
  populateMappingEditorFields({ selectedValue: selectedField });
  populateMappingEditorTargets({ selectedValue: options.selectedTarget ?? $('#mappingEditZabbixObject').value });
  updateMappingEditorSuggestedName();
  updateMappingEditorFormState();
}

function clearMappingEditorRuleForm() {
  $('#mappingEditClass').value = '';
  $('#mappingEditField').value = '';
  $('#mappingEditTargetType').value = '';
  $('#mappingEditZabbixObject').value = '';
  $('#mappingEditPriority').value = '100';
  $('#mappingEditRegex').value = '(?i).*';
  $('#mappingEditRuleName').value = '';
  state.mappingModifyFieldValue = '';
  state.mappingModifyTargetValue = '';
}

function resetMappingEditorForm() {
  if (state.mappingEditAction === 'modify') {
    if ($('#mappingModifyRule')) {
      $('#mappingModifyRule').value = '';
    }
    clearMappingEditorRuleForm();
    populateMappingModifyFilterControls({ autoSelect: false });
    setMappingEditorStatus(t('mapping.status.resetModify'));
    return;
  }

  $('#mappingEditField').value = '';
  $('#mappingEditZabbixObject').value = '';
  $('#mappingEditPriority').value = '100';
  $('#mappingEditRegex').value = '(?i).*';
  $('#mappingEditRuleName').value = '';
  state.mappingModifyFieldValue = '';
  state.mappingModifyTargetValue = '';
  refreshMappingEditorDependentControls({ selectedField: '', selectedTarget: '' });
  setMappingEditorStatus(t('mapping.status.resetAdd'));
}

function renderMappingDeleteRules() {
  const container = $('#mappingDeleteRules');
  if (!container) {
    return;
  }

  clear(container);
  const rules = currentMappingRules();
  const items = mappingDeleteRuleItems(rules);
  const view = $('#mappingDeleteView')?.value || state.mappingDeleteView || 'cmdbuild';
  state.mappingDeleteView = view;
  if (!state.mappingDraftRules) {
    container.append(mappingDeleteEmptyNode(t('mapping.status.loadMappingFirst')));
    updateMappingDeleteControls();
    return;
  }
  if (items.length === 0) {
    container.append(mappingDeleteEmptyNode(t('mapping.delete.noRulesInDraft')));
    updateMappingDeleteControls();
    return;
  }

  const groups = mappingDeleteTreeGroups(items, rules, view);
  for (const group of groups) {
    container.append(mappingDeleteGroupNode(group, rules));
  }
  updateMappingDeleteControls();
}

function mappingDeleteTreeGroups(items, rules, view) {
  if (view === 'zabbix') {
    return mappingDeleteZabbixGroups(items, rules);
  }
  if (view === 'rules') {
    return mappingDeleteRulesGroups(items);
  }
  return mappingDeleteCmdbuildGroups(items, rules);
}

function mappingDeleteRulesGroups(items) {
  return mappingDeleteFlatGroups(items, item => ({
    key: item.collection.key,
    label: item.collection.label,
    meta: 'rules collection'
  }));
}

function mappingDeleteFlatGroups(items, selector) {
  const groups = new Map();
  for (const item of items) {
    const selected = selector(item);
    const group = ensureMappingDeleteGroup(groups, selected.key, selected.label, selected.meta);
    group.items.push(item);
  }
  return [...groups.values()];
}

function mappingDeleteCmdbuildGroups(items, rules) {
  const groups = new Map();
  for (const item of items) {
    const classes = mappingDeleteClassesForItem(item, rules);
    const fields = mappingDeleteSourceFieldsForItem(item.rule)
      .filter(field => !['eventType', 'zabbixHostId'].includes(canonicalSourceField(field)));
    const fieldKeys = fields.length > 0 ? fields : ['__no_cmdb_field'];

    for (const className of classes) {
      const classKey = normalizeToken(className);
      const classGroup = ensureMappingDeleteGroup(
        groups,
        `cmdb-class:${classKey}`,
        className === '__any_class' ? 'Любой класс / без условия className' : catalogClassDisplayName(state.mappingCmdbuildCatalog ?? {}, className),
        className === '__any_class' ? 'rules без явного ограничения по CMDBuild class' : 'CMDBuild class'
      );

      for (const field of fieldKeys) {
        const fieldGroup = ensureMappingDeleteChildGroup(
          classGroup,
          `cmdb-field:${classKey}:${canonicalSourceField(field)}`,
          field === '__no_cmdb_field' ? 'Без CMDBuild attribute field' : mappingDeleteSourceFieldLabel(rules, field),
          field === '__no_cmdb_field' ? 'rule не привязано к конкретному source field' : mappingDeleteSourceFieldMeta(rules, field)
        );
        fieldGroup.items.push(item);
      }
    }
  }

  return [...groups.values()];
}

function mappingDeleteClassesForItem(item, rules) {
  const explicit = ruleClassConditions(item.rule);
  if (explicit.length > 0) {
    return explicit;
  }

  const fields = mappingDeleteSourceFieldsForItem(item.rule);
  const classesFromPaths = uniqueTokens(fields
    .map(field => rules.source?.fields?.[canonicalSourceField(field)]?.cmdbPath)
    .filter(Boolean)
    .map(path => String(path).split('.')[0])
    .filter(Boolean));

  return classesFromPaths.length > 0 ? classesFromPaths : ['__any_class'];
}

function mappingDeleteSourceFieldsForItem(rule = {}) {
  const fields = new Set(sourceFieldsForRule(rule));
  collectMappingDeleteSourceFields(rule, fields);
  return uniqueTokens([...fields].map(canonicalSourceField));
}

function collectMappingDeleteSourceFields(value, fields) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMappingDeleteSourceFields(item, fields);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, raw] of Object.entries(value)) {
    if (key === 'when') {
      mappingDeleteConditionFields(raw).forEach(field => fields.add(field));
    } else if (key === 'valueField' && raw) {
      fields.add(raw);
    }
    collectMappingDeleteSourceFields(raw, fields);
  }
}

function mappingDeleteConditionFields(condition = {}) {
  return uniqueTokens([
    ...(condition.anyRegex ?? []).map(matcher => matcher.field),
    ...(condition.allRegex ?? []).map(matcher => matcher.field),
    condition.fieldExists,
    ...(Array.isArray(condition.fieldsExist) ? condition.fieldsExist : [])
  ].filter(Boolean));
}

function mappingDeleteSourceFieldLabel(rules, field) {
  const sourceField = rules.source?.fields?.[canonicalSourceField(field)];
  const sourceNames = sourceField ? sourceFieldSources(sourceField) : [];
  const sourceName = sourceNames.find(name => !equalsIgnoreCase(name, field));
  return sourceName ? `${field} / ${sourceName}` : field;
}

function mappingDeleteSourceFieldMeta(rules, field) {
  const sourceField = rules.source?.fields?.[canonicalSourceField(field)];
  if (!sourceField) {
    return 'source field from rule condition';
  }

  return sourceFieldMeta(sourceField) || 'source field';
}

function mappingDeleteZabbixGroups(items, rules) {
  const roots = new Map();
  const payloadRoot = ensureMappingDeleteGroup(roots, 'zabbix-payload', 'Zabbix payload fields', 'groups of JSON-RPC attributes');
  const objectRoot = ensureMappingDeleteGroup(roots, 'zabbix-objects', 'Zabbix objects and references', 'host groups, templates, tags and extended catalogs');
  const structureRoot = ensureMappingDeleteGroup(roots, 'zabbix-structures', 'Conversion structures', 'rules grouped by conversion block');

  for (const item of items) {
    for (const payload of mappingDeletePayloadFieldsForItem(item)) {
      ensureMappingDeleteChildGroup(
        payloadRoot,
        `payload:${normalizeToken(payload)}`,
        payload,
        'Zabbix payload field or field group'
      ).items.push(item);
    }

    const structure = ensureMappingDeleteChildGroup(
      structureRoot,
      `structure:${item.collection.type}`,
      mappingDeleteZabbixTypeLabel(item.collection.type, item.collection.label),
      item.collection.label
    );
    structure.items.push(item);

    const targets = mappingDeleteTargetsForItem(item, rules);
    if (targets.length === 0) {
      ensureMappingDeleteChildGroup(
        objectRoot,
        `object:${item.collection.type}:__none`,
        mappingDeleteZabbixTypeLabel(item.collection.type, item.collection.label),
        'нет конкретного Zabbix object, правило влияет на structure/payload'
      ).items.push(item);
      continue;
    }

    const typeGroup = ensureMappingDeleteChildGroup(
      objectRoot,
      `object-type:${item.collection.type}`,
      mappingDeleteZabbixTypeLabel(item.collection.type, item.collection.label),
      'Zabbix object group'
    );
    for (const target of targets) {
      ensureMappingDeleteChildGroup(
        typeGroup,
        `object:${item.collection.type}:${normalizeToken(target)}`,
        target,
        'Zabbix object / reference'
      ).items.push(item);
    }
  }

  return [...roots.values()].filter(group => mappingDeleteGroupOperationKeys(group).length > 0);
}

function mappingDeleteTargetsForItem(item, rules) {
  const targets = selectionItemsForRule(rules, item.rule, item.collection.type)
    .map(target => mappingDeleteTargetLabel(item.collection.type, target))
    .filter(Boolean);
  if (item.collection.type === 'interface' && item.rule.interfaceRef) {
    targets.push(item.rule.interfaceRef);
  }
  if (item.collection.type === 'interfaceProfiles' && item.rule.interfaceProfileRef) {
    targets.push(item.rule.interfaceProfileRef);
  }
  return uniqueTokens(targets);
}

function mappingDeletePayloadFieldsForItem(item) {
  const type = item.collection.type;
  const rule = item.rule;
  const fields = {
    eventRouting: ['method', 'hostid', 'host'],
    hostProfiles: ['host', 'name', 'interfaces[]'],
    hostGroups: ['groups[].groupid'],
    templates: ['templates[].templateid'],
    templateGroups: ['templateGroups[].groupid'],
    interfaceAddress: [rule.mode === 'dns' ? 'interfaces[].dns' : 'interfaces[].ip', 'interfaces[].useip'],
    interface: ['interfaces[]'],
    tags: ['tags[].tag', 'tags[].value'],
    monitoringSuppression: ['suppression/no Zabbix request'],
    proxies: ['proxyid'],
    proxyGroups: ['proxy_groupid'],
    globalMacros: ['macros[]'],
    hostMacros: ['macros[].macro', 'macros[].value'],
    inventoryFields: ['inventory'],
    interfaceProfiles: ['interfaces[].type', 'interfaces[].port'],
    hostStatuses: ['status'],
    maintenances: ['maintenances'],
    tlsPskModes: ['tls_connect', 'tls_accept', 'tls_psk_identity', 'tls_psk'],
    valueMaps: ['valueMaps']
  }[type] ?? [`target:${type}`];

  return uniqueTokens(fields.filter(Boolean));
}

function mappingDeleteZabbixTypeLabel(type, fallback) {
  return {
    eventRouting: 'Event routing',
    hostProfiles: 'Host profiles / interfaces',
    hostGroups: 'Host groups',
    templates: 'Templates',
    templateGroups: 'Template groups',
    interfaceAddress: 'Interface address',
    interface: 'Interface structure',
    tags: 'Tags',
    monitoringSuppression: 'Monitoring suppression'
  }[type]
    ?? zabbixExtensionDefinitions.find(definition => definition.rulesKey === type)?.title
    ?? fallback
    ?? type;
}

function mappingDeleteGroupNode(group, rules, level = 0) {
  const groupNode = el('div', 'mapping-delete-group is-collapsed', '');
  groupNode.dataset.deleteRuleGroup = group.key;
  groupNode.dataset.deleteRuleLevel = String(level);

  const header = el('div', 'mapping-delete-group-header', '');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'mapping-delete-group-checkbox';
  checkbox.dataset.operationKeys = JSON.stringify(mappingDeleteGroupOperationKeys(group));
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'mapping-delete-group-toggle secondary';
  toggle.textContent = '+';
  const title = el('h3', '', '');
  title.append(el('span', '', group.label));
  if (group.meta) {
    title.append(el('span', 'mapping-delete-group-meta', group.meta));
  }
  const count = el('span', 'mapping-delete-group-count', String(mappingDeleteGroupOperationKeys(group).length));
  header.append(checkbox, toggle, title, count);

  const body = el('div', 'mapping-delete-group-body', '');
  body.replaceChildren(
    ...asArray(group.children).map(child => mappingDeleteGroupNode(child, rules, level + 1)),
    ...group.items.map(item => mappingDeleteRuleNode(item, rules))
  );
  groupNode.append(header, body);
  setHelp(header, `Группа удаления "${group.label}". Чекбокс отмечает все правила внутри группы; + раскрывает дочерние узлы и отдельные rules.`);
  toggle.addEventListener('click', event => {
    event.stopPropagation();
    setMappingDeleteGroupExpanded(groupNode, groupNode.classList.contains('is-collapsed'));
  });
  header.addEventListener('click', event => {
    if (event.target.matches('input, button')) {
      return;
    }
    setMappingDeleteGroupExpanded(groupNode, groupNode.classList.contains('is-collapsed'));
  });
  return groupNode;
}

function ensureMappingDeleteGroup(groups, key, label, meta = '') {
  if (!groups.has(key)) {
    groups.set(key, {
      key,
      label,
      meta,
      items: [],
      children: [],
      childGroups: new Map()
    });
  }

  return groups.get(key);
}

function ensureMappingDeleteChildGroup(parent, key, label, meta = '') {
  const group = ensureMappingDeleteGroup(parent.childGroups, key, label, meta);
  if (!parent.children.includes(group)) {
    parent.children.push(group);
  }
  return group;
}

function mappingDeleteGroupOperationKeys(group) {
  return uniqueTokens([
    ...asArray(group.items).map(item => item.operationKey),
    ...asArray(group.children).flatMap(mappingDeleteGroupOperationKeys)
  ]);
}

function setMappingDeleteGroupExpanded(groupNode, expanded) {
  groupNode.classList.toggle('is-collapsed', !expanded);
  const toggle = groupNode.querySelector('.mapping-delete-group-toggle');
  if (toggle) {
    toggle.textContent = expanded ? '-' : '+';
  }
}

function mappingDeleteEmptyNode(message) {
  const node = el('div', 'mapping-delete-empty', message);
  setHelp(node, 'Информационная строка режима удаления правил.');
  return node;
}

function mappingDeleteRuleItems(rules) {
  return mappingRuleCollections().flatMap(collection => asArray(rules[collection.key])
    .map((rule, index) => ({
      collection,
      rule,
      index,
      operationKey: mappingDeleteOperationKey(collection.key, index, rule)
    })));
}

function mappingDeleteRuleNode(item, rules) {
  const label = el('label', 'mapping-delete-item', '');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'mapping-delete-checkbox';
  checkbox.dataset.operationKey = item.operationKey;
  checkbox.dataset.ruleCollection = item.collection.key;
  checkbox.dataset.ruleIndex = String(item.index);

  const text = el('span', 'mapping-delete-text', '');
  text.append(
    el('span', 'mapping-delete-rule-name', ruleDisplayName(item.rule)),
    el('span', 'mapping-delete-rule-meta', mappingDeleteRuleMeta(item.rule, item.collection.type, rules))
  );
  label.append(checkbox, text);
  setHelp(label, `Отметьте правило "${ruleDisplayName(item.rule)}" для удаления из draft JSON. Удаление попадет в undo/redo и будет отражено как DELETE в webhook-файле текущей сессии.`);
  return label;
}

function mappingDeleteRuleMeta(rule, type, rules) {
  const parts = [];
  if (rule.eventType || rule.method) {
    parts.push([rule.eventType, rule.method].filter(Boolean).join(' -> '));
  }
  if (Number.isFinite(Number(rule.priority))) {
    parts.push(`priority ${rule.priority}`);
  }
  const classNames = ruleClassConditions(rule);
  if (classNames.length > 0) {
    parts.push(`classes ${classNames.join(', ')}`);
  }
  const fields = sourceFieldsForRule(rule).filter(field => canonicalSourceField(field) !== 'className');
  if (fields.length > 0) {
    parts.push(`fields ${fields.join(', ')}`);
  }
  const targets = selectionItemsForRule(rules, rule, type)
    .map(item => mappingDeleteTargetLabel(type, item))
    .filter(Boolean);
  if (targets.length > 0) {
    parts.push(`target ${uniqueTokens(targets).slice(0, 3).join(', ')}`);
  }
  if (rule.interfaceRef || rule.interfaceProfileRef) {
    parts.push(`interface ${rule.interfaceRef || rule.interfaceProfileRef}`);
  }
  if (rule.valueField || rule.mode) {
    parts.push(`address ${rule.mode ?? 'auto'}:${rule.valueField ?? ''}`);
  }
  return parts.join(' | ') || 'no details';
}

function mappingDeleteTargetLabel(type, item) {
  if (type === 'hostGroups') {
    return item.name || item.groupid;
  }
  if (type === 'templates') {
    return item.name || item.host || item.templateid;
  }
  if (type === 'templateGroups') {
    return item.name || item.groupid;
  }
  if (type === 'tags') {
    return [item.tag, item.value].filter(Boolean).join('=');
  }
  const definition = zabbixExtensionDefinitions.find(value => value.rulesKey === type);
  return definition ? mappingEditorTargetLabel(definition, item) : '';
}

function mappingDeleteOperationKey(collectionKey, index, rule) {
  return `${collectionKey}:${index}:${ruleIdentity(rule)}`;
}

function selectedMappingRuleDeletions() {
  const operations = new Map();
  for (const checkbox of $$('.mapping-delete-checkbox:checked')) {
    if (!checkbox.dataset.operationKey) {
      continue;
    }
    operations.set(checkbox.dataset.operationKey, {
      operationKey: checkbox.dataset.operationKey,
      collection: checkbox.dataset.ruleCollection
    });
  }
  return [...operations.values()];
}

function updateMappingDeleteControls() {
  const deletePanel = $('#mappingDeletePanel');
  const selectedCount = selectedMappingRuleDeletions().length;
  const hasRules = $$('.mapping-delete-checkbox').length > 0;
  const enabled = state.mappingMode === 'edit' && state.mappingEditAction === 'delete' && Boolean(state.mappingDraftRules);
  $('#mappingDeleteSelectAll').disabled = !enabled || !hasRules;
  $('#mappingDeleteClear').disabled = !enabled || !hasRules || selectedCount === 0;
  $('#mappingDeleteSelected').disabled = !enabled || selectedCount === 0;
  deletePanel?.classList.toggle('has-selection', selectedCount > 0);
  updateMappingDeleteGroupCheckboxes();
}

function setMappingDeleteSelection(checked) {
  $$('.mapping-delete-checkbox').forEach(checkbox => {
    checkbox.checked = checked;
  });
  updateMappingDeleteControls();
}

function setMappingDeleteGroupSelection(groupCheckbox) {
  const keys = new Set(mappingDeleteGroupKeysFromCheckbox(groupCheckbox));
  $$('.mapping-delete-checkbox').forEach(checkbox => {
    if (keys.has(checkbox.dataset.operationKey)) {
      checkbox.checked = groupCheckbox.checked;
    }
  });
  updateMappingDeleteControls();
}

function updateMappingDeleteGroupCheckboxes() {
  const selectedKeys = new Set(selectedMappingRuleDeletions().map(operation => operation.operationKey));
  $$('.mapping-delete-group-checkbox').forEach(checkbox => {
    const keys = mappingDeleteGroupKeysFromCheckbox(checkbox);
    const selectedCount = keys.filter(key => selectedKeys.has(key)).length;
    checkbox.checked = keys.length > 0 && selectedCount === keys.length;
    checkbox.indeterminate = selectedCount > 0 && selectedCount < keys.length;
  });
}

function mappingDeleteGroupKeysFromCheckbox(checkbox) {
  try {
    const keys = JSON.parse(checkbox.dataset.operationKeys ?? '[]');
    return Array.isArray(keys) ? keys : [];
  } catch {
    return [];
  }
}

function deleteSelectedMappingRules() {
  if (!state.mappingDraftRules) {
    setMappingEditorStatus(t('mapping.status.loadMappingFirst'));
    return;
  }

  const operations = selectedMappingRuleDeletions();
  if (operations.length === 0) {
    setMappingEditorStatus(t('mapping.status.selectRulesForDelete'));
    return;
  }

  const confirmed = window.confirm([
    tf('mapping.confirm.deleteRulesTitle', { count: operations.length }),
    t('mapping.confirm.deleteRulesKeepSources'),
    t('mapping.confirm.deleteRulesUndo')
  ].join('\n'));
  if (!confirmed) {
    return;
  }

  const selectedKeys = new Set(operations.map(operation => operation.operationKey));
  const rules = cloneJson(state.mappingDraftRules);
  let removed = 0;
  for (const collection of mappingRuleCollections()) {
    const items = asArray(rules[collection.key]);
    if (items.length === 0) {
      continue;
    }
    rules[collection.key] = items.filter((rule, index) => {
      const remove = selectedKeys.has(mappingDeleteOperationKey(collection.key, index, rule));
      if (remove) {
        removed += 1;
      }
      return !remove;
    });
  }

  if (removed === 0) {
    setMappingEditorStatus(t('mapping.status.deletedRulesMissing'));
    renderMappingDeleteRules();
    return;
  }

  pushMappingHistory(rules);
  rerenderMappingDraft(tf('mapping.status.deletedRules', { count: removed }));
}

function populateMappingEditorClasses() {
  const select = $('#mappingEditClass');
  const previous = select.value;
  const rules = currentMappingRules();
  const classes = mappingEditorClassOptions(rules, state.mappingCmdbuildCatalog ?? {});

  setClassSelectOptions(select, [
    { value: '', label: t('mapping.option.anyClass') },
    ...classes
  ], previous, state.mappingCmdbuildCatalog ?? {});
}

function setClassSelectOptions(select, options, selectedValue = '', catalog = {}) {
  let nextValue = selectedValue;
  if (selectedValue) {
    const selectedOption = options.find(option => normalizeClassName(option.value) === normalizeClassName(selectedValue));
    if (!selectedOption || selectedOption.disabled) {
      const nearest = nearestConcreteClassOption(options, catalog, selectedValue);
      nextValue = nearest?.value ?? selectedValue;
    }
  }

  setSelectOptions(select, options, nextValue);
  if (!select || !selectedValue || select.value === selectedValue) {
    return;
  }

  const normalizedSelected = normalizeClassName(selectedValue);
  const normalizedOption = options.find(option => !option.disabled && normalizeClassName(option.value) === normalizedSelected);
  if (normalizedOption) {
    select.value = normalizedOption.value;
  }
}

function mappingEditorClassOptions(rules, catalog) {
  const byClass = new Map();
  const putClass = (className, override = {}) => {
    if (!className) {
      return;
    }
    const key = normalizeClassName(className);
    if (!key || byClass.has(key)) {
      return;
    }
    byClass.set(key, {
      value: catalogClassRuleName(catalog, className),
      label: catalogClassDisplayName(catalog, className),
      ...override
    });
  };

  const configured = new Set((rules.source?.entityClasses ?? []).map(normalizeClassName));
  const hierarchyOptions = cmdbClassHierarchySelectOptions(catalog, configured);
  hierarchyOptions.forEach(option => putClass(option.value, option));
  (rules.source?.entityClasses ?? [])
    .filter(className => !byClass.has(normalizeClassName(className)))
    .forEach(className => putClass(className, { label: `${className} / rules only` }));

  if (hierarchyOptions.length > 0) {
    return [...byClass.values()];
  }

  return [...byClass.values()].sort((left, right) => compareText(left.label, right.label));
}

function cmdbClassHierarchySelectOptions(catalog = {}, configured = new Set()) {
  const classes = (catalog.classes ?? []).filter(item => item?.name);
  if (classes.length === 0) {
    return [];
  }

  const byName = new Map(classes.map(item => [normalizeClassName(item.name), item]));
  const childrenByParent = cmdbChildrenByParent(catalog);
  const roots = classes
    .filter(item => {
      const parentName = cmdbParentClassName(item);
      return !parentName || !byName.has(parentName);
    })
    .sort(compareCmdbClasses);

  return roots.flatMap(item => cmdbClassHierarchySelectBranch(item, 0, childrenByParent, configured));
}

function cmdbClassHierarchySelectBranch(item, depth, childrenByParent, configured) {
  const children = childrenByParent.get(normalizeClassName(item.name)) ?? [];
  const superclass = isCmdbSuperclass(item, children);
  const displayName = catalogClassDisplayName(state.mappingCmdbuildCatalog ?? {}, item);
  const prefix = depth > 0 ? `${'  '.repeat(depth)}↳ ` : '';
  const markers = [
    superclass ? 'superclass' : '',
    configured.has(normalizeClassName(item.name)) ? 'rules' : ''
  ].filter(Boolean);
  const option = {
    value: item.name,
    label: `${prefix}${displayName}${displayName !== item.name ? ` / ${item.name}` : ''}${markers.length ? ` (${markers.join(', ')})` : ''}`,
    disabled: superclass,
    className: superclass ? 'mapping-class-option-super' : ''
  };

  return [
    option,
    ...children.flatMap(child => cmdbClassHierarchySelectBranch(child, depth + 1, childrenByParent, configured))
  ];
}

function nearestConcreteClassOption(options, catalog, className) {
  const candidates = nearestConcreteClassNames(catalog, className).map(normalizeClassName);
  if (candidates.length === 0) {
    return null;
  }
  return options.find(option => !option.disabled && candidates.includes(normalizeClassName(option.value))) ?? null;
}

function nearestConcreteClassNames(catalog = {}, className = '') {
  const start = findCatalogClass(catalog, className);
  if (!start) {
    return [];
  }

  const childrenByParent = cmdbChildrenByParent(catalog);
  const queue = [...(childrenByParent.get(normalizeClassName(start.name)) ?? [])].sort(compareCmdbClasses);
  const result = [];
  while (queue.length > 0) {
    const item = queue.shift();
    const children = childrenByParent.get(normalizeClassName(item.name)) ?? [];
    if (!isCmdbSuperclass(item, children)) {
      result.push(item.name);
      continue;
    }
    queue.push(...children.sort(compareCmdbClasses));
  }
  return result;
}

function cmdbChildrenByParent(catalog = {}) {
  const classes = (catalog.classes ?? []).filter(item => item?.name);
  const byName = new Map(classes.map(item => [normalizeClassName(item.name), item]));
  const childrenByParent = new Map();
  for (const item of classes) {
    const parentName = cmdbParentClassName(item);
    if (!parentName || !byName.has(parentName)) {
      continue;
    }

    const children = childrenByParent.get(parentName) ?? [];
    children.push(item);
    childrenByParent.set(parentName, children);
  }

  for (const children of childrenByParent.values()) {
    children.sort(compareCmdbClasses);
  }
  return childrenByParent;
}

function populateMappingEditorFields(options = {}) {
  const select = $('#mappingEditField');
  const previous = options.selectedValue !== undefined ? options.selectedValue : select.value;
  const rules = currentMappingRules();
  const sourceFields = rules.source?.fields ?? {};
  const selectedClass = $('#mappingEditClass').value;
  const targetType = $('#mappingEditTargetType')?.value ?? '';
  const configuredOptions = Object.entries(sourceFields)
    .filter(([fieldKey, field]) => isMappingSourceFieldCompatibleWithClass(selectedClass, fieldKey, field, rules))
    .filter(([fieldKey, field]) => isMappingFieldAllowedForTarget(fieldKey, field, targetType))
    .sort(([left], [right]) => compareText(left, right))
    .map(([fieldKey, field]) => ({
      value: fieldKey,
      label: mappingEditorSourceFieldLabel(fieldKey, field)
    }));
  const catalogOptions = mappingEditorCatalogFieldOptions(selectedClass, sourceFields)
    .filter(option => isMappingFieldAllowedForTarget(option.value, option.fieldRule, targetType));
  state.mappingEditorFieldOptions = new Map(catalogOptions
    .filter(option => option.fieldRule)
    .map(option => [option.value, option]));
  let fieldOptions = selectedClass
    ? [...configuredOptions, ...catalogOptions]
    : configuredOptions;
  const selectedField = state.mappingModifyFieldValue || previous || '';
  if (selectedField && !fieldOptions.some(option => option.value === selectedField)) {
    fieldOptions = [{
      value: selectedField,
      label: tf('mapping.option.currentFieldMissing', { field: selectedField }),
      status: 'stale',
      meta: t('mapping.option.currentFieldMissingMeta')
    }, ...fieldOptions];
  }
  if (fieldOptions.length === 0) {
    fieldOptions = [{
      value: '',
      label: targetType
        ? tf('mapping.option.noCompatibleFields', { target: mappingTargetTypeLabel(targetType) })
        : t('mapping.option.noFields'),
      status: 'invalid'
    }];
  }
  fieldOptions = [
    {
      value: '',
      label: t('mapping.option.chooseLeaf'),
      status: 'invalid',
      meta: t('mapping.option.chooseLeafMeta')
    },
    ...fieldOptions.filter(option => option.value !== '')
  ];
  state.mappingEditorFieldOptionStates = new Map(fieldOptions.map(option => [option.value, option.status ?? 'valid']));
  state.mappingModifyFieldValue = '';
  setSelectOptions(select, fieldOptions, selectedField);
}

function populateMappingEditorStructures(options = {}) {
  const select = $('#mappingEditTargetType');
  const previous = options.selectedValue !== undefined ? options.selectedValue : select.value;
  const field = options.fieldValue !== undefined ? options.fieldValue : $('#mappingEditField')?.value ?? '';
  const fieldRule = field
    ? currentMappingRules().source?.fields?.[field] ?? state.mappingEditorFieldOptions?.get(field)?.fieldRule ?? {}
    : null;
  let structureOptions = [
    { value: 'hostGroups', label: mappingTargetTypeLabel('hostGroups') },
    { value: 'templates', label: mappingTargetTypeLabel('templates') },
    { value: 'tags', label: mappingTargetTypeLabel('tags') },
    { value: 'interfaceAddress', label: mappingTargetTypeLabel('interfaceAddress') },
    { value: 'interface', label: mappingTargetTypeLabel('interface') },
    { value: 'monitoringSuppression', label: mappingTargetTypeLabel('monitoringSuppression') },
    ...mappingEditorEditableExtensionDefinitions()
      .map(definition => ({ value: definition.rulesKey, label: `${definition.title} rule` }))
  ];
  if (fieldRule) {
    structureOptions = structureOptions
      .filter(option => isMappingFieldAllowedForTarget(field, fieldRule, option.value));
  }
  structureOptions = [
    {
      value: '',
      label: t('mapping.option.chooseStructure'),
      status: 'invalid',
      meta: t('mapping.option.chooseStructureMeta')
    },
    ...structureOptions
  ];
  setSelectOptions(select, structureOptions, previous);
}

async function populateMappingEditorTargets(options = {}) {
  const select = $('#mappingEditZabbixObject');
  const previous = options.selectedValue !== undefined ? options.selectedValue : select.value;
  const type = $('#mappingEditTargetType').value;
  const extension = mappingEditorExtensionDefinition(type);
  if (shouldLoadMappingEditorExtensionCatalog(extension)) {
    setSelectOptions(select, [{ value: '', label: t('mapping.option.loadingZabbix') }], '');
    try {
      const response = await api(`/api/zabbix/catalog/${extension.lazyCatalogPath}`);
      if ($('#mappingEditTargetType').value !== type) {
        return;
      }
      state.mappingZabbixCatalog[extension.catalogKey] = response.items ?? [];
    } catch (error) {
      if ($('#mappingEditTargetType').value !== type) {
        return;
      }
      setSelectOptions(select, [{ value: '', label: tf('mapping.option.loadError', { message: error.message }) }], '');
      return;
    }
  }

  let items = mappingEditorTargetOptions(type, currentMappingRules());
  let selectedTarget = state.mappingModifyTargetValue || previous;
  let missingRuleTarget = false;
  if (selectedTarget && !items.some(item => item.value === selectedTarget)) {
    missingRuleTarget = true;
    selectedTarget = '';
  }
  items = [
    {
      value: '',
      label: missingRuleTarget
        ? t('mapping.option.currentTargetMissingChooseNew')
        : t('mapping.option.chooseTarget'),
      status: 'invalid',
      meta: missingRuleTarget
        ? t('mapping.option.currentTargetMissingMeta')
        : t('mapping.option.chooseTargetMeta')
    },
    ...items.filter(item => item.value !== '')
  ];
  state.mappingEditorTargetOptionStates = new Map(items.map(option => [option.value, option.status ?? 'valid']));
  state.mappingModifyTargetValue = '';
  setSelectOptions(select, items, selectedTarget);
  updateMappingEditorSuggestedName();
  updateMappingEditorFormState();
}

function mappingEditorTargetOptions(type, rules) {
  if (type === 'hostGroups') {
    return uniqueMappingObjects(state.mappingZabbixCatalog?.hostGroups ?? [], item => item.groupid || item.name)
      .map(item => optionFromPayload(item.name || item.groupid, item));
  }

  if (type === 'templates') {
    return uniqueMappingObjects(state.mappingZabbixCatalog?.templates ?? [], item => item.templateid || item.name || item.host)
      .map(item => optionFromPayload(item.name || item.host || item.templateid, item));
  }

  if (type === 'tags') {
    return uniqueMappingObjects([
      ...(state.mappingZabbixCatalog?.tags ?? []),
      ...(rules.defaults?.tags ?? []),
      ...(rules.tagSelectionRules ?? []).flatMap(rule => rule.tags ?? [])
    ], item => `${item.tag}:${item.value ?? ''}`)
      .map(item => optionFromPayload(`${item.tag}${item.value ? `=${item.value}` : ''}`, item));
  }

  if (type === 'interfaceAddress') {
    return [
      optionFromPayload(t('mapping.option.ipAddress'), { mode: 'ip', valueField: 'ipAddress' }),
      optionFromPayload(t('mapping.option.dnsName'), { mode: 'dns', valueField: 'dnsName' })
    ];
  }

  if (type === 'interface') {
    return [
      optionFromPayload(t('mapping.option.agentInterface'), { interfaceRef: 'agentInterface' }),
      optionFromPayload(t('mapping.option.snmpInterface'), { interfaceRef: 'snmpInterface' })
    ];
  }

  if (type === 'monitoringSuppression') {
    return [
      optionFromPayload(t('mapping.option.monitoringSuppression'), {
        reason: 'object_policy_do_not_monitor'
      })
    ];
  }

  const extension = mappingEditorExtensionDefinition(type);
  if (extension) {
    return mappingEditorExtensionTargetOptions(extension, rules);
  }

  return [];
}

function mappingEditorEditableExtensionDefinitions() {
  return zabbixExtensionDefinitions.filter(definition => [
    'proxies',
    'proxyGroups',
    'hostMacros',
    'inventoryFields',
    'interfaceProfiles',
    'hostStatuses',
    'maintenances',
    'tlsPskModes',
    'valueMaps'
  ].includes(definition.rulesKey));
}

function mappingEditorExtensionDefinition(type) {
  return mappingEditorEditableExtensionDefinitions().find(definition => definition.rulesKey === type);
}

function shouldLoadMappingEditorExtensionCatalog(definition) {
  if (!definition?.lazyCatalogPath || !state.mappingZabbixCatalog) {
    return false;
  }

  const currentItems = state.mappingZabbixCatalog[definition.catalogKey];
  const knownCount = state.mappingZabbixCatalog.counts?.[definition.catalogKey] ?? 0;
  return (!Array.isArray(currentItems) || currentItems.length === 0) && knownCount > 0;
}

function mappingEditorExtensionTargetOptions(definition, rules) {
  if (definition.rulesKey === 'interfaceProfiles') {
    return Object.keys(rules.defaults?.interfaceProfiles ?? {})
      .sort(compareText)
      .map(name => optionFromPayload(tf('mapping.option.profilePrefix', { name }), { interfaceProfileRef: name }));
  }

  const items = zabbixExtensionItems(rules, state.mappingZabbixCatalog ?? {}, definition);
  const options = items
    .map(item => mappingEditorExtensionTarget(definition, item))
    .filter(Boolean)
    .map(target => optionFromPayload(mappingEditorTargetLabel(definition, target), target));

  if (definition.rulesKey === 'hostMacros') {
    options.unshift(optionFromPayload(t('mapping.option.newHostMacro'), {
      macro: '{$CMDB.VALUE}',
      valueTemplate: ''
    }));
  }
  if (definition.rulesKey === 'inventoryFields' && options.length === 0) {
    options.push(optionFromPayload(t('mapping.option.inventoryFromField'), {
      field: 'asset_tag',
      valueTemplate: ''
    }));
  }

  return options;
}

function optionFromPayload(label, payload) {
  return { value: JSON.stringify(payload), label };
}

function uniqueMappingObjects(items, keySelector) {
  const result = new Map();
  for (const item of items.filter(Boolean)) {
    const key = normalizeToken(keySelector(item));
    if (key && !result.has(key)) {
      result.set(key, item);
    }
  }
  return [...result.values()];
}

function mappingEditorClassAttributes(className) {
  if (!className) {
    return [];
  }

  const catalogClass = findCatalogClass(state.mappingCmdbuildCatalog ?? {}, className);
  if (!catalogClass || isCmdbCatalogSuperclass(state.mappingCmdbuildCatalog ?? {}, catalogClass)) {
    return [];
  }

  return catalogAttributesForClass(state.mappingCmdbuildCatalog ?? {}, catalogClass);
}

function sourceFieldHasCatalogAttribute(sourceFields, attributeName) {
  return Object.entries(sourceFields ?? {}).some(([fieldKey, field]) => {
    const names = [fieldKey, canonicalSourceField(fieldKey), ...sourceFieldSources(field), ...sourceFieldCatalogSources(field)]
      .map(normalizeToken);
    return names.includes(normalizeToken(attributeName));
  });
}

function mappingEditorExtensionTarget(definition, item) {
  if (!item) {
    return null;
  }

  if (definition.rulesKey === 'proxies') {
    return { name: item.name ?? '', proxyId: item.proxyId ?? item.proxyid ?? '' };
  }
  if (definition.rulesKey === 'proxyGroups') {
    return { name: item.name ?? '', proxy_groupid: item.proxy_groupid ?? item.proxyGroupId ?? '' };
  }
  if (definition.rulesKey === 'hostMacros') {
    return {
      macro: item.macro ?? '{$CMDB.VALUE}',
      value: item.value ?? '',
      valueTemplate: item.valueTemplate ?? '',
      description: item.description ?? '',
      type: Number(item.type ?? 0)
    };
  }
  if (definition.rulesKey === 'inventoryFields') {
    return {
      field: item.field ?? item.name ?? '',
      name: item.name ?? item.field ?? '',
      value: item.value ?? '',
      valueTemplate: item.valueTemplate ?? ''
    };
  }
  if (definition.rulesKey === 'hostStatuses') {
    return { status: Number(item.status ?? 0), name: item.name ?? '' };
  }
  if (definition.rulesKey === 'maintenances') {
    return { name: item.name ?? '', maintenanceId: item.maintenanceId ?? item.maintenanceid ?? '' };
  }
  if (definition.rulesKey === 'tlsPskModes') {
    return {
      name: item.name ?? '',
      tls_connect: item.tls_connect ?? item.tlsConnect ?? 1,
      tls_accept: item.tls_accept ?? item.tlsAccept ?? 1,
      tls_psk_identity: item.tls_psk_identity ?? item.tlsPskIdentity ?? '',
      tls_psk: item.tls_psk ?? item.tlsPsk ?? ''
    };
  }
  if (definition.rulesKey === 'valueMaps') {
    return { name: item.name ?? '', valueMapId: item.valueMapId ?? item.valuemapid ?? '' };
  }

  return item;
}

function mappingEditorTargetLabel(definition, target) {
  if (definition.rulesKey === 'hostMacros') {
    return target.macro || 'host macro';
  }
  if (definition.rulesKey === 'inventoryFields') {
    return target.field || target.name || 'inventory field';
  }
  if (definition.rulesKey === 'hostStatuses') {
    return target.name || `status ${target.status}`;
  }
  if (definition.rulesKey === 'tlsPskModes') {
    return target.name || `TLS ${target.tls_connect}/${target.tls_accept}`;
  }

  return target.name
    || target.proxyId
    || target.proxy_groupid
    || target.maintenanceId
    || target.valueMapId
    || 'target';
}

function setSelectOptions(select, options, selectedValue = '') {
  if (!select) {
    return;
  }

  select.replaceChildren(...options.map(option => {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    node.disabled = Boolean(option.disabled);
    if (option.className) {
      node.className = option.className;
    }
    if (option.title || option.meta) {
      node.title = option.title ?? option.meta;
    }
    return node;
  }));

  if (options.some(option => option.value === selectedValue && !option.disabled)) {
    select.value = selectedValue;
    return;
  }

  const firstEnabled = options.find(option => !option.disabled);
  if (firstEnabled) {
    select.value = firstEnabled.value;
  }
}

function mappingEditorSourceFieldLabel(fieldKey, field) {
  const attribute = findCatalogAttributeForField(mappingEditorClassAttributes($('#mappingEditClass').value), field, fieldKey);
  return field.cmdbPath
    ? `${fieldKey} / ${field.cmdbPath}`
    : attribute?.name ?? fieldKey;
}

function mappingEditorAttributeForField(className, fieldKey, rules = currentMappingRules()) {
  if (!className || !fieldKey) {
    return null;
  }

  const attributes = mappingEditorClassAttributes(className);
  const field = rules.source?.fields?.[fieldKey] ?? { source: fieldKey };
  return findCatalogAttributeForField(attributes, field, fieldKey);
}

function isMappingEditorFieldValidForClass(className, fieldKey) {
  if (!className || !fieldKey) {
    return true;
  }

  if (state.mappingEditorFieldOptions?.has(fieldKey)) {
    return true;
  }

  const field = currentMappingRules().source?.fields?.[fieldKey] ?? { source: fieldKey };
  return isVirtualSourceFieldRule(fieldKey, field)
    || sourceFieldPathStartsWithClass(className, field)
    || Boolean(mappingEditorAttributeForField(className, fieldKey));
}

function isMappingSourceFieldCompatibleWithClass(className, fieldKey, field, rules = currentMappingRules()) {
  if (!className) {
    return true;
  }
  return isVirtualSourceFieldRule(fieldKey, field)
    || Boolean(mappingEditorAttributeForField(className, fieldKey, rules))
    || sourceFieldPathStartsWithClass(className, field);
}

function sourceFieldPathStartsWithClass(className, field = {}) {
  if (!className || !field?.cmdbPath) {
    return false;
  }

  const rootClass = String(field.cmdbPath).split('.')[0] ?? '';
  const catalog = state.mappingCmdbuildCatalog ?? {};
  const selectedRuleName = catalogClassRuleName(catalog, className);
  const rootRuleName = catalogClassRuleName(catalog, rootClass);
  return normalizeClassName(selectedRuleName) === normalizeClassName(rootRuleName);
}

function updateMappingEditorFormState() {
  const formState = mappingEditorFormValidation();
  for (const selector of mappingEditorFormControlSelectors) {
    setMappingEditorControlState(selector, 'normal', '');
  }
  for (const [selector, status] of Object.entries(formState.controls)) {
    setMappingEditorControlState(selector, status.level, status.message);
  }

  const formStateNode = $('#mappingEditorFormState');
  if (formStateNode) {
    formStateNode.textContent = formState.summary;
    formStateNode.classList.toggle('is-valid', formState.level === 'valid');
    formStateNode.classList.toggle('is-invalid', formState.level === 'invalid');
    formStateNode.classList.toggle('is-stale', formState.level === 'stale');
  }

  const saveButton = $('#mappingAddRule');
  if (saveButton && ['add', 'modify'].includes(state.mappingEditAction)) {
    saveButton.disabled = !formState.canSave;
  }
  const resetButton = $('#mappingResetForm');
  if (resetButton) {
    resetButton.disabled = !state.mappingDraftRules;
  }
}

function setMappingEditorControlState(selector, level = 'normal', message = '') {
  const control = $(selector);
  const wrapper = control?.closest('label');
  if (!wrapper) {
    return;
  }

  wrapper.classList.toggle('mapping-editor-control-valid', level === 'valid');
  wrapper.classList.toggle('mapping-editor-control-invalid', level === 'invalid');
  wrapper.classList.toggle('mapping-editor-control-stale', level === 'stale');
  wrapper.title = message || '';
}

function mappingEditorFormValidation() {
  if (state.mappingMode !== 'edit' || !['add', 'modify'].includes(state.mappingEditAction)) {
    return {
      canSave: false,
      level: 'normal',
      summary: '',
      controls: {}
    };
  }
  if (!state.mappingDraftRules) {
    return {
      canSave: false,
      level: 'invalid',
      summary: t('mapping.status.loadMappingFirst'),
      controls: {}
    };
  }

  const className = $('#mappingEditClass')?.value ?? '';
  const field = $('#mappingEditField')?.value ?? '';
  const type = $('#mappingEditTargetType')?.value ?? '';
  const targetValue = $('#mappingEditZabbixObject')?.value ?? '';
  const priority = Number($('#mappingEditPriority')?.value || 0);
  const selectedModifyRule = selectedMappingModifyItem(state.mappingDraftRules);
  const fieldRule = field
    ? currentMappingRules().source?.fields?.[field] ?? state.mappingEditorFieldOptions?.get(field)?.fieldRule ?? {}
    : {};
  const target = targetValue ? readMappingEditorTarget() : {};
  const classOption = [...($('#mappingEditClass')?.options ?? [])]
    .find(option => normalizeClassName(option.value) === normalizeClassName(className));
  const controls = {
    '#mappingModifyRule': { level: 'valid', message: t('mapping.status.ruleForModifySelected') },
    '#mappingEditClass': { level: 'valid', message: className ? t('mapping.status.classSelected') : t('mapping.status.noClassRestriction') },
    '#mappingEditField': { level: 'valid', message: t('mapping.status.leafSelected') },
    '#mappingEditTargetType': { level: 'valid', message: t('mapping.status.structureCompatible') },
    '#mappingEditZabbixObject': { level: 'valid', message: t('mapping.status.targetSelected') },
    '#mappingEditPriority': { level: 'valid', message: t('mapping.status.prioritySet') },
    '#mappingEditRegex': { level: 'valid', message: t('mapping.status.regexSaved') },
    '#mappingEditRuleName': { level: 'valid', message: t('mapping.status.ruleNameSetOrAuto') }
  };
  const messages = [];
  const staleMessages = [];

  if (state.mappingEditAction === 'modify' && !selectedModifyRule) {
    return {
      canSave: false,
      level: 'invalid',
      summary: t('mapping.status.noModifyRule'),
      controls: {
        '#mappingModifyRule': { level: 'invalid', message: t('mapping.status.modifyNeedsRule') }
      }
    };
  }

  if (classOption?.disabled) {
    controls['#mappingEditClass'] = { level: 'invalid', message: t('mapping.status.superclassNotAllowed') };
    messages.push(t('mapping.status.selectConcreteClass'));
  }

  if (!field) {
    controls['#mappingEditField'] = { level: 'invalid', message: t('mapping.status.chooseLeafField') };
    messages.push(t('mapping.status.chooseLeafField'));
  } else if (!isMappingEditorFieldValidForClass(className, field)) {
    const message = tf('mapping.status.fieldMissingInClass', { field });
    controls['#mappingEditField'] = { level: 'invalid', message };
    messages.push(message);
  } else if (!isMappingFieldAllowedForTarget(field, fieldRule, type)) {
    controls['#mappingEditField'] = { level: 'invalid', message: tf('mapping.status.fieldMultiValueIncompatible', { field, target: mappingTargetTypeLabel(type) }) };
    controls['#mappingEditTargetType'] = { level: 'invalid', message: t('mapping.status.chooseStructureForField') };
    messages.push(tf('mapping.status.fieldIncompatible', { field, target: mappingTargetTypeLabel(type) }));
  } else {
    const compatibilityMessage = mappingFieldTargetCompatibilityMessage(field, fieldRule, type, target);
    if (compatibilityMessage) {
      controls['#mappingEditField'] = { level: 'invalid', message: compatibilityMessage };
      controls['#mappingEditZabbixObject'] = { level: 'invalid', message: compatibilityMessage };
      messages.push(compatibilityMessage);
    } else if (state.mappingEditorFieldOptionStates?.get(field) === 'stale') {
      controls['#mappingEditField'] = { level: 'stale', message: tf('mapping.status.fieldStale', { field }) };
      staleMessages.push(tf('mapping.status.fieldStaleShort', { field }));
    }
  }

  if (!type) {
    controls['#mappingEditTargetType'] = { level: 'invalid', message: t('mapping.status.chooseStructure') };
    messages.push(t('mapping.status.chooseStructure'));
  }

  if (!targetValue) {
    controls['#mappingEditZabbixObject'] = { level: 'invalid', message: t('mapping.status.chooseTarget') };
    messages.push(t('mapping.status.chooseTarget'));
  } else if (state.mappingEditorTargetOptionStates?.get(targetValue) === 'invalid') {
    controls['#mappingEditZabbixObject'] = { level: 'invalid', message: t('mapping.status.targetMissing') };
    messages.push(t('mapping.status.targetMissingSummary'));
  } else if (state.mappingEditorTargetOptionStates?.get(targetValue) === 'stale') {
    controls['#mappingEditZabbixObject'] = { level: 'stale', message: t('mapping.status.targetStale') };
    staleMessages.push(t('mapping.status.targetStaleShort'));
  }

  if (!Number.isFinite(priority) || priority < 1) {
    controls['#mappingEditPriority'] = { level: 'invalid', message: t('mapping.status.priorityPositive') };
    messages.push(t('mapping.status.priorityPositive'));
  }

  const changed = state.mappingEditAction === 'add' || mappingEditorFormHasChanges();
  if (state.mappingEditAction === 'modify' && !changed && messages.length === 0) {
    messages.push(t('mapping.status.ruleResetNeeded'));
  }

  if (messages.length > 0) {
    return {
      canSave: false,
      level: 'invalid',
      summary: messages[0],
      controls
    };
  }

  if (staleMessages.length > 0) {
    return {
      canSave: changed,
      level: 'stale',
      summary: tf('mapping.status.readyButStale', { details: staleMessages.join(' ') }),
      controls
    };
  }

  return {
    canSave: changed,
    level: 'valid',
    summary: state.mappingEditAction === 'modify'
      ? t('mapping.status.canModify')
      : t('mapping.status.canAdd'),
    controls
  };
}

function mappingEditorFormHasChanges() {
  const selected = selectedMappingModifyItem(state.mappingDraftRules);
  const candidate = mappingEditorRuleCandidate();
  if (!selected || !candidate) {
    return false;
  }

  if (selected.collection.key !== candidate.rulesKey || stableJson(selected.rule) !== stableJson(candidate.rule)) {
    return true;
  }

  const rules = currentMappingRules();
  const className = catalogClassRuleName(state.mappingCmdbuildCatalog ?? {}, $('#mappingEditClass')?.value ?? '');
  const field = $('#mappingEditField')?.value ?? '';
  const target = readMappingEditorTarget();
  const fieldRule = rules?.source?.fields?.[field] ?? state.mappingEditorFieldOptions?.get(field)?.fieldRule ?? {};
  return !classHasHostProfile(rules, className)
    && ['ip', 'dns'].includes(minimalHostProfileInterfaceMode(field, fieldRule, target));
}

function mappingEditorRuleCandidate() {
  const type = $('#mappingEditTargetType')?.value ?? '';
  const className = catalogClassRuleName(state.mappingCmdbuildCatalog ?? {}, $('#mappingEditClass')?.value ?? '');
  const field = $('#mappingEditField')?.value ?? '';
  const regex = $('#mappingEditRegex')?.value.trim() ?? '';
  const priority = Number($('#mappingEditPriority')?.value || 100);
  const targetValue = $('#mappingEditZabbixObject')?.value ?? '';
  if (!type || !field || !targetValue) {
    return null;
  }

  const target = readMappingEditorTarget();
  const ruleName = ($('#mappingEditRuleName')?.value.trim() || buildMappingRuleName(type, className, field, target)).trim();
  return {
    rulesKey: mappingRulesKey(type, target),
    rule: buildMappingEditorRule({ type, className, field, regex, priority, target, ruleName })
  };
}

function applyMappingEditorRule() {
  if (state.mappingEditAction === 'modify') {
    modifyMappingConversionRule();
    return;
  }

  addMappingConversionRule();
}

function addMappingConversionRule() {
  if (!state.mappingDraftRules) {
    setMappingEditorStatus(t('mapping.status.loadMappingFirst'));
    return;
  }

  const formState = mappingEditorFormValidation();
  if (!formState.canSave) {
    updateMappingEditorFormState();
    setMappingEditorStatus(formState.summary, 'warning');
    return;
  }

  const rules = cloneJson(state.mappingDraftRules);
  const type = $('#mappingEditTargetType').value;
  const className = catalogClassRuleName(state.mappingCmdbuildCatalog ?? {}, $('#mappingEditClass').value);
  const field = $('#mappingEditField').value;
  const regex = $('#mappingEditRegex').value.trim();
  const priority = Number($('#mappingEditPriority').value || 100);
  const target = readMappingEditorTarget();
  if (!field) {
    setMappingEditorStatus(t('mapping.status.chooseCompatibleFieldAdd'), 'warning');
    return;
  }

  if (!isMappingEditorFieldValidForClass(className, field)) {
    setMappingEditorStatus(tf('mapping.status.classFieldMissing', { className, field }));
    return;
  }

  const selectedFieldRule = rules.source?.fields?.[field] ?? state.mappingEditorFieldOptions?.get(field)?.fieldRule ?? {};
  if (!isMappingFieldAllowedForTarget(field, selectedFieldRule, type)) {
    setMappingEditorStatus(
      tf('mapping.status.multiValueScalarNotAllowed', { field, target: mappingTargetTypeLabel(type) }),
      'warning');
    return;
  }

  const ruleName = ($('#mappingEditRuleName').value.trim() || buildMappingRuleName(type, className, field, target)).trim();
  const rule = buildMappingEditorRule({ type, className, field, regex, priority, target, ruleName });

  ensureMappingEditorClass(rules, className);
  ensureMappingEditorSourceField(rules, field);
  const fieldRuleForProfile = rules.source?.fields?.[field] ?? selectedFieldRule;
  const profileResult = ensureMinimalHostProfileForClass(rules, className, field, fieldRuleForProfile, target);
  const rulesKey = mappingRulesKey(type, target);
  rules[rulesKey] = Array.isArray(rules[rulesKey]) ? rules[rulesKey] : [];
  rules[rulesKey].push(rule);
  pushMappingHistory(rules);
  $('#mappingEditRuleName').value = '';
  rerenderMappingDraft(profileResult.created
    ? tf('mapping.status.addedRuleWithProfile', { name: ruleName, profile: profileResult.profileName, className })
    : tf('mapping.status.addedRule', { name: ruleName }));
}

function populateMappingModifyRules(options = {}) {
  const select = $('#mappingModifyRule');
  if (!select) {
    return;
  }

  const previous = options.selectedValue !== undefined ? options.selectedValue : select.value;
  const items = options.items ?? mappingModifyRuleItems(currentMappingRules());
  const ruleOptions = items.map(item => ({
    value: item.operationKey,
    label: `${item.collection.label}: ${ruleDisplayName(item.rule)}`,
    meta: mappingDeleteRuleMeta(item.rule, item.collection.type, currentMappingRules())
  }));

  setSelectOptions(select, ruleOptions.length > 0
    ? [
      {
        value: '',
        label: t('mapping.option.chooseRule'),
        status: 'invalid',
        meta: t('mapping.option.modifyStartsWithoutRuleMeta')
      },
      ...ruleOptions
    ]
    : [{ value: '', label: t('mapping.option.noRulesToModify'), disabled: true }], previous);
}

function populateMappingModifyFilterControls(options = {}) {
  const rules = currentMappingRules();
  const allItems = mappingModifyRuleItems(rules);
  const filters = normalizedMappingModifyFilters(mappingModifyFilterValues());
  if (options.autoSelect) {
    autoFillMappingModifyFilters(filters, allItems, options.changed);
  }

  const filteredItems = mappingModifyRuleItemsMatching(allItems, filters, rules);
  if (options.autoSelect && filteredItems.length === 1) {
    $('#mappingModifyRule').value = filteredItems[0].operationKey;
    populateMappingModifyRules({ items: filteredItems, selectedValue: filteredItems[0].operationKey });
    loadSelectedMappingRuleIntoEditor({ silent: true });
    refreshMappingEditorDependentControls();
    setMappingEditorStatus(tf('mapping.status.autoSelected', { name: ruleDisplayName(filteredItems[0].rule) }));
    return;
  }

  populateMappingModifyRules({ items: filteredItems, selectedValue: '' });
  populateMappingModifyClassFilter(filteredItems, filters.className);
  populateMappingModifyFieldFilter(filteredItems, filters.field, rules);
  populateMappingModifyStructureFilter(filteredItems, filters.type);
  populateMappingModifyTargetFilter(filteredItems, filters.targetValue, rules);
  updateMappingEditorSuggestedName();
  updateMappingEditorFormState();
}

function mappingModifyFilterValues() {
  return {
    className: $('#mappingEditClass')?.value ?? '',
    field: $('#mappingEditField')?.value ?? '',
    type: $('#mappingEditTargetType')?.value ?? '',
    targetValue: $('#mappingEditZabbixObject')?.value ?? ''
  };
}

function normalizedMappingModifyFilters(filters = {}) {
  return {
    className: filters.className ?? '',
    field: filters.field ?? '',
    type: filters.type ?? '',
    targetValue: filters.targetValue ?? ''
  };
}

function autoFillMappingModifyFilters(filters, allItems, changed) {
  const keys = ['className', 'field', 'type', 'targetValue'].filter(key => key !== changed);
  for (const key of keys) {
    if (filters[key]) {
      continue;
    }

    const candidates = mappingModifyRuleItemsMatching(allItems, filters, currentMappingRules());
    const values = uniqueMappingModifyFilterValues(candidates, key);
    if (values.length === 1) {
      filters[key] = values[0];
    }
  }
}

function uniqueMappingModifyFilterValues(items, key) {
  const values = new Map();
  for (const item of items) {
    const itemValues = {
      className: mappingModifyItemClasses(item),
      field: mappingModifyItemFields(item),
      type: [item.collection.type],
      targetValue: [mappingModifyItemTargetValue(item)]
    }[key] ?? [];
    for (const value of itemValues.filter(Boolean)) {
      values.set(normalizeToken(value), value);
    }
  }
  return [...values.values()];
}

function mappingModifyRuleItemsMatching(items, filters, rules) {
  return items.filter(item => mappingModifyRuleItemMatches(item, filters, rules));
}

function mappingModifyRuleItemMatches(item, filters, rules) {
  if (filters.className && !mappingModifyItemClasses(item, rules)
    .some(className => normalizeClassName(className) === normalizeClassName(filters.className))) {
    return false;
  }
  if (filters.field && !mappingModifyItemFields(item)
    .some(field => canonicalSourceField(field) === canonicalSourceField(filters.field))) {
    return false;
  }
  if (filters.type && item.collection.type !== filters.type) {
    return false;
  }
  if (filters.targetValue && mappingModifyItemTargetValue(item) !== filters.targetValue) {
    return false;
  }
  return true;
}

function mappingModifyItemClasses(item, rules = currentMappingRules()) {
  return mappingDeleteClassesForItem(item, rules)
    .filter(className => className !== '__any_class');
}

function mappingModifyItemFields(item) {
  return mappingDeleteSourceFieldsForItem(item.rule)
    .filter(field => !['className', 'eventType', 'zabbixHostId'].includes(canonicalSourceField(field)));
}

function mappingModifyItemTargetValue(item) {
  return JSON.stringify(mappingRuleTargetForForm(item));
}

function populateMappingModifyClassFilter(items, selectedValue) {
  const classes = uniqueTokens(items.flatMap(item => mappingModifyItemClasses(item)))
    .sort(compareText);
  const options = mappingModifyClassOptions(classes);
  setClassSelectOptions($('#mappingEditClass'), [
    { value: '', label: t('mapping.option.chooseClassFilter') },
    ...options
  ], selectedValue, state.mappingCmdbuildCatalog ?? {});
}

function mappingModifyClassOptions(classNames) {
  const allowed = new Set(classNames.map(normalizeClassName));
  const hierarchy = cmdbClassHierarchyFilteredSelectOptions(state.mappingCmdbuildCatalog ?? {}, allowed);
  const known = new Set(hierarchy.map(option => normalizeClassName(option.value)));
  const rulesOnly = classNames
    .filter(className => !known.has(normalizeClassName(className)))
    .map(className => ({
      value: className,
      label: `${className} / rules only`
    }));
  return [...hierarchy, ...rulesOnly];
}

function cmdbClassHierarchyFilteredSelectOptions(catalog = {}, allowed = new Set()) {
  const classes = (catalog.classes ?? []).filter(item => item?.name);
  if (classes.length === 0) {
    return [];
  }

  const byName = new Map(classes.map(item => [normalizeClassName(item.name), item]));
  const childrenByParent = cmdbChildrenByParent(catalog);
  const roots = classes
    .filter(item => {
      const parentName = cmdbParentClassName(item);
      return !parentName || !byName.has(parentName);
    })
    .sort(compareCmdbClasses);

  return roots.flatMap(item => cmdbClassHierarchyFilteredBranch(item, 0, childrenByParent, allowed));
}

function cmdbClassHierarchyFilteredBranch(item, depth, childrenByParent, allowed) {
  const children = childrenByParent.get(normalizeClassName(item.name)) ?? [];
  const childOptions = children.flatMap(child => cmdbClassHierarchyFilteredBranch(child, depth + 1, childrenByParent, allowed));
  const selfAllowed = allowed.has(normalizeClassName(item.name));
  if (!selfAllowed && childOptions.length === 0) {
    return [];
  }

  const superclass = isCmdbSuperclass(item, children);
  const displayName = catalogClassDisplayName(state.mappingCmdbuildCatalog ?? {}, item);
  const prefix = depth > 0 ? `${'  '.repeat(depth)}↳ ` : '';
  const option = {
    value: item.name,
    label: `${prefix}${displayName}${displayName !== item.name ? ` / ${item.name}` : ''}${superclass ? ' (superclass)' : ''}`,
    disabled: superclass || !selfAllowed,
    className: superclass || !selfAllowed ? 'mapping-class-option-super' : ''
  };
  return [option, ...childOptions];
}

function populateMappingModifyFieldFilter(items, selectedValue, rules) {
  const fields = uniqueTokens(items.flatMap(item => mappingModifyItemFields(item)))
    .sort(compareText);
  const options = fields.map(field => ({
    value: field,
    label: mappingDeleteSourceFieldLabel(rules, field),
    meta: mappingDeleteSourceFieldMeta(rules, field)
  }));
  setSelectOptions($('#mappingEditField'), [
    {
      value: '',
      label: t('mapping.option.chooseFieldFilter'),
      status: 'invalid'
    },
    ...options
  ], selectedValue);
}

function populateMappingModifyStructureFilter(items, selectedValue) {
  const types = uniqueTokens(items.map(item => item.collection.type))
    .sort(compareText);
  const options = types.map(type => ({
    value: type,
    label: mappingTargetTypeLabel(type)
  }));
  setSelectOptions($('#mappingEditTargetType'), [
    {
      value: '',
      label: t('mapping.option.chooseStructureFilter'),
      status: 'invalid'
    },
    ...options
  ], selectedValue);
}

function populateMappingModifyTargetFilter(items, selectedValue, rules) {
  const targets = new Map();
  for (const item of items) {
    const value = mappingModifyItemTargetValue(item);
    const label = mappingDeleteTargetsForItem(item, rules)[0]
      || ruleDisplayName(item.rule)
      || item.collection.label;
    if (!targets.has(value)) {
      targets.set(value, {
        value,
        label: `${mappingTargetTypeLabel(item.collection.type)}: ${label}`
      });
    }
  }

  setSelectOptions($('#mappingEditZabbixObject'), [
    {
      value: '',
      label: t('mapping.option.chooseTargetFilter'),
      status: 'invalid'
    },
    ...[...targets.values()].sort((left, right) => compareText(left.label, right.label))
  ], selectedValue);
}

function mappingModifyRuleItems(rules) {
  const editableTypes = new Set(mappingEditorEditableTargetTypes());
  return mappingDeleteRuleItems(rules)
    .filter(item => editableTypes.has(item.collection.type));
}

function mappingEditorEditableTargetTypes() {
  return [
    'hostGroups',
    'templates',
    'tags',
    'interfaceAddress',
    'interface',
    'monitoringSuppression',
    ...mappingEditorEditableExtensionDefinitions().map(definition => definition.rulesKey)
  ];
}

function selectedMappingModifyItem(rules = currentMappingRules()) {
  const operationKey = $('#mappingModifyRule')?.value ?? '';
  if (!operationKey) {
    return null;
  }
  return mappingModifyRuleItems(rules).find(item => item.operationKey === operationKey) ?? null;
}

function loadSelectedMappingRuleIntoEditor(options = {}) {
  const item = selectedMappingModifyItem();
  if (!item) {
    if (!options.silent) {
      setMappingEditorStatus(t('mapping.status.noModifyRule'), 'warning');
    }
    return;
  }

  const form = mappingRuleFormValues(item, currentMappingRules());
  $('#mappingEditTargetType').value = form.type;
  populateMappingEditorClasses();
  const classSelect = $('#mappingEditClass');
  const selectedClass = nearestConcreteClassOption(
    [...classSelect.options].map(option => ({
      value: option.value,
      disabled: option.disabled
    })),
    state.mappingCmdbuildCatalog ?? {},
    form.className
  );
  classSelect.value = selectedClass?.value || form.className;
  $('#mappingEditPriority').value = String(form.priority);
  $('#mappingEditRegex').value = form.regex;
  $('#mappingEditRuleName').value = form.ruleName;
  state.mappingModifyTargetValue = form.targetValue;
  if (form.field) {
    state.mappingModifyFieldValue = form.field;
  }
}

function mappingRuleFormValues(item, rules) {
  const className = ruleClassConditions(item.rule)[0] ?? '';
  const fields = mappingDeleteSourceFieldsForItem(item.rule)
    .filter(field => !['className', 'eventType', 'zabbixHostId'].includes(canonicalSourceField(field)));
  const field = item.rule.valueField || fields[0] || '';
  return {
    type: item.collection.type,
    className,
    field,
    regex: mappingRuleRegexForField(item.rule, field),
    priority: Number.isFinite(Number(item.rule.priority)) ? Number(item.rule.priority) : 100,
    ruleName: ruleDisplayName(item.rule),
    targetValue: JSON.stringify(mappingRuleTargetForForm(item))
  };
}

function mappingRuleRegexForField(rule, field) {
  const matchers = [
    ...(rule.when?.allRegex ?? []),
    ...(rule.when?.anyRegex ?? [])
  ];
  const selected = matchers.find(matcher => canonicalSourceField(matcher.field) === canonicalSourceField(field))
    ?? matchers.find(matcher => !['className', 'eventType', 'zabbixHostId'].includes(canonicalSourceField(matcher.field)));
  return selected?.pattern ?? '(?i).*';
}

function mappingRuleTargetForForm(item) {
  const rule = item.rule;
  const type = item.collection.type;
  if (type === 'hostGroups') {
    return rule.hostGroups?.[0] ?? {};
  }
  if (type === 'templates') {
    return rule.templates?.[0] ?? {};
  }
  if (type === 'tags') {
    return rule.tags?.[0] ?? {};
  }
  if (type === 'interfaceAddress') {
    return { mode: rule.mode ?? 'ip', valueField: rule.valueField ?? 'ipAddress' };
  }
  if (type === 'interface') {
    return { interfaceRef: rule.interfaceRef ?? 'agentInterface' };
  }
  if (type === 'monitoringSuppression') {
    return { reason: rule.reason ?? 'object_policy_do_not_monitor' };
  }

  return {
    proxies: rule.proxy,
    proxyGroups: rule.proxyGroup,
    hostMacros: rule.hostMacro,
    inventoryFields: rule.inventoryField,
    interfaceProfiles: { interfaceProfileRef: rule.interfaceProfileRef },
    hostStatuses: rule.hostStatus,
    maintenances: rule.maintenance,
    tlsPskModes: rule.tlsPskMode,
    valueMaps: rule.valueMap
  }[type] ?? {};
}

function modifyMappingConversionRule() {
  if (!state.mappingDraftRules) {
    setMappingEditorStatus(t('mapping.status.loadMappingFirst'));
    return;
  }

  const formState = mappingEditorFormValidation();
  if (!formState.canSave) {
    updateMappingEditorFormState();
    setMappingEditorStatus(formState.summary, 'warning');
    return;
  }

  const selected = selectedMappingModifyItem(state.mappingDraftRules);
  if (!selected) {
    setMappingEditorStatus(t('mapping.status.noModifyRule'), 'warning');
    return;
  }

  const rules = cloneJson(state.mappingDraftRules);
  const type = $('#mappingEditTargetType').value;
  const className = catalogClassRuleName(state.mappingCmdbuildCatalog ?? {}, $('#mappingEditClass').value);
  const field = $('#mappingEditField').value;
  const regex = $('#mappingEditRegex').value.trim();
  const priority = Number($('#mappingEditPriority').value || 100);
  const target = readMappingEditorTarget();
  if (!field) {
    setMappingEditorStatus(t('mapping.status.chooseCompatibleFieldModify'), 'warning');
    return;
  }

  if (!isMappingEditorFieldValidForClass(className, field)) {
    setMappingEditorStatus(tf('mapping.status.classFieldMissing', { className, field }));
    return;
  }

  const selectedFieldRule = rules.source?.fields?.[field] ?? state.mappingEditorFieldOptions?.get(field)?.fieldRule ?? {};
  if (!isMappingFieldAllowedForTarget(field, selectedFieldRule, type)) {
    setMappingEditorStatus(
      tf('mapping.status.multiValueScalarNotAllowed', { field, target: mappingTargetTypeLabel(type) }),
      'warning');
    return;
  }

  const ruleName = ($('#mappingEditRuleName').value.trim() || buildMappingRuleName(type, className, field, target)).trim();
  const rule = buildMappingEditorRule({ type, className, field, regex, priority, target, ruleName });
  ensureMappingEditorClass(rules, className);
  ensureMappingEditorSourceField(rules, field);
  const fieldRuleForProfile = rules.source?.fields?.[field] ?? selectedFieldRule;
  const profileResult = ensureMinimalHostProfileForClass(rules, className, field, fieldRuleForProfile, target);

  const newRulesKey = mappingRulesKey(type, target);
  if (selected.collection.key === newRulesKey && stableJson(selected.rule) === stableJson(rule) && !profileResult.created) {
    setMappingEditorStatus(t('mapping.status.noRuleChanges'), 'warning');
    updateMappingEditorFormState();
    return;
  }

  const oldRules = Array.isArray(rules[selected.collection.key]) ? rules[selected.collection.key] : [];
  if (selected.index < 0 || selected.index >= oldRules.length) {
    setMappingEditorStatus(t('mapping.status.modifyRuleMissing'), 'warning');
    return;
  }

  oldRules.splice(selected.index, 1);
  rules[newRulesKey] = Array.isArray(rules[newRulesKey]) ? rules[newRulesKey] : [];
  rules[newRulesKey].push(rule);
  pushMappingHistory(rules);
  rerenderMappingDraft(profileResult.created
    ? tf('mapping.status.modifiedRuleWithProfile', { name: ruleName, profile: profileResult.profileName, className })
    : tf('mapping.status.modifiedRule', { name: ruleName }));
}

function readMappingEditorTarget() {
  try {
    return JSON.parse($('#mappingEditZabbixObject').value);
  } catch {
    return {};
  }
}

function buildMappingEditorRule({ type, className, field, regex, priority, target, ruleName }) {
  const rule = {
    name: ruleName,
    priority,
    when: buildMappingEditorCondition(type, className, field, regex, target)
  };

  if (type === 'hostGroups') {
    rule.hostGroups = [{ name: target.name ?? '', groupid: target.groupid ?? '' }];
  } else if (type === 'templates') {
    rule.templates = [{ name: target.name ?? target.host ?? '', templateid: target.templateid ?? '' }];
  } else if (type === 'tags') {
    rule.tags = [{ tag: target.tag ?? 'cmdb.mapping', value: target.value ?? '' }];
  } else if (type === 'interfaceAddress') {
    rule.mode = target.mode ?? 'ip';
    rule.valueField = field || target.valueField || 'ipAddress';
  } else if (type === 'interface') {
    if (target.interfaceProfileRef) {
      rule.interfaceProfileRef = target.interfaceProfileRef;
    } else {
      rule.interfaceRef = target.interfaceRef ?? 'agentInterface';
    }
  } else if (type === 'monitoringSuppression') {
    rule.reason = target.reason ?? 'object_policy_do_not_monitor';
  } else {
    applyMappingEditorExtensionTarget(rule, type, target, field);
  }

  return rule;
}

function ensureMappingEditorClass(rules, className) {
  if (!className) {
    return;
  }

  rules.source ??= {};
  rules.source.entityClasses = Array.isArray(rules.source.entityClasses) ? rules.source.entityClasses : [];
  const canonicalName = catalogClassRuleName(state.mappingCmdbuildCatalog ?? {}, className);
  const existingIndex = rules.source.entityClasses.findIndex(item => normalizeClassName(item) === normalizeClassName(canonicalName));
  if (existingIndex >= 0) {
    rules.source.entityClasses[existingIndex] = canonicalName;
  } else {
    rules.source.entityClasses.push(canonicalName);
  }
  rules.source.entityClasses.sort(compareText);
}

function ensureMappingEditorSourceField(rules, field) {
  if (!field || rules.source?.fields?.[field]) {
    return;
  }

  rules.source ??= {};
  rules.source.fields ??= {};
  const generatedOption = state.mappingEditorFieldOptions?.get(field);
  if (generatedOption?.fieldRule) {
    rules.source.fields[field] = cloneJson(generatedOption.fieldRule);
    return;
  }

  const attribute = mappingEditorClassAttributes($('#mappingEditClass').value)
    .find(item => equalsIgnoreCase(item.name, field));
  rules.source.fields[field] = sourceFieldRuleForDirectAttribute(catalogClassRuleName(state.mappingCmdbuildCatalog ?? {}, $('#mappingEditClass').value), attribute, field);
}

function hostProfileFixFieldForClass(rules, cmdbuildCatalog, className) {
  const catalogClass = findCatalogClass(cmdbuildCatalog ?? {}, className);
  if (!catalogClass || isCmdbCatalogSuperclass(cmdbuildCatalog ?? {}, catalogClass)) {
    return null;
  }

  const attributes = catalogAttributesForClass(cmdbuildCatalog ?? {}, catalogClass);
  const candidates = addressCandidatesForClass(rules, attributes);
  if (candidates.length > 0) {
    const candidate = candidates[0];
    return {
      fieldKey: candidate.fieldKey,
      fieldRule: rules.source?.fields?.[candidate.fieldKey] ?? { source: candidate.fieldKey },
      mode: candidate.mode
    };
  }

  return null;
}

function mappingEditorCatalogFieldOptions(className, sourceFields) {
  if (!className) {
    return [];
  }

  const rootClass = catalogClassRuleName(state.mappingCmdbuildCatalog ?? {}, className);
  const options = [];
  for (const attribute of mappingEditorClassAttributes(className)) {
    if (!isReadableMappingAttribute(attribute)) {
      continue;
    }

    if (isReferenceAttribute(attribute)) {
      options.push(...referenceLeafFieldOptions(rootClass, attribute));
      continue;
    }

    const fieldKey = attribute.name;
    const fieldRule = sourceFieldRuleForDirectAttribute(rootClass, attribute, fieldKey);
    options.push({
      value: fieldKey,
      label: `${attribute.name}${attribute.type ? ` / ${attribute.type}` : ''}`,
      fieldRule
    });
  }

  options.push(...domainLeafFieldOptions(rootClass));

  return options
    .filter(option => !sourceFieldHasCatalogOption(sourceFields, option))
    .sort((left, right) => compareText(left.label, right.label));
}

function referenceLeafFieldOptions(rootClass, attribute, prefix = [], depth = 1, seen = new Set()) {
  const maxDepth = mappingTraversalMaxDepth();
  const targetClass = attribute.targetClass;
  if (!targetClass || depth > maxDepth) {
    return [];
  }

  const visitKey = `${targetClass}:${attribute.name}`;
  if (seen.has(visitKey)) {
    return [];
  }

  const nextSeen = new Set(seen);
  nextSeen.add(visitKey);
  const path = [...prefix, attribute];
  const options = [];
  for (const targetAttribute of mappingEditorClassAttributes(targetClass)) {
    if (!isReadableMappingAttribute(targetAttribute)) {
      continue;
    }

    if (isReferenceAttribute(targetAttribute)) {
      options.push(...referenceLeafFieldOptions(rootClass, targetAttribute, path, depth + 1, nextSeen));
      continue;
    }

    const leafPath = [...path, targetAttribute];
    const cmdbPath = [rootClass, ...leafPath.map(item => item.name)].join('.');
    const fieldKey = fieldKeyForCmdbPath(leafPath);
    const fieldRule = sourceFieldRuleForCmdbPath(cmdbPath, leafPath);
    options.push({
      value: fieldKey,
      label: `${leafPath.map(item => item.name).join(' -> ')}${targetAttribute.type ? ` / ${targetAttribute.type}` : ''}`,
      fieldRule
    });
  }

  return options;
}

function domainLeafFieldOptions(rootClass) {
  const options = [];
  for (const targetClass of domainTargetClassesForSourceClass(rootClass)) {
    for (const attribute of mappingEditorClassAttributes(targetClass)) {
      if (!isReadableMappingAttribute(attribute)) {
        continue;
      }

      if (isReferenceAttribute(attribute)) {
        options.push(...domainReferenceLeafFieldOptions(rootClass, targetClass, attribute));
        continue;
      }

      const leafPath = [attribute];
      const fieldRule = sourceFieldRuleForDomainPath(rootClass, targetClass, leafPath);
      options.push({
        value: fieldKeyForDomainPath(targetClass, leafPath),
        label: `domain ${catalogClassDisplayName(state.mappingCmdbuildCatalog ?? {}, targetClass)} -> ${attribute.name}${attribute.type ? ` / ${attribute.type}` : ''}`,
        fieldRule
      });
    }
  }

  return options;
}

function domainReferenceLeafFieldOptions(rootClass, domainTargetClass, attribute, prefix = [], depth = 1, seen = new Set()) {
  const maxDepth = mappingTraversalMaxDepth();
  const targetClass = attribute.targetClass;
  if (!targetClass || depth > maxDepth) {
    return [];
  }

  const visitKey = `${domainTargetClass}:${targetClass}:${attribute.name}`;
  if (seen.has(visitKey)) {
    return [];
  }

  const nextSeen = new Set(seen);
  nextSeen.add(visitKey);
  const path = [...prefix, attribute];
  const options = [];
  for (const targetAttribute of mappingEditorClassAttributes(targetClass)) {
    if (!isReadableMappingAttribute(targetAttribute)) {
      continue;
    }

    if (isReferenceAttribute(targetAttribute)) {
      options.push(...domainReferenceLeafFieldOptions(rootClass, domainTargetClass, targetAttribute, path, depth + 1, nextSeen));
      continue;
    }

    const leafPath = [...path, targetAttribute];
    const fieldRule = sourceFieldRuleForDomainPath(rootClass, domainTargetClass, leafPath);
    options.push({
      value: fieldKeyForDomainPath(domainTargetClass, leafPath),
      label: `domain ${catalogClassDisplayName(state.mappingCmdbuildCatalog ?? {}, domainTargetClass)} -> ${leafPath.map(item => item.name).join(' -> ')}${targetAttribute.type ? ` / ${targetAttribute.type}` : ''}`,
      fieldRule
    });
  }

  return options;
}

function domainTargetClassesForSourceClass(rootClass) {
  const catalog = state.mappingCmdbuildCatalog ?? {};
  const targets = new Map();
  for (const domain of catalog.domains ?? []) {
    const otherClass = cmdbDomainOtherClass(domain, rootClass);
    if (!otherClass) {
      continue;
    }

    const targetClass = catalogClassRuleName(catalog, otherClass);
    const catalogClass = findCatalogClass(catalog, targetClass);
    if (!catalogClass || isCmdbCatalogSuperclass(catalog, catalogClass)) {
      continue;
    }

    const key = normalizeClassName(targetClass);
    if (key && !targets.has(key)) {
      targets.set(key, targetClass);
    }
  }

  return [...targets.values()].sort(compareText);
}

function cmdbDomainOtherClass(domain, rootClass) {
  const sourceClass = cmdbDomainEndpointClass(domain, 'source');
  const destinationClass = cmdbDomainEndpointClass(domain, 'destination');
  if (equalsIgnoreCase(sourceClass, rootClass) && destinationClass) {
    return destinationClass;
  }
  if (equalsIgnoreCase(destinationClass, rootClass) && sourceClass) {
    return sourceClass;
  }

  return '';
}

function cmdbDomainEndpointClass(domain, side) {
  const isSource = side === 'source';
  const propertyNames = isSource
    ? ['source', 'sourceClass', 'sourceClassName', '_sourceClass', '_sourceType', 'sourceType', 'src', 'srcClass', 'srcType']
    : ['destination', 'destinationClass', 'destinationClassName', '_destinationClass', '_destinationType', 'destinationType', 'target', 'targetClass', 'targetClassName', '_targetClass', '_targetType', 'targetType', 'dst', 'dstClass', 'dstType'];
  for (const item of [domain, domain?.raw].filter(Boolean)) {
    for (const propertyName of propertyNames) {
      const value = cmdbDomainEndpointValue(item[propertyName]);
      if (value) {
        return value;
      }
    }
  }

  return '';
}

function cmdbDomainEndpointValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return cmdbDomainEndpointValue(value[0]);
  }
  if (typeof value === 'object') {
    for (const propertyName of ['name', '_id', 'id', 'className', 'class', 'type', '_type', 'description', '_description']) {
      const nestedValue = cmdbDomainEndpointValue(value[propertyName]);
      if (nestedValue) {
        return nestedValue;
      }
    }
  }

  return '';
}

function mappingTraversalMaxDepth(catalog = state.mappingCmdbuildCatalog) {
  return clampNumber(catalog?.maxTraversalDepth, 2, 2, 5);
}

function sourceFieldRuleForDirectAttribute(rootClass, attribute, fieldKey) {
  const rule = {
    source: attribute?.name ?? fieldKey,
    cmdbAttribute: attribute?.name ?? fieldKey,
    cmdbPath: attribute?.name ? `${rootClass}.${attribute.name}` : '',
    required: false
  };
  if (attribute?.type) {
    rule.type = attribute.type;
  }
  if (isLookupAttribute(attribute)) {
    rule.lookupType = attribute.lookupType ?? attribute.name;
    rule.resolve = {
      mode: 'lookup',
      lookupType: rule.lookupType,
      valueMode: 'code'
    };
  } else if (rule.cmdbPath) {
    rule.resolve = { mode: 'none' };
  }
  return rule;
}

function sourceFieldRuleForDomainPath(rootClass, targetClass, path) {
  const leaf = path[path.length - 1] ?? {};
  const cmdbPath = [rootClass, `{domain:${targetClass}}`, ...path.map(item => item.name)].join('.');
  const maxDepth = mappingTraversalMaxDepth();
  const rule = {
    source: 'id',
    cmdbAttribute: `{domain:${targetClass}}${path[0]?.name ? `.${path[0].name}` : ''}`,
    cmdbPath,
    type: leaf.type ?? '',
    required: false,
    resolve: {
      mode: 'cmdbPath',
      valueMode: isLookupAttribute(leaf) ? 'code' : 'leaf',
      collectionMode: 'join',
      collectionSeparator: '; ',
      maxDepth
    }
  };
  if (isLookupAttribute(leaf)) {
    rule.lookupType = leaf.lookupType ?? leaf.name;
    rule.resolve.leafType = 'lookup';
    rule.resolve.lookupType = rule.lookupType;
  }
  return rule;
}

function sourceFieldRuleForCmdbPath(cmdbPath, path) {
  const first = path[0];
  const leaf = path[path.length - 1];
  const maxDepth = mappingTraversalMaxDepth();
  const rule = {
    source: first.name,
    cmdbAttribute: first.name,
    cmdbPath,
    type: leaf.type ?? '',
    required: false,
    resolve: {
      mode: 'cmdbPath',
      valueMode: isLookupAttribute(leaf) ? 'code' : 'leaf',
      maxDepth
    }
  };
  if (isLookupAttribute(leaf)) {
    rule.lookupType = leaf.lookupType ?? leaf.name;
    rule.resolve.leafType = 'lookup';
    rule.resolve.lookupType = rule.lookupType;
  }
  return rule;
}

function fieldKeyForCmdbPath(path) {
  const text = path
    .map(item => item.name ?? '')
    .filter(Boolean)
    .map((item, index) => camelPathSegment(item, index === 0))
    .join('');
  return text || 'cmdbPathField';
}

function fieldKeyForDomainPath(targetClass, path) {
  const targetSegment = camelPathSegment(targetClass, false);
  const leafSegment = fieldKeyForCmdbPath(path);
  const normalizedLeaf = leafSegment.charAt(0).toUpperCase() + leafSegment.slice(1);
  return `domain${targetSegment}${normalizedLeaf}` || 'domainPathField';
}

function camelPathSegment(value, lowerFirst) {
  const text = String(value ?? '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return lowerFirst ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function sourceFieldHasCatalogOption(sourceFields, option) {
  if (sourceFields?.[option.value]) {
    return true;
  }

  const cmdbPath = option.fieldRule?.cmdbPath;
  if (cmdbPath) {
    return Object.values(sourceFields ?? {}).some(field => equalsIgnoreCase(field.cmdbPath, cmdbPath));
  }

  return sourceFieldHasCatalogAttribute(sourceFields, option.fieldRule?.cmdbAttribute ?? option.value);
}

function isMappingFieldAllowedForTarget(_fieldKey, fieldRule = {}, targetType = '') {
  if (!mappingTargetExpectsScalar(targetType)) {
    return true;
  }

  return !sourceFieldMayReturnMultiple(fieldRule);
}

function mappingTargetExpectsScalar(type) {
  return [
    'interfaceAddress',
    'interface',
    'proxies',
    'proxyGroups',
    'hostMacros',
    'inventoryFields',
    'interfaceProfiles',
    'hostStatuses',
    'tlsPskModes',
    'valueMaps'
  ].includes(type);
}

function mappingFieldTargetCompatibilityMessage(fieldKey, fieldRule = {}, targetType = '', target = {}) {
  const issue = interfaceAddressCompatibilityIssue(fieldKey, fieldRule, targetType, target);
  return issue ? tf(`mapping.status.${issue.code}`, issue.params) : '';
}

function mappingTargetTypeLabel(type) {
  const extension = zabbixExtensionDefinitions.find(definition => definition.rulesKey === type);
  return {
    hostGroups: t('mapping.target.hostGroups'),
    templates: t('mapping.target.templates'),
    tags: t('mapping.target.tags'),
    interfaceAddress: t('mapping.target.interfaceAddress'),
    interface: t('mapping.target.interface'),
    monitoringSuppression: t('mapping.target.monitoringSuppression')
  }[type] ?? extension?.title ?? type ?? 'target';
}

function isReadableMappingAttribute(attribute) {
  return attribute?.name
    && attribute.active !== false
    && attribute._can_read !== false
    && !equalsIgnoreCase(attribute.mode, 'syshidden')
    && !['IdClass', 'IdTenant'].some(name => equalsIgnoreCase(attribute.name, name));
}

function isReferenceAttribute(attribute) {
  return Boolean(attribute) && equalsIgnoreCase(attribute.type, 'reference');
}

function applyMappingEditorExtensionTarget(rule, type, target, field) {
  if (type === 'proxies') {
    rule.proxy = { name: target.name ?? '', proxyId: target.proxyId ?? '' };
  } else if (type === 'proxyGroups') {
    rule.proxyGroup = { name: target.name ?? '', proxy_groupid: target.proxy_groupid ?? '' };
  } else if (type === 'hostMacros') {
    rule.hostMacro = {
      macro: target.macro ?? '{$CMDB.VALUE}',
      value: target.value ?? '',
      valueTemplate: target.valueTemplate || `<#= Model.Source("${field}") #>`,
      description: target.description ?? '',
      type: Number(target.type ?? 0)
    };
  } else if (type === 'inventoryFields') {
    rule.inventoryField = {
      field: target.field ?? target.name ?? field,
      name: target.name ?? target.field ?? field,
      value: target.value ?? '',
      valueTemplate: target.valueTemplate || `<#= Model.Source("${field}") #>`
    };
  } else if (type === 'interfaceProfiles') {
    rule.interfaceProfileRef = target.interfaceProfileRef ?? target.name ?? '';
  } else if (type === 'hostStatuses') {
    rule.hostStatus = { status: Number(target.status ?? 0), name: target.name ?? '' };
  } else if (type === 'maintenances') {
    rule.maintenance = { name: target.name ?? '', maintenanceId: target.maintenanceId ?? '' };
  } else if (type === 'tlsPskModes') {
    rule.tlsPskMode = {
      name: target.name ?? '',
      tls_connect: Number(target.tls_connect ?? 1),
      tls_accept: Number(target.tls_accept ?? 1),
      tls_psk_identity: target.tls_psk_identity ?? '',
      tls_psk: target.tls_psk ?? ''
    };
  } else if (type === 'valueMaps') {
    rule.valueMap = { name: target.name ?? '', valueMapId: target.valueMapId ?? '' };
  }
}

function buildMappingEditorCondition(type, className, field, regex, target) {
  const allRegex = [];
  if (className) {
    allRegex.push({ field: 'className', pattern: `(?i)^${escapeRegex(className)}$` });
  }

  if (type === 'monitoringSuppression') {
    allRegex.push({ field: 'eventType', pattern: '(?i)^(create|update)$' });
    allRegex.push({
      field,
      pattern: regex || '(?i)^(do_not_monitor|dont_monitor|do not monitor|not_monitored|false|0)$'
    });
  } else if (regex) {
    allRegex.push({ field, pattern: regex });
  }

  const condition = {};
  if (allRegex.length > 0) {
    condition.allRegex = allRegex;
  }

  if (type === 'interfaceAddress') {
    condition.fieldExists = field || target.valueField || 'ipAddress';
  }

  return Object.keys(condition).length > 0 ? condition : { always: true };
}

function mappingRulesKey(type, target = {}) {
  if (type === 'interface' && target.interfaceProfileRef) {
    return 'interfaceProfileSelectionRules';
  }

  const extension = mappingEditorExtensionDefinition(type);
  if (extension) {
    return extension.selectionRulesKey;
  }

  return {
    hostGroups: 'groupSelectionRules',
    templates: 'templateSelectionRules',
    tags: 'tagSelectionRules',
    interfaceAddress: 'interfaceAddressRules',
    interface: 'interfaceSelectionRules',
    monitoringSuppression: 'monitoringSuppressionRules'
  }[type] ?? `${type}SelectionRules`;
}

function buildMappingRuleName(type, className, field, target) {
  const targetName = target.name
    || target.host
    || target.tag
    || target.macro
    || target.field
    || target.groupid
    || target.templateid
    || target.proxyId
    || target.proxy_groupid
    || target.maintenanceId
    || target.valueMapId
    || target.valueField
    || target.interfaceRef
    || target.interfaceProfileRef
    || 'target';
  return normalizeRuleName([type, className || 'any', field, targetName].join('-'));
}

function updateMappingEditorSuggestedName() {
  const input = $('#mappingEditRuleName');
  if (!input || input.value.trim()) {
    return;
  }

  input.placeholder = buildMappingRuleName(
    $('#mappingEditTargetType').value || 'rule',
    $('#mappingEditClass').value,
    $('#mappingEditField').value || 'field',
    readMappingEditorTarget());
}

async function saveMappingDraftAsFile() {
  if (!state.mappingDraftRules) {
    return;
  }

  const validation = validateMappingDraftBeforeSave(state.mappingDraftRules, state.mappingCmdbuildCatalog);
  const changes = mappingSessionChanges(initialMappingRules(), state.mappingDraftRules);
  if (validation.issues.length > 0) {
    setMappingEditorStatusForDraft(tf('mapping.status.saveIpDnsInconsistent', { count: sessionWebhookChangeCount(changes) }));
    const confirmed = window.confirm([
      t('mapping.confirm.saveIpDnsTitle'),
      '',
      ...validation.issues.slice(0, 12).map(issue => `- ${issue}`),
      validation.issues.length > 12 ? `- ${tf('mapping.confirm.saveIpDnsMore', { count: validation.issues.length - 12 })}` : '',
      '',
      t('mapping.confirm.saveAnyway')
    ].filter(Boolean).join('\n'));
    if (!confirmed) {
      setMappingEditorStatus(t('mapping.status.saveCancelledFixIpDns'));
      return;
    }
  }

  const defaultName = `${normalizeRuleName(state.mappingDraftRules.name || 'cmdbuild-to-zabbix-rules')}.json`;
  const content = `${JSON.stringify(state.mappingDraftRules, null, 2)}\n`;
  const webhookBodiesName = defaultName.replace(/\.json$/i, '-webhook-bodies.txt');
  const webhookBodies = buildWebhookBodiesFile(state.mappingDraftRules, state.mappingCmdbuildCatalog, validation, changes);
  setMappingEditorStatusForDraft(tf('mapping.status.saveReady', { count: sessionWebhookChangeCount(changes) }));

  const rulesResult = await saveTextAsFile(content, defaultName, 'JSON rules', { 'application/json': ['.json'] });
  if (rulesResult.cancelled) {
    setMappingEditorStatus(t('mapping.status.saveCancelled'));
    return;
  }

  const webhookResult = await saveTextAsFile(webhookBodies, webhookBodiesName, 'Webhook bodies', { 'text/plain': ['.txt'] });
  if (webhookResult.cancelled) {
    setMappingEditorStatus(tf('mapping.status.rulesFileSavedWebhookNotSaved', { name: rulesResult.name }));
    return;
  }

  const warningText = validation.issues.length > 0
    ? tf('mapping.status.saveWarnings', { count: validation.issues.length })
    : '';
  setMappingEditorStatus(tf('mapping.status.filesSaved', {
    rulesName: rulesResult.name,
    webhookName: webhookResult.name,
    warning: warningText
  }));
}

async function saveValidateMappingDraftAsFile() {
  const rules = state.validateMappingRules ?? state.currentRules?.content;
  if (!rules) {
    toast('Rules JSON is not loaded');
    return;
  }

  const validation = await api('/api/rules/validate', {
    method: 'POST',
    body: { content: rules }
  });
  $('#rulesResult').textContent = JSON.stringify({
    saved: false,
    note: 'Logical Control draft saved through the browser only. Publish the file to git outside the application, then reload rules on the microservice.',
    validation,
    content: rules
  }, null, 2);
  if (!validation.valid) {
    const confirmed = window.confirm('Rules JSON has validation errors. Save file anyway?');
    if (!confirmed) {
      return;
    }
  }

  const defaultName = `${normalizeRuleName(rules.name || 'cmdbuild-to-zabbix-rules')}.json`;
  const result = await saveTextAsFile(
    `${JSON.stringify(rules, null, 2)}\n`,
    defaultName,
    'JSON rules',
    { 'application/json': ['.json'] });
  if (!result.cancelled) {
    toast(tf('toast.rulesFileSaved', { name: result.name }));
  }
}

async function saveTextAsFile(content, defaultName, description, accept) {
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: defaultName,
        types: [{ description, accept }]
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return { name: handle.name, cancelled: false };
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { name: defaultName, cancelled: true };
    }
    throw error;
  }

  const requestedName = window.prompt(tf('common.saveFileNamePrompt', { description }), defaultName);
  if (requestedName === null) {
    return { name: defaultName, cancelled: true };
  }

  const name = requestedName || defaultName;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type: accept['application/json'] ? 'application/json' : 'text/plain' }));
  link.download = ensureFileExtension(name, defaultName);
  link.click();
  URL.revokeObjectURL(link.href);
  return { name: link.download, cancelled: false };
}

function ensureFileExtension(name, defaultName) {
  const extension = defaultName.match(/(\.[^.]+)$/)?.[1] ?? '';
  return extension && !name.toLowerCase().endsWith(extension.toLowerCase())
    ? `${name}${extension}`
    : name;
}

function initialMappingRules() {
  return state.mappingHistory?.[0] ?? state.currentRules?.content ?? {};
}

function mappingSessionChanges(initialRules = {}, currentRules = {}) {
  const initialClasses = new Set((initialRules.source?.entityClasses ?? []).map(normalizeClassName));
  const currentClasses = new Set((currentRules.source?.entityClasses ?? []).map(normalizeClassName));
  const initialSourceFields = new Set(Object.keys(initialRules.source?.fields ?? {}).map(normalizeToken));
  const currentSourceFields = new Set(Object.keys(currentRules.source?.fields ?? {}).map(normalizeToken));

  return {
    addedClasses: (currentRules.source?.entityClasses ?? [])
      .filter(className => !initialClasses.has(normalizeClassName(className))),
    removedClasses: (initialRules.source?.entityClasses ?? [])
      .filter(className => !currentClasses.has(normalizeClassName(className))),
    addedSourceFields: Object.keys(currentRules.source?.fields ?? {})
      .filter(fieldKey => !initialSourceFields.has(normalizeToken(fieldKey))),
    removedSourceFields: Object.keys(initialRules.source?.fields ?? {})
      .filter(fieldKey => !currentSourceFields.has(normalizeToken(fieldKey))),
    addedRules: diffRuleCollections(initialRules, currentRules, 'added'),
    removedRules: diffRuleCollections(currentRules, initialRules, 'removed')
  };
}

function diffRuleCollections(leftRules, rightRules, action) {
  return mappingRuleCollections().flatMap(collection => {
    const leftKeys = new Set((leftRules[collection.key] ?? []).map(ruleIdentity));
    return (rightRules[collection.key] ?? [])
      .filter(rule => !leftKeys.has(ruleIdentity(rule)))
      .map(rule => ({
        action,
        collection: collection.key,
        label: collection.label,
        type: collection.type,
        name: ruleDisplayName(rule),
        rule,
        classes: ruleClassConditions(rule)
      }));
  });
}

function mappingRuleCollections() {
  return [
    { key: 'eventRoutingRules', label: 'Event routing', type: 'eventRouting' },
    { key: 'hostProfiles', label: 'Host profiles', type: 'hostProfiles' },
    { key: 'groupSelectionRules', label: 'Group rules', type: 'hostGroups' },
    { key: 'templateSelectionRules', label: 'Template rules', type: 'templates' },
    { key: 'templateGroupSelectionRules', label: 'Template group rules', type: 'templateGroups' },
    { key: 'interfaceAddressRules', label: 'Interface address rules', type: 'interfaceAddress' },
    { key: 'interfaceSelectionRules', label: 'Interface rules', type: 'interface' },
    { key: 'tagSelectionRules', label: 'Tag rules', type: 'tags' },
    { key: 'monitoringSuppressionRules', label: 'Monitoring suppression rules', type: 'monitoringSuppression' },
    ...zabbixExtensionDefinitions.map(definition => ({
      key: definition.selectionRulesKey,
      label: `${definition.title} rules`,
      type: definition.rulesKey
    }))
  ];
}

function ruleIdentity(rule) {
  return normalizeRuleName(stableJson(rule));
}

function ruleDisplayName(rule) {
  return rule?.name
    || rule?.eventType
    || rule?.method
    || rule?.interfaceRef
    || rule?.interfaceProfileRef
    || ruleIdentity(rule).slice(0, 80)
    || 'rule';
}

function ruleValidationToken(rule, type) {
  return `rule-id:${normalizeToken(type)}:${stableTokenHash(stableJson(rule))}`;
}

function stableTokenHash(value) {
  let hash = 2166136261;
  const text = String(value ?? '');
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hasSessionWebhookChanges(changes) {
  return [
    changes.addedClasses,
    changes.removedClasses,
    changes.addedSourceFields,
    changes.removedSourceFields,
    changes.addedRules,
    changes.removedRules
  ].some(items => items.length > 0);
}

function sessionWebhookChangeCount(changes) {
  return [
    changes.addedClasses,
    changes.removedClasses,
    changes.addedSourceFields,
    changes.removedSourceFields,
    changes.addedRules,
    changes.removedRules
  ].reduce((total, items) => total + items.length, 0);
}

function monitoredClassNamesForRules(rules) {
  return uniqueTokens([
    ...(rules.source?.entityClasses ?? []),
    ...mappingRuleCollections().flatMap(collection => asArray(rules[collection.key]).flatMap(ruleClassConditions))
  ]);
}

function validateMappingDraftBeforeSave(rules, cmdbuildCatalog) {
  const issues = [];
  const expectedFields = (rules.zabbix?.expectedMonitoringFields ?? []).map(item => String(item).toLowerCase());
  const hasInterfaceUseIp = expectedFields.includes('interfaces[].useip');
  const hasInterfaceIp = expectedFields.includes('interfaces[].ip');
  const hasInterfaceDns = expectedFields.includes('interfaces[].dns');
  const addressRules = allInterfaceAddressRuleSources(rules);

  if (addressRules.length === 0) {
    issues.push('Не настроены interfaceAddressRules или hostProfiles[].interfaces: Zabbix host не получит обязательный interface address.');
  }
  if (!hasInterfaceUseIp) {
    issues.push('В zabbix.expectedMonitoringFields отсутствует interfaces[].useip.');
  }
  if (!hasInterfaceIp && !hasInterfaceDns) {
    issues.push('В zabbix.expectedMonitoringFields отсутствуют interfaces[].ip и interfaces[].dns.');
  }

  const createUpdateRoutes = (rules.eventRoutingRules ?? [])
    .filter(route => route.publish !== false)
    .filter(route => ['create', 'update'].includes(String(route.eventType ?? '').toLowerCase()));
  for (const route of createUpdateRoutes) {
    const required = route.requiredFields ?? [];
    if (!required.some(field => ['interfaceaddress', 'ipaddress', 'dnsname'].includes(normalizeToken(field)))) {
      issues.push(`Маршрут ${route.eventType} не требует interfaceAddress/ipAddress/dnsName в requiredFields.`);
    }
  }

  for (const className of monitoredClassNamesForRules(rules)) {
    const catalogClass = findCatalogClass(cmdbuildCatalog ?? {}, className);
    if (!catalogClass) {
      issues.push(`Класс ${className} отсутствует в CMDBuild catalog.`);
      continue;
    }
    if (isCmdbCatalogSuperclass(cmdbuildCatalog ?? {}, catalogClass)) {
      continue;
    }

    const displayName = catalogClassDisplayName(cmdbuildCatalog ?? {}, className);
    if (!classHasHostProfile(rules, className)) {
      issues.push(`Класс ${displayName}: нет hostProfiles[] с условием className для создания или обновления Zabbix host.`);
    }

    const attributes = catalogAttributesForClass(cmdbuildCatalog ?? {}, catalogClass);
    const candidates = addressCandidatesForClass(rules, attributes);
    if (candidates.length === 0) {
      issues.push(`Класс ${displayName}: нет class attribute field, связанного с interfaceAddressRules как IP или DNS.`);
      continue;
    }

    for (const candidate of candidates) {
      if (candidate.mode === 'ip' && (!hasInterfaceIp || !hasInterfaceUseIp)) {
        issues.push(`Класс ${displayName}: ${candidate.attribute.name} заявлен как IP, но Zabbix structure должна содержать interfaces[].ip и interfaces[].useip.`);
      }
      if (candidate.mode === 'dns' && (!hasInterfaceDns || !hasInterfaceUseIp)) {
        issues.push(`Класс ${displayName}: ${candidate.attribute.name} заявлен как DNS, но Zabbix structure должна содержать interfaces[].dns и interfaces[].useip.`);
      }
    }
  }

  issues.push(...scalarDomainMappingIssues(rules));

  return { issues };
}

function scalarDomainMappingIssues(rules) {
  const issues = [];
  const sourceFields = rules.source?.fields ?? {};
  for (const collection of mappingRuleCollections()) {
    if (!mappingTargetExpectsScalar(collection.type)) {
      continue;
    }

    for (const rule of asArray(rules[collection.key])) {
      for (const fieldKey of sourceFieldsForRule(rule)) {
        const [actualKey, fieldRule] = sourceFieldRuleByCanonicalKey(sourceFields, fieldKey);
        if (sourceFieldMayReturnMultiple(fieldRule)) {
          issues.push(`Скалярная Zabbix structure ${mappingTargetTypeLabel(collection.type)} в rule "${rule.name ?? collection.label}" использует multi-value domain field "${actualKey}" (${fieldRule.cmdbPath}).`);
        }
      }
    }
  }

  return issues;
}

function sourceFieldRuleByCanonicalKey(sourceFields, fieldKey) {
  const canonical = canonicalSourceField(fieldKey);
  for (const [key, field] of Object.entries(sourceFields ?? {})) {
    const tokens = [key, canonicalSourceField(key), ...sourceFieldSources(field), ...sourceFieldCatalogSources(field)]
      .map(canonicalSourceField);
    if (tokens.includes(canonical)) {
      return [key, field];
    }
  }

  return [fieldKey, {}];
}

function addressCandidatesForClass(rules, attributes) {
  return allInterfaceAddressRuleSources(rules).flatMap(rule => {
    const fieldKey = rule.valueField || rule.mode;
    if (!fieldKey) {
      return [];
    }

    const mode = interfaceAddressMode(rule, fieldKey);
    if (!['ip', 'dns'].includes(mode)) {
      return [];
    }

    const fieldRule = rules.source?.fields?.[fieldKey] ?? { source: fieldKey };
    const attribute = findCatalogAttributeForField(attributes, fieldRule, fieldKey);
    return attribute ? [{ mode, fieldKey, attribute, rule }] : [];
  });
}

function allInterfaceAddressRuleSources(rules) {
  return [
    ...(rules.interfaceAddressRules ?? []),
    ...(rules.hostProfiles ?? []).flatMap(profile => {
      const profileLevel = profile.valueField || profile.mode
        ? [{
          name: `${profile.name || 'profile'} address`,
          mode: profile.mode,
          valueField: profile.valueField
        }]
        : [];
      const interfaceLevel = (profile.interfaces ?? []).map(item => ({
        name: `${profile.name || 'profile'} / ${item.name || 'interface'}`,
        mode: item.mode || profile.mode,
        valueField: item.valueField || profile.valueField
      }));
      return [...profileLevel, ...interfaceLevel];
    })
  ].filter(rule => rule.valueField || rule.mode);
}

function interfaceAddressMode(rule, fieldKey) {
  const mode = String(rule.mode ?? '').toLowerCase();
  if (mode === 'ip' || mode === 'dns') {
    return mode;
  }

  return canonicalSourceField(fieldKey) === 'dnsName' ? 'dns' : 'ip';
}

function buildWebhookBodiesFile(rules, cmdbuildCatalog, validation, changes) {
  const lines = [
    '# CMDBuild webhook Body snippets',
    '#',
    '# Назначение: заготовки Body для webhook-записей CMDBuild, которые отправляют события в cmdbwebhooks2kafka.',
    '# Файл формируется только по добавленным и удаленным в текущей UI-сессии правилам.',
    '# Authorization: Bearer <token> нужно взять и согласовать с настройками микросервиса, если это первая настройка.',
    '# Если рядом уже есть рабочие webhook-записи, можно взять из них блок Authorization и использовать тот же подход.',
    '# Method в CMDBuild выбирайте POST. Он должен совпадать с HTTP-интерфейсом микросервиса: POST /webhooks/cmdbuild.',
    '# Dev URL сейчас обычно: http://192.168.202.100:5080/webhooks/cmdbuild. Для другого окружения замените URL.',
    '# Content-Type вручную лучше не добавлять в headers CMDBuild: CMDBuild сам выставляет его для JSON body.',
    '#',
    validation.issues.length > 0
      ? `# Save validation warnings: ${validation.issues.length}. Перед применением проверьте IP/DNS -> Zabbix interface binding.`
      : '# Save validation: критичных предупреждений по IP/DNS -> Zabbix interface binding нет.',
    ''
  ];

  if (!hasSessionWebhookChanges(changes)) {
    lines.push(
      '# В текущей сессии нет добавленных или удаленных rules/class attribute fields/classes.',
      '# Body snippets не сформированы, чтобы не смешивать текущие настройки с неизмененными webhook-записями.',
      ''
    );
    return `${lines.join('\n')}\n`;
  }

  const events = webhookEventsForRules(rules);
  const emitted = new Set();
  appendAddedClassWebhookBodies(lines, rules, cmdbuildCatalog, changes, events, emitted);
  appendRemovedClassWebhookInstructions(lines, changes, events, emitted);
  appendSourceFieldWebhookChanges(lines, rules, cmdbuildCatalog, changes, events, emitted);
  appendRuleWebhookChanges(lines, rules, cmdbuildCatalog, changes, events, emitted);

  return `${lines.join('\n')}\n`;
}

function appendAddedClassWebhookBodies(lines, rules, cmdbuildCatalog, changes, events, emitted) {
  for (const className of changes.addedClasses) {
    appendWebhookBodiesForClass(lines, rules, cmdbuildCatalog, className, events, 'ADD class rule', emitted);
  }
}

function appendRemovedClassWebhookInstructions(lines, changes, events, emitted) {
  for (const className of changes.removedClasses) {
    appendWebhookDeleteInstructions(lines, className, events, 'DELETE class rule', emitted);
  }
}

function appendSourceFieldWebhookChanges(lines, rules, cmdbuildCatalog, changes, events, emitted) {
  for (const fieldKey of changes.addedSourceFields) {
    const classes = classesForSourceField(rules, cmdbuildCatalog, fieldKey);
    if (classes.length === 0) {
      lines.push(
        `## ADD class attribute field / ${fieldKey}`,
        '# Action: CHECK',
        '# Для этого поля не найдено классов с соответствующим CMDBuild attribute. Webhook Body не сформирован.',
        ''
      );
      continue;
    }

    for (const className of classes) {
      appendWebhookBodiesForClass(lines, rules, cmdbuildCatalog, className, events, `ADD class attribute field ${fieldKey}`, emitted);
    }
  }

  for (const fieldKey of changes.removedSourceFields) {
    lines.push(
      `## DELETE class attribute field / ${fieldKey}`,
      '# Action: DELETE field from CMDBuild webhook Body',
      '# Удалите это поле из Body соседних webhook-записей, если оно больше не используется rules.',
      `# Field key: ${fieldKey}`,
      ''
    );
  }
}

function appendRuleWebhookChanges(lines, rules, cmdbuildCatalog, changes, events, emitted) {
  for (const change of changes.addedRules) {
    const classes = classesForRuleChange(change, rules, cmdbuildCatalog);
    const scopedEvents = webhookEventsForRuleChange(change, events);
    lines.push(
      `## ADD rule / ${change.label} / ${change.name}`,
      `# Rule collection: ${change.collection}`,
      classes.length > 0
        ? `# Affected class rules: ${classes.join(', ')}`
        : '# Affected class rules: не определены по className regex; отдельный Body не сформирован.',
      ''
    );
    for (const className of classes) {
      appendWebhookBodiesForClass(lines, rules, cmdbuildCatalog, className, scopedEvents, `ADD rule ${change.name}`, emitted);
    }
  }

  for (const change of changes.removedRules) {
    const classes = classesForRuleChange(change, rules, cmdbuildCatalog);
    const scopedEvents = webhookEventsForRuleChange(change, events);
    lines.push(
      `## DELETE rule / ${change.label} / ${change.name}`,
      '# Action: DELETE/disable related rule handling',
      `# Rule collection: ${change.collection}`,
      classes.length > 0
        ? `# Affected class rules: ${classes.join(', ')}`
        : '# Affected class rules: не определены по className regex.',
      '# Если это правило было единственной причиной webhook-записи, удалите/отключите соответствующую запись CMDBuild.',
      ''
    );
    for (const className of classes) {
      appendWebhookDeleteInstructions(lines, className, scopedEvents, `DELETE rule ${change.name}`, emitted);
    }
  }
}

function appendWebhookBodiesForClass(lines, rules, cmdbuildCatalog, className, events, actionLabel, emitted) {
  const classItem = webhookClassItem(className, cmdbuildCatalog);
  if (!classItem) {
    lines.push(
      `## ${actionLabel} / ${className}`,
      '# Action: CHECK',
      '# Класс не найден или является superclass/prototype; Body не сформирован.',
      ''
    );
    return;
  }

  for (const event of events) {
    const emitKey = `add|${normalizeClassName(classItem.name)}|${normalizeToken(event.eventType)}`;
    if (emitted.has(emitKey)) {
      continue;
    }
    emitted.add(emitKey);

    const body = webhookBodyForClassEvent(rules, cmdbuildCatalog, classItem.name, event);
    const pathComments = webhookBodyPathComments(rules, cmdbuildCatalog, classItem.name);
    lines.push(
      `## ${actionLabel} / ${classItem.name} / ${event.eventType}`,
      '# Action: ADD or UPDATE CMDBuild webhook Body',
      '# Method: POST',
      '# URL: http://192.168.202.100:5080/webhooks/cmdbuild',
      '# Headers: Authorization: Bearer <token>',
      ...pathComments,
      JSON.stringify(body, null, 2),
      ''
    );
  }
}

function appendWebhookDeleteInstructions(lines, className, events, actionLabel, emitted) {
  const normalizedEvents = events.length > 0 ? events : webhookEventsForRules({});
  const visibleEvents = normalizedEvents.filter(event => {
    const emitKey = `delete|${normalizeClassName(className)}|${normalizeToken(event.eventType)}`;
    if (emitted.has(emitKey)) {
      return false;
    }
    emitted.add(emitKey);
    return true;
  });

  if (visibleEvents.length === 0) {
    return;
  }

  lines.push(
    `## ${actionLabel} / ${className}`,
    '# Action: DELETE or disable CMDBuild webhook records.',
    '# Body для удаления не нужен. Удалите/отключите webhook-записи со следующими событиями:',
    ...visibleEvents.map(event => `# - ${event.eventType}: ${event.cmdbuildEvent}`),
    '# Method у удаляемых записей: POST',
    '# URL у удаляемых записей: http://192.168.202.100:5080/webhooks/cmdbuild',
    ''
  );
}

function webhookClassItem(className, cmdbuildCatalog) {
  const classItem = findCatalogClass(cmdbuildCatalog ?? {}, className) ?? { name: className };
  return classItem?.name && !isCmdbCatalogSuperclass(cmdbuildCatalog ?? {}, classItem)
    ? classItem
    : null;
}

function classesForSourceField(rules, cmdbuildCatalog, fieldKey) {
  const field = rules.source?.fields?.[fieldKey] ?? { source: fieldKey };

  return (rules.source?.entityClasses ?? [])
    .map(className => webhookClassItem(className, cmdbuildCatalog))
    .filter(item => item?.name)
    .filter(item => findCatalogAttributeForField(catalogAttributesForClass(cmdbuildCatalog ?? {}, item), field, fieldKey))
    .map(item => item.name);
}

function classesForRuleChange(change, rules, cmdbuildCatalog) {
  const explicitClasses = uniqueTokens((change.classes ?? [])
    .filter(className => webhookClassItem(className, cmdbuildCatalog))
    .map(className => webhookClassItem(className, cmdbuildCatalog).name));
  if (explicitClasses.length > 0) {
    return explicitClasses;
  }

  if (change.collection === 'eventRoutingRules' || change.rule?.when?.always) {
    return allWebhookClasses(rules, cmdbuildCatalog);
  }

  const sourceFieldClasses = sourceFieldsForRule(change.rule)
    .flatMap(fieldKey => classesForSourceField(rules, cmdbuildCatalog, fieldKey));
  return uniqueTokens(sourceFieldClasses);
}

function allWebhookClasses(rules, cmdbuildCatalog) {
  return uniqueTokens((rules.source?.entityClasses ?? [])
    .map(className => webhookClassItem(className, cmdbuildCatalog))
    .filter(item => item?.name)
    .map(item => item.name));
}

function sourceFieldsForRule(rule = {}) {
  const when = rule.when ?? {};
  const fields = [
    ...(when.anyRegex ?? []).map(matcher => matcher.field),
    ...(when.allRegex ?? []).map(matcher => matcher.field),
    when.fieldExists,
    ...(Array.isArray(when.fieldsExist) ? when.fieldsExist : []),
    rule.valueField
  ].filter(Boolean);

  const serialized = JSON.stringify(rule);
  for (const match of serialized.matchAll(/Model\.Source\(["']([^"']+)["']\)/g)) {
    fields.push(match[1]);
  }
  for (const match of serialized.matchAll(/Model\.([A-Za-z0-9_]+)/g)) {
    if (match[1] !== 'Source') {
      fields.push(match[1]);
    }
  }

  return uniqueTokens(fields.map(canonicalSourceField));
}

function webhookEventsForRuleChange(change, events) {
  const eventType = String(change.rule?.eventType ?? '').trim();
  if (!eventType) {
    return events;
  }

  return [{
    eventType,
    cmdbuildEvent: cmdbuildWebhookEventName(eventType)
  }];
}

function webhookEventsForRules(rules) {
  const routes = (rules.eventRoutingRules ?? [])
    .filter(route => route.publish !== false)
    .map(route => String(route.eventType ?? '').trim())
    .filter(Boolean);
  const supported = rules.source?.supportedEvents ?? [];
  return uniqueTokens(routes.length > 0 ? routes : supported.length > 0 ? supported : ['create', 'update', 'delete'])
    .map(eventType => ({
      eventType,
      cmdbuildEvent: cmdbuildWebhookEventName(eventType)
    }));
}

function cmdbuildWebhookEventName(eventType) {
  return {
    create: 'card_create_after',
    update: 'card_update_after',
    delete: 'card_delete_after'
  }[String(eventType).toLowerCase()] ?? `card_${eventType}_after`;
}

function webhookBodyForClassEvent(rules, cmdbuildCatalog, className, event) {
  const catalogClass = findCatalogClass(cmdbuildCatalog ?? {}, className);
  const attributes = catalogAttributesForClass(cmdbuildCatalog ?? {}, catalogClass ?? className);
  const usedFields = webhookSourceFieldsForClass(rules, className);
  const body = {
    source: 'cmdbuild',
    eventType: event.eventType,
    cmdbuildEvent: event.cmdbuildEvent,
    className
  };

  for (const [fieldKey, field] of Object.entries(rules.source?.fields ?? {})) {
    const bodyKey = webhookBodyKeyForField(fieldKey, field);
    if (!bodyKey || webhookBodyHasField(body, fieldKey, field)) {
      continue;
    }
    if (!webhookSourceFieldIsUsed(usedFields, fieldKey) && !field.required) {
      continue;
    }
    if (field.cmdbPath && !cmdbPathRootAppliesToClass(field.cmdbPath, className, cmdbuildCatalog, rules)) {
      continue;
    }

    const value = webhookBodyValueForField(className, event, attributes, fieldKey, field);
    if (value !== undefined) {
      body[bodyKey] = value;
    }
  }

  return body;
}

function webhookBodyPathComments(rules, cmdbuildCatalog, className) {
  const catalogClass = findCatalogClass(cmdbuildCatalog ?? {}, className);
  const attributes = catalogAttributesForClass(cmdbuildCatalog ?? {}, catalogClass ?? className);
  const usedFields = webhookSourceFieldsForClass(rules, className);
  const comments = [];
  for (const [fieldKey, field] of Object.entries(rules.source?.fields ?? {})) {
    const isDomainPath = cmdbPathIncludesDomain(field.cmdbPath);
    if (!field.cmdbPath
      || (!webhookSourceFieldIsUsed(usedFields, fieldKey) && !field.required)
      || !cmdbPathRootAppliesToClass(field.cmdbPath, className, cmdbuildCatalog, rules)
      || (!isDomainPath && !findCatalogAttributeForField(attributes, field, fieldKey))) {
      continue;
    }

    const bodyKey = webhookBodyKeyForField(fieldKey, field);
    if (!bodyKey) {
      continue;
    }

    const mode = field.resolve?.mode && field.resolve.mode !== 'none'
      ? `, resolve=${field.resolve.mode}${field.resolve.leafType ? `/${field.resolve.leafType}` : ''}`
      : '';
    if (isDomainPath) {
      comments.push(`# Domain path metadata: ${fieldKey} uses "${bodyKey}" -> ${field.cmdbPath}${mode}. Payload stays flat; CMDBuild sends the current card id, converter reads related cards through /relations.`);
    } else {
      comments.push(`# Path metadata: ${bodyKey} -> ${field.cmdbPath}${mode}. Payload stays flat; CMDBuild sends the numeric id/value in "${bodyKey}".`);
    }
  }
  return comments.length > 0 ? comments : ['# Path metadata: no CMDB path fields for this class.'];
}

function webhookBodyKeyForField(fieldKey, field) {
  if (canonicalSourceField(fieldKey) === 'eventType') {
    return 'eventType';
  }
  if (canonicalSourceField(fieldKey) === 'className') {
    return 'className';
  }

  return sourceFieldSources(field)[0] || fieldKey;
}

function webhookBodyValueForField(className, event, attributes, fieldKey, field) {
  const canonical = canonicalSourceField(fieldKey);
  if (canonical === 'eventType') {
    return event.eventType;
  }
  if (canonical === 'className') {
    return className;
  }

  const attribute = findCatalogAttributeForField(attributes, field, fieldKey);
  if (attribute) {
    return `{{${attribute.name}}}`;
  }
  if (canonical === 'entityId') {
    return '{{Id}}';
  }

  return undefined;
}

function setMappingEditorStatus(message, status = 'normal') {
  const node = $('#mappingEditorStatus');
  if (node && message) {
    node.textContent = message;
    node.classList.toggle('is-warning', status === 'warning');
  }
}

function setMappingEditorStatusForDraft(message) {
  const status = mappingDraftValidationStatus(message);
  setMappingEditorStatus(status.message, status.level);
}

function mappingDraftValidationStatus(message) {
  if (!state.mappingDraftRules || !state.mappingCmdbuildCatalog) {
    return { message, level: 'normal' };
  }

  const validation = validateMappingDraftBeforeSave(state.mappingDraftRules, state.mappingCmdbuildCatalog);
  if (validation.issues.length === 0) {
    return {
      message: `${message} Проверка IP/DNS: обязательные привязки для Zabbix interface есть.`,
      level: 'normal'
    };
  }

  const selectedClass = $('#mappingEditClass')?.value ?? '';
  const selectedToken = normalizeClassName(selectedClass);
  const selectedIssues = selectedToken
    ? validation.issues.filter(issue => mappingIssueMentionsClass(issue, selectedToken))
    : [];
  if (selectedToken && selectedIssues.length === 0) {
    return {
      message: `${message} Проверка IP/DNS: по выбранному классу предупреждений нет. Всего предупреждений в rules: ${validation.issues.length}.`,
      level: 'normal'
    };
  }

  const issues = selectedIssues.length > 0
    ? selectedIssues
    : prioritizedMappingValidationIssues(validation.issues, selectedClass);
  const visibleIssues = issues.slice(0, 4).join(' ');
  const extra = issues.length > 4
    ? ` Еще предупреждений: ${issues.length - 4}.`
    : '';
  const scope = selectedIssues.length > 0
    ? `по выбранному классу: ${selectedIssues.length}; всего в rules: ${validation.issues.length}`
    : `${validation.issues.length}`;
  return {
    message: `${message} Предупреждения save validation: ${scope}. ${visibleIssues}${extra}`,
    level: 'warning'
  };
}

function prioritizedMappingValidationIssues(issues, selectedClass) {
  if (!selectedClass) {
    return issues;
  }

  const selectedToken = normalizeClassName(selectedClass);
  return [...issues].sort((left, right) => Number(!mappingIssueMentionsClass(left, selectedToken)) - Number(!mappingIssueMentionsClass(right, selectedToken)));
}

function mappingIssueMentionsClass(issue, classToken) {
  return Boolean(classToken) && normalizeToken(issue).includes(classToken);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), undefined, { sensitivity: 'base' });
}

async function loadValidateMapping() {
  const [rulesDocument, zabbixCatalog, cmdbuildCatalog] = await Promise.all([
    api('/api/rules/current'),
    api('/api/zabbix/catalog'),
    api('/api/cmdbuild/catalog')
  ]);

  state.currentRules = rulesDocument;
  state.currentRules.content = cloneJson(rulesDocument.content ?? {});
  initializeValidateMappingHistory(state.currentRules.content);
  state.validateMappingZabbixCatalog = zabbixCatalog;
  state.validateMappingCmdbuildCatalog = cmdbuildCatalog;
  renderValidateMapping(state.validateMappingRules, zabbixCatalog, cmdbuildCatalog);
  state.validateMappingLoaded = true;
}

function renderValidateMapping(rules, zabbixCatalog, cmdbuildCatalog) {
  const validation = buildRulesMappingValidation(rules, zabbixCatalog, cmdbuildCatalog);
  renderValidationSummary($('#validateMappingSummary'), validation);
  renderValidateMappingZabbix($('#validateMappingZabbix'), rules, zabbixCatalog, validation);
  renderValidateMappingRules($('#validateMappingRules'), rules, cmdbuildCatalog, validation);
  renderValidateMappingCmdbuild($('#validateMappingCmdbuild'), rules, cmdbuildCatalog, validation);
  updateValidationSelectionControls();
}

function renderValidationSummary(container, validation) {
  clear(container);
  const errors = validation.issues.filter(issue => issue.severity === 'error');
  const warnings = validation.issues.filter(issue => issue.severity === 'warning');
  const header = el('div', 'validation-summary-line', errors.length === 0
    ? 'Критичные расхождения не найдены.'
    : `Найдено ошибок: ${errors.length}`);
  const details = el('div', 'validation-summary-detail', errors.length === 0
    ? `Предупреждения: ${warnings.length}. По текущим каталогам нет объектов для выбора и исправления.`
    : `Предупреждения: ${warnings.length}. Красным отмечаются отсутствующие сущности и rules, которые на них ссылаются; их можно выбрать чекбоксами в соответствующей колонке.`);
  container.append(header, details);
  setHelp(container, 'Сводка проверки правил. Красная подсветка показывает отсутствующие сущности Zabbix/CMDBuild и затронутые conversion rules.');

  if (validation.issues.length === 0) {
    return;
  }

  const list = el('ul', 'validation-issues', '');
  for (const issue of validation.issues) {
    const item = el('li', `validation-issue validation-issue-${issue.severity}`, issue.message);
    setHelp(item, issue.help ?? issue.message);
    list.append(item);
  }
  container.append(list);
}

function renderValidateMappingZabbix(container, rules, catalog, validation) {
  clear(container);
  const hostGroups = referencedHostGroups(rules);
  const templates = referencedTemplates(rules);
  const templateGroups = referencedTemplateGroups(rules);
  const tags = referencedTags(rules);

  appendValidationSection(container, 'Host groups', hostGroups.map(group => {
    const tokens = zabbixItemTokens(rules, 'hostGroups', group.groupid, group.name);
    const exists = zabbixCatalogItemExists(catalog.hostGroups ?? [], 'groupid', group.groupid, group.name);
    const node = mappingNode({
      label: group.name || group.groupid,
      meta: exists ? `groupid ${group.groupid}` : `нет в Zabbix: groupid ${group.groupid || '-'}`,
      tokens,
      level: 1,
      kind: 'zabbix',
      status: exists ? 'normal' : 'error',
      help: exists
        ? 'Host group найдена в каталоге Zabbix и может использоваться в правилах.'
        : 'Host group указана в правилах, но отсутствует в каталоге Zabbix. Такой объект нужно создать или исправить правило.'
    });
    return exists ? node : validationFixNode(node, {
      scope: 'zabbix',
      kind: 'hostGroup',
      id: group.groupid ?? '',
      name: group.name ?? ''
    });
  }));

  appendValidationSection(container, 'Templates', templates.map(template => {
    const tokens = zabbixItemTokens(rules, 'templates', template.templateid, template.name || template.host);
    const exists = zabbixCatalogItemExists(catalog.templates ?? [], 'templateid', template.templateid, template.name || template.host);
    const node = mappingNode({
      label: template.name || template.host || template.templateid,
      meta: exists ? `templateid ${template.templateid}` : `нет в Zabbix: templateid ${template.templateid || '-'}`,
      tokens,
      level: 1,
      kind: 'zabbix',
      status: exists ? 'normal' : 'error',
      help: exists
        ? 'Template найдена в каталоге Zabbix и может назначаться хосту.'
        : 'Template указана в правилах, но отсутствует в каталоге Zabbix. Такой шаблон нужно создать или исправить правило.'
    });
    return exists ? node : validationFixNode(node, {
      scope: 'zabbix',
      kind: 'template',
      id: template.templateid ?? '',
      name: template.name ?? template.host ?? ''
    });
  }));

  appendValidationSection(container, 'Template groups', templateGroups.map(group => {
    const tokens = zabbixItemTokens(rules, 'templateGroups', group.groupid, group.name);
    const exists = zabbixCatalogItemExists(catalog.templateGroups ?? [], 'groupid', group.groupid, group.name);
    const node = mappingNode({
      label: group.name || group.groupid,
      meta: exists ? `groupid ${group.groupid}` : `нет в Zabbix: groupid ${group.groupid || '-'}`,
      tokens,
      level: 1,
      kind: 'zabbix',
      status: exists ? 'normal' : 'error',
      help: exists
        ? 'Template group найдена в каталоге Zabbix.'
        : 'Template group указана в правилах, но отсутствует в каталоге Zabbix.'
    });
    return exists ? node : validationFixNode(node, {
      scope: 'zabbix',
      kind: 'templateGroup',
      id: group.groupid ?? '',
      name: group.name ?? ''
    });
  }));

  appendValidationSection(container, 'Tags', tags.map(tag => {
    const tokens = zabbixItemTokens(rules, 'tags', tag.tag, tag.value ?? tag.valueTemplate);
    return mappingNode({
      label: tag.tag,
      meta: tag.value ?? tag.valueTemplate ?? 'dynamic',
      tokens,
      level: 1,
      kind: 'zabbix',
      status: 'normal',
      help: 'Zabbix tag передается в host.create или host.update. Отсутствие такого tag в каталоге не считается ошибкой, потому что tags создаются на хосте.'
    });
  }));

  for (const definition of zabbixExtensionDefinitions) {
    const items = referencedZabbixExtensionItems(rules, definition);
    if (items.length === 0) {
      continue;
    }

    appendValidationSection(container, definition.title, items.map(item => {
      const exists = definition.requiresCatalog === false
        || zabbixExtensionItemExists(catalog[definition.catalogKey] ?? [], definition, item);
      return mappingNode({
        label: definition.label(item),
        meta: exists ? definition.meta(item) : `нет в Zabbix: ${definition.meta(item)}`,
        tokens: zabbixExtensionItemMappingTokens(definition, item, rules),
        level: 1,
        kind: 'zabbix',
        status: exists ? 'normal' : 'error',
        help: exists
          ? definition.help
          : `${definition.help} Объект указан в JSON правил, но отсутствует в Zabbix catalog.`
      });
    }));
  }
}

function renderValidateMappingRules(container, rules, cmdbuildCatalog, validation) {
  clear(container);
  const lookupFields = new Set(lookupSourceFields(rules, cmdbuildCatalog));

  appendValidationSection(container, 'Entity classes', (rules.source?.entityClasses ?? []).map(className => {
    const tokens = [`class:${normalizeToken(className)}`, `match:className:${normalizeToken(className)}`, ...sourceFieldTokens('className')];
    const displayName = catalogClassDisplayName(cmdbuildCatalog ?? {}, className);
    const status = validationStatus(tokens, validation);
    const node = mappingNode({
      label: displayName,
      meta: displayName !== className ? `configured / rules: ${className}` : 'configured',
      tokens,
      level: 1,
      kind: 'source',
      status,
      help: 'Класс источника из JSON правил. Он должен существовать в CMDBuild, иначе события этого класса нельзя корректно обработать.'
    });
    const hostProfileIssue = validationIssueForClassHostProfile(validation, className);
    return hostProfileIssue?.fix ? validationFixNode(node, hostProfileIssue.fix) : node;
  }));

  appendValidationSection(container, 'Class attribute fields', Object.entries(rules.source?.fields ?? {}).map(([fieldKey, field]) => {
    const tokens = [
      ...sourceFieldTokensForRule(fieldKey, field),
      ...sourceFieldTargetTokens(fieldKey),
      ...lookupFieldTokens(fieldKey, lookupFields)
    ];
    return mappingNode({
      label: fieldKey,
      meta: `${sourceFieldMeta(field)}${field.required ? ' required' : ''}${field.validationRegex ? ` | ${field.validationRegex}` : ''}`,
      tokens,
      level: 1,
      kind: 'source',
      status: 'normal',
      help: sourceFieldHelp(fieldKey, field)
    });
  }));

  appendValidationSection(container, 'Event routing', (rules.eventRoutingRules ?? []).map(rule => {
    const tokens = eventRoutingRuleTokens(rule, rules);
    return mappingNode({
      label: rule.eventType,
      meta: `${rule.method}${rule.fallbackMethod ? ` / ${rule.fallbackMethod}` : ''}`,
      tokens,
      level: 1,
      kind: 'rule',
      status: 'normal',
      help: eventRoutingHelp(rule)
    });
  }));

  appendValidationSection(container, 'Host profiles', validationRuleNodesForCollection(rules, 'hostProfiles', 'hostProfiles', validation));
  appendValidationSection(container, 'Group rules', validationRuleNodesForCollection(rules, 'groupSelectionRules', 'hostGroups', validation));
  appendValidationSection(container, 'Template rules', validationRuleNodesForCollection(rules, 'templateSelectionRules', 'templates', validation));
  appendValidationSection(container, 'Interface address rules', validationRuleNodesForCollection(rules, 'interfaceAddressRules', 'interfaceAddress', validation, rule => rule.valueField ?? rule.mode));
  appendValidationSection(container, 'Interface rules', validationRuleNodesForCollection(rules, 'interfaceSelectionRules', 'interface', validation, rule => rule.interfaceRef));
  appendValidationSection(container, 'Tag rules', validationRuleNodesForCollection(rules, 'tagSelectionRules', 'tags', validation));
  appendValidationSection(container, 'Monitoring suppression rules', validationRuleNodesForCollection(rules, 'monitoringSuppressionRules', 'monitoringSuppression', validation));
  appendOptionalZabbixRuleSections(container, rules, validation, appendValidationSection);
}

function validationRuleNodesForCollection(rules, collectionKey, type, validation, metaSelector = null) {
  return asArray(rules[collectionKey]).flatMap((rule, index) =>
    validationRuleMappingNodes(rules, collectionKey, rule, index, type, validation, metaSelector?.(rule)));
}

function validationRuleMappingNodes(rules, collectionKey, rule, index, type, validation, meta = null) {
  const nodes = type === 'hostProfiles'
    ? hostProfileMappingNodes(rule, validation)
    : ruleMappingNodes(rule, type, meta, validation, rules);
  if (nodes.length === 0) {
    return nodes;
  }

  const tokens = ruleTokens(rule, type, rules);
  nodes[0] = validationRuleFixWrapper(nodes[0], validationRuleItem(rules, collectionKey, rule, index), tokens, validation);
  return nodes;
}

function validationRuleFixWrapper(node, item, tokens, validation) {
  if (validationStatus([ruleValidationToken(item.rule, item.collection.type)], validation) !== 'error') {
    return node;
  }

  return validationFixNode(node, {
    scope: 'rules',
    kind: 'rule',
    collectionKey: item.collection.key,
    collectionLabel: item.collection.label,
    ruleIndex: item.index,
    ruleName: ruleDisplayName(item.rule),
    ruleIdentity: item.ruleIdentity,
    reviewRequired: true
  });
}

function validationRuleItem(rules, collectionKey, rule, index) {
  const collection = mappingRuleCollections().find(item => item.key === collectionKey)
    ?? { key: collectionKey, label: collectionKey, type: collectionKey };
  return {
    collection,
    rule,
    index,
    ruleIdentity: stableJson(rule),
    operationKey: mappingDeleteOperationKey(collection.key, index, rule)
  };
}

function validationIssueForClassHostProfile(validation, className) {
  const key = normalizeToken(className);
  if (!key) {
    return null;
  }

  return (validation?.issues ?? []).find(issue =>
    issue.fix?.action === 'createHostProfile'
    && normalizeToken(issue.fix.className) === key) ?? null;
}

function renderValidateMappingCmdbuild(container, rules, catalog, validation) {
  clear(container);
  const classes = rules.source?.entityClasses ?? [];
  const lookupFieldNames = new Set(lookupSourceFields(rules, catalog));

  for (const className of classes) {
    const catalogClass = findCatalogClass(catalog, className);
    const superclass = catalogClass ? isCmdbCatalogSuperclass(catalog, catalogClass) : false;
    const classTokens = [`class:${normalizeToken(className)}`, `match:className:${normalizeToken(className)}`, ...sourceFieldTokens('className')];
    const classMissing = !catalogClass;
    const displayName = catalogClassDisplayName(catalog, className);
    const rawClassNode = mappingNode({
      label: displayName,
      meta: catalogClass
        ? `${catalogClass.parent ?? 'Class'} / ${catalogClass.active === false ? 'inactive' : 'active'}${displayName !== className ? ` / rules: ${className}` : ''}${superclass ? ' / superclass / attributes skipped' : ''}`
        : 'нет в CMDBuild',
      tokens: classTokens,
      level: 1,
      kind: superclass ? 'cmdb-super' : 'cmdb',
      status: classMissing ? 'error' : 'normal',
      help: catalogClass
        ? superclass
          ? 'Superclass/prototype найден в каталоге CMDBuild. Атрибуты не раскрываются и не проверяются, потому что карточек superclass нет и monitoring webhook по нему не ожидается.'
          : 'Класс найден в каталоге CMDBuild.'
        : 'Класс указан в правилах, но отсутствует в каталоге CMDBuild. Исправьте имя класса или создайте класс.'
    });
    const classNode = classMissing ? validationFixNode(rawClassNode, {
      scope: 'cmdbuild',
      kind: 'class',
      className
    }) : rawClassNode;
    const attributes = !classMissing && !superclass ? catalogAttributesForClass(catalog, catalogClass) : [];
    const fieldNodes = superclass ? [] : Object.entries(rules.source?.fields ?? {}).flatMap(([fieldKey, field]) => {
      const canonicalField = canonicalSourceField(fieldKey);
      const isVirtual = isVirtualSourceFieldRule(fieldKey, field);
      const attribute = isVirtual ? null : findCatalogAttributeForField(attributes, field, fieldKey);
      const attributeMissing = field.required && !isVirtual && !classMissing && !attribute;
      if (isVirtual || (!attribute && !attributeMissing)) {
        return [];
      }

      const tokens = [
        ...sourceFieldTokensForRule(fieldKey, field),
        ...sourceFieldTargetTokens(fieldKey),
        ...lookupFieldTokens(fieldKey, lookupFieldNames),
        classFieldToken(className, canonicalField)
      ];
      const rawNode = mappingNode({
        label: attribute?.name ?? (sourceFieldCatalogLabel(field) || sourceFieldLabel(field)),
        meta: attribute
          ? `${attribute.type}${attribute.mandatory ? ' mandatory' : ''}`
          : `обязательный атрибут для class attribute field "${fieldKey}" отсутствует`,
        tokens,
        level: 2,
        kind: 'cmdb',
        status: attributeMissing ? 'error' : 'normal',
        help: attribute
          ? 'Атрибут найден в классе CMDBuild.'
          : 'Обязательный атрибут указан в правилах, но отсутствует в классе CMDBuild.'
      });
      const nodes = [attributeMissing ? validationFixNode(rawNode, {
        scope: 'cmdbuild',
        kind: 'attribute',
        className,
        fieldKey,
        source: sourceFieldLabel(field)
      }) : rawNode];

      if (lookupFieldNames.has(canonicalField)) {
        nodes.push(...cmdbLookupNodes(rules, catalog, canonicalField, className, 3));
      }

      return nodes;
    });

    appendValidationSection(container, className, [classNode, ...fieldNodes]);
  }
}

function validationFixNode(node, fix) {
  const wrapper = el('div', `validation-selectable mapping-status-error validation-scope-${fix.scope}`, '');
  const row = el('label', 'validation-fix-row', '');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'validation-fix-checkbox';
  checkbox.dataset.validationScope = fix.scope;
  checkbox.dataset.fix = JSON.stringify(fix);
  const labelKey = fix.action === 'createHostProfile' ? 'validation.createHostProfile' : 'validation.deleteFromRules';
  const helpKey = fix.action === 'createHostProfile' ? 'validation.createHostProfileHelp' : 'validation.deleteFromRulesHelp';
  setHelpKey(checkbox, helpKey);
  const label = el('span', '', t(labelKey));
  label.dataset.i18n = labelKey;
  row.append(checkbox, label);
  wrapper.append(row, node);
  return wrapper;
}

function setValidationColumnSelection(scope, checked) {
  $$(`.validation-fix-checkbox[data-validation-scope="${scope}"]`).forEach(checkbox => {
    checkbox.checked = checked;
  });
  updateValidationSelectionControls();
}

function selectedValidationFixes() {
  return $$('.validation-fix-checkbox:checked')
    .map(checkbox => JSON.parse(checkbox.dataset.fix))
    .filter(Boolean);
}

function updateValidationSelectionControls() {
  for (const scope of ['zabbix', 'cmdbuild', 'rules']) {
    const checkboxes = $$(`.validation-fix-checkbox[data-validation-scope="${scope}"]`);
    $$(`[data-validation-select="${scope}"], [data-validation-clear="${scope}"]`).forEach(button => {
      button.disabled = checkboxes.length === 0;
    });
  }

  $('#deleteValidateMappingSelected').disabled = selectedValidationFixes().length === 0;
  updateValidateMappingHistoryControls();
}

async function deleteSelectedValidationFixes() {
  const operations = selectedValidationFixes();
  if (operations.length === 0) {
    toast(t('toast.validationSelectMissing'));
    return;
  }

  const sourceRules = state.validateMappingRules ?? state.currentRules?.content;
  if (!sourceRules) {
    toast(t('validation.review.noRules'));
    return;
  }

  const rules = cloneJson(sourceRules);
  const catalogs = {
    zabbix: state.validateMappingZabbixCatalog ?? {},
    cmdbuild: state.validateMappingCmdbuildCatalog ?? {}
  };
  const changes = [];
  const createProfileOperations = operations.filter(operation => operation.action === 'createHostProfile');
  for (const operation of createProfileOperations) {
    const fieldRule = rules.source?.fields?.[operation.fieldKey] ?? { source: operation.fieldKey };
    const result = ensureMinimalHostProfileForClass(
      rules,
      operation.className,
      operation.fieldKey,
      fieldRule,
      { mode: operation.mode });
    if (result.created) {
      changes.push({
        action: 'createHostProfile',
        className: operation.className,
        fieldKey: operation.fieldKey,
        profile: result.profileName
      });
    }
  }

  const deleteOperations = operations.filter(operation => operation.action !== 'createHostProfile');
  const plan = buildValidationRuleDeletePlan(rules, deleteOperations, catalogs);
  if (plan.autoDelete.length === 0 && plan.review.length === 0) {
    if (changes.length > 0) {
      await saveValidationRulesFixResult(rules, changes);
      return;
    }
    if (deleteOperations.length === 0) {
      toast(t('toast.rulesNotChanged'));
      return;
    }
    await deleteSelectedValidationReferences(deleteOperations);
    return;
  }

  const edits = new Map();
  const deletes = new Map(plan.autoDelete.map(item => [item.key, item]));
  for (const item of plan.review) {
    const decision = await openValidationRuleDialog(item);
    if (decision.action === 'cancel') {
      toast(t('validation.review.cancelled'));
      return;
    }
    if (decision.action === 'delete') {
      deletes.set(item.key, item);
    } else if (decision.action === 'edit') {
      edits.set(item.key, { item, rule: decision.rule });
    }
  }

  for (const { item, rule } of edits.values()) {
    if (replaceValidationRule(rules, item, rule)) {
      changes.push({ action: 'editRule', collection: item.collection.key, name: ruleDisplayName(rule) });
    }
  }
  for (const item of [...deletes.values()].sort(compareValidationRuleDeleteOrder)) {
    if (removeValidationRule(rules, item)) {
      changes.push({ action: 'deleteRule', collection: item.collection.key, name: ruleDisplayName(item.rule) });
    }
  }
  changes.push(...cleanupValidationSelectedReferences(rules, deleteOperations));

  if (changes.length === 0) {
    toast(t('toast.rulesNotChanged'));
    return;
  }

  await saveValidationRulesFixResult(rules, changes);
}

async function deleteSelectedValidationReferences(operations) {
  const confirmed = window.confirm(tf('validation.confirmDeleteSelected', { count: operations.length }));
  if (!confirmed) {
    return;
  }

  const result = await api('/api/rules/fix-mapping', {
    method: 'POST',
    body: { operations }
  });
  $('#rulesResult').textContent = JSON.stringify(result, null, 2);
  if (result.content && result.changes?.length > 0) {
    pushValidateMappingHistory(result.content);
    state.currentRules = { ...(state.currentRules ?? {}), content: state.validateMappingRules };
    renderValidateMapping(state.validateMappingRules, state.validateMappingZabbixCatalog ?? {}, state.validateMappingCmdbuildCatalog ?? {});
    toast(t('toast.validationDraftChanged'));
    return;
  }

  toast(t('toast.rulesNotChanged'));
}

function buildValidationRuleDeletePlan(rules, operations, catalogs) {
  const entries = new Map();
  for (const operation of operations) {
    for (const item of mappingDeleteRuleItems(rules)) {
      if (!validationRuleMatchesOperation(item, operation, rules)) {
        continue;
      }

      const key = item.operationKey;
      const entry = entries.get(key) ?? {
        key,
        collection: item.collection,
        index: item.index,
        rule: item.rule,
        ruleIdentity: stableJson(item.rule),
        operations: [],
        reviewRequired: false
      };
      entry.operations.push(operation);
      entry.reviewRequired ||= validationRuleRequiresReview(item, operation, rules, catalogs);
      entries.set(key, entry);
    }
  }

  const values = [...entries.values()];
  return {
    autoDelete: values.filter(item => !item.reviewRequired),
    review: values.filter(item => item.reviewRequired)
  };
}

function validationRuleMatchesOperation(item, operation, rules) {
  if (operation.scope === 'rules' && operation.kind === 'rule') {
    if (item.collection.key !== operation.collectionKey) {
      return false;
    }
    if (String(item.index) !== String(operation.ruleIndex)) {
      return false;
    }
    return !operation.ruleIdentity || stableJson(item.rule) === operation.ruleIdentity;
  }

  if (operation.scope === 'zabbix') {
    const type = validationOperationTargetType(operation);
    if (!type || item.collection.type !== type) {
      return false;
    }
    return selectionItemsForRule(rules, item.rule, type)
      .some(target => validationTargetMatchesOperation(type, target, operation));
  }

  if (operation.scope === 'cmdbuild' && operation.kind === 'class') {
    return mappingDeleteClassesForItem(item, rules)
      .some(className => sameNormalized(className, operation.className));
  }

  if (operation.scope === 'cmdbuild' && operation.kind === 'attribute') {
    return mappingDeleteSourceFieldsForItem(item.rule)
      .some(field => canonicalSourceField(field) === canonicalSourceField(operation.fieldKey));
  }

  return false;
}

function validationRuleRequiresReview(item, operation, rules, catalogs) {
  if (operation.scope === 'rules' && operation.kind === 'rule') {
    return operation.reviewRequired !== false;
  }

  if (operation.scope === 'zabbix') {
    const type = validationOperationTargetType(operation);
    const targets = selectionItemsForRule(rules, item.rule, type);
    return targets.some(target =>
      !validationTargetMatchesOperation(type, target, operation)
      && validationTargetExists(type, target, catalogs.zabbix));
  }

  if (operation.scope === 'cmdbuild' && operation.kind === 'class') {
    return mappingDeleteClassesForItem(item, rules)
      .some(className => !sameNormalized(className, operation.className) && findCatalogClass(catalogs.cmdbuild, className));
  }

  if (operation.scope === 'cmdbuild' && operation.kind === 'attribute') {
    const selected = canonicalSourceField(operation.fieldKey);
    return mappingDeleteSourceFieldsForItem(item.rule)
      .some(field => canonicalSourceField(field) !== selected);
  }

  return false;
}

function validationOperationTargetType(operation) {
  return {
    hostGroup: 'hostGroups',
    template: 'templates',
    templateGroup: 'templateGroups'
  }[operation.kind] ?? '';
}

function validationTargetMatchesOperation(type, target, operation) {
  return sameMappingItem(target, type, operation.id, operation.name);
}

function validationTargetExists(type, target, zabbixCatalog = {}) {
  if (type === 'hostGroups') {
    return zabbixCatalogItemExists(zabbixCatalog.hostGroups ?? [], 'groupid', target.groupid, target.name);
  }
  if (type === 'templates') {
    return zabbixCatalogItemExists(zabbixCatalog.templates ?? [], 'templateid', target.templateid, target.name || target.host);
  }
  if (type === 'templateGroups') {
    return zabbixCatalogItemExists(zabbixCatalog.templateGroups ?? [], 'groupid', target.groupid, target.name);
  }
  return true;
}

function openValidationRuleDialog(item) {
  const dialog = $('#validationRuleDialog');
  $('#validationRuleDialogText').textContent = tf('validation.review.message', { name: ruleDisplayName(item.rule) });
  $('#validationRuleJson').value = JSON.stringify(item.rule, null, 2);
  $('#validationRuleDialogError').textContent = '';
  dialog.classList.remove('hidden');

  return new Promise(resolve => {
    state.validationRuleDialog = { item, resolve };
  });
}

function applyValidationRuleDialogEdit() {
  const current = state.validationRuleDialog;
  if (!current) {
    return;
  }
  try {
    const rule = JSON.parse($('#validationRuleJson').value);
    closeValidationRuleDialog();
    current.resolve({ action: 'edit', rule });
  } catch (error) {
    $('#validationRuleDialogError').textContent = tf('validation.review.invalidJson', { message: error.message });
  }
}

function deleteValidationRuleDialogAnyway() {
  const current = state.validationRuleDialog;
  if (!current) {
    return;
  }
  closeValidationRuleDialog();
  current.resolve({ action: 'delete' });
}

function cancelValidationRuleDialog() {
  const current = state.validationRuleDialog;
  if (!current) {
    return;
  }
  closeValidationRuleDialog();
  current.resolve({ action: 'cancel' });
}

function closeValidationRuleDialog() {
  $('#validationRuleDialog').classList.add('hidden');
  state.validationRuleDialog = null;
}

function compareValidationRuleDeleteOrder(left, right) {
  if (left.collection.key !== right.collection.key) {
    return compareText(left.collection.key, right.collection.key);
  }
  return right.index - left.index;
}

function validationRuleIndex(rules, item) {
  const list = rules[item.collection.key] ?? [];
  if (stableJson(list[item.index]) === item.ruleIdentity) {
    return item.index;
  }
  return list.findIndex(rule => stableJson(rule) === item.ruleIdentity);
}

function replaceValidationRule(rules, item, rule) {
  const list = rules[item.collection.key] ?? [];
  const index = validationRuleIndex(rules, item);
  if (index < 0) {
    return false;
  }
  list[index] = rule;
  return true;
}

function removeValidationRule(rules, item) {
  const list = rules[item.collection.key] ?? [];
  const index = validationRuleIndex(rules, item);
  if (index < 0) {
    return false;
  }
  list.splice(index, 1);
  return true;
}

function cleanupValidationSelectedReferences(rules, operations) {
  const changes = [];
  for (const operation of operations) {
    if (operation.scope === 'zabbix') {
      changes.push(...cleanupValidationZabbixReference(rules, operation));
    } else if (operation.scope === 'cmdbuild' && operation.kind === 'class') {
      const removed = removeFromArray(rules.source?.entityClasses, item => sameNormalized(item, operation.className));
      if (removed > 0) {
        changes.push({ action: 'deleteClass', className: operation.className, removed });
      }
    } else if (operation.scope === 'cmdbuild' && operation.kind === 'attribute' && rules.source?.fields?.[operation.fieldKey]) {
      if (!rulesStillUseField(rules, operation.fieldKey)) {
        delete rules.source.fields[operation.fieldKey];
        changes.push({ action: 'deleteSourceField', fieldKey: operation.fieldKey, removed: 1 });
      }
    }
  }
  return changes;
}

function cleanupValidationZabbixReference(rules, operation) {
  const spec = {
    hostGroup: { lookupPath: ['lookups', 'hostGroups'], defaultsPath: ['defaults', 'hostGroups'], idField: 'groupid' },
    template: { lookupPath: ['lookups', 'templates'], defaultsPath: ['defaults', 'templates'], idField: 'templateid' },
    templateGroup: { lookupPath: ['lookups', 'templateGroups'], defaultsPath: ['defaults', 'templateGroups'], idField: 'groupid' }
  }[operation.kind];
  if (!spec) {
    return [];
  }

  const matcher = item => sameRulesFixItemClient(item, spec.idField, operation.id, operation.name);
  const removed = removeItemsAtClientPath(rules, spec.lookupPath, matcher)
    + removeItemsAtClientPath(rules, spec.defaultsPath, matcher);
  return removed > 0
    ? [{ action: 'deleteZabbixReference', kind: operation.kind, id: operation.id, name: operation.name, removed }]
    : [];
}

function rulesStillUseField(rules, fieldKey) {
  const selected = canonicalSourceField(fieldKey);
  return mappingDeleteRuleItems(rules).some(item =>
    mappingDeleteSourceFieldsForItem(item.rule)
      .some(field => canonicalSourceField(field) === selected));
}

function removeItemsAtClientPath(root, path, matcher) {
  const items = path.reduce((current, part) => current?.[part], root);
  return removeFromArray(items, matcher);
}

function removeFromArray(items, matcher) {
  if (!Array.isArray(items)) {
    return 0;
  }
  const initial = items.length;
  items.splice(0, items.length, ...items.filter(item => !matcher(item)));
  return initial - items.length;
}

function sameRulesFixItemClient(item, idField, id, name) {
  const wanted = [id, name].map(normalizeToken).filter(Boolean);
  if (wanted.length === 0) {
    return false;
  }
  return [item?.[idField], item?.name, item?.host]
    .map(normalizeToken)
    .some(candidate => wanted.includes(candidate));
}

async function saveValidationRulesFixResult(rules, changes) {
  const validation = await api('/api/rules/validate', {
    method: 'POST',
    body: { content: rules }
  });
  const result = {
    saved: false,
    note: 'Rules were changed in memory only. Save the returned JSON through the browser and publish it to git outside monitoring-ui-api.',
    validation,
    changes,
    content: rules
  };
  $('#rulesResult').textContent = JSON.stringify(result, null, 2);
  if (!validation.valid) {
    toast(t('toast.rulesValidationFailed'));
    return;
  }

  pushValidateMappingHistory(rules);
  state.currentRules = { ...(state.currentRules ?? {}), content: state.validateMappingRules };
  renderValidateMapping(state.validateMappingRules, state.validateMappingZabbixCatalog ?? {}, state.validateMappingCmdbuildCatalog ?? {});
  toast(t('toast.validationDraftChanged'));
}

function buildRulesMappingValidation(rules, zabbixCatalog, cmdbuildCatalog) {
  const issues = [];
  const addIssue = issue => issues.push({
    severity: issue.severity ?? 'error',
    source: issue.source,
    message: issue.message,
    tokens: uniqueTokens(issue.tokens ?? []),
    help: issue.help,
    fix: issue.fix
  });

  for (const group of referencedHostGroups(rules)) {
    if (!zabbixCatalogItemExists(zabbixCatalog.hostGroups ?? [], 'groupid', group.groupid, group.name)) {
      addIssue({
        source: 'zabbix',
        message: `Zabbix host group отсутствует: ${group.name || group.groupid}`,
        tokens: zabbixItemTokens(rules, 'hostGroups', group.groupid, group.name),
        help: 'Правило ссылается на host group, которой нет в Zabbix. Создайте группу в Zabbix или замените groupid/name в JSON правил.'
      });
    }
  }

  for (const template of referencedTemplates(rules)) {
    if (!zabbixCatalogItemExists(zabbixCatalog.templates ?? [], 'templateid', template.templateid, template.name || template.host)) {
      addIssue({
        source: 'zabbix',
        message: `Zabbix template отсутствует: ${template.name || template.host || template.templateid}`,
        tokens: zabbixItemTokens(rules, 'templates', template.templateid, template.name || template.host),
        help: 'Правило ссылается на template, которого нет в Zabbix. Создайте шаблон, импортируйте его или замените templateid/name в JSON правил.'
      });
    }
  }

  for (const group of referencedTemplateGroups(rules)) {
    if (!zabbixCatalogItemExists(zabbixCatalog.templateGroups ?? [], 'groupid', group.groupid, group.name)) {
      addIssue({
        source: 'zabbix',
        message: `Zabbix template group отсутствует: ${group.name || group.groupid}`,
        tokens: zabbixItemTokens(rules, 'templateGroups', group.groupid, group.name),
        help: 'Правило ссылается на template group, которой нет в Zabbix.'
      });
    }
  }

  for (const definition of zabbixExtensionDefinitions) {
    if (definition.requiresCatalog === false) {
      continue;
    }

    for (const item of referencedZabbixExtensionItems(rules, definition)) {
      if (!zabbixExtensionItemExists(zabbixCatalog[definition.catalogKey] ?? [], definition, item)) {
        addIssue({
          source: 'zabbix',
          message: `Zabbix ${definition.title} отсутствует: ${definition.label(item)}`,
          tokens: zabbixExtensionItemMappingTokens(definition, item, rules),
          help: `${definition.help} Объект указан в JSON правил, но отсутствует в Zabbix catalog.`
        });
      }
    }
  }

  const reportedMissingClassKeys = new Set();
  const addMissingCmdbClassIssue = (className, origin = 'source.entityClasses') => {
    const key = normalizeToken(className);
    if (!key || reportedMissingClassKeys.has(key)) {
      return;
    }
    reportedMissingClassKeys.add(key);
    const affectedRuleTokens = mappingDeleteRuleItems(rules)
      .filter(item => ruleClassConditions(item.rule).some(value => sameNormalized(value, className)))
      .map(item => ruleValidationToken(item.rule, item.collection.type));
    addIssue({
      source: 'cmdbuild',
      message: origin === 'rule condition'
        ? `CMDBuild class из rule condition отсутствует: ${className}`
        : `CMDBuild class отсутствует: ${className}`,
      tokens: [`class:${key}`, `match:className:${key}`, ...affectedRuleTokens],
      help: origin === 'rule condition'
        ? 'Rule condition по className указывает значение, которого нет в каталоге CMDBuild. Исправьте condition или создайте соответствующий класс.'
        : 'Класс указан в source.entityClasses правил, но не найден в каталоге CMDBuild.'
    });
  };

  for (const className of rules.source?.entityClasses ?? []) {
    const key = normalizeToken(className);
    const catalogClass = findCatalogClass(cmdbuildCatalog, className);
    if (!catalogClass) {
      addMissingCmdbClassIssue(className);
      continue;
    }
    if (isCmdbCatalogSuperclass(cmdbuildCatalog, catalogClass)) {
      continue;
    }

    if (!classHasHostProfile(rules, className)) {
      const profileFixField = hostProfileFixFieldForClass(rules, cmdbuildCatalog, className);
      addIssue({
        source: 'rules',
        message: `Для CMDBuild class не найден hostProfile: ${catalogClassDisplayName(cmdbuildCatalog, className)}`,
        tokens: [
          `class:${key}`,
          `match:className:${key}`,
          'target:hostProfiles',
          'target:interfaces',
          ...sourceFieldTokens('className'),
          ...(profileFixField ? sourceFieldTokens(profileFixField.fieldKey) : [])
        ],
        help: 'События этого класса будут приняты, но converter пропустит их с no_host_profile_matched. Добавьте hostProfiles[] для класса или примените автоматическое исправление.',
        fix: profileFixField ? {
          action: 'createHostProfile',
          scope: 'rules',
          kind: 'hostProfile',
          className: catalogClassRuleName(cmdbuildCatalog, className),
          fieldKey: profileFixField.fieldKey,
          mode: profileFixField.mode
        } : null
      });
    }

    const attributes = catalogAttributesForClass(cmdbuildCatalog, catalogClass);
    for (const [fieldKey, field] of Object.entries(rules.source?.fields ?? {})) {
      if (!field.required || isVirtualSourceFieldRule(fieldKey, field)) {
        continue;
      }

      const attribute = findCatalogAttributeForField(attributes, field, fieldKey);
      if (!attribute) {
        addIssue({
          source: 'cmdbuild',
          message: `CMDBuild attribute отсутствует: ${catalogClassDisplayName(cmdbuildCatalog, className)}.${sourceFieldCatalogLabel(field) || sourceFieldLabel(field)}`,
          tokens: [
            ...sourceFieldTokensForRule(fieldKey, field),
            classFieldToken(className, canonicalSourceField(fieldKey)),
            ...ruleValidationTokensForSourceField(rules, fieldKey)
          ],
          help: 'Обязательный атрибут указан в source.fields правил, но ни один source-алиас не найден в соответствующем классе CMDBuild.'
        });
      }
    }
  }

  for (const className of monitoredClassNamesForRules(rules)) {
    if (!findCatalogClass(cmdbuildCatalog, className)) {
      addMissingCmdbClassIssue(className, 'rule condition');
    }
  }

  const unknownSourceFieldTokens = new Map();
  for (const item of mappingDeleteRuleItems(rules)) {
    for (const field of mappingDeleteSourceFieldsForItem(item.rule)) {
      const fieldKey = canonicalSourceField(field);
      if (isKnownMappingSourceField(rules, fieldKey)) {
        continue;
      }
      const tokens = unknownSourceFieldTokens.get(fieldKey) ?? [];
      tokens.push(ruleValidationToken(item.rule, item.collection.type), ...sourceFieldTokens(fieldKey));
      unknownSourceFieldTokens.set(fieldKey, tokens);
    }
  }

  for (const [fieldKey, tokens] of unknownSourceFieldTokens) {
    addIssue({
      source: 'cmdbuild',
      message: `Class attribute field в rule не объявлен: ${fieldKey}`,
      tokens: [...sourceFieldTokens(fieldKey), ...tokens],
      help: 'Rule ссылается на class attribute field, которого нет в source.fields. Добавьте field в правила или исправьте condition/valueField.'
    });
  }

  return {
    issues,
    issueTokens: buildIssueTokenMap(issues)
  };
}

function ruleValidationTokensForSourceField(rules, fieldKey) {
  const selected = canonicalSourceField(fieldKey);
  return mappingDeleteRuleItems(rules)
    .filter(item => mappingDeleteSourceFieldsForItem(item.rule)
      .some(field => canonicalSourceField(field) === selected))
    .map(item => ruleValidationToken(item.rule, item.collection.type));
}

function appendValidationSection(container, title, nodes) {
  appendMappingSection(container, title, nodes, {
    expanded: nodes.some(node => node.classList.contains('mapping-status-error')),
    status: sectionStatusFromNodes(nodes)
  });
}

function sectionStatusFromNodes(nodes) {
  if (nodes.some(node => node.classList.contains('mapping-status-error'))) {
    return 'error';
  }
  if (nodes.some(node => node.classList.contains('mapping-status-warning'))) {
    return 'warning';
  }
  return 'normal';
}

function validationStatus(tokens, validation) {
  let status = 'normal';
  for (const token of uniqueTokens(tokens)) {
    const issueStatus = validation?.issueTokens?.get(token);
    if (issueStatus === 'error') {
      return 'error';
    }
    if (issueStatus === 'warning') {
      status = 'warning';
    }
  }
  return status;
}

function buildIssueTokenMap(issues) {
  const values = new Map();
  for (const issue of issues) {
    for (const token of issue.tokens ?? []) {
      const current = values.get(token);
      if (current !== 'error') {
        values.set(token, issue.severity);
      }
    }
  }
  return values;
}

function referencedHostGroups(rules) {
  return uniqueById([
    ...(rules.lookups?.hostGroups ?? []),
    ...(rules.defaults?.hostGroups ?? []),
    ...(rules.groupSelectionRules ?? []).flatMap(rule => rule.hostGroups ?? [])
  ], 'groupid');
}

function referencedTemplates(rules) {
  return uniqueById([
    ...(rules.lookups?.templates ?? []),
    ...(rules.defaults?.templates ?? []),
    ...(rules.templateSelectionRules ?? []).flatMap(rule => rule.templates ?? [])
  ], 'templateid');
}

function referencedTemplateGroups(rules) {
  return uniqueById([
    ...(rules.lookups?.templateGroups ?? []),
    ...(rules.defaults?.templateGroups ?? []),
    ...(rules.templateGroupSelectionRules ?? []).flatMap(rule => rule.templateGroups ?? [])
  ], 'groupid');
}

function referencedTags(rules) {
  return uniqueById([
    ...(rules.defaults?.tags ?? []),
    ...(rules.tagSelectionRules ?? []).flatMap(rule => rule.tags ?? [])
  ], 'tag');
}

function zabbixCatalogItemExists(items, idField, id, name) {
  const wanted = [id, name].map(normalizeToken).filter(Boolean);
  return items.some(item => wanted.includes(normalizeToken(item?.[idField])) || wanted.includes(normalizeToken(item?.name)) || wanted.includes(normalizeToken(item?.host)));
}

function findCatalogClass(catalog, className) {
  const wanted = normalizeClassName(className);
  return (catalog.classes ?? []).find(item => catalogClassAliases(item).some(alias => normalizeClassName(alias) === wanted));
}

function catalogClassAliases(item = {}) {
  return uniqueTokens([
    item.name,
    item.description,
    item.label,
    item.text,
    item.raw?.name,
    item.raw?.description,
    item.raw?._description
  ]);
}

function catalogClassDisplayName(catalog, className) {
  const item = typeof className === 'object' ? className : findCatalogClass(catalog ?? {}, className);
  if (!item) {
    return className;
  }
  return item.description || item.label || item.text || item.name || className;
}

function catalogClassRuleName(catalog, className) {
  const item = findCatalogClass(catalog ?? {}, className);
  return item?.name || className;
}

function catalogAttributesForClass(catalog, classNameOrItem) {
  const classItem = typeof classNameOrItem === 'object'
    ? classNameOrItem
    : findCatalogClass(catalog ?? {}, classNameOrItem);
  const aliases = new Set(catalogClassAliases(classItem ?? { name: classNameOrItem }).map(normalizeClassName));
  return (catalog?.attributes ?? [])
    .find(item => aliases.has(normalizeClassName(item.className)))
    ?.items ?? [];
}

function normalizeClassName(value) {
  const token = normalizeToken(value);
  return token.endsWith('s') ? token.slice(0, -1) : token;
}

function isVirtualSourceField(fieldKey, sourceName) {
  return ['className', 'eventType'].includes(canonicalSourceField(fieldKey))
    || ['className', 'eventType'].includes(canonicalSourceField(sourceName));
}

function isVirtualSourceFieldRule(fieldKey, field) {
  return sourceFieldSources(field).some(sourceName => isVirtualSourceField(fieldKey, sourceName));
}

function sourceFieldSources(field = {}) {
  return uniqueTokens([
    field.source,
    ...(Array.isArray(field.sources) ? field.sources : [])
  ].filter(Boolean));
}

function sourceFieldCatalogSources(field = {}) {
  return uniqueTokens([
    field.cmdbAttribute,
    ...(Array.isArray(field.cmdbAttributes) ? field.cmdbAttributes : [])
  ].filter(Boolean));
}

function sourceFieldLabel(field = {}) {
  const sources = sourceFieldSources(field);
  return sources.length > 0 ? sources.join(' | ') : '<not configured>';
}

function sourceFieldCatalogLabel(field = {}) {
  const sources = sourceFieldCatalogSources(field);
  return sources.length > 0 ? sources.join(' | ') : '';
}

function sourceFieldMeta(field = {}) {
  const parts = [sourceFieldLabel(field)];
  const catalogLabel = sourceFieldCatalogLabel(field);
  if (catalogLabel) {
    parts.push(`CMDB ${catalogLabel}`);
  }
  if (field.cmdbPath) {
    parts.push(`path ${field.cmdbPath}`);
  }
  if (field.resolve?.mode && field.resolve.mode !== 'none') {
    const leaf = field.resolve.leafType ? `/${field.resolve.leafType}` : '';
    parts.push(`resolve ${field.resolve.mode}${leaf}`);
  }
  return parts.join(' -> ');
}

function sourceFieldTokensForRule(fieldKey, field = {}) {
  return uniqueTokens([
    ...sourceFieldTokens(fieldKey),
    ...sourceFieldSources(field).flatMap(sourceName => sourceFieldTokens(fieldKey, sourceName)),
    ...sourceFieldCatalogSources(field).flatMap(sourceName => sourceFieldTokens(fieldKey, sourceName)),
    ...String(field.cmdbPath ?? '')
      .split('.')
      .filter(Boolean)
      .flatMap(sourceName => sourceFieldTokens(fieldKey, sourceName))
  ]);
}

function findCatalogAttributeForField(attributes, field, fieldKey) {
  for (const sourceName of sourceFieldCatalogSources(field)) {
    const attribute = findCatalogAttribute(attributes, sourceName, fieldKey);
    if (attribute) {
      return attribute;
    }
  }

  for (const sourceName of sourceFieldSources(field)) {
    const attribute = findCatalogAttribute(attributes, sourceName, fieldKey);
    if (attribute) {
      return attribute;
    }
  }

  return findCatalogAttribute(attributes, fieldKey, fieldKey);
}

function renderMappingZabbix(container, rules, catalog) {
  clear(container);
  appendMappingSection(container, 'JSON-RPC fields', (rules.zabbix?.expectedMonitoringFields ?? []).map(field => mappingNode({
    label: field,
    meta: 'payload',
    tokens: [...monitoringFieldTokens(field), 'target:payload'],
    level: 1,
    kind: 'target'
  })));

  appendMappingSection(container, 'Host groups', zabbixHostGroups(rules, catalog).map(group => mappingNode({
    label: group.name || group.groupid,
    meta: `groupid ${group.groupid}`,
    tokens: zabbixItemTokens(rules, 'hostGroups', group.groupid, group.name),
    level: 1,
    kind: 'zabbix'
  })));

  appendMappingSection(container, 'Templates', zabbixTemplates(rules, catalog).map(template => mappingNode({
    label: template.name || template.host || template.templateid,
    meta: `templateid ${template.templateid}`,
    tokens: zabbixItemTokens(rules, 'templates', template.templateid, template.name || template.host),
    level: 1,
    kind: 'zabbix'
  })));

  appendMappingSection(container, 'Template groups', zabbixTemplateGroups(rules, catalog).map(group => mappingNode({
    label: group.name || group.groupid,
    meta: `groupid ${group.groupid}`,
    tokens: zabbixItemTokens(rules, 'templateGroups', group.groupid, group.name),
    level: 1,
    kind: 'zabbix'
  })));

  appendMappingSection(container, 'Tags', zabbixTags(rules, catalog).map(tag => mappingNode({
    label: tag.tag,
    meta: tag.value ?? '',
    tokens: zabbixItemTokens(rules, 'tags', tag.tag, tag.value),
    level: 1,
    kind: 'zabbix'
  })));

  for (const definition of zabbixExtensionDefinitions) {
    const items = zabbixExtensionItems(rules, catalog, definition);
    const totalCount = catalog.counts?.[definition.catalogKey] ?? items.length;
    appendLazyMappingSection(container, `${definition.title} (${totalCount})`, () => zabbixExtensionSectionNodes(definition, items, rules, catalog), {
      expanded: false,
      help: definition.help,
      tokens: zabbixLazySectionTokens(definition, items, rules)
    });
  }
}

function renderMappingRules(container, rules, cmdbuildCatalog = null) {
  clear(container);
  const lookupFields = new Set(lookupSourceFields(rules, cmdbuildCatalog));

  appendMappingSection(container, 'Class attribute fields', Object.entries(rules.source?.fields ?? {}).map(([fieldKey, field]) => mappingNode({
    label: fieldKey,
    meta: `${sourceFieldMeta(field)}${field.required ? ' required' : ''}${field.validationRegex ? ` | ${field.validationRegex}` : ''}`,
    tokens: [
      ...sourceFieldTokensForRule(fieldKey, field),
      ...sourceFieldTargetTokens(fieldKey),
      ...lookupFieldTokens(fieldKey, lookupFields)
    ],
    level: 1,
    kind: 'source',
    help: sourceFieldHelp(fieldKey, field)
  })));

  appendMappingSection(container, 'Event routing', (rules.eventRoutingRules ?? []).map(rule => mappingNode({
    label: rule.eventType,
    meta: `${rule.method}${rule.fallbackMethod ? ` / ${rule.fallbackMethod}` : ''}`,
    tokens: eventRoutingRuleTokens(rule, rules),
    level: 1,
    kind: 'rule',
    help: eventRoutingHelp(rule)
  })));

  appendHostProfilesSection(container, rules);
  appendConversionRuleSection(container, 'Group rules', rules.groupSelectionRules ?? [], 'hostGroups', null, rules);
  appendConversionRuleSection(container, 'Template rules', rules.templateSelectionRules ?? [], 'templates', null, rules);
  appendConversionRuleSection(container, 'Template group rules', rules.templateGroupSelectionRules ?? [], 'templateGroups', null, rules);
  appendConversionRuleSection(container, 'Interface address rules', rules.interfaceAddressRules ?? [], 'interfaceAddress', null, rules);
  appendConversionRuleSection(container, 'Interface rules', rules.interfaceSelectionRules ?? [], 'interface', null, rules);
  appendConversionRuleSection(container, 'Tag rules', rules.tagSelectionRules ?? [], 'tags', null, rules);
  appendConversionRuleSection(container, 'Monitoring suppression rules', rules.monitoringSuppressionRules ?? [], 'monitoringSuppression', null, rules);
  appendOptionalZabbixRuleSections(container, rules, null, appendMappingSection);

  appendMappingSection(container, 'T4 templates', Object.entries(rules.t4Templates ?? {})
    .filter(([, value]) => Array.isArray(value))
    .map(([name, value]) => mappingNode({
      label: name,
      meta: `${value.length} lines`,
      tokens: [`template:${normalizeToken(name)}`, ...templateTargetTokens(name)],
      level: 1,
      kind: 'template',
      help: t4TemplateHelp(name)
    })));
}

function renderMappingCmdbuild(container, rules, catalog) {
  clear(container);
  const classes = rules.source?.entityClasses ?? [];
  const attributesByClass = new Map((catalog.attributes ?? []).map(item => [String(item.className).toLowerCase(), item.items ?? []]));
  const lookupFieldNames = new Set(lookupSourceFields(rules, catalog));
  const hierarchyNodes = cmdbClassHierarchyNodes(rules, catalog, attributesByClass);

  appendMappingSection(container, 'CMDBuild class hierarchy', hierarchyNodes, {
    expanded: false,
    status: sectionStatusFromNodes(hierarchyNodes),
    help: 'Иерархия классов CMDBuild. Классы из source.entityClasses помечены как configured, остальные являются кандидатами для будущего добавления в правила. Super/prototype-классы выделены отдельно.'
  });

  for (const className of classes) {
    const catalogClass = findCatalogClass(catalog, className);
    const superclass = catalogClass ? isCmdbCatalogSuperclass(catalog, catalogClass) : false;
    const displayName = catalogClassDisplayName(catalog, className);
    const classNode = mappingNode({
      label: displayName,
      meta: `${classMeta(catalog, className)}${displayName !== className ? ` / rules: ${className}` : ''}${superclass ? ' / superclass / attributes skipped' : ''}`,
      tokens: [`class:${normalizeToken(className)}`, `match:className:${normalizeToken(className)}`, ...sourceFieldTokens('className')],
      level: 1,
      kind: superclass ? 'cmdb-super' : 'cmdb',
      help: superclass
        ? `CMDBuild superclass/prototype "${displayName}" формально присутствует в source.entityClasses, но атрибуты не раскрываются и не проверяются: карточек superclass нет и monitoring webhook по нему не ожидается.`
        : `Класс CMDBuild "${displayName}" участвует в правилах как source entity. Сам класс создается и меняется в CMDBuild; в JSON правил можно только включить или исключить его из source.entityClasses, если webhook уже передает события этого класса.`
    });
    const classAttributes = !superclass
      ? catalogAttributesForClass(catalog, catalogClass ?? className)
      : [];
    const fieldNodes = superclass ? [] : Object.entries(rules.source?.fields ?? {}).flatMap(([fieldKey, field]) => {
      const attribute = isVirtualSourceFieldRule(fieldKey, field)
        ? null
        : findCatalogAttributeForField(classAttributes, field, fieldKey);
      if (!attribute) {
        return [];
      }

      const canonicalField = canonicalSourceField(fieldKey);
      const nodes = [mappingNode({
        label: attribute.name,
        meta: `${attribute.type}${attribute.mandatory ? ' mandatory' : ''}`,
        tokens: [
          ...sourceFieldTokensForRule(fieldKey, field),
          ...sourceFieldTargetTokens(fieldKey),
          ...lookupFieldTokens(fieldKey, lookupFieldNames),
          classFieldToken(className, canonicalField)
        ],
        level: 2,
        kind: 'cmdb',
        help: cmdbFieldHelp(className, fieldKey, field, attribute)
      })];

      if (lookupFieldNames.has(canonicalField)) {
        nodes.push(...cmdbLookupNodes(rules, catalog, canonicalField, className, 3));
      }

      return nodes;
    });

    appendMappingSection(container, displayName, [classNode, ...fieldNodes], {
      help: superclass
        ? `Superclass/prototype "${displayName}" показан только как класс. Атрибуты и lookup-значения не раскрываются, потому что по superclass нет карточек и значимых webhook для мониторинга.`
        : `Класс "${displayName}" в CMDBuild-части mapping. Атрибуты и lookup-справочники приходят из CMDBuild catalog. Без изменения источника можно редактировать только правила, которые читают эти атрибуты.`
    });
  }
}

function cmdbClassHierarchyNodes(rules, catalog, attributesByClass) {
  const configuredClasses = new Set((rules.source?.entityClasses ?? []).map(normalizeClassName));
  const classes = (catalog.classes ?? []).filter(item => item?.name);
  const byName = new Map(classes.map(item => [normalizeClassName(item.name), item]));
  const childrenByParent = new Map();
  for (const item of classes) {
    const parentName = cmdbParentClassName(item);
    if (!parentName || !byName.has(parentName)) {
      continue;
    }

    const children = childrenByParent.get(parentName) ?? [];
    children.push(item);
    childrenByParent.set(parentName, children);
  }

  for (const children of childrenByParent.values()) {
    children.sort(compareCmdbClasses);
  }

  const roots = classes
    .filter(item => {
      const parentName = cmdbParentClassName(item);
      return !parentName || !byName.has(parentName);
    })
    .sort(compareCmdbClasses);

  return roots.flatMap(item => cmdbClassHierarchyBranch(item, 1, childrenByParent, attributesByClass, configuredClasses));
}

function cmdbClassHierarchyBranch(item, level, childrenByParent, attributesByClass, configuredClasses) {
  const normalizedName = normalizeClassName(item.name);
  const children = childrenByParent.get(normalizedName) ?? [];
  const superclass = isCmdbSuperclass(item, children);
  const attributes = superclass ? [] : attributesByClass.get(String(item.name).toLowerCase()) ?? [];
  const required = superclass ? [] : cmdbRequiredClassFields(attributes);
  const missing = required.filter(field => !field.present);
  const configured = configuredClasses.has(normalizedName);
  const status = missing.length > 0 ? 'warning' : 'normal';
  const meta = [
    configured ? 'configured' : 'candidate',
    superclass ? 'superclass' : 'class',
    item.active === false ? 'inactive' : 'active',
    superclass
      ? 'attributes skipped'
      : missing.length > 0
        ? `missing: ${missing.map(field => field.label).join(', ')}`
        : 'required ok'
  ].join(' | ');
  const node = mappingNode({
    label: item.name,
    meta,
    tokens: [
      `class:${normalizeToken(item.name)}`,
      `match:className:${normalizeToken(item.name)}`
    ],
    level: Math.min(level, 5),
    kind: superclass ? 'cmdb-super' : 'cmdb',
    status,
    help: cmdbHierarchyClassHelp(item, configured, superclass, missing)
  });
  const fieldNodes = required.map(field => mappingNode({
    label: field.label,
    meta: field.present ? field.detail : 'обязательный атрибут отсутствует',
    tokens: [
      `class:${normalizeToken(item.name)}`,
      classFieldToken(item.name, field.fieldKey)
    ],
    level: Math.min(level + 1, 5),
    kind: 'source',
    status: field.present ? 'normal' : 'warning',
    help: field.present
      ? `Обязательное поле "${field.label}" найдено для класса "${item.name}": ${field.detail}.`
      : `Обязательное поле "${field.label}" не найдено для класса "${item.name}". Перед добавлением класса в rules проверьте CMDBuild attribute или webhook binding.`
  }));

  return [
    node,
    ...fieldNodes,
    ...children.flatMap(child => cmdbClassHierarchyBranch(child, level + 1, childrenByParent, attributesByClass, configuredClasses))
  ];
}

function cmdbRequiredClassFields(attributes) {
  return [
    requiredCmdbField('id', 'entityId', ['id', 'Id', '_id'], attributes),
    requiredCmdbField('code', 'code', ['code', 'Code'], attributes),
    {
      label: 'className',
      fieldKey: 'className',
      sourceName: 'className',
      present: true,
      detail: 'webhook/system field'
    }
  ];
}

function requiredCmdbField(label, fieldKey, candidates, attributes) {
  const attribute = findCatalogAttributeByNames(attributes, candidates);
  return {
    label,
    fieldKey,
    sourceName: candidates[0],
    present: Boolean(attribute),
    detail: attribute ? `${attribute.name} / ${attribute.type}${attribute.mandatory ? ' mandatory' : ''}` : ''
  };
}

function findCatalogAttributeByNames(attributes, candidates) {
  const wanted = candidates.map(normalizeToken);
  return attributes.find(attribute => wanted.includes(normalizeToken(attribute.name)) || wanted.includes(normalizeToken(attribute.alias)));
}

function cmdbParentClassName(item) {
  return typeof item.parent === 'string' ? normalizeClassName(item.parent) : '';
}

function isCmdbSuperclass(item, children = []) {
  return item.raw?.prototype === true || children.length > 0;
}

function isCmdbCatalogSuperclass(catalog, item) {
  if (!item) {
    return false;
  }

  return item.raw?.prototype === true || hasCmdbSubclass(catalog, item.name);
}

function hasCmdbSubclass(catalog, className) {
  const normalizedName = normalizeClassName(className);
  return (catalog.classes ?? []).some(item => cmdbParentClassName(item) === normalizedName);
}

function compareCmdbClasses(left, right) {
  return String(left.name).localeCompare(String(right.name), undefined, { sensitivity: 'base' });
}

function cmdbHierarchyClassHelp(item, configured, superclass, missing) {
  if (superclass) {
    const configuredText = configured
      ? 'Класс формально входит в source.entityClasses.'
      : 'Класс не входит в source.entityClasses.';
    return `CMDBuild superclass/prototype "${item.name}". ${configuredText} Атрибуты не выводятся и не проверяются, потому что карточек superclass нет и значимых monitoring webhook по нему не ожидается.`;
  }

  const missingText = missing.length > 0
    ? ` Отсутствуют обязательные поля: ${missing.map(field => field.label).join(', ')}.`
    : ' Все проверяемые обязательные поля найдены.';
  const configuredText = configured
    ? 'Класс уже входит в source.entityClasses.'
    : 'Класс пока не входит в source.entityClasses; позже здесь можно будет добавить его в rules.';
  const superclassText = superclass
    ? ' Это superclass/prototype или класс с наследниками; он визуально выделен.'
    : ' Это обычный класс.';
  return `CMDBuild class "${item.name}". ${configuredText} ${superclassText}${missingText}`;
}

function appendMappingSection(container, title, nodes, options = {}) {
  const section = document.createElement('div');
  section.className = `mapping-section mapping-section-status-${options.status ?? 'normal'}`;
  const initialExpanded = options.expanded ?? !container.closest('#mapping');
  section.dataset.manualOpen = initialExpanded ? 'true' : 'false';
  const header = el('div', 'mapping-section-header', '');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'mapping-section-toggle';
  toggle.textContent = '-';
  toggle.addEventListener('click', () => {
    const expand = section.classList.contains('is-collapsed');
    section.dataset.manualOpen = expand ? 'true' : 'false';
    setMappingSectionExpanded(section, expand);
  });
  const titleNode = el('h3', '', title);
  titleNode.tabIndex = 0;
  setHelp(titleNode, options.help ?? mappingSectionHelp(title));
  header.append(toggle, titleNode);
  section.append(header);
  const body = el('div', 'mapping-section-body', '');
  body.replaceChildren(...nodes);
  section.append(body);
  container.append(section);
  setMappingSectionExpanded(section, initialExpanded);
}

function appendLazyMappingSection(container, title, buildNodes, options = {}) {
  const section = document.createElement('div');
  section.className = `mapping-section mapping-section-status-${options.status ?? 'normal'}`;
  section.dataset.lazy = 'true';
  section.dataset.chain = uniqueTokens(options.tokens ?? []).join(' ');
  const initialExpanded = options.expanded ?? false;
  section.dataset.manualOpen = initialExpanded ? 'true' : 'false';
  const header = el('div', 'mapping-section-header', '');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'mapping-section-toggle';
  toggle.textContent = '+';
  const titleNode = el('h3', '', title);
  titleNode.tabIndex = 0;
  setHelp(titleNode, options.help ?? mappingSectionHelp(title));
  header.append(toggle, titleNode);
  section.append(header);
  const body = el('div', 'mapping-section-body', '');
  section.append(body);

  const renderBody = async () => {
    if (section.dataset.rendered === 'true') {
      return;
    }
    if (section.dataset.loading === 'true') {
      return;
    }

    section.dataset.loading = 'true';
    body.replaceChildren(mappingNode({
      label: t('common.loading'),
      meta: t('mapping.lazyLoadingMeta'),
      tokens: options.tokens ?? [],
      level: 1,
      kind: 'zabbix'
    }));
    try {
      body.replaceChildren(...await Promise.resolve(buildNodes()));
    } catch (error) {
      console.error(`Conversion rules lazy render failed for ${title}`, error);
      body.replaceChildren(mappingNode({
        label: 'Ошибка отрисовки',
        meta: error.message ?? String(error),
        level: 1,
        kind: 'rule',
        status: 'error',
        help: `Раздел "${title}" не отрисовался из-за клиентской ошибки.`
      }));
    }
    section.dataset.loading = 'false';
    section.dataset.rendered = 'true';
  };

  section.renderLazyBody = renderBody;
  toggle.addEventListener('click', async () => {
    const expand = section.classList.contains('is-collapsed');
    section.dataset.manualOpen = expand ? 'true' : 'false';
    if (expand) {
      await renderBody();
    }
    setMappingSectionExpanded(section, expand);
  });
  container.append(section);
  if (initialExpanded) {
    renderBody();
  }
  setMappingSectionExpanded(section, initialExpanded);
}

async function zabbixExtensionSectionNodes(definition, items, rules, catalog) {
  if (!definition.lazyCatalogPath) {
    return zabbixExtensionMappingNodes(definition, items, rules);
  }

  const response = await api(`/api/zabbix/catalog/${definition.lazyCatalogPath}`);
  const fullItems = response.items ?? [];
  return zabbixExtensionMappingNodes(definition, zabbixExtensionItems(rules, {
    ...catalog,
    [definition.catalogKey]: fullItems
  }, definition), rules);
}

function zabbixExtensionMappingNodes(definition, items, rules = null) {
  const shownItems = items.slice(0, largeMappingSectionLimit);
  const nodes = shownItems.map(item => mappingNode({
    label: definition.label(item),
    meta: definition.meta(item),
    tokens: zabbixExtensionItemMappingTokens(definition, item, rules),
    level: 1,
    kind: 'zabbix',
    help: definition.help
  }));

  if (items.length > shownItems.length) {
    nodes.unshift(mappingNode({
      label: `Показаны первые ${shownItems.length} из ${items.length}`,
      meta: 'сузьте каталог в Zabbix или используйте поиск/отдельный справочник в будущей версии UI',
      tokens: [`target:${definition.rulesKey}`],
      level: 1,
      kind: 'zabbix',
      status: 'warning',
      help: 'Раздел слишком большой для полной интерактивной отрисовки в управлении правилами конвертации. Ограничение защищает UI от зависания.'
    }));
  }

  return nodes;
}

function sectionTitleWithCount(title, items) {
  return `${title} (${items.length})`;
}

function mappingSectionHelp(title) {
  const extensionDefinition = zabbixExtensionDefinitions.find(definition => definition.title === title);
  if (extensionDefinition) {
    return extensionDefinition.help;
  }

  const extensionRulesDefinition = zabbixExtensionDefinitions.find(definition => `${definition.title} rules` === title);
  if (extensionRulesDefinition) {
    return `Правила выбора "${extensionRulesDefinition.title}". Это расширение JSON правил для будущей отправки в Zabbix payload или отдельные Zabbix API операции. Без изменения микросервисов блок можно использовать как проектирование/валидацию правил; для реального исполнения нужен соответствующий output в конвертере.`;
  }

  const helpByTitle = {
    'JSON-RPC fields': 'Поля payload, которые ожидаются на выходе в сторону Zabbix. Это справочный блок контракта. Менять его в JSON правил можно только если downstream-сервис и Zabbix writer уже поддерживают такие поля; иначе потребуется правка микросервиса.',
    'Host groups': 'Zabbix host groups. В JSON правил можно менять ссылки на уже существующие группы и regex-условия выбора. Если группы нет в Zabbix, ее нужно создать в Zabbix или убрать ссылку из правил.',
    Templates: 'Zabbix templates. В JSON правил можно менять назначаемые шаблоны, если они уже есть в Zabbix. Новый template сначала создается или импортируется в Zabbix; микросервисы переписывать не нужно, пока payload остается templates[].templateid.',
    'Template groups': 'Zabbix template groups. Это проверяемый справочник Zabbix. Исправляется либо созданием группы в Zabbix, либо удалением/заменой ссылки в JSON правил.',
    Tags: 'Zabbix tags показывают итоговые tag definitions, которые приходят из defaults.tags и Tag rules. Они связаны с Tag rules как результат: правило выбирает, какой tag/value попадет в payload. Это не входное условие Template rules, а выходная часть Zabbix host payload.',
    'Entity classes': 'Список классов CMDBuild, события которых правила считают допустимыми. Можно добавлять или удалять имя класса в JSON правил только если такой класс уже есть в CMDBuild и webhook передает его события.',
    'Class attribute fields': 'Conversion fields: поле слева является нормализованным Model-полем конвертера, source справа указывает атрибут или ключ webhook CMDBuild. Без правки микросервиса безопасно менять source, required и validationRegex для уже поддержанных Model-полей и реально существующих CMDBuild attributes.',
    'Event routing': 'Маршрутизация create/update/delete в JSON-RPC методы Zabbix и T4-шаблоны. Без правки микросервисов можно менять метод, templateName и fallbackTemplateName только в рамках уже поддержанных сценариев и существующих T4 templates.',
    'Host profiles': 'Host profiles описывают fan-out: один CMDB object может дать один или несколько Zabbix hosts. Внутри profile задаются hostName/visibleName templates и interfaces. Для нескольких IP можно оставить их interfaces одного основного host или создать отдельные profiles для отдельных Zabbix hosts. Переименование profile меняет suffix нового Zabbix host, старые hosts не переименовываются автоматически.',
    'Group rules': 'Правила выбора host groups по regex над class attribute fields. Обычно редактируются в JSON правил: priority, when.anyRegex/when.allRegex и ссылки на существующие Zabbix host groups. CMDBuild менять не нужно, если поля уже приходят в webhook.',
    'Template rules': 'Правила выбора Zabbix templates по regex над class attribute fields. В условии можно использовать lookup/class attribute field zabbixTag, если tag из CMDBuild должен влиять на выбор шаблона. Результатом Template rules должны оставаться только templates/templateRef; выбирать или назначать Zabbix tags в этом блоке нецелесообразно, для этого есть Tag rules. После выбора применяется templateConflictRules: на create конфликтующие templates не попадают в payload, на update fallback они также попадают в templates_clear.',
    'Interface address rules': 'Правила выбора адреса Zabbix interface. Можно выбирать IP или DNS через mode и valueField; valueField ссылается на нормализованное class attribute field, например ipAddress или dnsName.',
    'Interface rules': 'Правила выбора интерфейса мониторинга. Без изменения микросервисов можно менять regex и ссылки на уже описанные interface defaults, пока Zabbix writer поддерживает этот тип интерфейса.',
    'Tag rules': 'Правила формирования Zabbix tags. Они читают class attribute fields через regex, например zabbixTag, и добавляют tag/value в payload. Связь с блоком Tags прямая: Tag rules создают элементы, которые видны как Tags. Tag rules не выбирают templates; если tag должен влиять на template, используйте тот же class attribute field как условие в Template rules.',
    'T4 templates': 'T4-шаблоны JSON-RPC payload. Можно менять структуру payload для уже поддержанных Zabbix methods и Model-полей. Новые Model-поля, новые методы или новая логика выполнения требуют правки микросервисов.'
  };

  return helpByTitle[title]
    ?? `Блок "${title}" группирует элементы карты правил конвертации. Если это класс CMDBuild, сам класс и его attributes приходят из CMDBuild; в JSON правил меняется только список допустимых классов и правила обработки, а источник не редактируется.`;
}

function sourceFieldHelp(fieldKey, field) {
  const regexText = field.validationRegex
    ? ` Валидация выполняется regex: ${field.validationRegex}.`
    : '';
  const requiredText = field.required
    ? ' Поле обязательное: событие без него не должно проходить нормальную обработку.'
    : ' Поле необязательное: правило может использовать его, если значение пришло в payload.';
  const catalogText = sourceFieldCatalogLabel(field)
    ? ` Для управления правилами конвертации и генерации CMDBuild Body оно связано с атрибутом CMDBuild "${sourceFieldCatalogLabel(field)}"; это не входной alias для микросервиса.`
    : '';
  const pathText = field.cmdbPath
    ? ` CMDB path "${field.cmdbPath}" хранится в rules: webhook остается плоским и передает значение source "${sourceFieldLabel(field)}"; converter при необходимости поднимает leaf через CMDBuild REST.`
    : '';
  return `Conversion field "${fieldKey}" читает source "${sourceFieldLabel(field)}" из CMDBuild webhook и кладет значение в Model.${modelFieldName(fieldKey)}.${requiredText}${regexText} Если указано несколько source-алиасов, берется первый найденный в payload.${catalogText}${pathText}`;
}

function cmdbFieldHelp(className, fieldKey, field, attribute) {
  const sourceText = attribute
    ? `Атрибут CMDBuild найден: ${attribute.name}, тип ${attribute.type}.`
    : `Ни один source-алиас "${sourceFieldLabel(field)}" не найден в каталоге класса или поле является служебным webhook-полем.`;
  const catalogText = sourceFieldCatalogLabel(field)
    ? ` В rules явно указано соответствие source -> CMDBuild attribute: ${sourceFieldLabel(field)} -> ${sourceFieldCatalogLabel(field)}.`
    : '';
  return `Для класса "${className}" conversion field "${fieldKey}" читает CMDBuild source "${sourceFieldLabel(field)}". ${sourceText}${catalogText} CMDBuild attribute здесь не редактируется; меняются только JSON rules, если источник уже передает это поле.`;
}

function lookupHelp(className, lookupName, lookup) {
  const catalogText = lookup
    ? `Справочник найден в CMDBuild catalog: ${lookup.name ?? lookupName}.`
    : 'Справочник показан по правилам, но не найден в текущем каталоге CMDBuild.';
  return `${catalogText} Для управления правилами конвертации используется связка class="${className}" + lookup="${lookupName}". Сам lookup и его значения меняются в CMDBuild, а поведение конвертации меняется regex-правилами в JSON.`;
}

function lookupValueHelp(className, lookupName, value) {
  const valueText = value.id
    ? `${value.label} / id ${value.id}`
    : value.label;
  return `Lookup value "${valueText}" рассматривается как отдельная связка "${className}.${lookupName}.${value.label}". Например, Notebook + zabbixTag + tag1 может вести к своему tag rule, а то же значение в другом классе не обязано подсвечиваться как та же логика. Меняйте regex в JSON rules; справочник CMDBuild не трогается.`;
}

function eventRoutingHelp(rule) {
  return `Event routing для "${rule.eventType}" выбирает Zabbix method "${rule.method}" и T4 template "${rule.templateName}". Связанные поля берутся из requiredFields и из Model.* внутри T4 templates. Без правки микросервисов меняйте только существующие события, методы и шаблоны, которые уже поддержаны обработчиком.`;
}

function hostProfileHelp(profile) {
  return `Host profile "${profile.name || 'default'}" задает один выходной Zabbix host для подходящего CMDB object. Несколько profiles создают несколько Kafka messages и несколько Zabbix hosts. Profile с условием по пустому адресу на create/update не публикуется. Если адрес появился только на update и profile включает createOnUpdateWhenMissing, поток делает host.get, затем host.update для найденного host или host.create для отсутствующего host. Очистка поля не удаляет Zabbix host автоматически: по объекту мониторинга нужно принять отдельное решение. Поля hostNameTemplate/visibleNameTemplate можно менять в rules; сами CMDB attributes должны уже приходить в webhook.`;
}

function hostProfileInterfaceHelp(profile, item) {
  const valueField = item.valueField || profile.valueField || 'interfaceAddressRules';
  const mode = item.mode || profile.mode || 'auto';
  return `Interface "${item.name || valueField}" внутри host profile "${profile.name || 'default'}" добавляет элемент в Model.Interfaces и затем в Zabbix interfaces[]. mode=${mode}: ip заполняет interfaces[].ip/useip=1, dns заполняет interfaces[].dns/useip=0. Если valueField пустой, interface не попадает в payload и это не считается ошибкой. Количество interfaces задается rules, но текущий webhook использует named fields, а не массив IP. Для нескольких interfaces одного Zabbix type оставляйте main=1 только у одного profile, остальные должны быть main=0. Для одного Zabbix host с несколькими IP держите такие interfaces в одном profile; для отдельного profile host используйте отдельный host profile.`;
}

function conversionRuleHelp(rule, type) {
  if (type === 'hostProfiles') {
    return hostProfileHelp(rule);
  }

  if (type === 'templates') {
    return `Template rule "${rule.name}" выбирает Zabbix templates. Условия when.anyRegex/when.allRegex могут читать любой class attribute field, включая lookup zabbixTag, если значение tag должно влиять на выбор шаблона. Результатом должны быть templates/templateRef; назначать tags здесь не нужно и обычно вредно для читаемости правил. После объединения Template rules применяются templateConflictRules.`;
  }

  if (type === 'tags') {
    return `Tag rule "${rule.name}" формирует Zabbix tags. Условия when.anyRegex/when.allRegex читают class attribute fields, результатом являются tag/value или tag/valueTemplate. Эти элементы затем видны в блоке Tags и попадают в tags[] payload. Template этот блок не выбирает.`;
  }

  if (type === 'interfaceAddress') {
    return `Interface address rule "${rule.name}" выбирает, чем заполнить Zabbix interfaces[]: mode=ip пишет valueField в ip и useip=1, mode=dns пишет valueField в dns и useip=0. Обычно меняются priority, fieldExists/regex, mode и valueField.`;
  }

  const targetText = {
    hostGroups: 'Zabbix host groups',
    templateGroups: 'Zabbix template groups',
    interface: 'monitoring interface'
  }[type] ?? type;
  return `Правило "${rule.name}" выбирает ${targetText}. Условия when.anyRegex/when.allRegex читают class attribute fields, результат берется из этого правила или ref/defaults. Обычно можно менять priority, regex и ссылки на существующие Zabbix objects. Новые поля или новая логика обработки требуют изменения микросервиса.`;
}

function t4TemplateHelp(name) {
  return `T4 template "${name}" формирует JSON-RPC payload для Zabbix. Можно менять JSON и использовать уже доступные Model-поля из class attribute fields. Если нужен новый Model.X, новый Zabbix method или другая логика выполнения, потребуется изменение микросервиса.`;
}

function modelFieldName(fieldKey) {
  const canonical = canonicalSourceField(fieldKey);
  return canonical.charAt(0).toUpperCase() + canonical.slice(1);
}

function mappingNode({ label, meta = '', tokens = [], level = 1, kind = 'rule', status = 'normal', help = null }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `mapping-node mapping-level-${level} mapping-kind-${kind} mapping-status-${status}`;
  button.dataset.chain = uniqueTokens(tokens).join(' ');
  button.dataset.kind = kind;
  button.dataset.level = String(level);
  button.dataset.status = status;
  button.append(
    el('span', 'mapping-node-label', label ?? ''),
    el('span', 'mapping-node-meta', meta ?? '')
  );
  setHelp(button, help ?? mappingNodeHelp(label, meta, kind, status));
  button.addEventListener('click', () => highlightMapping(button));
  return button;
}

function mappingNodeHelp(label, meta, kind, status) {
  const kindText = {
    cmdb: 'Элемент CMDBuild',
    'cmdb-super': 'Superclass CMDBuild',
    lookup: 'Lookup-значение CMDBuild',
    rule: 'Правило конвертации',
    template: 'T4 шаблон',
    source: 'Поле источника',
    regex: 'Регулярное выражение правила',
    zabbix: 'Элемент Zabbix',
    target: 'Поле JSON-RPC payload'
  }[kind] ?? 'Элемент карты правил конвертации';
  const statusText = status === 'error'
    ? ' Есть ошибка: элемент отсутствует в подключенной системе или некорректно сопоставлен.'
    : status === 'warning'
      ? ' Есть предупреждение, проверьте настройку.'
      : '';
  return `${kindText}: ${label ?? ''}.${meta ? ` Детали: ${meta}.` : ''}${statusText} Нажмите, чтобы подсветить связанные элементы.`;
}

function highlightMapping(sourceNode) {
  if (sourceNode.closest('#validateMapping')) {
    return;
  }

  const sourceColumn = sourceNode.closest('.mapping-column');
  const scope = sourceNode.closest('.view') ?? document;
  if (sourceNode.classList.contains('is-selected')) {
    clearMappingHighlight(scope);
    return;
  }

  const includeBroadTokens = sourceNode.dataset.kind === 'target';
  const lookupValueMode = isLookupValueNode(sourceNode);
  const tokens = selectionTokenSet(sourceNode, includeBroadTokens, lookupValueMode);
  applyMappingHighlight(sourceNode, scope, sourceColumn, tokens, includeBroadTokens, lookupValueMode);
  loadRelatedLazyMappingSections(scope, tokens, sourceNode);
}

function applyMappingHighlight(sourceNode, scope, sourceColumn, tokens, includeBroadTokens, lookupValueMode) {
  [...scope.querySelectorAll('.mapping-node')].forEach(node => {
    const nodeTokens = lookupValueMode
      ? lookupValueCandidateTokensFor(node)
      : relationTokensFor(node, includeBroadTokens);
    const relatedTokens = nodeTokens.filter(token => tokens.has(token));
    const sameColumn = node.closest('.mapping-column') === sourceColumn;
    const related = isRelatedMappingNode(sourceNode, node, relatedTokens, sameColumn, lookupValueMode);
    node.classList.toggle('is-selected', node === sourceNode);
    node.classList.toggle('is-related', related && node !== sourceNode);
  });

  updateMappingSectionVisibility(scope);
}

function updateMappingMode() {
  state.mappingMode = $('#mappingMode')?.value ?? 'view';
  updateMappingEditor();
  updateMappingSectionVisibility($('#mapping'));
}

function refreshMappingSelection(scope) {
  const selectedNode = scope?.querySelector('.mapping-node.is-selected');
  if (!selectedNode) {
    updateMappingSectionVisibility(scope);
    return;
  }

  const includeBroadTokens = selectedNode.dataset.kind === 'target';
  const lookupValueMode = isLookupValueNode(selectedNode);
  const tokens = selectionTokenSet(selectedNode, includeBroadTokens, lookupValueMode);
  applyMappingHighlight(
    selectedNode,
    scope,
    selectedNode.closest('.mapping-column'),
    tokens,
    includeBroadTokens,
    lookupValueMode
  );
}

function selectionTokenSet(sourceNode, includeBroadTokens, lookupValueMode) {
  const tokens = lookupValueMode
    ? lookupValueSourceTokensFor(sourceNode)
    : relationTokensFor(sourceNode, includeBroadTokens);
  return new Set(refineSelectionTokens(tokens, sourceNode));
}

function refineSelectionTokens(tokens, sourceNode = null) {
  const unique = uniqueTokens(tokens);
  if (sourceNode && isSourceSideNode(sourceNode) && unique.some(isSpecificSourceMappingToken)) {
    return unique.filter(token => !isTargetMappingToken(token));
  }

  const hasSpecificTarget = unique.some(token => token.startsWith('target:') && token !== 'target:payload');
  return hasSpecificTarget
    ? unique.filter(token => token !== 'target:payload')
    : unique;
}

function isRelatedMappingNode(sourceNode, node, relatedTokens, sameColumn, lookupValueMode) {
  if (relatedTokens.length === 0) {
    return false;
  }

  const sourceClassFieldTokens = classFieldTokensForNode(sourceNode);
  const nodeClassFieldTokens = classFieldTokensForNode(node);
  if (sourceClassFieldTokens.length > 0
      && nodeClassFieldTokens.length > 0
      && !sourceClassFieldTokens.some(token => nodeClassFieldTokens.includes(token))) {
    return false;
  }

  if (lookupValueMode) {
    return true;
  }

  if (isSourceSideNode(sourceNode) && isSourceSideNode(node) && relatedTokens.every(isTargetMappingToken)) {
    return false;
  }

  if (isSourceSideNode(sourceNode) && node.dataset.kind !== 'target' && relatedTokens.every(isPayloadTargetFieldToken)) {
    return false;
  }

  const sourceKind = sourceNode.dataset.kind;
  const nodeKind = node.dataset.kind;
  if (sameColumn && (sourceKind === 'lookup' || nodeKind === 'lookup')) {
    return relatedTokens.some(isClassScopedLookupToken);
  }

  return true;
}

function classFieldTokensForNode(node) {
  return relationTokensFor(node).filter(token => token.startsWith('class-field:'));
}

function isClassScopedLookupToken(token) {
  return token.startsWith('class-field:')
    || token.startsWith('class-lookup-value:');
}

function isSourceSideNode(node) {
  return ['cmdb', 'cmdb-super', 'source', 'lookup'].includes(node.dataset.kind);
}

function isTargetMappingToken(token) {
  return token.startsWith('target:');
}

function isPayloadTargetFieldToken(token) {
  return token.startsWith('target-field:');
}

function isSpecificSourceMappingToken(token) {
  return token.startsWith('source:')
    || token.startsWith('cmdb-field:')
    || token.startsWith('class-field:')
    || token.startsWith('class-lookup-value:')
    || token.startsWith('field-lookup:')
    || token.startsWith('lookup:')
    || token.startsWith('lookup-value:')
    || token.startsWith('match:');
}

async function loadRelatedLazyMappingSections(scope, tokens, sourceNode) {
  const sections = [...scope.querySelectorAll('.mapping-section[data-lazy="true"]')]
    .filter(section => section.dataset.rendered !== 'true')
    .filter(section => (section.dataset.chain ?? '').split(/\s+/).some(token => tokens.has(token)));
  if (sections.length === 0) {
    return;
  }

  await Promise.all(sections.map(async section => {
    setMappingSectionExpanded(section, true);
    if (typeof section.renderLazyBody === 'function') {
      await section.renderLazyBody();
    }
  }));

  if (!sourceNode.isConnected || !sourceNode.classList.contains('is-selected')) {
    return;
  }

  const includeBroadTokens = sourceNode.dataset.kind === 'target';
  const lookupValueMode = isLookupValueNode(sourceNode);
  const refreshedTokens = selectionTokenSet(sourceNode, includeBroadTokens, lookupValueMode);
  applyMappingHighlight(
    sourceNode,
    scope,
    sourceNode.closest('.mapping-column'),
    refreshedTokens,
    includeBroadTokens,
    lookupValueMode
  );
}

function clearMappingHighlight(scope) {
  [...scope.querySelectorAll('.mapping-node')].forEach(node => {
    node.classList.remove('is-selected', 'is-related');
  });
  updateMappingSectionVisibility(scope);
}

function relationTokensFor(node, includeBroadTokens = false) {
  const tokens = (node.dataset.chain ?? '').split(/\s+/).filter(Boolean);
  if (includeBroadTokens || node.dataset.kind === 'target') {
    return uniqueTokens(tokens);
  }

  return uniqueTokens(tokens.filter(isStrongMappingToken));
}

function isLookupValueNode(node) {
  return node.dataset.kind === 'lookup'
    && relationTokensFor(node).some(token => token.startsWith('lookup-value:'));
}

function lookupValueSourceTokensFor(node) {
  return relationTokensFor(node)
    .filter(isLookupValueRelationToken);
}

function lookupValueCandidateTokensFor(node) {
  const tokens = relationTokensFor(node);
  if (isLookupValueNode(node)) {
    const classScopedTokens = tokens.filter(token => token.startsWith('class-lookup-value:'));
    return classScopedTokens.length > 0
      ? classScopedTokens
      : tokens.filter(isLookupValueRelationToken);
  }

  return tokens.filter(isLookupValueRelationToken);
}

function isLookupValueRelationToken(token) {
  return token.startsWith('class-lookup-value:')
    || token.startsWith('lookup-value:')
    || token.startsWith('match:');
}

function isStrongMappingToken(token) {
  return token.startsWith('rule:')
    || token.startsWith('source:')
    || token.startsWith('cmdb-field:')
    || token.startsWith('class:')
    || token.startsWith('class-field:')
    || token.startsWith('class-lookup-value:')
    || token.startsWith('field-lookup:')
    || token.startsWith('lookup:')
    || token.startsWith('lookup-value:')
    || token.startsWith('match:')
    || token.startsWith('zbx-')
    || token.startsWith('template:')
    || token.startsWith('target-field:')
    || (token.startsWith('target:') && token !== 'target:payload')
    || token.startsWith('event:')
    || token.startsWith('method:')
    || token.startsWith('interface:')
    || token.startsWith('fallback:');
}

function updateMappingSectionVisibility(scope = document) {
  const sections = [...scope.querySelectorAll('.mapping-section')];
  const hasAnyActiveNode = sections.some(section => section.querySelector('.mapping-node.is-selected, .mapping-node.is-related'));
  const editMode = isMappingEditMode(scope);

  sections.forEach(section => {
    const hasActiveNode = Boolean(section.querySelector('.mapping-node.is-selected, .mapping-node.is-related'));
    section.querySelectorAll('.mapping-node').forEach(node => {
      const marked = node.classList.contains('is-selected') || node.classList.contains('is-related');
      node.classList.toggle('is-selection-filtered-out', hasAnyActiveNode && shouldHideUnmarkedMappingNode(node, marked));
      node.classList.toggle('is-edit-filtered-out', editMode && hasAnyActiveNode && !marked);
    });
    section.classList.toggle('is-edit-filtered-out', editMode && hasAnyActiveNode && !hasActiveNode);

    if (!hasAnyActiveNode) {
      section.classList.remove('is-filtered-out');
      setMappingSectionExpanded(section, section.dataset.manualOpen !== 'false');
      return;
    }

    section.classList.toggle('is-filtered-out', !hasActiveNode);
    if (hasActiveNode) {
      setMappingSectionExpanded(section, true);
    } else if (section.dataset.manualOpen !== 'true') {
      setMappingSectionExpanded(section, false);
    }
  });
  updateMappingModeControls(scope, hasAnyActiveNode);
}

function shouldHideUnmarkedMappingNode(node, marked) {
  if (marked || !node.closest('#mapping')) {
    return false;
  }

  const kind = node.dataset.kind;
  if (['lookup', 'source', 'rule', 'regex', 'template', 'zabbix', 'target'].includes(kind)) {
    return true;
  }

  if (kind !== 'cmdb') {
    return false;
  }

  return !isCmdbClassHierarchyNode(node) && Number(node.dataset.level ?? '1') > 1;
}

function isCmdbClassHierarchyNode(node) {
  const title = node.closest('.mapping-section')?.querySelector('.mapping-section-header h3')?.textContent ?? '';
  return title === 'CMDBuild class hierarchy';
}

function isMappingEditMode(scope) {
  if (!scope || scope === document) {
    return $('#mapping')?.classList.contains('active') && state.mappingMode === 'edit';
  }

  const mappingRoot = scope.id === 'mapping'
    ? scope
    : scope.closest?.('#mapping');
  return Boolean(mappingRoot) && state.mappingMode === 'edit';
}

function updateMappingModeControls(scope = document, hasAnyActiveNode = null) {
  const mappingRoot = scope?.id === 'mapping' ? scope : scope?.closest?.('#mapping') ?? $('#mapping');
  if (!mappingRoot) {
    return;
  }

  mappingRoot.classList.toggle('mapping-edit-mode', state.mappingMode === 'edit');
  $('#mappingEditor')?.classList.toggle('hidden', state.mappingMode !== 'edit');
  updateMappingClearSelectionButton(hasAnyActiveNode);
}

function updateMappingClearSelectionButton(hasAnyActiveNode = null) {
  const button = $('#mappingClearSelection');
  if (!button) {
    return;
  }

  const hasSelection = hasAnyActiveNode ?? Boolean($('#mapping')?.querySelector('.mapping-node.is-selected, .mapping-node.is-related'));
  const viewMode = state.mappingMode !== 'edit';
  button.classList.toggle('hidden', !viewMode);
  button.disabled = !viewMode || !hasSelection;
}

function setMappingSectionExpanded(section, expanded) {
  section.classList.toggle('is-collapsed', !expanded);
  const toggle = section.querySelector('.mapping-section-toggle');
  if (toggle) {
    toggle.textContent = expanded ? '-' : '+';
  }
}

function zabbixHostGroups(rules, catalog) {
  return uniqueById([
    ...(catalog.hostGroups ?? []),
    ...(rules.lookups?.hostGroups ?? []),
    ...(rules.defaults?.hostGroups ?? []),
    ...(rules.groupSelectionRules ?? []).flatMap(rule => rule.hostGroups ?? [])
  ], 'groupid');
}

function zabbixTemplates(rules, catalog) {
  return uniqueById([
    ...(catalog.templates ?? []),
    ...(rules.lookups?.templates ?? []),
    ...(rules.defaults?.templates ?? []),
    ...(rules.templateSelectionRules ?? []).flatMap(rule => rule.templates ?? [])
  ], 'templateid');
}

function zabbixTemplateGroups(rules, catalog) {
  return uniqueById([
    ...(catalog.templateGroups ?? []),
    ...(rules.lookups?.templateGroups ?? []),
    ...(rules.defaults?.templateGroups ?? []),
    ...(rules.templateGroupSelectionRules ?? []).flatMap(rule => rule.templateGroups ?? [])
  ], 'groupid');
}

function zabbixTags(rules, catalog) {
  return uniqueById([
    ...(catalog.tags ?? []),
    ...(rules.defaults?.tags ?? []),
    ...(rules.tagSelectionRules ?? []).flatMap(rule => rule.tags ?? [])
  ], 'tag');
}

function zabbixExtensionItems(rules, catalog, definition) {
  return uniqueById([
    ...asArray(catalog[definition.catalogKey]),
    ...referencedZabbixExtensionItems(rules, definition)
  ], definition.idField);
}

function referencedZabbixExtensionItems(rules, definition) {
  const selectionRules = rules[definition.selectionRulesKey] ?? rules[`${definition.rulesKey}SelectionRules`] ?? [];
  const singularKey = singularRuleKey(definition.rulesKey);
  return uniqueById([
    ...asArray(rules.lookups?.[definition.rulesKey]),
    ...asArray(rules.defaults?.[definition.rulesKey]),
    ...(rules.defaults?.[singularKey] ? [rules.defaults[singularKey]] : []),
    ...selectionRules.flatMap(rule => [
      ...asArray(rule[definition.rulesKey]),
      ...(rule[singularKey] ? [rule[singularKey]] : []),
      ...itemsFromRulesRef(rules, rule[`${definition.rulesKey}Ref`]),
      ...itemsFromRulesRef(rules, rule[`${singularKey}Ref`])
    ])
  ], definition.idField);
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return value ? [value] : [];
}

function singularRuleKey(value) {
  return {
    proxies: 'proxy',
    proxyGroups: 'proxyGroup',
    globalMacros: 'globalMacro',
    hostMacros: 'hostMacro',
    inventoryFields: 'inventoryField',
    interfaceProfiles: 'interfaceProfile',
    hostStatuses: 'hostStatus',
    maintenances: 'maintenance',
    tlsPskModes: 'tlsPskMode',
    valueMaps: 'valueMap'
  }[value] ?? value;
}

function zabbixExtensionTokens(definition, item) {
  const id = item?.[definition.idField] ?? definition.label(item);
  const tokens = [
    `target:${definition.rulesKey}`,
    `zbx-${definition.rulesKey}:${normalizeToken(id)}`,
    `zbx-${definition.rulesKey}:${normalizeToken(definition.label(item))}`
  ];
  if (definition.rulesKey === 'hostMacros') {
    tokens.push('target:macros', ...tagValueTokens(item));
  }
  if (definition.rulesKey === 'inventoryFields') {
    tokens.push(
      'target:inventory',
      ...inventoryFieldTokens(item),
      ...tagValueTokens(item)
    );
  }
  return tokens;
}

function zabbixExtensionItemMappingTokens(definition, item, rules = null) {
  const tokens = zabbixExtensionTokens(definition, item);
  if (!rules) {
    return tokens;
  }

  const selectionRules = rules[definition.selectionRulesKey] ?? rules[`${definition.rulesKey}SelectionRules`] ?? [];
  for (const rule of selectionRules) {
    if (selectionItemsForRule(rules, rule, definition.rulesKey)
      .some(candidate => sameZabbixExtensionItem(definition, candidate, item))) {
      tokens.push(ruleValidationToken(rule, definition.rulesKey));
    }
  }

  return uniqueTokens(tokens);
}

function sameZabbixExtensionItem(definition, left, right) {
  const leftValues = zabbixExtensionIdentityValues(definition, left);
  const rightValues = zabbixExtensionIdentityValues(definition, right);
  return leftValues.some(value => rightValues.includes(value));
}

function zabbixExtensionIdentityValues(definition, item) {
  if (!item) {
    return [];
  }

  return uniqueTokens([
    item?.[definition.idField],
    definition.label(item),
    item?.name,
    item?.macro,
    item?.field,
    item?.proxyId,
    item?.proxy_groupid,
    item?.maintenanceId,
    item?.valueMapId
  ].map(normalizeToken).filter(Boolean));
}

function inventoryFieldTokens(item) {
  return [
    item?.field,
    item?.name
  ].filter(Boolean).map(value => `inventory-field:${normalizeToken(value)}`);
}

function zabbixLazySectionTokens(definition, items, rules) {
  const selectionRules = rules[definition.selectionRulesKey] ?? rules[`${definition.rulesKey}SelectionRules`] ?? [];
  return uniqueTokens([
    `target:${definition.rulesKey}`,
    ...items.flatMap(item => zabbixExtensionTokens(definition, item)),
    ...selectionRules.flatMap(rule => ruleTokens(rule, definition.rulesKey, rules))
  ]);
}

function zabbixExtensionItemExists(items, definition, item) {
  const wanted = [
    item?.[definition.idField],
    definition.label(item),
    item?.name,
    item?.macro
  ].map(normalizeToken).filter(Boolean);
  if (wanted.length === 0) {
    return false;
  }

  return items.some(candidate => [
    candidate?.[definition.idField],
    definition.label(candidate),
    candidate?.name,
    candidate?.macro
  ].map(normalizeToken).some(value => wanted.includes(value)));
}

function appendOptionalZabbixRuleSections(container, rules, validation, appendSection) {
  for (const definition of zabbixExtensionDefinitions) {
    const selectionRules = rules[definition.selectionRulesKey] ?? rules[`${definition.rulesKey}SelectionRules`] ?? [];
    if (validation && (!Array.isArray(selectionRules) || selectionRules.length === 0)) {
      continue;
    }
    appendConversionRuleSection(container, `${definition.title} rules`, selectionRules, definition.rulesKey, validation, rules, appendSection, definition.selectionRulesKey);
  }
}

function zabbixItemTokens(rules, type, id, name) {
  const tokens = [`target:${type === 'hostGroups' ? 'groups' : type}`, `zbx-${type}:${normalizeToken(id || name)}`];
  const ruleLists = {
    hostGroups: rules.groupSelectionRules ?? [],
    templates: rules.templateSelectionRules ?? [],
    templateGroups: rules.templateGroupSelectionRules ?? [],
    tags: rules.tagSelectionRules ?? []
  };
  for (const rule of ruleLists[type] ?? []) {
    const items = selectionItemsForRule(rules, rule, type);
    if (items.some(item => sameMappingItem(item, type, id, name))) {
      tokens.push(ruleValidationToken(rule, type));
    }
  }

  return uniqueTokens(tokens);
}

function appendConversionRuleSection(container, title, selectionRules, type, validation, rules, appendSection = appendMappingSection, collectionKey = null) {
  const ruleItems = Array.isArray(selectionRules) ? selectionRules : [];
  const nodes = ruleItems.length > 0
    ? ruleItems.flatMap((rule, index) => validation && collectionKey
      ? validationRuleMappingNodes(rules, collectionKey, rule, index, type, validation)
      : ruleMappingNodes(rule, type, null, validation, rules))
    : [emptyConversionBlockNode(title, type)];
  appendSection(container, title, nodes, {
    expanded: false,
    status: ruleItems.length > 0 ? sectionStatusFromNodes(nodes) : 'warning',
    help: conversionBlockHelp(title, type, ruleItems.length)
  });
}

function emptyConversionBlockNode(title, type) {
  return mappingNode({
    label: 'conversion block не настроен',
    meta: `нет правил для ${title}`,
    tokens: [`target:${type === 'hostGroups' ? 'groups' : type}`, `empty-conversion:${normalizeToken(type)}`],
    level: 1,
    kind: 'rule',
    status: 'warning',
    help: `Пустая заготовка conversion block для "${title}". Добавьте соответствующий selectionRules-блок в JSON правил, когда этот тип Zabbix objects начнет участвовать в конвертации.`
  });
}

function conversionBlockHelp(title, type, ruleCount) {
  if (ruleCount > 0) {
    return mappingSectionHelp(title);
  }

  return `Пустой conversion block "${title}" для Zabbix target "${type}". Он показывает место будущей настройки; сейчас правила не участвуют в обработке и не меняют payload.`;
}

function ruleMappingNodes(rule, type, meta = null, validation = null, rules = null) {
  const tokens = ruleTokens(rule, type, rules);
  return [
    mappingNode({
      label: rule.name,
      meta: meta ?? ruleMeta(rule),
      tokens,
      level: 1,
      kind: 'rule',
      status: validationStatus(tokens, validation),
      help: conversionRuleHelp(rule, type)
    }),
    ...conditionMappingNodes(rule, type, validation)
  ];
}

function ruleMeta(rule) {
  const parts = [rule.fallback ? 'fallback' : `priority ${rule.priority}`];
  if (rule.mode) {
    parts.push(`mode ${rule.mode}`);
  }
  if (rule.valueField) {
    parts.push(`value ${rule.valueField}`);
  }
  return parts.join(' | ');
}

function conditionMappingNodes(rule, type, validation = null) {
  const regexNodes = [
    ...(rule.when?.anyRegex ?? []).map(matcher => ({ matcher, mode: 'anyRegex' })),
    ...(rule.when?.allRegex ?? []).map(matcher => ({ matcher, mode: 'allRegex' }))
  ].map(({ matcher, mode }) => {
    const tokens = [
      `rule:${normalizeToken(rule.name)}`,
      ...targetTokensForRuleType(type),
      ...sourceFieldTokens(matcher.field),
      ...regexLiteralTokens(matcher.field, matcher.pattern)
    ];
    return mappingNode({
      label: matcher.field,
      meta: `${mode}: ${matcher.pattern}`,
      tokens,
      level: 2,
      kind: 'regex',
      status: validationStatus(tokens, validation),
      help: `Regex condition правила "${rule.name}". ${mode} читает class attribute field "${matcher.field}" и сравнивает значение с pattern "${matcher.pattern}". allRegex требует совпадения всех условий, anyRegex требует совпадения одного из условий.`
    });
  });
  const existsFields = [
    rule.when?.fieldExists,
    ...(Array.isArray(rule.when?.fieldsExist) ? rule.when.fieldsExist : [])
  ].filter(Boolean);
  const existsNodes = existsFields.map(field => {
    const tokens = [
      `rule:${normalizeToken(rule.name)}`,
      ...targetTokensForRuleType(type),
      ...sourceFieldTokens(field)
    ];
    return mappingNode({
      label: field,
      meta: 'field exists',
      tokens,
      level: 2,
      kind: 'regex',
      status: validationStatus(tokens, validation),
      help: `Condition правила "${rule.name}" проверяет, что class attribute field "${field}" присутствует и не пустой.`
    });
  });
  return [...regexNodes, ...existsNodes];
}

function ruleTokens(rule, type, rules = null) {
  const tokens = [
    ruleValidationToken(rule, type),
    `rule:${normalizeToken(rule.name)}`,
    ...targetTokensForRuleType(type),
    ...conditionTokens(rule.when),
    ...conditionMatchTokens(rule.when)
  ];

  for (const item of rules ? selectionItemsForRule(rules, rule, type) : rule[type] ?? []) {
    if (type === 'hostGroups') {
      tokens.push(`zbx-hostGroups:${normalizeToken(item.groupid || item.name)}`);
    } else if (type === 'templates') {
      tokens.push(`zbx-templates:${normalizeToken(item.templateid || item.name)}`);
    } else if (type === 'templateGroups') {
      tokens.push(`zbx-templateGroups:${normalizeToken(item.groupid || item.name)}`);
    } else if (type === 'tags') {
      tokens.push(`zbx-tags:${normalizeToken(item.tag)}`, ...tagValueTokens(item));
    } else {
      tokens.push(...zabbixRuleItemTokens(type, item));
    }
  }

  if (type === 'interface') {
    tokens.push(`target:interfaces`, `interface:${normalizeToken(rule.interfaceRef)}`);
  }
  if (type === 'interfaceProfiles' && rule.interfaceProfileRef) {
    tokens.push(
      'target:interfaces',
      `target:${type}`,
      `interface:${normalizeToken(rule.interfaceProfileRef)}`,
      `zbx-interfaceProfiles:${normalizeToken(rule.interfaceProfileRef)}`
    );
  }
  if (type === 'interfaceAddress') {
    tokens.push(
      'target:interfaces',
      `interface-address:${normalizeToken(rule.mode || rule.valueField)}`,
      ...sourceFieldTokens(rule.valueField),
      ...sourceFieldTargetTokens(rule.valueField)
    );
  }
  if (type === 'hostProfiles') {
    tokens.push(...hostProfileTokens(rule));
  }

  if (rule.fallback) {
    tokens.push(`fallback:${type}`);
  }

  return uniqueTokens(tokens);
}

function hostProfileTokens(profile) {
  const profileName = profile.name || 'default';
  const interfaceTokens = (profile.interfaces ?? []).flatMap(item => {
    const interfaceProfile = item.interfaceProfileRef || item.interfaceRef || profile.interfaceProfileRef || profile.interfaceRef || '';
    return [
      `interface:${normalizeToken(interfaceProfile)}`,
      `zbx-interfaceProfiles:${normalizeToken(interfaceProfile)}`,
      ...sourceFieldTokens(item.valueField || profile.valueField),
      ...sourceFieldTargetTokens(item.valueField || profile.valueField),
      ...conditionTokens(item.when),
      ...conditionMatchTokens(item.when)
    ];
  });
  return uniqueTokens([
    `profile:${normalizeToken(profileName)}`,
    'target:host',
    'target:interfaces',
    ...conditionTokens(profile.when),
    ...conditionMatchTokens(profile.when),
    ...templateStringTokens(profile.hostNameTemplate),
    ...templateStringTokens(profile.visibleNameTemplate),
    ...interfaceTokens
  ]);
}

function targetTokensForRuleType(type) {
  if (type === 'hostGroups') {
    return ['target:groups'];
  }
  if (type === 'interface' || type === 'interfaceAddress' || type === 'interfaceProfiles' || type === 'hostProfiles') {
    return ['target:interfaces'];
  }
  return [`target:${type}`];
}

function zabbixRuleItemTokens(type, item) {
  const definition = zabbixExtensionDefinitions.find(value => value.rulesKey === type);
  if (!definition) {
    return [];
  }

  return zabbixExtensionTokens(definition, item);
}

function appendHostProfilesSection(container, rules) {
  const profiles = rules.hostProfiles ?? [];
  const nodes = profiles.length > 0
    ? profiles.flatMap(profile => hostProfileMappingNodes(profile))
    : [emptyConversionBlockNode('Host profiles', 'hostProfiles')];
  appendMappingSection(container, 'Host profiles', nodes, {
    expanded: false,
    status: profiles.length > 0 ? sectionStatusFromNodes(nodes) : 'warning',
    help: mappingSectionHelp('Host profiles')
  });
}

function hostProfileMappingNodes(profile, validation = null) {
  const profileName = profile.name || 'default';
  const tokens = hostProfileTokens(profile);
  return [
    mappingNode({
      label: profileName,
      meta: `priority ${profile.priority ?? 1000}${profile.fallback ? ' | fallback' : ''}`,
      tokens,
      level: 1,
      kind: 'rule',
      status: validationStatus(tokens, validation),
      help: hostProfileHelp(profile)
    }),
    ...conditionMappingNodes(profile, 'hostProfiles', validation),
    ...((profile.interfaces ?? []).flatMap(item => hostProfileInterfaceMappingNodes(profile, item, validation)))
  ];
}

function hostProfileInterfaceMappingNodes(profile, item, validation = null) {
  const profileName = profile.name || 'default';
  const interfaceProfile = item.interfaceProfileRef || item.interfaceRef || profile.interfaceProfileRef || profile.interfaceRef || 'selected interface';
  const valueField = item.valueField || profile.valueField || '';
  const tokens = uniqueTokens([
    `profile:${normalizeToken(profileName)}`,
    'target:interfaces',
    `interface:${normalizeToken(interfaceProfile)}`,
    `zbx-interfaceProfiles:${normalizeToken(interfaceProfile)}`,
    ...sourceFieldTokens(valueField),
    ...sourceFieldTargetTokens(valueField),
    ...targetTokensForRuleType('hostProfiles'),
    ...conditionTokens(item.when),
    ...conditionMatchTokens(item.when)
  ]);
  return [
    mappingNode({
      label: item.name || interfaceProfile,
      meta: `${item.mode || profile.mode || 'mode auto'} ${valueField ? `| ${valueField}` : ''}`,
      tokens,
      level: 2,
      kind: 'rule',
      status: validationStatus(tokens, validation),
      help: hostProfileInterfaceHelp(profile, item)
    }),
    ...conditionMappingNodes(item, 'hostProfiles', validation)
  ];
}

function eventRoutingRuleTokens(rule, rules) {
  const templateNames = [rule.templateName, rule.fallbackTemplateName].filter(Boolean);
  return uniqueTokens([
    `event:${normalizeToken(rule.eventType)}`,
    `method:${normalizeToken(rule.method)}`,
    ...templateNames.map(name => `template:${normalizeToken(name)}`),
    'target:method',
    ...(rule.requiredFields ?? []).flatMap(field => requiredFieldTokens(field)),
    ...templateSourceFieldTokens(rules, templateNames)
  ]);
}

function requiredFieldTokens(field) {
  return equalsIgnoreCase(field, 'interfaceAddress')
    ? ['target:interfaces', ...sourceFieldTokens('ipAddress'), ...sourceFieldTokens('dnsName')]
    : sourceFieldTokens(field);
}

function templateSourceFieldTokens(rules, templateNames) {
  const fields = new Set();
  for (const templateName of templateNames) {
    const templateLines = rules?.t4Templates?.[templateName];
    if (!Array.isArray(templateLines)) {
      continue;
    }

    for (const match of templateLines.join('\n').matchAll(/Model\.([A-Za-z0-9_]+)/g)) {
      const field = canonicalSourceField(match[1]);
      if (isKnownMappingSourceField(rules, field)) {
        fields.add(field);
      }
    }
  }

  return [...fields].flatMap(field => sourceFieldTokens(field));
}

function templateStringTokens(template = '') {
  return [
    ...[...String(template).matchAll(/Model\.Field\(["']([^"']+)["']\)/g)].map(match => match[1]),
    ...[...String(template).matchAll(/Model\.([A-Za-z0-9_]+)/g)]
      .map(match => canonicalSourceField(match[1]))
      .filter(field => field !== 'field')
  ].flatMap(field => sourceFieldTokens(field));
}

function isKnownMappingSourceField(rules, field) {
  return Boolean(rules?.source?.fields?.[field])
    || ['eventType', 'zabbixHostId', 'ipAddress', 'dnsName', 'hostProfile', 'outputProfile'].includes(canonicalSourceField(field));
}

function selectionItemsForRule(rules, rule, type) {
  const singularKey = singularRuleKey(type);
  const singularItems = singularKey !== type && rule[singularKey]
    ? [rule[singularKey]]
    : [];
  const singularRefItems = singularKey !== type
    ? itemsFromRulesRef(rules, rule[`${singularKey}Ref`])
    : [];
  return [
    ...asArray(rule[type]),
    ...singularItems,
    ...itemsFromRulesRef(rules, rule[`${type}Ref`]),
    ...singularRefItems
  ];
}

function itemsFromRulesRef(rules, ref) {
  if (!ref) {
    return [];
  }

  const value = String(ref)
    .split('.')
    .reduce((current, part) => current?.[part], rules);
  return Array.isArray(value) ? value : [];
}

function conditionTokens(condition = {}) {
  if (condition.always) {
    return ['condition:always'];
  }

  return uniqueTokens([
    ...(condition.anyRegex ?? []).flatMap(matcher => sourceFieldTokens(matcher.field)),
    ...(condition.allRegex ?? []).flatMap(matcher => sourceFieldTokens(matcher.field)),
    ...[
      condition.fieldExists,
      ...(Array.isArray(condition.fieldsExist) ? condition.fieldsExist : [])
    ].filter(Boolean).flatMap(field => sourceFieldTokens(field))
  ]);
}

function conditionMatchTokens(condition = {}) {
  return [
    ...(condition.anyRegex ?? []),
    ...(condition.allRegex ?? [])
  ].flatMap(matcher => regexLiteralTokens(matcher.field, matcher.pattern));
}

function regexLiteralTokens(field, pattern) {
  const sourceField = canonicalSourceField(field);
  return regexLiteralValues(pattern).map(value => `match:${sourceField}:${normalizeToken(value)}`);
}

function sourceFieldTokens(fieldKey, sourceName = fieldKey) {
  const token = canonicalSourceField(fieldKey);
  const sourceToken = canonicalSourceField(sourceName);
  return uniqueTokens([
    `source:${token}`,
    `source:${sourceToken}`,
    `cmdb-field:${normalizeToken(sourceName)}`
  ]);
}

function sourceFieldTargetTokens(fieldKey) {
  return {
    entityId: ['target:host', 'target:id', 'target:tags', 'target:fallback'],
    id: ['target:host', 'target:id', 'target:tags', 'target:fallback'],
    code: ['target:host', 'target:name'],
    className: ['target:name', 'target:tags', 'target:groups', 'target:templates'],
    ipAddress: interfaceIpPayloadTokens(),
    dnsName: interfaceDnsPayloadTokens(),
    profileIpAddress: interfaceIpPayloadTokens(),
    profile2IpAddress: interfaceIpPayloadTokens(),
    profileDnsName: interfaceDnsPayloadTokens(),
    interfaceIpAddress: interfaceIpPayloadTokens(),
    interface2IpAddress: interfaceIpPayloadTokens(),
    hostProfile: ['target:host', 'target:interfaces', 'target:groups', 'target:templates', 'target:tags'],
    outputProfile: ['target:host', 'target:interfaces', 'target:groups', 'target:templates', 'target:tags'],
    description: ['target:groups', 'target:templates', 'target:interfaces'],
    os: ['target:groups', 'target:templates', 'target:tags'],
    zabbixTag: ['target:tags'],
    zabbixHostId: ['target:hostid', 'target:fallback'],
    eventType: ['target:method', 'target:tags']
  }[canonicalSourceField(fieldKey)] ?? [];
}

function interfaceIpPayloadTokens() {
  return ['target-field:interfaces.ip', 'target-field:interfaces.useip'];
}

function interfaceDnsPayloadTokens() {
  return ['target-field:interfaces.dns', 'target-field:interfaces.useip'];
}

function templateTargetTokens(name) {
  const normalized = normalizeToken(name);
  if (normalized.includes('create') || normalized.includes('update')) {
    return ['target:host', 'target:name', 'target:interfaces', 'target:groups', 'target:templates', 'target:tags'];
  }

  if (normalized.includes('delete')) {
    return ['target:hostid'];
  }

  return ['target:fallback', 'target:host'];
}

function tagValueTokens(tag) {
  const template = String(tag.valueTemplate ?? '');
  const fields = [
    ...[...template.matchAll(/Model\.Source\(["']([^"']+)["']\)/g)].map(match => match[1]),
    ...[...template.matchAll(/Model\.([A-Za-z0-9_]+)/g)]
      .map(match => match[1])
      .filter(field => field !== 'Source')
  ];

  return fields.flatMap(field => sourceFieldTokens(field));
}

function lookupSourceFields(rules, catalog = null) {
  const fields = new Set();
  const classes = rules.source?.entityClasses ?? [];

  for (const [fieldKey, field] of Object.entries(rules.source?.fields ?? {})) {
    const sources = sourceFieldSources(field);
    if (sources.some(sourceName => equalsIgnoreCase(sourceName, 'OS') || equalsIgnoreCase(sourceName, 'zabbixTag'))
        || equalsIgnoreCase(field.type, 'lookup')
        || equalsIgnoreCase(field.resolve?.leafType, 'lookup')
        || Boolean(field.lookupType)
        || Boolean(field.resolve?.lookupType)) {
      fields.add(canonicalSourceField(fieldKey));
      continue;
    }

    if (!catalog) {
      continue;
    }

    const hasLookupAttribute = classes.some(className => {
      const catalogClass = findCatalogClass(catalog, className);
      if (!catalogClass || isCmdbCatalogSuperclass(catalog, catalogClass)) {
        return false;
      }

      const attributes = catalogAttributesForClass(catalog ?? {}, catalogClass);
      const attribute = findCatalogAttributeForField(attributes, field, fieldKey);
      return isLookupAttribute(attribute);
    });
    if (hasLookupAttribute) {
      fields.add(canonicalSourceField(fieldKey));
    }
  }

  return [...fields];
}

function isLookupAttribute(attribute) {
  return Boolean(attribute)
    && (equalsIgnoreCase(attribute.type, 'lookup')
      || equalsIgnoreCase(attribute.type, 'lookupArray')
      || Boolean(attribute.lookupType));
}

function cmdbLookupNodes(rules, catalog, lookupName, className, level = 1) {
  const lookup = (catalog.lookups ?? []).find(item => equalsIgnoreCase(item.name, lookupName) || equalsIgnoreCase(item._id, lookupName));
  const nodes = [mappingNode({
    label: `lookup ${lookup?.name ?? lookupName}`,
    meta: lookup ? `${lookup.accessType ?? 'default'} lookup` : 'configured lookup',
    tokens: [
      ...sourceFieldTokens(lookupName),
      ...lookupFieldTokens(lookupName),
      classFieldToken(className, canonicalSourceField(lookupName))
    ],
    level,
    kind: 'lookup',
    help: lookupHelp(className, lookupName, lookup)
  })];

  for (const value of lookupValuesForMapping(rules, catalog, lookupName, lookup)) {
    nodes.push(mappingNode({
      label: value.label,
      meta: value.id ? `id ${value.id}` : 'value',
      tokens: [
        ...lookupFieldTokens(lookupName),
        classFieldToken(className, canonicalSourceField(lookupName)),
        classLookupValueToken(className, lookupName, value.id || value.label),
        `lookup-value:${normalizeToken(lookupName)}:${normalizeToken(value.id || value.label)}`,
        ...[value.id, value.label].filter(Boolean).map(item => `match:${canonicalSourceField(lookupName)}:${normalizeToken(item)}`)
      ],
      level: level + 1,
      kind: 'lookup',
      help: lookupValueHelp(className, lookupName, value)
    }));
  }

  return nodes;
}

function lookupValuesForMapping(rules, catalog, lookupName, lookup = null) {
  const values = new Map();
  const put = value => {
    const key = normalizeToken(value.id || value.label);
    if (key && !values.has(key)) {
      values.set(key, value);
    }
  };

  const catalogLookup = lookup ?? (catalog.lookups ?? [])
    .find(item => equalsIgnoreCase(item.name, lookupName) || equalsIgnoreCase(item._id, lookupName));
  for (const value of lookupValuesFromCatalog(catalogLookup)) {
    put(value);
  }
  for (const value of lookupValuesFromRules(rules, lookupName)) {
    put(value);
  }
  return [...values.values()];
}

function lookupValuesFromCatalog(lookup) {
  return asArray(lookup?.values).map(item => {
    const id = item?._id ?? item?.id ?? '';
    const label = item?.code ?? item?.description ?? item?._description_translation ?? id;
    return { id, label };
  }).filter(item => item.id || item.label);
}

function lookupValuesFromRules(rules, lookupName) {
  const field = canonicalSourceField(lookupName);
  const values = new Map();
  for (const rule of [
    ...(rules.groupSelectionRules ?? []),
    ...(rules.templateSelectionRules ?? []),
    ...(rules.tagSelectionRules ?? [])
  ]) {
    for (const matcher of [
      ...(rule.when?.anyRegex ?? []),
      ...(rule.when?.allRegex ?? [])
    ]) {
      if (!equalsIgnoreCase(canonicalSourceField(matcher.field), field)) {
        continue;
      }

      for (const value of pairLookupLiterals(regexLiteralValues(matcher.pattern))) {
        const key = normalizeToken(value.id || value.label);
        if (key && !values.has(key)) {
          values.set(key, value);
        }
      }
    }
  }

  return [...values.values()];
}

function pairLookupLiterals(literals) {
  const textValues = literals.filter(item => !/^\d+$/.test(item));
  const idValues = literals.filter(item => /^\d+$/.test(item));
  if (textValues.length > 0 && idValues.length > 0) {
    return textValues.map((label, index) => ({ label, id: idValues[index] ?? '' }));
  }

  return literals.map(item => /^\d+$/.test(item) ? { label: item, id: item } : { label: item, id: '' });
}

function lookupFieldTokens(fieldKey, lookupFields = null) {
  const field = canonicalSourceField(fieldKey);
  if (lookupFields && !lookupFields.has(field)) {
    return [];
  }

  return [`field-lookup:${field}`, `lookup:${normalizeToken(field)}`];
}

function classFieldToken(className, fieldKey) {
  return `class-field:${normalizeToken(className)}:${canonicalSourceField(fieldKey)}`;
}

function classLookupValueToken(className, lookupName, value) {
  return `class-lookup-value:${normalizeToken(className)}:${canonicalSourceField(lookupName)}:${normalizeToken(value)}`;
}

function targetKey(field) {
  const value = String(field ?? '');
  if (value.startsWith('interfaces')) {
    return 'interfaces';
  }
  if (value.startsWith('templates')) {
    return 'templates';
  }
  if (value.startsWith('groups')) {
    return 'groups';
  }
  if (value.startsWith('tags')) {
    return 'tags';
  }
  return normalizeToken(value);
}

function monitoringFieldTokens(field) {
  const key = monitoringFieldKey(field);
  return uniqueTokens([
    `target:${targetKey(field)}`,
    key ? `target-field:${key}` : ''
  ]);
}

function monitoringFieldKey(field) {
  return String(field ?? '')
    .toLowerCase()
    .replace(/\[\]/g, '')
    .replace(/[^a-z0-9.]+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\./, '')
    .replace(/\.$/, '');
}

function classMeta(catalog, className) {
  const item = findCatalogClass(catalog ?? {}, className);
  return item ? `${item.parent ?? 'Class'} / ${item.active === false ? 'inactive' : 'active'}` : 'configured';
}

function findCatalogAttribute(attributes, sourceName, fieldKey) {
  const wanted = [sourceName, fieldKey, canonicalSourceField(fieldKey)].map(normalizeToken);
  return attributes.find(attribute => wanted.includes(normalizeToken(attribute.name)) || wanted.includes(normalizeToken(attribute.alias)));
}

async function loadRuntimeSettings() {
  state.runtimeSettings = await api('/api/settings/runtime');
  fillRuntimeSettingsForm(state.runtimeSettings);
  renderEventTopics(state.runtimeSettings.eventBrowser?.topics ?? [], $('#eventsTopic').value);
  $('#eventsMaxMessages').value ||= String(defaultEventMaxMessages);
  return state.runtimeSettings;
}

async function saveRuntimeSettings() {
  const previousDepth = clampNumber(state.runtimeSettings?.cmdbuild?.maxTraversalDepth, 2, 2, 5);
  const body = readRuntimeSettingsForm();
  const result = await api('/api/settings/runtime', {
    method: 'PUT',
    body
  });
  state.runtimeSettings = result;
  fillRuntimeSettingsForm(result);
  renderEventTopics(result.eventBrowser?.topics ?? [], $('#eventsTopic').value);
  const nextDepth = clampNumber(result.cmdbuild?.maxTraversalDepth, 2, 2, 5);
  toast(nextDepth !== previousDepth ? t('toast.runtimeSavedResyncRequired') : t('toast.runtimeSaved'));
}

async function loadAuthSettings() {
  const result = await api('/api/settings/idp');
  state.idp = result;
  state.auth = {
    ...(state.auth ?? {}),
    useIdp: Boolean(result.enabled),
    provider: normalizeIdpProvider(result.provider)
  };
  fillIdpForm(result);
  if (currentRole() === 'admin') {
    await loadUsers();
  }
  return result;
}

function fillRuntimeSettingsForm(settings) {
  const form = $('#runtimeSettingsForm');
  const cmdbuild = settings.cmdbuild ?? {};
  const zabbix = settings.zabbix ?? {};
  const rules = settings.rules ?? {};
  const eventBrowser = settings.eventBrowser ?? {};

  form.elements.filePath.value = settings.filePath ?? '';
  form.elements.usersFilePath.value = settings.usersFilePath ?? '';
  form.elements.cmdbuildBaseUrl.value = cmdbuild.baseUrl ?? '';
  form.elements.cmdbuildMaxTraversalDepth.value = clampNumber(cmdbuild.maxTraversalDepth, 2, 2, 5);
  form.elements.zabbixApiEndpoint.value = zabbix.apiEndpoint ?? '';
  form.elements.zabbixApiToken.value = zabbix.apiToken ?? '';
  form.elements.rulesFilePath.value = rules.rulesFilePath || defaultConversionRulesFilePath;
  form.elements.rulesReadFromGit.checked = Boolean(rules.readFromGit);
  form.elements.rulesRepositoryUrl.value = rules.repositoryUrl ?? '';
  updateRuntimeRulesUiState();
  updateIdpUiState();

  form.elements.eventsEnabled.checked = Boolean(eventBrowser.enabled);
  form.elements.eventsBootstrapServers.value = eventBrowser.bootstrapServers ?? '';
  form.elements.eventsClientId.value = eventBrowser.clientId ?? '';
  form.elements.eventsSecurityProtocol.value = eventBrowser.securityProtocol ?? 'Plaintext';
  form.elements.eventsSaslMechanism.value = eventBrowser.saslMechanism ?? '';
  form.elements.eventsUsername.value = eventBrowser.username ?? '';
  form.elements.eventsPassword.value = eventBrowser.password ?? '';
  form.elements.eventsSslRejectUnauthorized.checked = eventBrowser.sslRejectUnauthorized !== false;
  form.elements.eventsMaxMessages.value = eventBrowser.maxMessages ?? 50;
  form.elements.eventsReadTimeoutMs.value = eventBrowser.readTimeoutMs ?? 2500;
  form.elements.eventsTopics.value = JSON.stringify(eventBrowser.topics ?? [], null, 2);
}

function updateRuntimeRulesUiState() {
  const form = $('#runtimeSettingsForm');
  if (!form) {
    return;
  }

  const enabled = Boolean(form.elements.rulesReadFromGit?.checked);
  const rulesPath = form.elements.rulesFilePath?.value?.trim() || defaultConversionRulesFilePath;
  if (form.elements.rulesRepositoryUrl) {
    form.elements.rulesRepositoryUrl.readOnly = !enabled;
  }
  const note = $('#rulesReadModeNote');
  if (note) {
    note.textContent = tf(enabled ? 'settings.rulesReadModeGit' : 'settings.rulesReadModeDisk', { path: rulesPath });
  }
}

function readRuntimeSettingsForm() {
  const form = new FormData($('#runtimeSettingsForm'));
  const cmdbuildBaseUrl = form.get('cmdbuildBaseUrl');
  const zabbixApiEndpoint = form.get('zabbixApiEndpoint');
  return {
    cmdbuild: {
      baseUrl: cmdbuildBaseUrl,
      maxTraversalDepth: Number(form.get('cmdbuildMaxTraversalDepth') || 2)
    },
    zabbix: {
      apiEndpoint: zabbixApiEndpoint,
      apiToken: form.get('zabbixApiToken')
    },
    rules: {
      rulesFilePath: String(form.get('rulesFilePath') || '').trim() || defaultConversionRulesFilePath,
      readFromGit: form.get('rulesReadFromGit') === 'on',
      repositoryUrl: form.get('rulesRepositoryUrl')
    },
    eventBrowser: {
      enabled: form.get('eventsEnabled') === 'on',
      bootstrapServers: form.get('eventsBootstrapServers'),
      clientId: form.get('eventsClientId'),
      securityProtocol: form.get('eventsSecurityProtocol'),
      saslMechanism: form.get('eventsSaslMechanism'),
      username: form.get('eventsUsername'),
      password: form.get('eventsPassword'),
      sslRejectUnauthorized: form.get('eventsSslRejectUnauthorized') === 'on',
      maxMessages: Number(form.get('eventsMaxMessages')),
      readTimeoutMs: Number(form.get('eventsReadTimeoutMs')),
      topics: JSON.parse(form.get('eventsTopics') || '[]')
    }
  };
}

async function saveIdp() {
  const elements = $('#idpForm').elements;
  const value = name => elements[name]?.value ?? '';
  const checked = name => Boolean(elements[name]?.checked);
  const authMode = value('authMode') || currentAuthMode();
  const provider = authMode === 'msad'
    ? 'ldap'
    : authMode === 'idp'
      ? normalizeIdpProvider(value('provider'))
      : normalizeIdpProvider(state.idp?.provider ?? value('provider') ?? 'saml2');
  const result = await api('/api/settings/idp', {
    method: 'PUT',
    body: {
      enabled: authMode !== 'local',
      provider: provider === 'ldap' && authMode === 'idp' ? 'saml2' : provider,
      metadataUrl: value('metadataUrl'),
      entityId: value('entityId'),
      ssoUrl: value('ssoUrl'),
      sloUrl: value('sloUrl'),
      spEntityId: value('spEntityId'),
      acsUrl: value('acsUrl'),
      sloCallbackUrl: value('sloCallbackUrl'),
      nameIdFormat: value('nameIdFormat'),
      authnRequestBinding: value('authnRequestBinding'),
      requireSignedResponses: checked('requireSignedResponses'),
      requireSignedAssertions: checked('requireSignedAssertions'),
      idpX509Certificate: value('idpX509Certificate'),
      spCertificate: value('spCertificate'),
      spPrivateKey: value('spPrivateKey'),
      roleMapping: {
        admin: value('roleAdminGroups'),
        editor: value('roleEditorGroups'),
        viewer: value('roleViewerGroups')
      },
      oauth2: {
        authorizationUrl: value('oauth2AuthorizationUrl'),
        tokenUrl: value('oauth2TokenUrl'),
        userInfoUrl: value('oauth2UserInfoUrl'),
        clientId: value('oauth2ClientId'),
        clientSecret: value('oauth2ClientSecret'),
        redirectUri: value('oauth2RedirectUri'),
        scopes: value('oauth2Scopes'),
        loginClaim: value('oauth2LoginClaim'),
        emailClaim: value('oauth2EmailClaim'),
        displayNameClaim: value('oauth2DisplayNameClaim'),
        groupsClaim: value('oauth2GroupsClaim')
      },
      ldap: {
        protocol: value('ldapProtocol'),
        host: value('ldapHost'),
        port: Number(value('ldapPort')),
        baseDn: value('ldapBaseDn'),
        bindDn: value('ldapBindDn'),
        bindPassword: value('ldapBindPassword'),
        userDnTemplate: value('ldapUserDnTemplate'),
        userSearchBase: value('ldapUserSearchBase'),
        userFilter: value('ldapUserFilter'),
        groupSearchBase: value('ldapGroupSearchBase'),
        groupFilter: value('ldapGroupFilter'),
        groupNameAttribute: value('ldapGroupNameAttribute'),
        loginAttribute: value('ldapLoginAttribute'),
        emailAttribute: value('ldapEmailAttribute'),
        displayNameAttribute: value('ldapDisplayNameAttribute'),
        groupsAttribute: value('ldapGroupsAttribute'),
        tlsRejectUnauthorized: checked('ldapTlsRejectUnauthorized')
      }
    }
  });
  fillIdpForm(result);
  state.idp = result;
  state.auth = state.auth ?? {};
  state.auth.useIdp = Boolean(result.enabled);
  state.auth.provider = normalizeIdpProvider(result.provider);
  updateIdpUiState();
  toast(t('toast.idpSaved'));
}

function fillIdpForm(idp) {
  const form = $('#idpForm');
  const provider = normalizeIdpProvider(idp.provider ?? 'saml2');
  form.elements.authMode.value = !idp.enabled ? 'local' : provider === 'ldap' ? 'msad' : 'idp';
  form.elements.provider.value = provider === 'ldap' ? 'saml2' : provider;
  for (const field of ['metadataUrl', 'entityId', 'ssoUrl', 'sloUrl', 'spEntityId', 'acsUrl', 'sloCallbackUrl', 'nameIdFormat', 'authnRequestBinding']) {
    form.elements[field].value = idp[field] ?? '';
  }
  form.elements.requireSignedResponses.checked = Boolean(idp.requireSignedResponses);
  form.elements.requireSignedAssertions.checked = Boolean(idp.requireSignedAssertions);
  const mapping = idp.roleMapping ?? {};
  form.elements.roleAdminGroups.value = normalizeGroupInput(mapping.admin ?? mapping.Admin);
  form.elements.roleEditorGroups.value = normalizeGroupInput(mapping.editor ?? mapping.Editor);
  form.elements.roleViewerGroups.value = normalizeGroupInput(mapping.viewer ?? mapping.Viewer);
  const oauth2 = idp.oauth2 ?? {};
  for (const [elementName, value] of Object.entries({
    oauth2AuthorizationUrl: oauth2.authorizationUrl,
    oauth2TokenUrl: oauth2.tokenUrl,
    oauth2UserInfoUrl: oauth2.userInfoUrl,
    oauth2ClientId: oauth2.clientId,
    oauth2ClientSecret: '',
    oauth2RedirectUri: oauth2.redirectUri,
    oauth2Scopes: oauth2.scopes,
    oauth2LoginClaim: oauth2.loginClaim,
    oauth2EmailClaim: oauth2.emailClaim,
    oauth2DisplayNameClaim: oauth2.displayNameClaim,
    oauth2GroupsClaim: oauth2.groupsClaim
  })) {
    form.elements[elementName].value = value ?? '';
  }
  const ldap = idp.ldap ?? {};
  for (const [elementName, value] of Object.entries({
    ldapProtocol: ldap.protocol,
    ldapHost: ldap.host,
    ldapPort: ldap.port,
    ldapBaseDn: ldap.baseDn,
    ldapBindDn: ldap.bindDn,
    ldapBindPassword: '',
    ldapUserDnTemplate: ldap.userDnTemplate,
    ldapUserSearchBase: ldap.userSearchBase,
    ldapUserFilter: ldap.userFilter,
    ldapGroupSearchBase: ldap.groupSearchBase,
    ldapGroupFilter: ldap.groupFilter,
    ldapGroupNameAttribute: ldap.groupNameAttribute,
    ldapLoginAttribute: ldap.loginAttribute,
    ldapEmailAttribute: ldap.emailAttribute,
    ldapDisplayNameAttribute: ldap.displayNameAttribute,
    ldapGroupsAttribute: ldap.groupsAttribute
  })) {
    form.elements[elementName].value = value ?? '';
  }
  form.elements.ldapTlsRejectUnauthorized.checked = ldap.tlsRejectUnauthorized !== false;
  updateIdpUiState();
}

function normalizeGroupInput(value) {
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
}

function updateIdpUiState() {
  const idpForm = $('#idpForm');
  const authMode = idpForm?.elements.authMode?.value ?? currentAuthMode();
  const rawProvider = idpForm?.elements.provider?.value ?? currentIdpProvider();
  const provider = authMode === 'msad' ? 'ldap' : normalizeIdpProvider(rawProvider) === 'ldap' ? 'saml2' : normalizeIdpProvider(rawProvider);
  const enabled = authMode !== 'local';
  state.auth = { ...(state.auth ?? {}), useIdp: enabled, provider };
  state.idp = { ...(state.idp ?? {}), enabled, provider };

  const providerRow = $('#idpProviderRow');
  if (providerRow) {
    providerRow.classList.toggle('hidden', authMode !== 'idp');
    providerRow.classList.toggle('is-disabled', authMode !== 'idp');
    const providerSelect = providerRow.querySelector('select');
    if (providerSelect) {
      providerSelect.disabled = authMode !== 'idp';
      providerSelect.value = provider === 'ldap' ? 'saml2' : provider;
    }
  }

  for (const block of $$('.idp-provider-block')) {
    const isSamlBlock = block.id === 'samlSettingsBlock';
    const isOauth2Block = block.id === 'oauth2SettingsBlock';
    const isLdapBlock = block.id === 'ldapSettingsBlock';
    const visible = isLdapBlock
      ? authMode !== 'local'
      : authMode === 'idp' && ((isSamlBlock && provider === 'saml2') || (isOauth2Block && provider === 'oauth2'));
    const isActiveProvider = isLdapBlock
      ? authMode !== 'local'
      : visible;
    block.hidden = !visible;
    block.disabled = !visible;
    block.classList.toggle('is-disabled', !visible);
    block.classList.toggle('is-active-provider', isActiveProvider);
  }
  $('#roleMappingBlock')?.classList.toggle('is-disabled', !enabled);
  $$('#roleMappingBlock input').forEach(input => {
    input.disabled = !enabled;
  });

  const idpDependentDisabled = authMode !== 'idp';
  $$('.idp-dependent input, .idp-dependent select').forEach(input => {
    input.disabled = idpDependentDisabled;
  });
  $$('.idp-dependent').forEach(node => {
    node.classList.toggle('is-disabled', idpDependentDisabled);
  });

  const userAdmin = $('#userAdminForm');
  if (userAdmin) {
    const localUsersActive = userAdmin.elements.localUsersActive;
    if (localUsersActive) {
      localUsersActive.checked = authMode === 'local';
    }
    userAdmin.classList.toggle('is-disabled', authMode !== 'local');
    [...userAdmin.elements].forEach(element => {
      element.disabled = element.name === 'localUsersActive' || authMode !== 'local';
    });
  }
}

function openPasswordDialog() {
  $('#passwordError').textContent = '';
  $('#passwordForm').reset();
  $('#passwordDialog').classList.remove('hidden');
  $('#passwordForm').elements.currentPassword.focus();
}

function closePasswordDialog() {
  if (state.user?.passwordChangeRequired) {
    return;
  }

  $('#passwordDialog').classList.add('hidden');
}

async function changeOwnPassword(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const newPassword = String(form.get('newPassword') ?? '');
  if (newPassword !== String(form.get('confirmPassword') ?? '')) {
    $('#passwordError').textContent = state.language === 'ru' ? 'Новые пароли не совпадают.' : 'New passwords do not match.';
    return;
  }

  try {
    const result = await api('/api/auth/change-password', {
      method: 'POST',
      body: {
        currentPassword: form.get('currentPassword'),
        newPassword
      }
    });
    state.user = result.user;
    closePasswordDialog();
    updateSessionSummary();
    toast(state.language === 'ru' ? 'Пароль обновлен' : 'Password updated');
  } catch (error) {
    $('#passwordError').textContent = error.message;
  }
}

async function loadUsers() {
  if (currentRole() !== 'admin') {
    return null;
  }

  const result = await api('/api/users');
  state.users = result.users ?? [];
  renderUsers(state.users);
  return result;
}

function renderUsers(users) {
  const form = $('#userAdminForm');
  const select = form.elements.username;
  const current = select.value;
  clear(select);
  for (const user of users) {
    const option = document.createElement('option');
    option.value = user.username;
    option.textContent = `${user.username} | ${user.roleLabel}`;
    option.selected = user.username === current;
    select.append(option);
  }

  renderRows($('#usersTable'), users, user => [
    user.displayName ? `${user.username} (${user.displayName})` : user.username,
    user.roleLabel,
    user.mustChangePassword ? (state.language === 'ru' ? 'требуется' : 'required') : ''
  ]);
}

async function resetUserPassword() {
  const form = new FormData($('#userAdminForm'));
  const newPassword = String(form.get('newPassword') ?? '');
  if (!newPassword) {
    toast(state.language === 'ru' ? 'Введите новый пароль' : 'Enter a new password');
    return;
  }

  const result = await api('/api/users/reset-password', {
    method: 'POST',
    body: {
      username: form.get('username'),
      newPassword,
      mustChangePassword: form.get('mustChangePassword') === 'on'
    }
  });
  state.users = result.users ?? [];
  renderUsers(state.users);
  $('#userAdminForm').elements.newPassword.value = '';
  toast(state.language === 'ru' ? 'Пароль сброшен' : 'Password reset');
}

function promptSessionCredentials(details) {
  if (state.credentialPrompt) {
    state.credentialPrompt.reject(new Error('credentials_prompt_replaced'));
  }

  const dialog = $('#credentialsDialog');
  const form = $('#credentialsForm');
  form.reset();
  form.elements.service.value = details.service ?? '';
  form.elements.baseUrl.value = details.baseUrl ?? state.user?.cmdbuild?.baseUrl ?? '';
  form.elements.apiEndpoint.value = details.apiEndpoint ?? state.user?.zabbix?.apiEndpoint ?? '';
  $('#credentialsBaseUrlRow').classList.toggle('hidden', details.service !== 'cmdbuild');
  $('#credentialsApiEndpointRow').classList.toggle('hidden', details.service !== 'zabbix');
  $('#credentialsDialogTitle').textContent = details.service === 'zabbix'
    ? (state.language === 'ru' ? 'Нужны учетные данные Zabbix' : 'Zabbix credentials required')
    : (state.language === 'ru' ? 'Нужны учетные данные CMDBuild' : 'CMDBuild credentials required');
  const idpHint = details.service === 'zabbix'
    ? {
        ru: 'Внешняя авторизация UI не используется для backend-доступа к Zabbix. Нужен Zabbix API key или временные учетные данные.',
        en: 'External UI authentication is not used for backend access to Zabbix. A Zabbix API key or temporary credentials are required.'
      }
    : {
        ru: 'Внешняя авторизация UI не используется для backend-доступа к CMDBuild. Нужны временные учетные данные CMDBuild.',
        en: 'External UI authentication is not used for backend access to CMDBuild. Temporary CMDBuild credentials are required.'
      };
  $('#credentialsError').textContent = currentAuthMode() !== 'local'
    ? idpHint[state.language]
    : '';
  dialog.classList.remove('hidden');
  form.elements.username.focus();

  return new Promise((resolve, reject) => {
    state.credentialPrompt = { resolve, reject };
  });
}

function cancelCredentialPrompt() {
  $('#credentialsDialog').classList.add('hidden');
  if (state.credentialPrompt) {
    state.credentialPrompt.reject(new Error(state.language === 'ru' ? 'Ввод учетных данных отменен.' : 'Credential entry was cancelled.'));
    state.credentialPrompt = null;
  }
}

async function submitSessionCredentials(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const result = await api('/api/auth/session-credentials', {
      method: 'POST',
      body: {
        service: form.get('service'),
        baseUrl: form.get('baseUrl'),
        apiEndpoint: form.get('apiEndpoint'),
        username: form.get('username'),
        password: form.get('password')
      },
      retryCredentials: false
    });
    state.user = result.user;
    $('#credentialsDialog').classList.add('hidden');
    updateSessionSummary();
    state.credentialPrompt?.resolve();
    state.credentialPrompt = null;
  } catch (error) {
    $('#credentialsError').textContent = error.message;
  }
}

function bindHelp() {
  document.addEventListener('mouseover', event => {
    const target = event.target.closest('[data-help]');
    if (!target || target.closest('#helpPopover')) {
      return;
    }
    scheduleHelp(target);
  });

  document.addEventListener('mouseout', event => {
    const target = event.target.closest('[data-help]');
    if (!target || target.contains(event.relatedTarget)) {
      return;
    }
    cancelScheduledHelp();
    hideHelp();
  });

  document.addEventListener('focusin', event => {
    const target = event.target.closest('[data-help]');
    if (target && !target.closest('#helpPopover') && target.matches(':focus-visible')) {
      scheduleHelp(target);
    }
  });

  document.addEventListener('focusout', event => {
    if (event.target.closest('[data-help]')) {
      cancelScheduledHelp();
      hideHelp();
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      hideHelp();
    }
  });
}

function applyHelpText() {
  const selectorHelp = {
    '.brand': 'tooltip.brand',
    '#sessionSummary': 'tooltip.sessionSummary',
    '#idpLoginButton': 'tooltip.idpLoginButton',
    '#changePasswordOpen': 'tooltip.changePasswordOpen',
    '#logoutButton': 'tooltip.logoutButton',
    '#refreshDashboard': 'tooltip.refreshDashboard',
    '#eventsMaxMessages': 'tooltip.eventsMaxMessages',
    '#refreshEvents': 'tooltip.refreshEvents',
    '#loadRules': 'tooltip.loadRules',
    '#validateRules': 'tooltip.validateRules',
    '#createEmptyRules': 'tooltip.createEmptyRules',
    '#rulesFile': 'tooltip.rulesFile',
    '#dryRunPayload': 'tooltip.dryRunPayload',
    '#dryRunRules': 'tooltip.dryRunRules',
    '#saveRulesAs': 'tooltip.saveRulesAs',
    '#loadMapping': 'tooltip.loadMapping',
    '#mappingMode': 'tooltip.mappingMode',
    '#mappingEditAction': 'tooltip.mappingEditAction',
    '#mappingClearSelection': 'tooltip.mappingClearSelection',
    '#mappingUndo': 'tooltip.mappingUndo',
    '#mappingRedo': 'tooltip.mappingRedo',
    '#mappingSaveAs': 'tooltip.mappingSaveAs',
    '#mappingResetForm': 'tooltip.mappingResetForm',
    '#mappingAddRule': 'tooltip.mappingAddRule',
    '#mappingDeleteView': 'tooltip.mappingDeleteView',
    '#mappingDeleteSelectAll': 'tooltip.mappingDeleteSelectAll',
    '#mappingDeleteClear': 'tooltip.mappingDeleteClear',
    '#mappingDeleteSelected': 'tooltip.mappingDeleteSelected',
    '#loadValidateMapping': 'tooltip.loadValidateMapping',
    '#webhooksUndo': 'tooltip.webhooksUndo',
    '#webhooksRedo': 'tooltip.webhooksRedo',
    '#webhooksAnalyze': 'tooltip.webhooksAnalyze',
    '#webhooksLoadCmdb': 'tooltip.webhooksLoadCmdb',
    '#webhooksSaveAs': 'tooltip.webhooksSaveAs',
    '#webhooksApplyCmdb': 'tooltip.webhooksApplyCmdb',
    '#webhooksSelectAll': 'tooltip.webhooksSelectAll',
    '#webhooksClear': 'tooltip.webhooksClear',
    '#syncZabbix': 'tooltip.syncZabbix',
    '#loadZabbix': 'tooltip.loadZabbix',
    '#syncCmdbuild': 'tooltip.syncCmdbuild',
    '#loadCmdbuild': 'tooltip.loadCmdbuild',
    '#loadRuntimeSettings': 'tooltip.loadRuntimeSettings',
    '#loadAuthSettings': 'tooltip.loadAuthSettings',
    '#saveRuntimeSettings': 'tooltip.saveRuntimeSettings',
    '[name="rulesFilePath"]': 'tooltip.rulesFilePath',
    '[name="rulesReadFromGit"]': 'tooltip.rulesReadFromGit',
    '[name="rulesRepositoryUrl"]': 'tooltip.rulesRepositoryUrl',
    '#saveIdp': 'tooltip.saveIdp',
    '#loadUsers': 'tooltip.loadUsers',
    '#resetUserPassword': 'tooltip.resetUserPassword',
    '#helpPopoverClose': 'tooltip.helpPopoverClose'
  };
  for (const [selector, key] of Object.entries(selectorHelp)) {
    $$(selector).forEach(node => setHelpKey(node, key));
  }

  $$('label').forEach(label => {
    const labelText = label.querySelector('span')?.textContent?.trim();
    const control = label.querySelector('input, select, textarea');
    if (control?.tagName === 'SELECT') {
      return;
    }
    if (labelText && control && !control.dataset.helpKey) {
      setHelp(control, tf('tooltip.field', { label: labelText }));
    }
  });

  $$('table th').forEach(header => {
    const text = header.textContent.trim();
    if (text) {
      setHelp(header, tf('tooltip.tableColumn', { label: text }));
    }
  });

}

function setHelpKey(node, key) {
  if (!node || !key) {
    return node;
  }
  node.dataset.helpKey = key;
  return setHelp(node, t(key));
}

function setHelp(node, text) {
  if (!node || !text) {
    return node;
  }
  node.dataset.help = text;
  node.removeAttribute('title');
  if (!isNaturallyInteractive(node) && node.tabIndex < 0) {
    node.tabIndex = 0;
  }
  return node;
}

function scheduleHelp(target) {
  const popover = $('#helpPopover');
  if (pendingHelpTarget === target && (helpShowTimer || !popover.classList.contains('hidden'))) {
    return;
  }

  cancelScheduledHelp();
  pendingHelpTarget = target;
  helpShowTimer = window.setTimeout(() => {
    helpShowTimer = null;
    if (pendingHelpTarget === target && target.isConnected) {
      showHelp(target);
    }
  }, helpShowDelayMs);
}

function cancelScheduledHelp() {
  window.clearTimeout(helpShowTimer);
  helpShowTimer = null;
  pendingHelpTarget = null;
}

function showHelp(target) {
  const text = target.dataset.help;
  if (!text) {
    return;
  }

  const popover = $('#helpPopover');
  $('#helpPopoverText').textContent = text;
  popover.classList.remove('hidden');
  const rect = target.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - popover.offsetWidth - 8));
  const preferredTop = rect.bottom + 8;
  const top = preferredTop + popover.offsetHeight > window.innerHeight
    ? Math.max(8, rect.top - popover.offsetHeight - 8)
    : preferredTop;
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function hideHelp() {
  cancelScheduledHelp();
  $('#helpPopover').classList.add('hidden');
}

function isNaturallyInteractive(node) {
  return ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(node.tagName)
    || node.hasAttribute('tabindex');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json();
  if (!response.ok) {
    if (response.status === 428 && payload.error === 'credentials_required' && options.retryCredentials !== false) {
      await promptSessionCredentials(payload);
      return api(path, { ...options, retryCredentials: false });
    }

    const error = new Error(payload.message ?? payload.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function renderRows(tbody, items, columns) {
  clear(tbody);
  for (const item of items.slice(0, 250)) {
    const row = document.createElement('tr');
    for (const value of columns(item)) {
      const cell = el('td', '', '');
      if (value instanceof Node) {
        cell.append(value);
      } else {
        cell.textContent = value ?? '';
      }
      setHelp(cell, 'Ячейка таблицы. Содержит значение из текущего набора данных.');
      row.append(cell);
    }
    tbody.append(row);
  }
  if (items.length === 0) {
    const row = document.createElement('tr');
    const cell = el('td', '', 'empty');
    cell.colSpan = 10;
    row.append(cell);
    tbody.append(row);
  }
}

function renderDefinitionList(container, values) {
  clear(container);
  for (const [key, value] of Object.entries(values)) {
    container.append(el('dt', '', key), el('dd', '', String(value ?? '')));
  }
}

function clear(node) {
  node.replaceChildren();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  node.textContent = text;
  return node;
}

function uniqueById(items, idField) {
  const values = new Map();
  for (const item of items) {
    const key = normalizeToken(item?.[idField] ?? item?.name ?? item?.host ?? item?.value);
    if (key && !values.has(key)) {
      values.set(key, item);
    }
  }

  return [...values.values()];
}

function sameMappingItem(item, type, id, name) {
  const candidates = {
    hostGroups: [item.groupid, item.name],
    templates: [item.templateid, item.name, item.host],
    templateGroups: [item.groupid, item.name],
    tags: [item.tag]
  }[type] ?? [];
  const wanted = [id, name].map(normalizeToken);
  return candidates.map(normalizeToken).some(candidate => wanted.includes(candidate));
}

function equalsIgnoreCase(left, right) {
  return String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.remove('hidden');
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => node.classList.add('hidden'), 3200);
}
