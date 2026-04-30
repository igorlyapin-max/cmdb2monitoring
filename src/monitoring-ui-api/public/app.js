const state = {
  currentRules: null,
  uploadedRulesText: null,
  runtimeSettings: null
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

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
    button.addEventListener('click', () => {
      $$('.nav-item[data-view]').forEach(item => item.classList.toggle('active', item === button));
      $$('.view').forEach(view => view.classList.toggle('active', view.id === button.dataset.view));
    });
  });
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
    grid.append(node);
  }
}

async function loadEvents() {
  const params = new URLSearchParams();
  const selectedTopic = $('#eventsTopic').value;
  const maxMessages = $('#eventsMaxMessages').value;
  if (selectedTopic) {
    params.set('topic', selectedTopic);
  }
  if (maxMessages) {
    params.set('maxMessages', maxMessages);
  }

  const events = await api(`/api/events${params.size ? `?${params}` : ''}`);
  renderEventTopics(events.topics ?? [], events.selectedTopic);
  renderRows($('#eventsTable'), events.items.length ? events.items : [{
    topic: events.selectedTopic ?? events.source,
    service: '',
    partition: '',
    offset: '',
    timestamp: '',
    key: '',
    value: events.message || 'empty'
  }], item => [
    item.topic,
    item.service,
    item.partition,
    item.offset,
    item.timestamp,
    item.key,
    formatEventValue(item.value)
  ]);
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
    item.name,
    item.service,
    item.direction,
    item.description
  ]);
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

async function loadRuntimeSettings() {
  state.runtimeSettings = await api('/api/settings/runtime');
  fillRuntimeSettingsForm(state.runtimeSettings);
  renderEventTopics(state.runtimeSettings.eventBrowser?.topics ?? [], $('#eventsTopic').value);
  $('#eventsMaxMessages').value = state.runtimeSettings.eventBrowser?.maxMessages ?? 50;
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
      row.append(el('td', '', value ?? ''));
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

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.remove('hidden');
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => node.classList.add('hidden'), 3200);
}
