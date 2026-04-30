const state = {
  currentRules: null,
  uploadedRulesText: null,
  runtimeSettings: null,
  mappingLoaded: false,
  validateMappingLoaded: false
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const defaultEventMaxMessages = 5;
const zabbixExtensionDefinitions = [
  {
    title: 'Proxies',
    rulesKey: 'proxies',
    selectionRulesKey: 'proxySelectionRules',
    catalogKey: 'proxies',
    idField: 'proxyid',
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
    label: item => item.macro || item.name || item.globalmacroid,
    meta: item => item.description || item.value || '',
    help: 'Global macro - существующий macro в Zabbix. В rules его целесообразно использовать как ссылку или значение для host macros, не как замену Source fields.'
  },
  {
    title: 'Host macros',
    rulesKey: 'hostMacros',
    selectionRulesKey: 'hostMacroSelectionRules',
    catalogKey: 'hostMacros',
    idField: 'hostmacroid',
    requiresCatalog: false,
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
    label: item => item.name || item.valuemapid,
    meta: item => `${item.mappings?.length ?? 0} mappings`,
    help: 'Value map - объект Zabbix для отображения значений items. В CMDB->host mapping обычно справочный, применять его напрямую к host payload нужно осторожно.'
  }
];
const viewDescriptions = {
  dashboard: 'Показывает состояние доступности сервисов и быстрые проверки текущего окружения.',
  events: 'Показывает используемые Kafka-топики и последние сообщения выбранного топика.',
  rules: 'Загружает текущий JSON правил, проверяет его, выполняет dry-run и upload нового файла правил.',
  mapping: 'Показывает цепочку CMDBuild -> conversion rules -> Zabbix. Template rules выбирают templates, Tag rules формируют tags; одно и то же Source field, например zabbixTag, может использоваться как условие в обоих блоках, но результат у них разный.',
  validateMapping: 'Проверяет правила против каталогов Zabbix и CMDBuild; красным отмечаются только отсутствующие сущности в источниках. Template rules не назначают tags, а Tag rules не назначают templates; смешивать результат этих блоков нецелесообразно.',
  zabbix: 'Показывает templates, host groups, template groups, tags и расширенные Zabbix-справочники: proxies, macros, inventory fields, interface profiles, statuses, maintenance, TLS/PSK и value maps.',
  cmdbuild: 'Показывает классы, атрибуты и lookup-справочники, загруженные из CMDBuild.',
  settings: 'Содержит runtime-настройки подключений, Kafka Events и IdP/SAML2.'
};

const defaultPayload = {
  source: 'cmdbuild',
  eventType: 'update',
  className: 'Server',
  id: '109921',
  code: 's1',
  ip_address: '1.1.1.2',
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
  renderRows($('#zabbixTemplates'), catalog.templates ?? [], item => [item.templateid, item.name, item.host]);
  renderRows($('#zabbixHostGroups'), catalog.hostGroups ?? [], item => [item.groupid, item.name]);
  renderRows($('#zabbixTemplateGroups'), catalog.templateGroups ?? [], item => [item.groupid, item.name]);
  renderRows($('#zabbixTags'), catalog.tags ?? [], item => [item.tag, item.value]);
  renderRows($('#zabbixProxies'), catalog.proxies ?? [], item => [item.proxyid, item.name, item.operating_mode ?? '']);
  renderRows($('#zabbixProxyGroups'), catalog.proxyGroups ?? [], item => [item.proxy_groupid, item.name, item.failover_delay ?? '']);
  renderRows($('#zabbixGlobalMacros'), catalog.globalMacros ?? [], item => [item.globalmacroid, item.macro, item.description ?? '']);
  renderRows($('#zabbixHostMacros'), catalog.hostMacros ?? [], item => [item.hostmacroid, item.macro, hostMacroHost(item)]);
  renderRows($('#zabbixInventoryFields'), catalog.inventoryFields ?? [], item => [item.name]);
  renderRows($('#zabbixInterfaceProfiles'), catalog.interfaceProfiles ?? [], item => [item.name, item.type, item.defaultPort]);
  renderRows($('#zabbixHostStatuses'), catalog.hostStatuses ?? [], item => [item.status, item.name]);
  renderRows($('#zabbixMaintenances'), catalog.maintenances ?? [], item => [item.maintenanceid, item.name, item.maintenance_type ?? '']);
  renderRows($('#zabbixTlsPskModes'), catalog.tlsPskModes ?? [], item => [item.name, item.tls_connect, item.tls_accept]);
  renderRows($('#zabbixValueMaps'), catalog.valueMaps ?? [], item => [item.valuemapid, item.name, String(item.mappings?.length ?? 0)]);
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
  const [rulesDocument, zabbixCatalog, cmdbuildCatalog] = await Promise.all([
    api('/api/rules/current'),
    api('/api/zabbix/catalog'),
    api('/api/cmdbuild/catalog')
  ]);

  state.currentRules = rulesDocument;
  renderMapping(rulesDocument.content, zabbixCatalog, cmdbuildCatalog);
  state.mappingLoaded = true;
}

function renderMapping(rules, zabbixCatalog, cmdbuildCatalog) {
  renderMappingZabbix($('#mappingZabbix'), rules, zabbixCatalog);
  renderMappingRules($('#mappingRules'), rules, cmdbuildCatalog);
  renderMappingCmdbuild($('#mappingCmdbuild'), rules, cmdbuildCatalog);
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
    const tokens = [`class:${normalizeToken(className)}`, ...sourceFieldTokens('className')];
    return mappingNode({
      label: className,
      meta: 'configured',
      tokens,
      level: 1,
      kind: 'source',
      status: 'normal',
      help: 'Класс источника из JSON правил. Он должен существовать в CMDBuild, иначе события этого класса нельзя корректно обработать.'
    });
  }));

  appendValidationSection(container, 'Source fields', Object.entries(rules.source?.fields ?? {}).map(([fieldKey, field]) => {
    const tokens = [
      ...sourceFieldTokens(fieldKey, field.source),
      ...sourceFieldTargetTokens(fieldKey),
      ...lookupFieldTokens(fieldKey, lookupFields)
    ];
    return mappingNode({
      label: fieldKey,
      meta: `${field.source}${field.required ? ' required' : ''}${field.validationRegex ? ` | ${field.validationRegex}` : ''}`,
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
  appendValidationSection(container, 'Interface rules', (rules.interfaceSelectionRules ?? []).flatMap(rule => ruleMappingNodes(rule, 'interface', rule.interfaceRef, null, rules)));
  appendValidationSection(container, 'Tag rules', (rules.tagSelectionRules ?? []).flatMap(rule => ruleMappingNodes(rule, 'tags', null, null, rules)));
  appendOptionalZabbixRuleSections(container, rules, validation, appendValidationSection);
}

function renderValidateMappingCmdbuild(container, rules, catalog, validation) {
  clear(container);
  const classes = rules.source?.entityClasses ?? [];
  const attributesByClass = new Map((catalog.attributes ?? []).map(item => [String(item.className).toLowerCase(), item.items ?? []]));
  const lookupFieldNames = new Set(lookupSourceFields(rules, catalog));

  for (const className of classes) {
    const catalogClass = findCatalogClass(catalog, className);
    const classTokens = [`class:${normalizeToken(className)}`, ...sourceFieldTokens('className')];
    const classMissing = !catalogClass;
    const rawClassNode = mappingNode({
      label: className,
      meta: catalogClass ? `${catalogClass.parent ?? 'Class'} / ${catalogClass.active === false ? 'inactive' : 'active'}` : 'нет в CMDBuild',
      tokens: classTokens,
      level: 1,
      kind: 'cmdb',
      status: classMissing ? 'error' : 'normal',
      help: catalogClass
        ? 'Класс найден в каталоге CMDBuild.'
        : 'Класс указан в правилах, но отсутствует в каталоге CMDBuild. Исправьте имя класса или создайте класс.'
    });
    const classNode = classMissing ? validationFixNode(rawClassNode, {
      scope: 'cmdbuild',
      kind: 'class',
      className
    }) : rawClassNode;
    const attributes = catalogClass ? attributesByClass.get(String(catalogClass.name).toLowerCase()) ?? [] : [];
    const fieldNodes = Object.entries(rules.source?.fields ?? {}).flatMap(([fieldKey, field]) => {
      const canonicalField = canonicalSourceField(fieldKey);
      const isVirtual = isVirtualSourceField(fieldKey, field.source);
      const attribute = isVirtual ? null : findCatalogAttribute(attributes, field.source, fieldKey);
      const attributeMissing = !isVirtual && !classMissing && !attribute;
      const tokens = [
        ...sourceFieldTokens(fieldKey, field.source),
        ...sourceFieldTargetTokens(fieldKey),
        ...lookupFieldTokens(fieldKey, lookupFieldNames),
        classFieldToken(className, canonicalField)
      ];
      const rawNode = mappingNode({
        label: `${fieldKey} <- ${field.source}`,
        meta: isVirtual
          ? 'служебное поле webhook'
          : attribute
            ? `${attribute.name} / ${attribute.type}${attribute.mandatory ? ' mandatory' : ''}`
            : 'нет в CMDBuild',
        tokens,
        level: 2,
        kind: 'cmdb',
        status: attributeMissing ? 'error' : 'normal',
        help: isVirtual
          ? 'Служебное поле события, которое приходит из webhook payload и не обязано быть атрибутом CMDBuild.'
          : attribute
            ? 'Атрибут найден в классе CMDBuild.'
            : 'Атрибут указан в правилах, но отсутствует в классе CMDBuild.'
      });
      const nodes = [attributeMissing ? validationFixNode(rawNode, {
        scope: 'cmdbuild',
        kind: 'attribute',
        className,
        fieldKey,
        source: field.source ?? ''
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

  const attributesByClass = new Map((cmdbuildCatalog.attributes ?? []).map(item => [String(item.className).toLowerCase(), item.items ?? []]));
  for (const className of rules.source?.entityClasses ?? []) {
    const catalogClass = findCatalogClass(cmdbuildCatalog, className);
    if (!catalogClass) {
      addIssue({
        source: 'cmdbuild',
        message: `CMDBuild class отсутствует: ${className}`,
        tokens: [`class:${normalizeToken(className)}`, ...sourceFieldTokens('className')],
        help: 'Класс указан в source.entityClasses правил, но не найден в каталоге CMDBuild.'
      });
      continue;
    }

    const attributes = attributesByClass.get(String(catalogClass.name).toLowerCase()) ?? [];
    for (const [fieldKey, field] of Object.entries(rules.source?.fields ?? {})) {
      if (isVirtualSourceField(fieldKey, field.source)) {
        continue;
      }

      const attribute = findCatalogAttribute(attributes, field.source, fieldKey);
      if (!attribute) {
        addIssue({
          source: 'cmdbuild',
          message: `CMDBuild attribute отсутствует: ${catalogClass.name}.${field.source}`,
          tokens: [
            ...sourceFieldTokens(fieldKey, field.source),
            classFieldToken(className, canonicalSourceField(fieldKey))
          ],
          help: 'Атрибут указан в source.fields правил, но не найден в соответствующем классе CMDBuild.'
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
  return (catalog.classes ?? []).find(item => normalizeClassName(item.name) === wanted);
}

function normalizeClassName(value) {
  const token = normalizeToken(value);
  return token.endsWith('s') ? token.slice(0, -1) : token;
}

function isVirtualSourceField(fieldKey, sourceName) {
  return ['className', 'eventType'].includes(canonicalSourceField(fieldKey))
    || ['className', 'eventType'].includes(canonicalSourceField(sourceName));
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

  appendMappingSection(container, 'Tags', zabbixTags(rules, catalog).map(tag => mappingNode({
    label: tag.tag,
    meta: tag.value ?? '',
    tokens: zabbixItemTokens(rules, 'tags', tag.tag, tag.value),
    level: 1,
    kind: 'zabbix'
  })));

  for (const definition of zabbixExtensionDefinitions) {
    appendMappingSection(container, definition.title, zabbixExtensionItems(rules, catalog, definition).map(item => mappingNode({
      label: definition.label(item),
      meta: definition.meta(item),
      tokens: zabbixExtensionTokens(definition, item),
      level: 1,
      kind: 'zabbix',
      help: definition.help
    })), {
      expanded: false,
      help: definition.help
    });
  }
}

function renderMappingRules(container, rules, cmdbuildCatalog = null) {
  clear(container);
  const lookupFields = new Set(lookupSourceFields(rules, cmdbuildCatalog));

  appendMappingSection(container, 'Source fields', Object.entries(rules.source?.fields ?? {}).map(([fieldKey, field]) => mappingNode({
    label: fieldKey,
    meta: `${field.source}${field.required ? ' required' : ''}${field.validationRegex ? ` | ${field.validationRegex}` : ''}`,
    tokens: [
      ...sourceFieldTokens(fieldKey, field.source),
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

  appendMappingSection(container, 'Group rules', (rules.groupSelectionRules ?? []).flatMap(rule => ruleMappingNodes(rule, 'hostGroups', null, null, rules)));

  appendMappingSection(container, 'Template rules', (rules.templateSelectionRules ?? []).flatMap(rule => ruleMappingNodes(rule, 'templates', null, null, rules)));

  appendMappingSection(container, 'Interface rules', (rules.interfaceSelectionRules ?? []).flatMap(rule => ruleMappingNodes(rule, 'interface', rule.interfaceRef, null, rules)));

  appendMappingSection(container, 'Tag rules', (rules.tagSelectionRules ?? []).flatMap(rule => ruleMappingNodes(rule, 'tags', null, null, rules)));
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

  for (const className of classes) {
    const classNode = mappingNode({
      label: className,
      meta: classMeta(catalog, className),
      tokens: [`class:${normalizeToken(className)}`, ...sourceFieldTokens('className')],
      level: 1,
      kind: 'cmdb',
      help: `Класс CMDBuild "${className}" участвует в правилах как source entity. Сам класс создается и меняется в CMDBuild; в JSON правил можно только включить или исключить его из source.entityClasses, если webhook уже передает события этого класса.`
    });
    const fieldNodes = Object.entries(rules.source?.fields ?? {}).flatMap(([fieldKey, field]) => {
      const attribute = findCatalogAttribute(attributesByClass.get(className.toLowerCase()) ?? [], field.source, fieldKey);
      const canonicalField = canonicalSourceField(fieldKey);
      const nodes = [mappingNode({
        label: `${fieldKey} <- ${field.source}`,
        meta: attribute ? `${attribute.name} / ${attribute.type}${attribute.mandatory ? ' mandatory' : ''}` : field.required ? 'required' : 'optional',
        tokens: [
          ...sourceFieldTokens(fieldKey, field.source),
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

    appendMappingSection(container, className, [classNode, ...fieldNodes], {
      help: `Класс "${className}" в CMDBuild-части mapping. Атрибуты и lookup-справочники приходят из CMDBuild catalog. Без изменения источника можно редактировать только правила, которые читают эти атрибуты.`
    });
  }
}

function appendMappingSection(container, title, nodes, options = {}) {
  const section = document.createElement('div');
  section.className = `mapping-section mapping-section-status-${options.status ?? 'normal'}`;
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
  setMappingSectionExpanded(section, options.expanded ?? true);
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
    'Source fields': 'Conversion fields: поле слева является нормализованным Model-полем конвертера, source справа указывает атрибут или ключ webhook CMDBuild. Без правки микросервиса безопасно менять source, required и validationRegex для уже поддержанных Model-полей и реально существующих CMDBuild attributes.',
    'Event routing': 'Маршрутизация create/update/delete в JSON-RPC методы Zabbix и T4-шаблоны. Без правки микросервисов можно менять метод, templateName и fallbackTemplateName только в рамках уже поддержанных сценариев и существующих T4 templates.',
    'Group rules': 'Правила выбора host groups по regex над Source fields. Обычно редактируются в JSON правил: priority, when.anyRegex и ссылки на существующие Zabbix host groups. CMDBuild менять не нужно, если поля уже приходят в webhook.',
    'Template rules': 'Правила выбора Zabbix templates по regex над Source fields. В условии можно использовать lookup/source field zabbixTag, если tag из CMDBuild должен влиять на выбор шаблона. Результатом Template rules должны оставаться только templates/templateRef; выбирать или назначать Zabbix tags в этом блоке нецелесообразно, для этого есть Tag rules.',
    'Interface rules': 'Правила выбора интерфейса мониторинга. Без изменения микросервисов можно менять regex и ссылки на уже описанные interface defaults, пока Zabbix writer поддерживает этот тип интерфейса.',
    'Tag rules': 'Правила формирования Zabbix tags. Они читают Source fields через regex, например zabbixTag, и добавляют tag/value в payload. Связь с блоком Tags прямая: Tag rules создают элементы, которые видны как Tags. Tag rules не выбирают templates; если tag должен влиять на template, используйте тот же source field как условие в Template rules.',
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
  return `Conversion field "${fieldKey}" читает source "${field.source}" из CMDBuild webhook и кладет значение в Model.${modelFieldName(fieldKey)}.${requiredText}${regexText} Без переписывания микросервиса меняйте только mapping для существующего source-атрибута и уже поддержанного Model-поля.`;
}

function cmdbFieldHelp(className, fieldKey, field, attribute) {
  const sourceText = attribute
    ? `Атрибут CMDBuild найден: ${attribute.name}, тип ${attribute.type}.`
    : `Атрибут "${field.source}" не найден в каталоге класса или является служебным полем webhook.`;
  return `Для класса "${className}" conversion field "${fieldKey}" читает CMDBuild source "${field.source}". ${sourceText} CMDBuild attribute здесь не редактируется; меняются только JSON rules, если источник уже передает это поле.`;
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
    return `Template rule "${rule.name}" выбирает Zabbix templates. Условия when.anyRegex могут читать любой Source field, включая lookup zabbixTag, если значение tag должно влиять на выбор шаблона. Результатом должны быть templates/templateRef; назначать tags здесь не нужно и обычно вредно для читаемости правил.`;
  }

  if (type === 'tags') {
    return `Tag rule "${rule.name}" формирует Zabbix tags. Условия when.anyRegex читают Source fields, результатом являются tag/value или tag/valueTemplate. Эти элементы затем видны в блоке Tags и попадают в tags[] payload. Template этот блок не выбирает.`;
  }

  const targetText = {
    hostGroups: 'Zabbix host groups',
    interface: 'monitoring interface'
  }[type] ?? type;
  return `Правило "${rule.name}" выбирает ${targetText}. Условия when.anyRegex читают Source fields, результат берется из этого правила или ref/defaults. Обычно можно менять priority, regex и ссылки на существующие Zabbix objects. Новые source-поля или новая логика обработки требуют изменения микросервиса.`;
}

function t4TemplateHelp(name) {
  return `T4 template "${name}" формирует JSON-RPC payload для Zabbix. Можно менять JSON и использовать уже доступные Model-поля из Source fields. Если нужен новый Model.X, новый Zabbix method или другая логика выполнения, потребуется изменение микросервиса.`;
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
  const tokens = new Set(lookupValueMode
    ? lookupValueSourceTokensFor(sourceNode)
    : relationTokensFor(sourceNode, includeBroadTokens));
  [...scope.querySelectorAll('.mapping-node')].forEach(node => {
    const nodeTokens = lookupValueMode
      ? lookupValueCandidateTokensFor(node)
      : relationTokensFor(node, includeBroadTokens);
    const relatedTokens = nodeTokens.filter(token => tokens.has(token));
    const sameColumn = node.closest('.mapping-column') === sourceColumn;
    const lookupBridge = !lookupValueMode
      && sameColumn
      && ((sourceNode.dataset.kind === 'lookup') !== (node.dataset.kind === 'lookup'))
      && relatedTokens.some(token => token.startsWith('class-field:'));
    const lookupFamily = !lookupValueMode
      && sameColumn
      && sourceNode.dataset.kind === 'lookup'
      && node.dataset.kind === 'lookup'
      && relatedTokens.some(isLookupRelationToken);
    const lookupValueRelated = lookupValueMode && relatedTokens.length > 0;
    const related = lookupValueRelated || (!sameColumn && relatedTokens.length > 0) || lookupBridge || lookupFamily;
    node.classList.toggle('is-selected', node === sourceNode);
    node.classList.toggle('is-related', related && node !== sourceNode);
  });

  updateMappingSectionVisibility(scope);
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
    || token.startsWith('event:')
    || token.startsWith('method:')
    || token.startsWith('interface:')
    || token.startsWith('fallback:');
}

function isLookupRelationToken(token) {
  return token.startsWith('lookup:')
    || token.startsWith('field-lookup:')
    || token.startsWith('class-lookup-value:')
    || token.startsWith('lookup-value:')
    || token.startsWith('class-field:')
    || token.startsWith('match:');
}

function updateMappingSectionVisibility(scope = document) {
  const sections = [...scope.querySelectorAll('.mapping-section')];
  const hasAnyActiveNode = sections.some(section => section.querySelector('.mapping-node.is-selected, .mapping-node.is-related'));

  sections.forEach(section => {
    const hasActiveNode = Boolean(section.querySelector('.mapping-node.is-selected, .mapping-node.is-related'));
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

function zabbixTags(rules, catalog) {
  return uniqueById([
    ...(catalog.tags ?? []),
    ...(rules.defaults?.tags ?? []),
    ...(rules.tagSelectionRules ?? []).flatMap(rule => rule.tags ?? [])
  ], 'tag');
}

function zabbixExtensionItems(rules, catalog, definition) {
  return uniqueById([
    ...(catalog[definition.catalogKey] ?? []),
    ...referencedZabbixExtensionItems(rules, definition)
  ], definition.idField);
}

function referencedZabbixExtensionItems(rules, definition) {
  const selectionRules = rules[definition.selectionRulesKey] ?? rules[`${definition.rulesKey}SelectionRules`] ?? [];
  const singularKey = singularRuleKey(definition.rulesKey);
  return uniqueById([
    ...(rules.lookups?.[definition.rulesKey] ?? []),
    ...(rules.defaults?.[definition.rulesKey] ?? []),
    ...(rules.defaults?.[singularKey] ? [rules.defaults[singularKey]] : []),
    ...selectionRules.flatMap(rule => [
      ...(rule[definition.rulesKey] ?? []),
      ...(rule[singularKey] ? [rule[singularKey]] : []),
      ...itemsFromRulesRef(rules, rule[`${definition.rulesKey}Ref`]),
      ...itemsFromRulesRef(rules, rule[`${singularKey}Ref`])
    ])
  ], definition.idField);
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
  return [
    `target:${definition.rulesKey}`,
    `zbx-${definition.rulesKey}:${normalizeToken(id)}`,
    `zbx-${definition.rulesKey}:${normalizeToken(definition.label(item))}`
  ];
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
    if (!Array.isArray(selectionRules) || selectionRules.length === 0) {
      continue;
    }

    appendSection(
      container,
      `${definition.title} rules`,
      selectionRules.flatMap(rule => ruleMappingNodes(rule, definition.rulesKey, null, validation, rules))
    );
  }
}

function zabbixItemTokens(rules, type, id, name) {
  const tokens = [`target:${type === 'hostGroups' ? 'groups' : type}`, `zbx-${type}:${normalizeToken(id || name)}`];
  const ruleLists = {
    hostGroups: rules.groupSelectionRules ?? [],
    templates: rules.templateSelectionRules ?? [],
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

function ruleMappingNodes(rule, type, meta = null, validation = null, rules = null) {
  const tokens = ruleTokens(rule, type, rules);
  return [
    mappingNode({
      label: rule.name,
      meta: meta ?? (rule.fallback ? 'fallback' : `priority ${rule.priority}`),
      tokens,
      level: 1,
      kind: 'rule',
      status: validationStatus(tokens, validation),
      help: conversionRuleHelp(rule, type)
    }),
    ...regexMappingNodes(rule, type, validation)
  ];
}

function regexMappingNodes(rule, type, validation = null) {
  return (rule.when?.anyRegex ?? []).map(matcher => {
    const tokens = [
      `rule:${normalizeToken(rule.name)}`,
      `target:${type === 'hostGroups' ? 'groups' : type}`,
      ...sourceFieldTokens(matcher.field),
      ...regexLiteralTokens(matcher.field, matcher.pattern)
    ];
    return mappingNode({
      label: matcher.field,
      meta: matcher.pattern,
      tokens,
      level: 2,
      kind: 'regex',
      status: validationStatus(tokens, validation),
      help: `Regex condition правила "${rule.name}". Читает Source field "${matcher.field}" и сравнивает значение с pattern "${matcher.pattern}". Это редактируемая часть JSON правил, если поле уже есть в Source fields и приходит из CMDBuild webhook.`
    });
  });
}

function ruleTokens(rule, type, rules = null) {
  const tokens = [
    `rule:${normalizeToken(rule.name)}`,
    `target:${type === 'hostGroups' ? 'groups' : type}`,
    ...conditionTokens(rule.when),
    ...conditionMatchTokens(rule.when)
  ];

  for (const item of rules ? selectionItemsForRule(rules, rule, type) : rule[type] ?? []) {
    if (type === 'hostGroups') {
      tokens.push(`zbx-hostGroups:${normalizeToken(item.groupid || item.name)}`);
    } else if (type === 'templates') {
      tokens.push(`zbx-templates:${normalizeToken(item.templateid || item.name)}`);
    } else if (type === 'tags') {
      tokens.push(`zbx-tags:${normalizeToken(item.tag)}`, ...tagValueTokens(item));
    } else {
      tokens.push(...zabbixRuleItemTokens(type, item));
    }
  }

  if (type === 'interface') {
    tokens.push(`target:interfaces`, `interface:${normalizeToken(rule.interfaceRef)}`);
  }

  if (rule.fallback) {
    tokens.push(`fallback:${type}`);
  }

  return uniqueTokens(tokens);
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
    ...(rule.requiredFields ?? []).flatMap(field => sourceFieldTokens(field)),
    ...templateSourceFieldTokens(rules, templateNames)
  ]);
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
    || ['eventType', 'zabbixHostId'].includes(canonicalSourceField(field));
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
    ...(rule[type] ?? []),
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

  return (condition.anyRegex ?? []).flatMap(matcher => sourceFieldTokens(matcher.field));
}

function conditionMatchTokens(condition = {}) {
  return (condition.anyRegex ?? []).flatMap(matcher => regexLiteralTokens(matcher.field, matcher.pattern));
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
    return [];
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
  return String(tag.valueTemplate ?? '')
    .match(/Model\.([A-Za-z0-9_]+)/g)
    ?.map(item => sourceFieldTokens(item.replace('Model.', '')))
    .flat() ?? [];
}

function lookupSourceFields(rules, catalog = null) {
  const fields = new Set();
  const classes = rules.source?.entityClasses ?? [];
  const attributesByClass = new Map((catalog?.attributes ?? []).map(item => [String(item.className).toLowerCase(), item.items ?? []]));

  for (const [fieldKey, field] of Object.entries(rules.source?.fields ?? {})) {
    if (equalsIgnoreCase(field.source, 'OS') || equalsIgnoreCase(field.source, 'zabbixTag') || equalsIgnoreCase(field.type, 'lookup')) {
      fields.add(canonicalSourceField(fieldKey));
      continue;
    }

    if (!catalog) {
      continue;
    }

    const hasLookupAttribute = classes.some(className => {
      const catalogClass = findCatalogClass(catalog, className);
      const attributes = attributesByClass.get(String(catalogClass?.name ?? className).toLowerCase()) ?? [];
      const attribute = findCatalogAttribute(attributes, field.source, fieldKey);
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
    for (const matcher of rule.when?.anyRegex ?? []) {
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
  const item = (catalog.classes ?? []).find(value => equalsIgnoreCase(value.name, className));
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
    showHelp(target);
  });

  document.addEventListener('mouseout', event => {
    const target = event.target.closest('[data-help]');
    if (!target || target.contains(event.relatedTarget)) {
      return;
    }
    hideHelp();
  });

  document.addEventListener('focusin', event => {
    const target = event.target.closest('[data-help]');
    if (target && !target.closest('#helpPopover') && target.matches(':focus-visible')) {
      showHelp(target);
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
  node.setAttribute('title', text);
  if (!isNaturallyInteractive(node) && node.tabIndex < 0) {
    node.tabIndex = 0;
  }
  return node;
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
