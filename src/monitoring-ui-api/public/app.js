const state = {
  currentRules: null,
  uploadedRulesText: null,
  runtimeSettings: null,
  mappingMode: 'view',
  mappingEditAction: 'add',
  mappingDraftRules: null,
  mappingHistory: [],
  mappingHistoryIndex: -1,
  mappingCmdbuildCatalog: null,
  mappingZabbixCatalog: null,
  mappingLoaded: false,
  validateMappingLoaded: false
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const defaultEventMaxMessages = 5;
const helpShowDelayMs = 900;
const largeMappingSectionLimit = 500;
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
    help: 'Interface profile описывает тип интерфейса мониторинга: agent, SNMP, IPMI или JMX. Это не отдельный Zabbix object, а управляемый профиль для interfaces[].'
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
    help: 'Value map - объект Zabbix для отображения значений items. В CMDB->host mapping обычно справочный, применять его напрямую к host payload нужно осторожно.'
  }
];
const viewDescriptions = {
  dashboard: 'Показывает состояние доступности сервисов и быстрые проверки текущего окружения.',
  events: 'Показывает используемые Kafka-топики и последние сообщения выбранного топика.',
  rules: 'Загружает текущий JSON правил, проверяет его, выполняет dry-run и upload нового файла правил.',
  mapping: 'Показывает цепочку CMDBuild -> conversion rules -> Zabbix. Template rules выбирают templates, Tag rules формируют tags; одно и то же class attribute field, например zabbixTag, может использоваться как условие в обоих блоках, но результат у них разный.',
  validateMapping: 'Проверяет правила против каталогов Zabbix и CMDBuild; красным отмечаются только отсутствующие сущности в источниках. Template rules не назначают tags, а Tag rules не назначают templates; смешивать результат этих блоков нецелесообразно.',
  zabbix: 'Показывает templates, host groups, template groups, tags и расширенные Zabbix-справочники: proxies, macros, inventory fields, interface profiles, statuses, maintenance, TLS/PSK и value maps.',
  cmdbuild: 'Показывает классы, атрибуты и lookup-справочники, загруженные из CMDBuild.',
  settings: 'Содержит runtime-настройки подключений, Kafka Events и IdP/SAML2.',
  help: 'Содержит справку по разделам интерфейса, правилам Mapping/Validate rules mapping и настройкам.'
};

const defaultPayload = {
  source: 'cmdbuild',
  eventType: 'update',
  className: 'Server',
  id: '109921',
  code: 's1',
  ip_address: '1.1.1.2',
  dns_name: 's1.example.local',
  description: 's1',
  os: '105146',
  zabbixTag: '106852'
};

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
    await loadRuntimeSettings();
    await loadDashboard();
    await loadRules();
  }
}

function bindNavigation() {
  $$('.nav-item[data-view]').forEach(button => {
    button.addEventListener('click', async () => {
      $$('.nav-item[data-view]').forEach(item => item.classList.toggle('active', item === button));
      $$('.view').forEach(view => view.classList.toggle('active', view.id === button.dataset.view));
      updateViewDescription(button.dataset.view);
      if (button.dataset.view === 'mapping' && !state.mappingLoaded) {
        await loadMapping();
      }
      if (button.dataset.view === 'validateMapping' && !state.validateMappingLoaded) {
        await loadValidateMapping();
      }
    });
  });
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

  description.textContent = viewDescriptions[view.id] ?? '';
  return description;
}

function updateViewDescription(viewId) {
  const view = document.getElementById(viewId);
  if (!view) {
    return;
  }
  ensureViewDescription(view);
}

function bindForms() {
  $('#loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (state.auth?.useIdp) {
      location.href = '/auth/saml2/login';
      return;
    }

    $('#loginError').textContent = '';
    const form = new FormData(event.currentTarget);
    try {
      const result = await api('/api/auth/login', {
        method: 'POST',
        body: {
          cmdbuild: {
            baseUrl: form.get('cmdbuildBaseUrl'),
            username: form.get('cmdbuildUsername'),
            password: form.get('cmdbuildPassword')
          },
          zabbix: {
            apiEndpoint: form.get('zabbixApiEndpoint'),
            username: form.get('zabbixUsername'),
            password: form.get('zabbixPassword'),
            apiToken: form.get('zabbixApiToken')
          }
        }
      });
      renderAuth({ authenticated: true, user: result.user });
      await loadRuntimeSettings();
      await loadDashboard();
      await loadRules();
    } catch (error) {
      $('#loginError').textContent = error.message;
    }
  });

  $('#idpLoginButton').addEventListener('click', () => {
    location.href = '/auth/saml2/login';
  });

  $('#logoutButton').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} });
    location.reload();
  });

  $('#refreshDashboard').addEventListener('click', loadDashboard);
  $('#refreshEvents').addEventListener('click', loadEvents);
  $('#eventsTopic').addEventListener('change', loadEvents);
  $('#loadRules').addEventListener('click', loadRules);
  $('#loadMapping').addEventListener('click', loadMapping);
  $('#mappingClearSelection').addEventListener('click', () => clearMappingHighlight($('#mapping')));
  $('#mappingMode').addEventListener('change', updateMappingMode);
  $('#mappingEditAction').addEventListener('change', updateMappingEditorAction);
  $('#mappingUndo').addEventListener('click', undoMappingEdit);
  $('#mappingRedo').addEventListener('click', redoMappingEdit);
  $('#mappingSaveAs').addEventListener('click', saveMappingDraftAsFile);
  $('#mappingEditTargetType').addEventListener('change', () => {
    populateMappingEditorTargets();
    updateMappingEditorSuggestedName();
  });
  $('#mappingEditClass').addEventListener('change', () => {
    populateMappingEditorFields();
    populateMappingEditorTargets();
    updateMappingEditorSuggestedName();
  });
  $('#mappingEditField').addEventListener('change', updateMappingEditorSuggestedName);
  $('#mappingEditZabbixObject').addEventListener('change', updateMappingEditorSuggestedName);
  $('#mappingEditRegex').addEventListener('input', updateMappingEditorSuggestedName);
  $('#mappingAddRule').addEventListener('click', addMappingConversionRule);
  $('#mappingDeleteSelectAll').addEventListener('click', () => setMappingDeleteSelection(true));
  $('#mappingDeleteClear').addEventListener('click', () => setMappingDeleteSelection(false));
  $('#mappingDeleteSelected').addEventListener('click', deleteSelectedMappingRules);
  $('#mappingDeleteRules').addEventListener('change', event => {
    if (event.target.matches('.mapping-delete-checkbox')) {
      updateMappingDeleteControls();
    }
  });
  $('#loadValidateMapping').addEventListener('click', loadValidateMapping);
  $('#deleteValidateMappingSelected').addEventListener('click', deleteSelectedValidationFixes);
  $('#validateRules').addEventListener('click', validateRules);
  $('#dryRunRules').addEventListener('click', dryRunRules);
  $('#uploadRules').addEventListener('click', uploadRules);
  $('#syncZabbix').addEventListener('click', syncZabbix);
  $('#loadZabbix').addEventListener('click', loadZabbix);
  $('#syncCmdbuild').addEventListener('click', syncCmdbuild);
  $('#loadCmdbuild').addEventListener('click', loadCmdbuild);
  $('#loadSettings').addEventListener('click', loadRuntimeSettings);
  $('#saveRuntimeSettings').addEventListener('click', saveRuntimeSettings);
  $('#saveIdp').addEventListener('click', saveIdp);
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
  $('#loginView').classList.toggle('hidden', status.authenticated);
  $('#appView').classList.toggle('hidden', !status.authenticated);
  $('#idpLoginBlock').classList.toggle('hidden', !state.auth.useIdp || status.authenticated);
  $('#localCredentials').classList.toggle('hidden', state.auth.useIdp);
  $('#localLoginActions').classList.toggle('hidden', state.auth.useIdp);
  $('#sessionSummary').textContent = status.authenticated
    ? `${status.user?.identity?.displayName ?? status.user?.cmdbuild?.username ?? 'user'} | ${status.user?.authMethod ?? 'local'}`
    : 'not authenticated';
  if (status.authenticated && status.idp) {
    fillIdpForm(status.idp);
  }
  if (!status.authenticated && !state.auth.useIdp) {
    fillLocalLoginDefaults(state.auth.localLoginDefaults);
  }
}

function fillLocalLoginDefaults(defaults) {
  if (!defaults?.enabled) {
    return;
  }

  const form = $('#loginForm');
  form.elements.cmdbuildBaseUrl.value = defaults.cmdbuild?.baseUrl ?? '';
  form.elements.cmdbuildUsername.value = defaults.cmdbuild?.username ?? '';
  form.elements.cmdbuildPassword.value = defaults.cmdbuild?.password ?? '';
  form.elements.zabbixApiEndpoint.value = defaults.zabbix?.apiEndpoint ?? '';
  form.elements.zabbixUsername.value = defaults.zabbix?.username ?? '';
  form.elements.zabbixPassword.value = defaults.zabbix?.password ?? '';
  form.elements.zabbixApiToken.value = defaults.zabbix?.apiToken ?? '';
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
    setHelp(node, `Проверка сервиса "${item.name}". Показывает HTTP-статус, задержку и проверяемый URL.`);
    grid.append(node);
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

async function dryRunRules() {
  const payload = JSON.parse($('#dryRunPayload').value);
  const body = state.uploadedRulesText
    ? { rules: JSON.parse(state.uploadedRulesText), payload }
    : { payload };
  const result = await api('/api/rules/dry-run', { method: 'POST', body });
  $('#rulesResult').textContent = JSON.stringify(result, null, 2);
}

async function uploadRules() {
  if (!state.uploadedRulesText) {
    toast('Select rules JSON first');
    return;
  }

  const result = await api('/api/rules/upload', {
    method: 'POST',
    body: {
      content: state.uploadedRulesText,
      save: true
    }
  });
  $('#rulesResult').textContent = JSON.stringify(result, null, 2);
  if (result.saved) {
    await loadRules();
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
    meta: 'загрузка данных',
    level: 1,
    kind: 'rule'
  });
  for (const [container, title] of [
    [$('#mappingCmdbuild'), 'CMDBuild'],
    [$('#mappingRules'), 'Conversion Rules'],
    [$('#mappingZabbix'), 'Zabbix']
  ]) {
    clear(container);
    appendMappingSection(container, title, [loadingNode('Загрузка')]);
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
        label: 'Ошибка загрузки Mapping',
        meta: message,
        level: 1,
        kind: 'rule',
        status: 'error',
        help: 'Ошибка показана здесь, чтобы не искать ее в console браузера.'
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
      label: 'Загрузка легкого Zabbix catalog',
      meta: 'CMDBuild и Conversion Rules уже доступны; полный Zabbix catalog не загружается в Mapping',
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
    console.error(`Mapping render failed for ${name}`, error);
    clear(container);
    appendMappingSection(container, `${name} render error`, [
      mappingNode({
        label: 'Ошибка отрисовки',
        meta: error.message ?? String(error),
        level: 1,
        kind: 'rule',
        status: 'error',
        help: `Колонка "${name}" не отрисовалась из-за клиентской ошибки. Остальные колонки Mapping продолжают работать.`
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
  rerenderMappingDraft('Undo выполнен.');
}

function redoMappingEdit() {
  if (state.mappingHistoryIndex >= state.mappingHistory.length - 1) {
    return;
  }

  state.mappingHistoryIndex += 1;
  state.mappingDraftRules = cloneJson(state.mappingHistory[state.mappingHistoryIndex]);
  rerenderMappingDraft('Redo выполнен.');
}

function rerenderMappingDraft(message = '') {
  if (state.currentRules) {
    state.currentRules.content = state.mappingDraftRules;
  }
  renderMapping(state.mappingDraftRules, state.mappingZabbixCatalog, state.mappingCmdbuildCatalog);
  updateMappingEditor(message);
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
  $('#mappingAddPanel')?.classList.toggle('hidden', !editMode || action !== 'add');
  $('#mappingDeletePanel')?.classList.toggle('hidden', !editMode || action !== 'delete');
  updateMappingDeleteControls();
}

function updateMappingEditor(message = '') {
  updateMappingEditorControls();
  if (state.mappingMode !== 'edit') {
    return;
  }

  populateMappingEditorClasses();
  populateMappingEditorFields();
  populateMappingEditorStructures();
  populateMappingEditorTargets();
  renderMappingDeleteRules();
  updateMappingEditorSuggestedName();
  setMappingEditorStatusForDraft(message || 'Перед сохранением проверьте Validate rules mapping: для создания/обновления host должен приходить ipAddress или dnsName.');
}

function updateMappingEditorAction() {
  state.mappingEditAction = $('#mappingEditAction')?.value ?? 'add';
  updateMappingEditorControls();
  if (state.mappingEditAction === 'delete') {
    renderMappingDeleteRules();
  } else {
    updateMappingEditorSuggestedName();
  }
  setMappingEditorStatusForDraft(state.mappingEditAction === 'delete'
    ? 'Выберите правила для удаления из draft JSON. Классы и class attribute fields не удаляются автоматически.'
    : 'Добавьте новое правило конвертации. После добавления будет сразу выполнена проверка IP/DNS для host mapping.');
}

function renderMappingDeleteRules() {
  const container = $('#mappingDeleteRules');
  if (!container) {
    return;
  }

  clear(container);
  const rules = currentMappingRules();
  const items = mappingDeleteRuleItems(rules);
  if (!state.mappingDraftRules) {
    container.append(mappingDeleteEmptyNode('Сначала загрузите Mapping.'));
    updateMappingDeleteControls();
    return;
  }
  if (items.length === 0) {
    container.append(mappingDeleteEmptyNode('В draft JSON нет правил, которые можно удалить через этот режим.'));
    updateMappingDeleteControls();
    return;
  }

  const groups = mappingDeleteRuleGroups(items);
  for (const group of groups) {
    container.append(mappingDeleteGroupNode(group, rules));
  }
  updateMappingDeleteControls();
}

function mappingDeleteRuleGroups(items) {
  const groups = [];
  let currentGroup = null;
  let currentKey = '';
  for (const item of items) {
    if (item.collection.key !== currentKey) {
      currentKey = item.collection.key;
      currentGroup = {
        key: item.collection.key,
        label: item.collection.label,
        items: []
      };
      groups.push(currentGroup);
    }
    currentGroup.items.push(item);
  }
  return groups;
}

function mappingDeleteGroupNode(group, rules) {
  const groupNode = el('div', 'mapping-delete-group is-collapsed', '');
  groupNode.dataset.deleteRuleGroup = group.key;

  const header = el('div', 'mapping-delete-group-header', '');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'mapping-delete-group-toggle secondary';
  toggle.textContent = '+';
  const title = el('h3', '', group.label);
  const count = el('span', 'mapping-delete-group-count', String(group.items.length));
  header.append(toggle, title, count);

  const body = el('div', 'mapping-delete-group-body', '');
  body.replaceChildren(...group.items.map(item => mappingDeleteRuleNode(item, rules)));
  groupNode.append(header, body);
  setHelp(header, `Группа rules "${group.label}". Нажмите +, чтобы раскрыть правила этой группы для выбора на удаление.`);
  header.addEventListener('click', () => setMappingDeleteGroupExpanded(groupNode, groupNode.classList.contains('is-collapsed')));
  return groupNode;
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
  return $$('.mapping-delete-checkbox:checked').map(checkbox => ({
    operationKey: checkbox.dataset.operationKey,
    collection: checkbox.dataset.ruleCollection
  }));
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
}

function setMappingDeleteSelection(checked) {
  $$('.mapping-delete-checkbox').forEach(checkbox => {
    checkbox.checked = checked;
  });
  updateMappingDeleteControls();
}

function deleteSelectedMappingRules() {
  if (!state.mappingDraftRules) {
    setMappingEditorStatus('Сначала загрузите Mapping.');
    return;
  }

  const operations = selectedMappingRuleDeletions();
  if (operations.length === 0) {
    setMappingEditorStatus('Выберите хотя бы одно правило для удаления.');
    return;
  }

  const confirmed = window.confirm([
    `Удалить выбранные правила из draft JSON (${operations.length})?`,
    'Классы и class attribute fields останутся в rules, чтобы не удалить источник, который может использоваться другими правилами.',
    'Действие можно отменить через Undo.'
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
    setMappingEditorStatus('Выбранные правила уже не найдены в текущем draft JSON.');
    renderMappingDeleteRules();
    return;
  }

  pushMappingHistory(rules);
  rerenderMappingDraft(`Удалено правил: ${removed}. Классы и class attribute fields не удалялись автоматически.`);
}

function populateMappingEditorClasses() {
  const select = $('#mappingEditClass');
  const previous = select.value;
  const rules = currentMappingRules();
  const classes = mappingEditorClassOptions(rules, state.mappingCmdbuildCatalog ?? {});

  setClassSelectOptions(select, [
    { value: '', label: 'Любой класс' },
    ...classes
  ], previous);
}

function setClassSelectOptions(select, options, selectedValue = '') {
  setSelectOptions(select, options, selectedValue);
  if (!select || !selectedValue || select.value === selectedValue) {
    return;
  }

  const normalizedSelected = normalizeClassName(selectedValue);
  const normalizedOption = options.find(option => normalizeClassName(option.value) === normalizedSelected);
  if (normalizedOption) {
    select.value = normalizedOption.value;
  }
}

function mappingEditorClassOptions(rules, catalog) {
  const byClass = new Map();
  const putClass = className => {
    if (!className) {
      return;
    }
    const key = normalizeClassName(className);
    if (!key || byClass.has(key)) {
      return;
    }
    byClass.set(key, {
      value: catalogClassRuleName(catalog, className),
      label: catalogClassDisplayName(catalog, className)
    });
  };

  (rules.source?.entityClasses ?? []).forEach(putClass);
  (catalog.classes ?? [])
    .filter(item => item?.name && !isCmdbCatalogSuperclass(catalog, item))
    .forEach(item => putClass(item.name));

  return [...byClass.values()].sort((left, right) => compareText(left.label, right.label));
}

function populateMappingEditorFields() {
  const select = $('#mappingEditField');
  const previous = select.value;
  const rules = currentMappingRules();
  const sourceFields = rules.source?.fields ?? {};
  const selectedClass = $('#mappingEditClass').value;
  const configuredOptions = Object.entries(sourceFields)
    .filter(([fieldKey, field]) => !selectedClass || isVirtualSourceFieldRule(fieldKey, field) || mappingEditorAttributeForField(selectedClass, fieldKey, rules))
    .sort(([left], [right]) => compareText(left, right))
    .map(([fieldKey, field]) => ({
      value: fieldKey,
      label: mappingEditorSourceFieldLabel(fieldKey, field)
    }));
  const catalogOptions = mappingEditorClassAttributes(selectedClass)
    .filter(attribute => !sourceFieldHasCatalogAttribute(sourceFields, attribute.name))
    .map(attribute => ({
      value: attribute.name,
      label: `${attribute.name}${attribute.type ? ` / ${attribute.type}` : ''}`
    }));
  const options = selectedClass
    ? [...configuredOptions, ...catalogOptions]
    : configuredOptions;
  setSelectOptions(select, options, previous || 'className');
}

function populateMappingEditorStructures() {
  const select = $('#mappingEditTargetType');
  const previous = select.value;
  setSelectOptions(select, [
    { value: 'hostGroups', label: 'Host group rule' },
    { value: 'templates', label: 'Template rule' },
    { value: 'tags', label: 'Tag rule' },
    { value: 'interfaceAddress', label: 'Interface address rule' },
    { value: 'interface', label: 'Interface rule' },
    ...mappingEditorEditableExtensionDefinitions()
      .map(definition => ({ value: definition.rulesKey, label: `${definition.title} rule` }))
  ], previous || 'hostGroups');
}

async function populateMappingEditorTargets() {
  const select = $('#mappingEditZabbixObject');
  const previous = select.value;
  const type = $('#mappingEditTargetType').value;
  const extension = mappingEditorExtensionDefinition(type);
  if (shouldLoadMappingEditorExtensionCatalog(extension)) {
    setSelectOptions(select, [{ value: '', label: 'Загрузка Zabbix catalog...' }], '');
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
      setSelectOptions(select, [{ value: '', label: `Ошибка загрузки: ${error.message}` }], '');
      return;
    }
  }

  const items = mappingEditorTargetOptions(type, currentMappingRules());
  setSelectOptions(select, items, previous);
  updateMappingEditorSuggestedName();
}

function mappingEditorTargetOptions(type, rules) {
  if (type === 'hostGroups') {
    return uniqueMappingObjects([
      ...(state.mappingZabbixCatalog?.hostGroups ?? []),
      ...(rules.lookups?.hostGroups ?? []),
      ...(rules.defaults?.hostGroups ?? [])
    ], item => item.groupid || item.name)
      .map(item => optionFromPayload(item.name || item.groupid, item));
  }

  if (type === 'templates') {
    return uniqueMappingObjects([
      ...(state.mappingZabbixCatalog?.templates ?? []),
      ...(rules.lookups?.templates ?? []),
      ...(rules.defaults?.templates ?? [])
    ], item => item.templateid || item.name || item.host)
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
      optionFromPayload('IP address -> interfaces[].ip / useip=1', { mode: 'ip', valueField: 'ipAddress' }),
      optionFromPayload('DNS name -> interfaces[].dns / useip=0', { mode: 'dns', valueField: 'dnsName' })
    ];
  }

  if (type === 'interface') {
    return [
      optionFromPayload('Agent interface', { interfaceRef: 'agentInterface' }),
      optionFromPayload('SNMP interface', { interfaceRef: 'snmpInterface' })
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
      .map(name => optionFromPayload(`Profile: ${name}`, { interfaceProfileRef: name }));
  }

  const items = zabbixExtensionItems(rules, state.mappingZabbixCatalog ?? {}, definition);
  const options = items
    .map(item => mappingEditorExtensionTarget(definition, item))
    .filter(Boolean)
    .map(target => optionFromPayload(mappingEditorTargetLabel(definition, target), target));

  if (definition.rulesKey === 'hostMacros') {
    options.unshift(optionFromPayload('Новый host macro из class attribute field', {
      macro: '{$CMDB.VALUE}',
      valueTemplate: ''
    }));
  }
  if (definition.rulesKey === 'inventoryFields' && options.length === 0) {
    options.push(optionFromPayload('Inventory field из class attribute field', {
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
    const names = [fieldKey, canonicalSourceField(fieldKey), ...sourceFieldSources(field)]
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
    return node;
  }));

  if (options.some(option => option.value === selectedValue)) {
    select.value = selectedValue;
  }
}

function mappingEditorSourceFieldLabel(fieldKey, field) {
  const attribute = mappingEditorClassAttributes($('#mappingEditClass').value)
    .find(item => sourceFieldSources(field)
      .some(sourceName => equalsIgnoreCase(item.name, sourceName)));
  return attribute?.name ?? fieldKey;
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

  const field = currentMappingRules().source?.fields?.[fieldKey] ?? { source: fieldKey };
  return isVirtualSourceFieldRule(fieldKey, field)
    || Boolean(mappingEditorAttributeForField(className, fieldKey));
}

function addMappingConversionRule() {
  if (!state.mappingDraftRules) {
    setMappingEditorStatus('Сначала загрузите Mapping.');
    return;
  }

  const rules = cloneJson(state.mappingDraftRules);
  const type = $('#mappingEditTargetType').value;
  const className = catalogClassRuleName(state.mappingCmdbuildCatalog ?? {}, $('#mappingEditClass').value);
  const field = $('#mappingEditField').value;
  const regex = $('#mappingEditRegex').value.trim();
  const priority = Number($('#mappingEditPriority').value || 100);
  const target = readMappingEditorTarget();
  if (!isMappingEditorFieldValidForClass(className, field)) {
    setMappingEditorStatus(`В классе "${className}" нет атрибута для "${field}". Добавьте атрибут в CMDBuild или выберите существующий class attribute field.`);
    return;
  }

  const ruleName = ($('#mappingEditRuleName').value.trim() || buildMappingRuleName(type, className, field, target)).trim();
  const rule = buildMappingEditorRule({ type, className, field, regex, priority, target, ruleName });

  ensureMappingEditorClass(rules, className);
  ensureMappingEditorSourceField(rules, field);
  const rulesKey = mappingRulesKey(type, target);
  rules[rulesKey] = Array.isArray(rules[rulesKey]) ? rules[rulesKey] : [];
  rules[rulesKey].push(rule);
  pushMappingHistory(rules);
  $('#mappingEditRuleName').value = '';
  rerenderMappingDraft(`Добавлено правило "${ruleName}".`);
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
  const attribute = mappingEditorClassAttributes($('#mappingEditClass').value)
    .find(item => equalsIgnoreCase(item.name, field));
  rules.source.fields[field] = {
    source: attribute?.name ?? field,
    required: false
  };
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

  if (regex) {
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
    interface: 'interfaceSelectionRules'
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

function normalizeRuleName(value) {
  return String(value)
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
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
    setMappingEditorStatusForDraft(`Save file as: найдена неконсистентность IP/DNS mapping. Изменений для webhook-файла: ${sessionWebhookChangeCount(changes)}.`);
    const confirmed = window.confirm([
      'В rules найдены проблемы связи IP/DNS class attribute field с Zabbix interface structure.',
      '',
      ...validation.issues.slice(0, 12).map(issue => `- ${issue}`),
      validation.issues.length > 12 ? `- ... еще ${validation.issues.length - 12}` : '',
      '',
      'Сохранить файлы несмотря на ошибки?'
    ].filter(Boolean).join('\n'));
    if (!confirmed) {
      setMappingEditorStatus('Сохранение отменено: сначала исправьте связь IP/DNS с Zabbix interface structure.');
      return;
    }
  }

  const defaultName = `${normalizeRuleName(state.mappingDraftRules.name || 'cmdbuild-to-zabbix-rules')}.json`;
  const content = `${JSON.stringify(state.mappingDraftRules, null, 2)}\n`;
  const webhookBodiesName = defaultName.replace(/\.json$/i, '-webhook-bodies.txt');
  const webhookBodies = buildWebhookBodiesFile(state.mappingDraftRules, state.mappingCmdbuildCatalog, validation, changes);
  setMappingEditorStatusForDraft(`Save file as: rules JSON и webhook-файл будут сохранены. Изменений для webhook-файла: ${sessionWebhookChangeCount(changes)}.`);

  const rulesResult = await saveTextAsFile(content, defaultName, 'JSON rules', { 'application/json': ['.json'] });
  if (rulesResult.cancelled) {
    setMappingEditorStatus('Сохранение отменено.');
    return;
  }

  const webhookResult = await saveTextAsFile(webhookBodies, webhookBodiesName, 'Webhook bodies', { 'text/plain': ['.txt'] });
  if (webhookResult.cancelled) {
    setMappingEditorStatus(`Файл rules сохранен: ${rulesResult.name}. Второй файл webhook bodies не сохранен.`);
    return;
  }

  const warningText = validation.issues.length > 0 ? ` Есть предупреждения: ${validation.issues.length}.` : '';
  setMappingEditorStatus(`Файлы сохранены: ${rulesResult.name}, ${webhookResult.name}.${warningText}`);
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

  const requestedName = window.prompt(`Имя файла для сохранения ${description}`, defaultName);
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
    { key: 'groupSelectionRules', label: 'Group rules', type: 'hostGroups' },
    { key: 'templateSelectionRules', label: 'Template rules', type: 'templates' },
    { key: 'templateGroupSelectionRules', label: 'Template group rules', type: 'templateGroups' },
    { key: 'interfaceAddressRules', label: 'Interface address rules', type: 'interfaceAddress' },
    { key: 'interfaceSelectionRules', label: 'Interface rules', type: 'interface' },
    { key: 'tagSelectionRules', label: 'Tag rules', type: 'tags' },
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

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function ruleClassConditions(rule) {
  const matchers = [
    ...(rule.when?.anyRegex ?? []),
    ...(rule.when?.allRegex ?? [])
  ].filter(matcher => canonicalSourceField(matcher.field) === 'className');

  return uniqueTokens(matchers.flatMap(matcher => regexLiteralValues(matcher.pattern)));
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
  const addressRules = rules.interfaceAddressRules ?? [];

  if (addressRules.length === 0) {
    issues.push('Не настроен блок interfaceAddressRules: Zabbix host не получит обязательный interface address.');
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

  return { issues };
}

function addressCandidatesForClass(rules, attributes) {
  return (rules.interfaceAddressRules ?? []).flatMap(rule => {
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
      ? `# Save validation warnings: ${validation.issues.length}. Перед применением проверьте IP/DNS -> Zabbix interface mapping.`
      : '# Save validation: критичных предупреждений по IP/DNS -> Zabbix interface mapping нет.',
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
    lines.push(
      `## ${actionLabel} / ${classItem.name} / ${event.eventType}`,
      '# Action: ADD or UPDATE CMDBuild webhook Body',
      '# Method: POST',
      '# URL: http://192.168.202.100:5080/webhooks/cmdbuild',
      '# Headers: Authorization: Bearer <token>',
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
  const body = {
    source: 'cmdbuild',
    eventType: event.eventType,
    cmdbuildEvent: event.cmdbuildEvent,
    className
  };

  for (const [fieldKey, field] of Object.entries(rules.source?.fields ?? {})) {
    const bodyKey = webhookBodyKeyForField(fieldKey, field);
    if (!bodyKey || body[bodyKey] !== undefined) {
      continue;
    }

    const value = webhookBodyValueForField(className, event, attributes, fieldKey, field);
    if (value !== undefined) {
      body[bodyKey] = value;
    }
  }

  return body;
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
  const issues = prioritizedMappingValidationIssues(validation.issues, selectedClass);
  const visibleIssues = issues.slice(0, 4).join(' ');
  const extra = validation.issues.length > 4
    ? ` Еще предупреждений: ${validation.issues.length - 4}.`
    : '';
  return {
    message: `${message} Предупреждения save validation: ${validation.issues.length}. ${visibleIssues}${extra}`,
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

function compareText(left, right) {
  return String(left).localeCompare(String(right), undefined, { sensitivity: 'base' });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loadValidateMapping() {
  const [rulesDocument, zabbixCatalog, cmdbuildCatalog] = await Promise.all([
    api('/api/rules/current'),
    api('/api/zabbix/catalog'),
    api('/api/cmdbuild/catalog')
  ]);

  state.currentRules = rulesDocument;
  renderValidateMapping(rulesDocument.content, zabbixCatalog, cmdbuildCatalog);
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
  const details = el('div', 'validation-summary-detail', `Предупреждения: ${warnings.length}. Красным отмечаются только отсутствующие сущности в Zabbix и CMDBuild.`);
  container.append(header, details);
  setHelp(container, 'Сводка проверки правил. Красная подсветка используется только для сущностей, которых нет в текущих каталогах Zabbix или CMDBuild.');

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
    const tokens = [`target:templategroups`, `zbx-templateGroups:${normalizeToken(group.groupid || group.name)}`];
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
        tokens: zabbixExtensionTokens(definition, item),
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
    return mappingNode({
      label: displayName,
      meta: displayName !== className ? `configured / rules: ${className}` : 'configured',
      tokens,
      level: 1,
      kind: 'source',
      status: 'normal',
      help: 'Класс источника из JSON правил. Он должен существовать в CMDBuild, иначе события этого класса нельзя корректно обработать.'
    });
  }));

  appendValidationSection(container, 'Class attribute fields', Object.entries(rules.source?.fields ?? {}).map(([fieldKey, field]) => {
    const tokens = [
      ...sourceFieldTokensForRule(fieldKey, field),
      ...sourceFieldTargetTokens(fieldKey),
      ...lookupFieldTokens(fieldKey, lookupFields)
    ];
    return mappingNode({
      label: fieldKey,
      meta: `${sourceFieldLabel(field)}${field.required ? ' required' : ''}${field.validationRegex ? ` | ${field.validationRegex}` : ''}`,
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

  appendValidationSection(container, 'Group rules', (rules.groupSelectionRules ?? []).flatMap(rule => ruleMappingNodes(rule, 'hostGroups', null, null, rules)));
  appendValidationSection(container, 'Template rules', (rules.templateSelectionRules ?? []).flatMap(rule => ruleMappingNodes(rule, 'templates', null, null, rules)));
  appendValidationSection(container, 'Interface address rules', (rules.interfaceAddressRules ?? []).flatMap(rule => ruleMappingNodes(rule, 'interfaceAddress', rule.valueField ?? rule.mode, null, rules)));
  appendValidationSection(container, 'Interface rules', (rules.interfaceSelectionRules ?? []).flatMap(rule => ruleMappingNodes(rule, 'interface', rule.interfaceRef, null, rules)));
  appendValidationSection(container, 'Tag rules', (rules.tagSelectionRules ?? []).flatMap(rule => ruleMappingNodes(rule, 'tags', null, null, rules)));
  appendOptionalZabbixRuleSections(container, rules, validation, appendValidationSection);
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
        label: attribute?.name ?? sourceFieldLabel(field),
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
  setHelp(checkbox, 'Отметьте, чтобы удалить эту отсутствующую ссылку из JSON правил.');
  row.append(checkbox, el('span', '', 'Удалить из правил'));
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
  for (const scope of ['zabbix', 'cmdbuild']) {
    const checkboxes = $$(`.validation-fix-checkbox[data-validation-scope="${scope}"]`);
    $$(`[data-validation-select="${scope}"], [data-validation-clear="${scope}"]`).forEach(button => {
      button.disabled = checkboxes.length === 0;
    });
  }

  $('#deleteValidateMappingSelected').disabled = selectedValidationFixes().length === 0;
}

async function deleteSelectedValidationFixes() {
  const operations = selectedValidationFixes();
  if (operations.length === 0) {
    toast('Выберите отсутствующие элементы для удаления из правил');
    return;
  }

  const confirmed = window.confirm(`Удалить выбранные элементы из JSON правил (${operations.length})? Предыдущая версия будет сохранена на backend.`);
  if (!confirmed) {
    return;
  }

  const result = await api('/api/rules/fix-mapping', {
    method: 'POST',
    body: { operations }
  });
  $('#rulesResult').textContent = JSON.stringify(result, null, 2);
  toast(result.saved
    ? `Rules updated. Backup: ${result.backupPath}`
    : 'Rules were not changed');
  await loadRules();
  await loadValidateMapping();
}

function buildRulesMappingValidation(rules, zabbixCatalog, cmdbuildCatalog) {
  const issues = [];
  const addIssue = issue => issues.push({
    severity: issue.severity ?? 'error',
    source: issue.source,
    message: issue.message,
    tokens: uniqueTokens(issue.tokens ?? []),
    help: issue.help
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
    const tokens = [`target:templategroups`, `zbx-templateGroups:${normalizeToken(group.groupid || group.name)}`];
    if (!zabbixCatalogItemExists(zabbixCatalog.templateGroups ?? [], 'groupid', group.groupid, group.name)) {
      addIssue({
        source: 'zabbix',
        message: `Zabbix template group отсутствует: ${group.name || group.groupid}`,
        tokens,
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
          tokens: zabbixExtensionTokens(definition, item),
          help: `${definition.help} Объект указан в JSON правил, но отсутствует в Zabbix catalog.`
        });
      }
    }
  }

  for (const className of rules.source?.entityClasses ?? []) {
    const catalogClass = findCatalogClass(cmdbuildCatalog, className);
    if (!catalogClass) {
      addIssue({
        source: 'cmdbuild',
        message: `CMDBuild class отсутствует: ${className}`,
        tokens: [`class:${normalizeToken(className)}`, `match:className:${normalizeToken(className)}`, ...sourceFieldTokens('className')],
        help: 'Класс указан в source.entityClasses правил, но не найден в каталоге CMDBuild.'
      });
      continue;
    }
    if (isCmdbCatalogSuperclass(cmdbuildCatalog, catalogClass)) {
      continue;
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
          message: `CMDBuild attribute отсутствует: ${catalogClassDisplayName(cmdbuildCatalog, className)}.${sourceFieldLabel(field)}`,
          tokens: [
            ...sourceFieldTokensForRule(fieldKey, field),
            classFieldToken(className, canonicalSourceField(fieldKey))
          ],
          help: 'Обязательный атрибут указан в source.fields правил, но ни один source-алиас не найден в соответствующем классе CMDBuild.'
        });
      }
    }
  }

  return {
    issues,
    issueTokens: buildIssueTokenMap(issues)
  };
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

function sourceFieldLabel(field = {}) {
  const sources = sourceFieldSources(field);
  return sources.length > 0 ? sources.join(' | ') : '<not configured>';
}

function sourceFieldTokensForRule(fieldKey, field = {}) {
  return uniqueTokens([
    ...sourceFieldTokens(fieldKey),
    ...sourceFieldSources(field).flatMap(sourceName => sourceFieldTokens(fieldKey, sourceName))
  ]);
}

function findCatalogAttributeForField(attributes, field, fieldKey) {
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
    tokens: [`target:${targetKey(field)}`, 'target:payload'],
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
    meta: `${sourceFieldLabel(field)}${field.required ? ' required' : ''}${field.validationRegex ? ` | ${field.validationRegex}` : ''}`,
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

  appendConversionRuleSection(container, 'Group rules', rules.groupSelectionRules ?? [], 'hostGroups', null, rules);
  appendConversionRuleSection(container, 'Template rules', rules.templateSelectionRules ?? [], 'templates', null, rules);
  appendConversionRuleSection(container, 'Template group rules', rules.templateGroupSelectionRules ?? [], 'templateGroups', null, rules);
  appendConversionRuleSection(container, 'Interface address rules', rules.interfaceAddressRules ?? [], 'interfaceAddress', null, rules);
  appendConversionRuleSection(container, 'Interface rules', rules.interfaceSelectionRules ?? [], 'interface', null, rules);
  appendConversionRuleSection(container, 'Tag rules', rules.tagSelectionRules ?? [], 'tags', null, rules);
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
      : `Обязательное поле "${field.label}" не найдено для класса "${item.name}". Перед добавлением класса в rules проверьте CMDBuild attribute или webhook mapping.`
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
      label: 'Загрузка',
      meta: 'данные раздела загружаются по требованию',
      tokens: options.tokens ?? [],
      level: 1,
      kind: 'zabbix'
    }));
    try {
      body.replaceChildren(...await Promise.resolve(buildNodes()));
    } catch (error) {
      console.error(`Mapping lazy render failed for ${title}`, error);
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
      help: 'Раздел слишком большой для полной интерактивной отрисовки в Mapping. Ограничение защищает UI от зависания.'
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
    'Group rules': 'Правила выбора host groups по regex над class attribute fields. Обычно редактируются в JSON правил: priority, when.anyRegex/when.allRegex и ссылки на существующие Zabbix host groups. CMDBuild менять не нужно, если поля уже приходят в webhook.',
    'Template rules': 'Правила выбора Zabbix templates по regex над class attribute fields. В условии можно использовать lookup/class attribute field zabbixTag, если tag из CMDBuild должен влиять на выбор шаблона. Результатом Template rules должны оставаться только templates/templateRef; выбирать или назначать Zabbix tags в этом блоке нецелесообразно, для этого есть Tag rules.',
    'Interface address rules': 'Правила выбора адреса Zabbix interface. Можно выбирать IP или DNS через mode и valueField; valueField ссылается на нормализованное class attribute field, например ipAddress или dnsName.',
    'Interface rules': 'Правила выбора интерфейса мониторинга. Без изменения микросервисов можно менять regex и ссылки на уже описанные interface defaults, пока Zabbix writer поддерживает этот тип интерфейса.',
    'Tag rules': 'Правила формирования Zabbix tags. Они читают class attribute fields через regex, например zabbixTag, и добавляют tag/value в payload. Связь с блоком Tags прямая: Tag rules создают элементы, которые видны как Tags. Tag rules не выбирают templates; если tag должен влиять на template, используйте тот же class attribute field как условие в Template rules.',
    'T4 templates': 'T4-шаблоны JSON-RPC payload. Можно менять структуру payload для уже поддержанных Zabbix methods и Model-полей. Новые Model-поля, новые методы или новая логика выполнения требуют правки микросервисов.'
  };

  return helpByTitle[title]
    ?? `Блок "${title}" группирует элементы mapping. Если это класс CMDBuild, сам класс и его attributes приходят из CMDBuild; в JSON правил меняется только список допустимых классов и правила обработки, а источник не редактируется.`;
}

function sourceFieldHelp(fieldKey, field) {
  const regexText = field.validationRegex
    ? ` Валидация выполняется regex: ${field.validationRegex}.`
    : '';
  const requiredText = field.required
    ? ' Поле обязательное: событие без него не должно проходить нормальную обработку.'
    : ' Поле необязательное: правило может использовать его, если значение пришло в payload.';
  return `Conversion field "${fieldKey}" читает source "${sourceFieldLabel(field)}" из CMDBuild webhook и кладет значение в Model.${modelFieldName(fieldKey)}.${requiredText}${regexText} Если указано несколько source-алиасов, берется первый найденный в payload.`;
}

function cmdbFieldHelp(className, fieldKey, field, attribute) {
  const sourceText = attribute
    ? `Атрибут CMDBuild найден: ${attribute.name}, тип ${attribute.type}.`
    : `Ни один source-алиас "${sourceFieldLabel(field)}" не найден в каталоге класса или поле является служебным webhook-полем.`;
  return `Для класса "${className}" conversion field "${fieldKey}" читает CMDBuild source "${sourceFieldLabel(field)}". ${sourceText} CMDBuild attribute здесь не редактируется; меняются только JSON rules, если источник уже передает это поле.`;
}

function lookupHelp(className, lookupName, lookup) {
  const catalogText = lookup
    ? `Справочник найден в CMDBuild catalog: ${lookup.name ?? lookupName}.`
    : 'Справочник показан по правилам, но не найден в текущем каталоге CMDBuild.';
  return `${catalogText} Для mapping используется связка class="${className}" + lookup="${lookupName}". Сам lookup и его значения меняются в CMDBuild, а поведение конвертации меняется regex-правилами в JSON.`;
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

function conversionRuleHelp(rule, type) {
  if (type === 'templates') {
    return `Template rule "${rule.name}" выбирает Zabbix templates. Условия when.anyRegex/when.allRegex могут читать любой class attribute field, включая lookup zabbixTag, если значение tag должно влиять на выбор шаблона. Результатом должны быть templates/templateRef; назначать tags здесь не нужно и обычно вредно для читаемости правил.`;
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
  }[kind] ?? 'Элемент mapping';
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
  return new Set(refineSelectionTokens(tokens));
}

function refineSelectionTokens(tokens) {
  const unique = uniqueTokens(tokens);
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
      tokens.push(...ruleTokens(rule, definition.rulesKey, rules));
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
    appendConversionRuleSection(container, `${definition.title} rules`, selectionRules, definition.rulesKey, validation, rules, appendSection);
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
      tokens.push(...conditionTokens(rule.when), ...ruleTokens(rule, type, rules));
    }
  }

  return uniqueTokens(tokens);
}

function appendConversionRuleSection(container, title, selectionRules, type, validation, rules, appendSection = appendMappingSection) {
  const ruleItems = Array.isArray(selectionRules) ? selectionRules : [];
  const nodes = ruleItems.length > 0
    ? ruleItems.flatMap(rule => ruleMappingNodes(rule, type, null, validation, rules))
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
      ...sourceFieldTokens(rule.valueField)
    );
  }

  if (rule.fallback) {
    tokens.push(`fallback:${type}`);
  }

  return uniqueTokens(tokens);
}

function targetTokensForRuleType(type) {
  if (type === 'hostGroups') {
    return ['target:groups'];
  }
  if (type === 'interface' || type === 'interfaceAddress' || type === 'interfaceProfiles') {
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

function isKnownMappingSourceField(rules, field) {
  return Boolean(rules?.source?.fields?.[field])
    || ['eventType', 'zabbixHostId', 'ipAddress', 'dnsName'].includes(canonicalSourceField(field));
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

function regexLiteralValues(pattern) {
  const cleaned = String(pattern ?? '')
    .replaceAll('(?i)', '')
    .replaceAll('\\b', '')
    .replace(/^\^|\$$/g, '')
    .replace(/[()]/g, '');
  if (!cleaned.includes('|')) {
    const singleValue = cleaned
      .replace(/\\/g, '')
      .replace(/[[\]{}.*+?^$]/g, '')
      .trim();
    return singleValue ? [singleValue] : [];
  }

  return cleaned
    .split('|')
    .map(item => item.replace(/\\/g, '').replace(/[[\]{}.*+?^$]/g, '').trim())
    .filter(item => item.length > 0);
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
    ipAddress: ['target:interfaces'],
    dnsName: ['target:interfaces'],
    description: ['target:groups', 'target:templates', 'target:interfaces'],
    os: ['target:groups', 'target:templates', 'target:tags'],
    zabbixTag: ['target:tags'],
    zabbixHostId: ['target:hostid', 'target:fallback'],
    eventType: ['target:method', 'target:tags']
  }[canonicalSourceField(fieldKey)] ?? [];
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
        || equalsIgnoreCase(field.type, 'lookup')) {
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

  for (const value of lookupValuesFromRules(rules, lookupName)) {
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

function canonicalSourceField(field) {
  const normalized = normalizeToken(field);
  return {
    entityid: 'entityId',
    id: 'entityId',
    code: 'code',
    classname: 'className',
    class: 'className',
    ipaddress: 'ipAddress',
    ip_address: 'ipAddress',
    dnsname: 'dnsName',
    dns_name: 'dnsName',
    fqdn: 'dnsName',
    hostname: 'dnsName',
    hostdns: 'dnsName',
    description: 'description',
    os: 'os',
    operatingsystem: 'os',
    zabbixtag: 'zabbixTag',
    zabbix_tag: 'zabbixTag',
    zabbixhostid: 'zabbixHostId',
    zabbix_hostid: 'zabbixHostId',
    eventtype: 'eventType'
  }[normalized] ?? field;
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
  const body = readRuntimeSettingsForm();
  const result = await api('/api/settings/runtime', {
    method: 'PUT',
    body
  });
  state.runtimeSettings = result;
  fillRuntimeSettingsForm(result);
  renderEventTopics(result.eventBrowser?.topics ?? [], $('#eventsTopic').value);
  toast('Runtime settings saved');
}

function fillRuntimeSettingsForm(settings) {
  const form = $('#runtimeSettingsForm');
  const defaults = settings.auth?.localLoginDefaults ?? {};
  const cmdbuild = settings.cmdbuild ?? {};
  const zabbix = settings.zabbix ?? {};
  const eventBrowser = settings.eventBrowser ?? {};

  form.elements.filePath.value = settings.filePath ?? '';
  form.elements.localDefaultsEnabled.checked = Boolean(defaults.enabled);
  form.elements.cmdbuildBaseUrl.value = cmdbuild.baseUrl ?? defaults.cmdbuildBaseUrl ?? '';
  form.elements.cmdbuildServiceUsername.value = cmdbuild.serviceAccount?.username ?? '';
  form.elements.cmdbuildServicePassword.value = cmdbuild.serviceAccount?.password ?? '';
  form.elements.cmdbuildDefaultUsername.value = defaults.cmdbuildUsername ?? '';
  form.elements.cmdbuildDefaultPassword.value = defaults.cmdbuildPassword ?? '';
  form.elements.zabbixApiEndpoint.value = zabbix.apiEndpoint ?? defaults.zabbixApiEndpoint ?? '';
  form.elements.zabbixServiceUser.value = zabbix.serviceAccount?.user ?? '';
  form.elements.zabbixServicePassword.value = zabbix.serviceAccount?.password ?? '';
  form.elements.zabbixServiceApiToken.value = zabbix.serviceAccount?.apiToken ?? '';
  form.elements.zabbixDefaultUsername.value = defaults.zabbixUsername ?? '';
  form.elements.zabbixDefaultPassword.value = defaults.zabbixPassword ?? '';
  form.elements.zabbixDefaultApiToken.value = defaults.zabbixApiToken ?? '';

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

function readRuntimeSettingsForm() {
  const form = new FormData($('#runtimeSettingsForm'));
  const cmdbuildBaseUrl = form.get('cmdbuildBaseUrl');
  const zabbixApiEndpoint = form.get('zabbixApiEndpoint');
  return {
    auth: {
      localLoginDefaults: {
        enabled: form.get('localDefaultsEnabled') === 'on',
        cmdbuildBaseUrl,
        cmdbuildUsername: form.get('cmdbuildDefaultUsername'),
        cmdbuildPassword: form.get('cmdbuildDefaultPassword'),
        zabbixApiEndpoint,
        zabbixUsername: form.get('zabbixDefaultUsername'),
        zabbixPassword: form.get('zabbixDefaultPassword'),
        zabbixApiToken: form.get('zabbixDefaultApiToken')
      }
    },
    cmdbuild: {
      baseUrl: cmdbuildBaseUrl,
      serviceAccount: {
        username: form.get('cmdbuildServiceUsername'),
        password: form.get('cmdbuildServicePassword')
      }
    },
    zabbix: {
      apiEndpoint: zabbixApiEndpoint,
      serviceAccount: {
        user: form.get('zabbixServiceUser'),
        password: form.get('zabbixServicePassword'),
        apiToken: form.get('zabbixServiceApiToken')
      }
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
  const form = new FormData($('#idpForm'));
  const result = await api('/api/settings/idp', {
    method: 'PUT',
    body: {
      enabled: form.get('enabled') === 'on',
      metadataUrl: form.get('metadataUrl'),
      entityId: form.get('entityId'),
      ssoUrl: form.get('ssoUrl'),
      sloUrl: form.get('sloUrl'),
      spEntityId: form.get('spEntityId'),
      acsUrl: form.get('acsUrl'),
      sloCallbackUrl: form.get('sloCallbackUrl'),
      nameIdFormat: form.get('nameIdFormat'),
      authnRequestBinding: form.get('authnRequestBinding'),
      requireSignedResponses: form.get('requireSignedResponses') === 'on',
      requireSignedAssertions: form.get('requireSignedAssertions') === 'on',
      idpX509Certificate: form.get('idpX509Certificate'),
      spCertificate: form.get('spCertificate'),
      spPrivateKey: form.get('spPrivateKey')
    }
  });
  fillIdpForm(result);
  toast('IdP settings saved');
}

function fillIdpForm(idp) {
  const form = $('#idpForm');
  form.elements.enabled.checked = Boolean(idp.enabled);
  for (const field of ['metadataUrl', 'entityId', 'ssoUrl', 'sloUrl', 'spEntityId', 'acsUrl', 'sloCallbackUrl', 'nameIdFormat', 'authnRequestBinding']) {
    form.elements[field].value = idp[field] ?? '';
  }
  form.elements.requireSignedResponses.checked = Boolean(idp.requireSignedResponses);
  form.elements.requireSignedAssertions.checked = Boolean(idp.requireSignedAssertions);
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
    '.brand': 'Название приложения cmdb2monitoring.',
    '#sessionSummary': 'Текущий пользователь и способ авторизации.',
    '#idpLoginButton': 'Запускает вход через внешний IdP по SAML2.',
    '#logoutButton': 'Завершает текущую пользовательскую сессию.',
    '#refreshDashboard': 'Повторно проверяет доступность сервисов.',
    '#eventsMaxMessages': 'Количество последних сообщений Kafka, которое будет выведено снизу.',
    '#refreshEvents': 'Загружает список топиков и последние сообщения выбранного топика.',
    '#loadRules': 'Загружает текущий JSON правил конвертации.',
    '#validateRules': 'Проверяет JSON правил по серверной схеме.',
    '#rulesFile': 'Выбор локального JSON-файла правил для проверки или загрузки.',
    '#dryRunPayload': 'Тестовый CMDBuild payload для dry-run конвертации.',
    '#dryRunRules': 'Выполняет пробную конвертацию без сохранения правил.',
    '#uploadRules': 'Сохраняет выбранный JSON правил на backend.',
    '#loadMapping': 'Загружает визуальную карту связей Zabbix, правил и CMDBuild.',
    '#mappingMode': 'Переключает Mapping между просмотром и редактированием draft-правил текущей сессии.',
    '#mappingEditAction': 'Переключает действие редактора: добавление нового conversion rule или удаление существующих rules из draft JSON.',
    '#mappingClearSelection': 'Снимает выделение цепочки Mapping в режиме просмотра и возвращает обычный обзор.',
    '#mappingUndo': 'Отменяет последнее изменение draft-правил Mapping в текущей сессии.',
    '#mappingRedo': 'Возвращает отмененное изменение draft-правил Mapping.',
    '#mappingSaveAs': 'Сохраняет текущий draft JSON правил без отправки на backend. Вторым файлом формируются только webhook Body/DELETE-инструкции по добавленным и удаленным правилам текущей сессии.',
    '#mappingAddRule': 'Добавляет выбранную conversion structure в draft JSON правил.',
    '#mappingDeleteSelectAll': 'Отмечает все rules в режиме удаления.',
    '#mappingDeleteClear': 'Снимает отметки со всех rules в режиме удаления.',
    '#mappingDeleteSelected': 'Удаляет отмеченные rules из draft JSON после подтверждения. Классы и class attribute fields остаются на месте.',
    '#loadValidateMapping': 'Запускает проверку правил против текущих каталогов Zabbix и CMDBuild.',
    '#syncZabbix': 'Обновляет каталог Zabbix из API Zabbix.',
    '#loadZabbix': 'Загружает сохраненный каталог Zabbix.',
    '#syncCmdbuild': 'Обновляет каталог CMDBuild через API CMDBuild.',
    '#loadCmdbuild': 'Загружает сохраненный каталог CMDBuild.',
    '#loadSettings': 'Загружает runtime-настройки из внешнего файла.',
    '#saveRuntimeSettings': 'Сохраняет runtime-настройки во внешний файл.',
    '#saveIdp': 'Сохраняет настройки IdP/SAML2.',
    '#helpPopoverClose': 'Закрывает открытую подсказку.'
  };
  for (const [selector, text] of Object.entries(selectorHelp)) {
    $$(selector).forEach(node => setHelp(node, text));
  }

  $$('label').forEach(label => {
    const labelText = label.querySelector('span')?.textContent?.trim();
    const control = label.querySelector('input, select, textarea');
    if (control?.tagName === 'SELECT') {
      return;
    }
    if (labelText && control && !control.dataset.help) {
      setHelp(control, `Поле "${labelText}". Значение используется соответствующим разделом интерфейса или сохраняется во внешний конфигурационный файл.`);
    }
  });

  $$('table th').forEach(header => {
    const text = header.textContent.trim();
    if (text) {
      setHelp(header, `Колонка таблицы "${text}".`);
    }
  });

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
    throw new Error(payload.message ?? payload.error ?? `HTTP ${response.status}`);
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

function uniqueTokens(tokens) {
  return [...new Set(tokens.filter(Boolean).map(String))];
}

function normalizeToken(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
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
