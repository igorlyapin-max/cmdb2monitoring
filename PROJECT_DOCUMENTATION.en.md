# cmdb2monitoring Project Documentation

Documentation version: `0.8.0`.
Last updated: 2026-05-05.

## Purpose

`cmdb2monitoring` is a monorepo for integrating CMDBuild, Kafka, and Zabbix.
The main flow is:

```text
CMDBuild webhook -> Kafka -> rules/T4 conversion -> Kafka -> Zabbix API -> Kafka response
```

After a successful `host.create/update/delete`, a separate flow writes the reverse `CMDBuild card/profile -> Zabbix hostid` binding back to CMDBuild for audit and future exact identification.

The additional `monitoring-ui-api` component provides an operator frontend/BFF for:

- microservice health dashboard;
- rules JSON load, validation, and dry-run;
- Conversion Rules Management and Logical Control of Conversion Rules with CMDBuild -> rules -> Zabbix highlighting;
- draft rule add/modify/delete, undo/redo, and browser save-as without writing the active backend rules file;
- safe in-memory removal of missing rule references with corrected JSON saved through the browser;
- `Webhook Setup`: load current CMDBuild webhooks, analyze rules, prepare a create/update/delete plan, and apply selected operations to CMDBuild for `editor`/`admin`;
- recent Kafka topic messages in the Events view;
- Zabbix and CMDBuild catalog synchronization;
- `Zabbix Metadata`: templates, item keys, LLD rule keys, inventory bindings, and the template conflict index used by the editor and Logical Control;
- `Runtime Settings` for endpoint/topic parameters;
- `Git Settings` for reading the rules file from disk or from a git working copy;
- `Authorization` for local login, MS AD, and IdP;
- Russian/English UI language selection on the login screen, with menu, Help, and base tooltips following the selected language;
- local login and external login through MS AD (`LDAP/LDAPS`) or IdP provider `SAML2`/`OAuth2/OIDC`; IdP role groups may be read from MS AD.

## Repository Contents

| Path | Purpose |
| --- | --- |
| `src/cmdbwebhooks2kafka` | Receives CMDBuild webhooks and publishes normalized events to Kafka |
| `src/cmdbkafka2zabbix` | Reads CMDB events, applies JSON/T4 rules and `hostProfiles[]`, publishes one or more Zabbix JSON-RPC requests |
| `src/zabbixrequests2api` | Reads Zabbix requests, calls Zabbix API, publishes responses |
| `src/zabbixbindings2cmdbuild` | Reads Zabbix binding events and writes `zabbix_main_hostid`/`ZabbixHostBinding` back to CMDBuild |
| `src/monitoring-ui-api` | Node.js frontend/BFF |
| `rules/cmdbuild-to-zabbix-host-create.json` | Demo conversion rules from CMDBuild events to Zabbix JSON-RPC |
| `rules/cmdbuild-to-zabbix-host-create.production-empty.json` | Clean production no-op starter rules |
| `rules/cmdbuild-to-zabbix-host-create.dev-empty.json` | Clean dev no-op starter rules: installation-style base with dev topic and Zabbix API URL |
| `SYSTEM_ADMIN_GUIDE.md` / `SYSTEM_ADMIN_GUIDE.en.md` | Administrator guide for runtime settings, CMDBuild/Zabbix preparation, webhooks, bindings, and operational risks |
| `RULE_DEVELOPER_GUIDE.md` / `RULE_DEVELOPER_GUIDE.en.md` | Rule developer guide for host profiles, leaf paths, dynamic targets, suppression, update behavior, and webhook checks |
| `DEPLOYMENT_LOCAL_REGISTRY.md` / `DEPLOYMENT_LOCAL_REGISTRY.en.md` | Docker image build and local registry publishing guide for microservices/UI |
| `deploy/dockerfiles/` | Dockerfiles for `cmdbwebhooks2kafka`, `cmdbkafka2zabbix`, `zabbixrequests2api`, `zabbixbindings2cmdbuild`, `monitoring-ui-api` |
| `aa/` | Architecture artifacts, diagrams, OpenAPI/AsyncAPI, maps |
| `tests/configvalidation` | Configuration and artifact checks |
| `scripts/test-configs.sh` | Fast repository configuration validator |
| `scripts/build-local-registry-images.sh` | Build and push all Docker images to a local registry |

## Development Endpoints

| Component | URL |
| --- | --- |
| `cmdbwebhooks2kafka` | `http://localhost:5080`, bind `http://0.0.0.0:5080` |
| `cmdbkafka2zabbix` | `http://localhost:5081` |
| `zabbixrequests2api` | `http://localhost:5082` |
| `zabbixbindings2cmdbuild` | `http://localhost:5083` |
| `monitoring-ui-api` | `http://localhost:5090` |
| CMDBuild | `http://localhost:8090/cmdbuild` |
| Zabbix UI/API | `http://localhost:8081`, `http://localhost:8081/api_jsonrpc.php` |
| Kafka host access | `localhost:9092` |
| Kafka Docker-network access | `kafka:29092` |

CMDBuild runs in Docker, so the CMDBuild webhook URL must point to a host address reachable from the Docker network:

```text
http://192.168.202.100:5080/webhooks/cmdbuild
```

For local development, `cmdbwebhooks2kafka` listens on `0.0.0.0:5080`. If it listens only on `localhost:5080`, the CMDBuild container cannot call it.

## Compatibility

Verified development environment on 2026-05-02:

| Component | Version | Notes |
| --- | --- | --- |
| CMDBuild | `4.1.0` | `itmicus/cmdbuild:4.1.0`, WAR manifest `CMDBuild-Version: 4.1.0`; REST API v3 and webhook JSON are used |
| Zabbix | `7.0.25` | `apiinfo.version=7.0.25`; `zabbix-*-pgsql:alpine-7.0-latest` containers resolve to `7.0.25` |
| Kafka | `3.9.2` | `apache/kafka:3.9.2`, dev KRaft/PLAINTEXT |
| CMDBuild DB | PostgreSQL `17.9`, PostGIS `3.5.x` | Project services do not connect to this DB directly |
| Zabbix DB | PostgreSQL `16.13` | Project services do not connect to this DB directly |
| Audit storage | PostgreSQL `16/17`, SQLite `3.x` | PostgreSQL is the target store for medium and large installations; SQLite is allowed for development and small installations through the same storage contract |
| .NET | SDK `10.0.203`, target `net10.0` | Repository wrapper `scripts/dotnet` is used |
| Node.js | `>=22` | Required by `monitoring-ui-api` |

Compatibility is contract-based, not Docker-tag-based:

- CMDBuild webhook body remains flat JSON, and catalog/reference/lookup/domain data is readable through REST v3;
- Zabbix exposes JSON-RPC `/api_jsonrpc.php` with methods and payload structures used by rules/T4;
- Kafka topics are created by external infrastructure and the broker is reachable with configured protocol/security.

Expected compatible versions are CMDBuild `4.x` with REST v3, Zabbix `7.0.x LTS` and newer 7.x versions that keep `template.get` subselects `selectTemplateGroups`, `selectItems`, and `selectDiscoveryRules`, and Kafka `3.x`. Other major/minor upgrades require a smoke check: health, catalog sync, rules dry-run, and create/update/delete chain.

## Kafka Topics

| Dev topic | Base/prod topic | Producer | Consumer |
| --- | --- | --- | --- |
| `cmdbuild.webhooks.dev` | `cmdbuild.webhooks` | `cmdbwebhooks2kafka` | `cmdbkafka2zabbix` |
| `zabbix.host.requests.dev` | `zabbix.host.requests` | `cmdbkafka2zabbix` | `zabbixrequests2api` |
| `zabbix.host.responses.dev` | `zabbix.host.responses` | `zabbixrequests2api` | future status/UI consumer |
| `zabbix.host.bindings.dev` | `zabbix.host.bindings` | `zabbixrequests2api` | `zabbixbindings2cmdbuild` |
| `cmdbwebhooks2kafka.logs.dev` | `cmdbwebhooks2kafka.logs` | `cmdbwebhooks2kafka` | future ELK shipper |
| `cmdbkafka2zabbix.logs.dev` | `cmdbkafka2zabbix.logs` | `cmdbkafka2zabbix` | future ELK shipper |
| `zabbixrequests2api.logs.dev` | `zabbixrequests2api.logs` | `zabbixrequests2api` | future ELK shipper |
| `zabbixbindings2cmdbuild.logs.dev` | `zabbixbindings2cmdbuild.logs` | `zabbixbindings2cmdbuild` | future ELK shipper |

Topics are created by external infrastructure. Services must not create Kafka topics at startup.

## Configuration Rules

Base config must not contain production secrets.
Development config may contain local stand values.
Production secrets are provided through environment variables, secret storage, or local config excluded from git.
The corporate secret-store provider `IndeedPamAapm` is also supported: any sensitive string field can contain `secret://id` or `aapm://id`, and the actual value is requested from `Secrets:References`/`Secrets:IndeedPamAapm` at service startup and substituted only in process memory. The bootstrap secret `Secrets:IndeedPamAapm:ApplicationToken`, `ApplicationTokenFile`, or `ApplicationUsername`/`ApplicationPassword` is provided by the deployment layer through a Docker/Kubernetes secret, protected mount, or `PAMURL`/`PAMUSERNAME`/`PAMPASSWORD` env aliases. Kafka SASL also supports the compatible `SASLUSERNAME`/`SASLPASSWORD`/`SASLPASSWORDSECRET` format; `SASLPASSWORDSECRET=AAA.LOCAL\PROD.contractorProfiles` is parsed as `AccountPath=AAA.LOCAL\PROD`, `AccountName=contractorProfiles`.

.NET services use `__` environment overrides:

```bash
Kafka__Input__BootstrapServers=kafka01:9093,kafka02:9093
Zabbix__AuthMode=Token
Zabbix__ApiToken=<secret>
```

`monitoring-ui-api` uses `config/appsettings*.json` and explicitly supported environment variables.

## cmdbwebhooks2kafka

Configuration files:

- `src/cmdbwebhooks2kafka/appsettings.json`;
- `src/cmdbwebhooks2kafka/appsettings.Development.json`.

Main settings:

| Section | What to configure |
| --- | --- |
| `Service` | Service name and health route |
| `CmdbWebhook:Route` | Webhook receive URL, currently `/webhooks/cmdbuild` |
| `CmdbWebhook:AuthorizationMode`, `CmdbWebhook:BearerToken` | Validates inbound `Authorization: Bearer ...`; in production provide the token through env/secret storage, for example `CmdbWebhook__BearerToken` |
| `CmdbWebhook:*Fields` | Fields used to detect event type, class, and id in webhook body |
| `Kafka` | Bootstrap servers, output topic, client id, auth/security |
| `ElkLogging` | Kafka log sink or future ELK endpoint |
| `Secrets` | `None` or `IndeedPamAapm`; maps `secret://id` to an Indeed PAM/AAPM account path/name |

For local Docker Kafka inside the Docker network:

```bash
Kafka__BootstrapServers=kafka:29092
```

The dev launch profile uses `http://0.0.0.0:5080` so CMDBuild in Docker can call the host service on port `5080`.

## cmdbkafka2zabbix

Configuration files:

- `src/cmdbkafka2zabbix/appsettings.json`;
- `src/cmdbkafka2zabbix/appsettings.Development.json`.

Main settings:

| Section | What to configure |
| --- | --- |
| `Service` | Service name, health route, rules reload route, and Bearer token |
| `Kafka:Input` | `cmdbuild.webhooks.*` topic, group id, consumer auth/security |
| `Kafka:Output` | `zabbix.host.requests.*` topic, producer auth/security, `ProfileHeaderName` |
| `ConversionRules` | `ReadFromGit`, repository URL/path, rules file path, git pull behavior, reload behavior, template engine |
| `Cmdbuild` | CMDBuild REST base URL, lookup/reference/domain resolver limits, `HostBindingLookupEnabled`, `MainHostIdAttributeName`, `BindingClassName`, `BindingLookupLimit` |
| `ProcessingState` | State file for the last processed object |
| `ElkLogging` | Kafka log topic or future ELK |
| `Secrets` | `None` or `IndeedPamAapm`; maps `secret://id` to CMDBuild/Kafka/reload-token service secrets |

The rules file defines:

- `schemaVersion` for format compatibility and `rulesVersion` for visual revision tracking;
- `create/update/delete` routing;
- regex validation;
- lookup/reference/domain path conversion through `source.fields[].cmdbPath` and `resolve`;
- selection of host profiles, host groups/templates/interfaces/tags;
- dynamic expansion only for `tags` and `hostGroups`: a rule with `targetMode=dynamicFromLeaf` reads the selected CMDBuild leaf through `valueField`; tags become `tags[]`, while host groups become `groups[]` with name/createIfMissing before the Zabbix writer stage, and after resolve/create the same host payload receives those groups as `groupid`;
- selection of proxy, proxy group, Zabbix interfaces[] profiles, host status, TLS/PSK, host macros, inventory fields, maintenances, and value maps;
- `monitoringSuppressionRules` for objects that must not be put on monitoring;
- T4 templates for JSON-RPC;
- fallback `host.get -> host.update/delete` when the Zabbix hostid is absent from both the incoming event and stored CMDBuild binding data;
- optional update upsert: `host.get -> host.create` when a profile has `createOnUpdateWhenMissing=true`.

Zabbix host identity during `update/delete`:

- priority 1: explicit `zabbix_hostid` from webhook payload or `source.fields.zabbixHostId`; for a concrete `hostProfiles[]` item, `hostProfiles[].zabbixHostIdField` is also respected;
- priority 2: stored CMDBuild reverse binding. For the main profile, `cmdbkafka2zabbix` reads the source card and uses `Cmdbuild:MainHostIdAttributeName`, default `zabbix_main_hostid`. For an additional profile, it reads `Cmdbuild:BindingClassName`, default `ZabbixHostBinding`, and looks for an active card by `OwnerClass + OwnerCardId + HostProfile`;
- priority 3: fallback `host.get` by the computed technical host name. The name is built by `normalization.hostName` or `hostProfiles[].hostNameTemplate` and must use stable CMDBuild identity: class, `id`, immutable `code`, and profile name. IP/DNS must not be part of the host identifier if those values can change;
- after `host.get`, `zabbixrequests2api` reads the found `hostid`, existing interfaces/templates, and builds the actual `host.update` or `host.delete`;
- if CMDBuild binding data cannot be read or returns an empty value, the converter logs the condition and uses fallback `host.get` when the route defines it. Stage 2 therefore keeps old rules working while reducing update/delete dependency on host name once `zabbixbindings2cmdbuild` has written hostids.
- when the primary IP changes, the host is still found by name and the new IP is applied as an interface update. For the first interface, if no exact match exists, the first existing `interfaceid` is reused, so a primary IP change updates the existing Zabbix host. Additional interfaces depend on profile rules and type/port/address matching;
- the `cmdb.id` tag is written to Zabbix as useful metadata, but the current fallback lookup searches by technical host name, not by tag. Service state files store processing progress, not a `CMDBuild id -> Zabbix hostid` registry.

During `host.update`, `groups[]`, `templates[]`, `tags[]`, `macros[]`, and `inventory` are merged with the current Zabbix host state. `zabbixrequests2api` reads the current host first, preserves external values that are not present in the rules payload, and adds or overrides only values from rules: groups by `groupid`, templates by `templateid`, tags by the `tag/value` pair, macros by `macro`, and inventory by field name. `templates_clear` remains an explicit removal operation for conflicting templates and is filtered to template IDs that are actually linked. `interfaces[]` intentionally keep the previous authoritative behavior: rules define the resulting interface list, while the writer only injects existing `interfaceid` values for a valid update.

Zabbix template compatibility. Before `host.create` and before the actual merged/fallback `host.update`, `zabbixrequests2api` uses Zabbix `template.get` with `selectTemplateGroups`, `selectItems`, and `selectDiscoveryRules` when `Zabbix:ValidateTemplateCompatibility=true`. This is the 7+ contract without deprecated subselects. If the final template set contains the same item key, the same LLD rule key, or the same inventory binding through `inventory_link` in two or more templates, the service returns `template_conflict`, sets `zabbixRequestSent=false`, and does not call `host.create/update`. The `errorMessage` includes the conflicting key or inventory link, template names/templateids, the expected corrective action, and where to read this contract: `PROJECT_DOCUMENTATION.md` / `PROJECT_DOCUMENTATION.en.md`, section `Zabbix template compatibility`. The fix belongs in rules or in Zabbix templates: choose a different template set, add/fix `templateConflictRules`, pass the conflicting template through `templates_clear` for update, or change the Zabbix templates themselves.

Rules reload:

- `POST /admin/reload-rules` in `cmdbkafka2zabbix` reloads conversion rules through `IConversionRulesProvider`;
- `GET /admin/rules-status` returns the current provider `name`, `schemaVersion`, `rulesVersion`, location, and git/version without reloading rules;
- the endpoint has no direct Git logic; the current provider runs `git pull --ff-only` only when both `ConversionRules:ReadFromGit=true` and `ConversionRules:PullOnReload=true`;
- authorization uses `Authorization: Bearer <Service:RulesReloadToken>`;
- `monitoring-ui-api` calls this endpoint from the `cmdbkafka2zabbix` dashboard card through `Перечитать правила конвертации` / reload rules for `editor` and `admin`; next to the button it shows two versions: `rulesVersion/schemaVersion` currently loaded by the microservice from `GET /admin/rules-status`, and `rulesVersion/schemaVersion` of the rules file read by the management system;
- storage location changes require provider/config changes, not HTTP-contract changes.

Rules publication happens outside `monitoring-ui-api`: the operator saves JSON through the browser or writes a local copy through `Git Settings`, reviews the diff, puts the file into the chosen git repository, and then clicks reload rules.
`Git Settings` shows `RulesFilePath`, a `Use git as the conversion data source` checkbox, local working-copy `RepositoryPath`, and `Git repository URL` with an example URL. For the dev/test system, the default mode is read from disk, file `rules/cmdbuild-to-zabbix-host-create.json`. When git reading is enabled, the rules file is expected inside the repository at the same path, or at the path explicitly configured in `RulesFilePath`; the UI can write a matching `*.webhooks.json` artifact next to it. That artifact is generated from current rules plus CMDBuild catalog/current webhooks, but all token/password/secret/API key/Authorization values are replaced with `XXXXX`. These fields control UI/BFF settings for reading the local rules file and checking `schemaVersion`/`rulesVersion`; the application does not commit or push. The converter service has the matching switch in `src/cmdbkafka2zabbix/appsettings*.json` under `ConversionRules`; that service section decides whether the microservice reads the local file as-is or runs git pull from an already prepared working copy on startup/reload.
`rulesVersion` must include both the date and the time of the change in a human-readable form, for example `2026.05.03-2027-serveri-webhook-fix`, so the dashboard and git diff show not only the revision purpose but also the release moment of the file.

Runtime settings also expose two independent rule-editor switches: `Allow dynamic Zabbix Tags expansion from a CMDBuild leaf` and `Allow dynamic Zabbix Host groups creation from a CMDBuild leaf`. With a switch disabled, the editor requires an existing Zabbix target. With a switch enabled, the matching conversion structure shows an explicit `Create/expand from selected CMDBuild leaf` target; the saved rule contains `targetMode=dynamicFromLeaf`, `valueField`, and `createIfMissing`. This mode intentionally does not apply to templates, interfaces, inventory, or macros; macros remain a possible future extension. For host groups, this is not only catalog creation/resolution: when a leaf value appears for the first time, the writer creates the missing group, substitutes the returned `groupid` into the same `host.create`/`host.update` payload, and immediately links the current host to that group. Dynamic expansion should be enabled only after analyzing the variety of leaf values: uncontrolled changes to the mapped CMDBuild attributes will produce the same amount of dynamic change in Zabbix.

`Zabbix Metadata` is available to `editor` and `admin`. It is built from Zabbix catalog sync and stores templates with `itemKeys`, `discoveryRuleKeys`, `inventoryLinks`, linked parent templates, existing host templates, the Zabbix version, and the template conflict index. A conflict means the same item key, LLD rule key, or `inventory_link` is present in two or more templates. Conversion Rules Management uses this data before saving a rule and marks a conflicting template target red. Conversion Rules Logical Control shows existing rules whose final template set remains incompatible after `templateConflictRules` are applied. The runtime check in `zabbixrequests2api` remains mandatory and blocks `host.create/update` if UI/catalog data is stale or rules were changed outside the interface.

Webhook payload remains flat. For CMDBuild reference fields, the webhook sends only the numeric id of the first reference attribute. The full path is stored in rules as `cmdbPath`, for example `Class.ReferenceAttribute.LeafAttribute`; `cmdbkafka2zabbix` iteratively reads cards through CMDBuild REST and substitutes the leaf value before regex/T4. For lookup leaf values, the default result is lookup `code`.

For CMDBuild domains, including N:N relations without a card attribute, the path syntax is `Class.{domain:RelatedClass}.LeafAttribute`. `Class` is the current card class, `domain` is a keyword, `RelatedClass` is the class at the second end, and `LeafAttribute` is the related card attribute. UI catalog sync reads both `/domains` and detailed `/domains/{domain}` because the CMDBuild domain list can omit `source`/`destination`; without those endpoints the editor cannot offer N:N domain paths. The converter reads relations, verifies both ends, and resolves the leaf using the same reference/lookup resolver. Multiple related cards are joined with `resolve.collectionSeparator` by default. The UI blocks such fields for scalar Zabbix targets unless `resolve.collectionMode=first` is explicitly configured.
If a domain path cannot resolve the leaf, the converter must not use the current card id as the leaf value: the field is treated as absent so dynamic host group/tag rules do not create Zabbix objects from a technical id. Relations are not cached across events because links may appear or change after `card_create_after`, and a later `card_update_after` must read the current relation set.
Runtime cache for CMDBuild cards and lookup values exists only inside one resolver event. Therefore, when the source card is modified and `card_update_after` arrives, the converter rereads lookup, reference, and domain leaf values. This lets Zabbix be updated from changed linked values when the update event belongs to the source card. A modification of only the linked card or only the domain relation, without a source-card webhook/event, does not trigger monitoring recalculation.

The maximum iterative traversal depth for `domain`/`reference`/`lookup` paths is configured in Runtime settings as `Max recursion depth for domains&reference&lookups`. The allowed range is `2..5`, and the default is `2`. A changed value takes effect in the UI only after logout and CMDBuild catalog resync; the new sync writes the depth to the catalog cache, and newly created `cmdbPath` fields receive the matching `resolve.maxDepth`.

A `do_not_monitor` state on a related domain leaf is not the same as "do not monitor the whole object". It means "do not use this related endpoint/address". The source card can still be processed through other allowed addresses. The demo case is `C2M-DEMO-011-DOMAIN-LEAF-DONT-MONITOR`: the main CI is monitored, but the related address interface is absent.

When source-card attributes mean the whole instance must not be monitored, use `monitoringSuppressionRules`. For `create/update`, the converter returns a skip reason and publishes no Zabbix request. `delete` is not suppressed so already-created hosts can be cleaned up.

## zabbixrequests2api

Configuration files:

- `src/zabbixrequests2api/appsettings.json`;
- `src/zabbixrequests2api/appsettings.Development.json`.

Main settings:

| Section | What to configure |
| --- | --- |
| `Kafka:Input` | `zabbix.host.requests.*` topic, group id, consumer auth/security |
| `Kafka:Output` | `zabbix.host.responses.*` topic, producer auth/security |
| `Kafka:BindingOutput` | `zabbix.host.bindings.*` topic, producer auth/security, headers `binding-event-type`, `binding-host-profile`, `binding-status` |
| `Zabbix:ApiEndpoint` | Zabbix JSON-RPC API URL |
| `Zabbix:AuthMode` | `Token`, `Login`, `LoginOrToken`, or `None` |
| `Zabbix:ApiToken` | Production token through secret/env |
| `Zabbix:AllowDynamicHostGroupCreate` | Allows the Zabbix writer to create missing host groups produced by dynamic `targetMode=dynamicFromLeaf` rules; enabled in the shipped configs |
| `Zabbix:User` / `Zabbix:Password` | Login credentials, only dev or secret/env |
| `Zabbix:Validate*` | Host group/template/template group checks before API call |
| `Processing` | Gentle delay, retries, retry delay |
| `ProcessingState` | State file for the last processed object |
| `Secrets` | `None` or `IndeedPamAapm`; maps `secret://id` to Zabbix/Kafka/ELK secrets |

`Processing:DelayBetweenObjectsMs` defaults to `2000` to avoid sending objects to Zabbix too aggressively.

The state file stores the last successfully processed input offset; startup resumes from `lastInputOffset + 1`.

`zabbixrequests2api` validates base `host.create/update/delete` payloads and extended host fields used by rules: `status`, `macros`, `inventory`, TLS/PSK parameters. Future/dedicated operations are reserved for `maintenance.*`, `usermacro.*`, `proxy.*`, and `valuemap.*`.

After a successful Zabbix write for `host.create`, `host.update`, or `host.delete`, the service publishes a binding event to `Kafka:BindingOutput`. The event contains `sourceClass`, `sourceCardId`, `sourceCode`, `hostProfile`, `isMainProfile`, `zabbixHostId`, `zabbixHostName`, `bindingStatus`, `rulesVersion`, `schemaVersion`, and the input offset. If source class/card id or `hostid` is missing, no binding event is published and a warning is logged. A binding publish failure does not roll back the already completed Zabbix write and does not block the normal response/offset commit, to avoid duplicate `host.create/update/delete`.

## zabbixbindings2cmdbuild

Configuration files:

- `src/zabbixbindings2cmdbuild/appsettings.json`;
- `src/zabbixbindings2cmdbuild/appsettings.Development.json`.

Main settings:

| Section | What to configure |
| --- | --- |
| `Kafka:Input` | `zabbix.host.bindings.*` topic, group id, consumer auth/security |
| `Cmdbuild:BaseUrl` | CMDBuild REST v3 base URL |
| `Cmdbuild:Username` / `Cmdbuild:Password` | Service account for writing audit bindings, through secret/env in test/prod |
| `Cmdbuild:MainHostIdAttributeName` | Main hostid attribute, default `zabbix_main_hostid` |
| `Cmdbuild:BindingClassName` | Service class for additional profiles, default `ZabbixHostBinding` |
| `Cmdbuild:BindingLookupLimit` | Existing binding-card lookup limit |
| `ProcessingState` | State file for the last processed binding event |
| `ElkLogging` | Kafka log topic or future ELK |
| `Secrets` | `None` or `IndeedPamAapm`; maps `secret://id` to CMDBuild/Kafka/ELK secrets |

The service consumes `zabbix.host.bindings.*` and applies reverse writes:

- when `isMainProfile=true`, it runs `PUT /classes/{sourceClass}/cards/{sourceCardId}` and writes `zabbix_main_hostid=<hostid>`; for `host.delete` it clears the value;
- for additional `hostProfiles`, it finds a `ZabbixHostBinding` card by `OwnerClass + OwnerCardId + HostProfile` and creates or updates `OwnerClass`, `OwnerCardId`, `OwnerCode`, `HostProfile`, `ZabbixHostId`, `ZabbixHostName`, `BindingStatus`, `RulesVersion`, and `LastSyncAt`;
- invalid JSON is treated as a poison message: a warning is logged, state/offset are recorded, and the message is skipped;
- CMDBuild write failures do not commit the Kafka offset, so the event is retried after the service or CMDBuild recovers.

Starting with stage 2, `cmdbkafka2zabbix` uses these values as the preferred `hostid` source before fallback `host.get`: the main profile reads `zabbix_main_hostid`, while additional profiles read `ZabbixHostBinding`.

## monitoring-ui-api

Configuration files:

- `src/monitoring-ui-api/config/appsettings.json`;
- `src/monitoring-ui-api/config/appsettings.Development.json`;
- `src/monitoring-ui-api/package.json`;
- `src/monitoring-ui-api/package-lock.json`.

Main settings:

| Section | What to configure |
| --- | --- |
| `Service` | Host, port, health route, public frontend directory |
| `UiSettings` | Runtime settings JSON saved by UI |
| `Auth` | External auth mode, users file, session cookie, session timeout, SAML POST limit |
| `Idp` | SAML2/OAuth2 IdP, LDAP/LDAPS/MS AD, role-to-group mapping |
| `Cmdbuild` | CMDBuild REST base URL and catalog cache |
| `Zabbix` | Zabbix API endpoint, optional API key, catalog cache |
| `Rules` | Rules path and local JSON validate/dry-run policy |
| `AuditStorage` | Provider `postgresql`/`sqlite`, connection string, schema, auto-migrate, and timeout for the future audit section |
| `EventBrowser` | Read-only Kafka browser for Events: bootstrap, auth, topics, limits |
| `Services:HealthEndpoints` | Microservice health endpoints and optional rules reload URL/token |
| `Secrets` | `None` or `IndeedPamAapm`; maps `secret://id` to the Zabbix API token, Kafka Event Browser password, LDAP/OAuth2/Audit DB secrets, and rules reload tokens |

Authorization modes:

- `Local`: `Auth:UseIdp=false`, login by users file;
- `MS AD`: `Auth:UseIdp=true`, `Idp:Provider=LDAP`, login/password verified through LDAP/LDAPS bind and roles assigned from AD groups;
- `IdP`: `Auth:UseIdp=true`, `Idp:Provider=SAML2` or `OAuth2`; IdP identifies the user, and the BFF reads MS AD groups through LDAP service bind when configured. If AD lookup is not configured, group claims from IdP are used as fallback.

Local UI users are stored in `Auth:UsersFilePath` near `UiSettings:FilePath`. First startup creates `viewer`, `editor`, and `admin` with PBKDF2-SHA256 hashes. Deployment initial passwords must be changed after first login or supplied through a mounted users file.
When `Zabbix:ApiToken`, `EventBrowser:Password`, LDAP/OAuth2 secrets, or the Audit DB connection string are configured as `secret://id`, the UI/BFF resolves them through Indeed PAM/AAPM and shows the reference in the interface instead of the actual secret.

Roles:

- `viewer`: Dashboard and Events;
- `editor`: all rule/catalog views except Authorization, Runtime Settings, and Git Settings;
- `admin`: all menus, Authorization, Runtime Settings, Git Settings, and user password reset.

CMDBuild/Zabbix backend credentials are separate from UI login. UI authentication through Local/MS AD/IdP is not used as CMDBuild/Zabbix API credentials. Zabbix uses `Zabbix:ApiToken` first; if absent, Zabbix login/password are requested for the server-side session. CMDBuild login/password are requested for the server-side session at the first CMDBuild API operation.

Minimum permissions by operation:

- CMDBuild for UI/catalog sync: REST API login and read-only access to metadata classes/attributes/domains, lookup types/values, current-card relations, and target cards reachable through reference/domain chains used by `source.fields[].cmdbPath`. CMDBuild card create/update/delete permissions are not required for catalog sync.
- CMDBuild for `Webhook Setup` load/analyze: read access to ETL/webhook records through REST v3 `/etl/webhook/?detailed=true`.
- CMDBuild for `Load into CMDB`: create/update/delete, or equivalent modify permissions, on ETL/webhook records through REST v3 `/etl/webhook/`. These permissions are needed only by operators who actually apply webhook plans to CMDBuild; they are not needed by viewers or for ordinary catalog sync.
- CMDBuild for quick audit: read-only access to metadata classes/attributes, selected class cards, and `ZabbixHostBinding`; Zabbix user/API token must have read-only `host.get` access with groups, parent templates, and interfaces, plus `maintenance.get` to check membership for expected maintenances.
- CMDBuild for `Apply CMDBuild preparation` in the `Audit` section: CMDBuild model-administration permissions to create classes and attributes through `POST /classes?scope=service` and `POST /classes/{class}/attributes`. These permissions are not needed for the audit plan check.
- CMDBuild service account for `cmdbkafka2zabbix`: read-only access to source cards and `ZabbixHostBinding` when `Cmdbuild:HostBindingLookupEnabled` is enabled; these permissions are in addition to the resolver's attributes/cards/relations/lookups access required by `cmdbPath`.
- CMDBuild service account for `zabbixbindings2cmdbuild`: read/update permissions on cards of classes participating in conversion rules to write/clear `zabbix_main_hostid`, plus read/create/update permissions on the `ZabbixHostBinding` service class. If additional profiles are used, the service also needs list/read access to this class to find existing bindings.
- The backend restricts writes to the managed `cmdbwebhooks2kafka-*` prefix, but this is an application guard, not a replacement for CMDBuild permissions. The CMDBuild account should still be restricted as narrowly as the CMDBuild permission model allows.
- Zabbix for UI/catalog sync: API access and read-only access to used host groups, template groups, templates, hosts/tags, and optional catalogs read through `*.get`, including `template.get` subselects for item keys, LLD rules, inventory links, and template groups.
- The separate `zabbixrequests2api` service, which actually applies monitoring, needs host create/update/delete permissions and read access to related groups/templates. Because `Zabbix:AllowDynamicHostGroupCreate` is enabled in the shipped configs, this API user also needs `hostgroup.create`.

For dynamic host groups, the writer runs `hostgroup.get` by name before `host.create/host.update`. If the group exists, `groupid` is substituted into the payload. If it is missing and `Zabbix:AllowDynamicHostGroupCreate=true`, the writer calls `hostgroup.create` and then substitutes the new `groupid` into the same request, so the host is immediately linked to the newly created group. If it is missing and creation is disabled, no Zabbix write is executed and the response contains `auto_expand_disabled`. Tags have no separate Zabbix catalog object in this flow: a dynamic tag is sent directly in `params.tags[]` of the current host payload.

Runtime Settings can edit CMDBuild/Zabbix endpoints, Zabbix API key, audit storage, Kafka Event Browser settings, and health/reload endpoints. `AuditStorage` selects `postgresql` for medium and large production installations or `sqlite` for development and small installations. SQLite is intended as an estimate for up to 1000 monitored objects, and can be acceptable up to 2000 objects with moderate event flow and short audit retention; larger scale, high user concurrency, or long audit retention should use PostgreSQL. The setting stores provider, connection string, PostgreSQL schema, `AutoMigrate`, and `CommandTimeoutSeconds`. Audit code must use the shared storage layer and be validated against both DB engines, without SQL tied only to SQLite or only to PostgreSQL. Git Settings edits only rules-file storage/read settings and can write rules JSON plus a neighboring `*.webhooks.json` into a local working copy without commit/push. CMDBuild/Zabbix `Use IdP` flags are not supported and must not be displayed.

Audit model:

- the `Audit` section prepares the CMDBuild model for reverse links to Zabbix. Check builds a plan without changes, while apply creates missing elements in the managed CMDBuild system as an administrator operation;
- every class participating in conversion rules receives the `zabbix_main_hostid` attribute. It stores the `hostid` of the main Zabbix host for a concrete CMDBuild card and makes it directly visible which card is already monitored. This attribute belongs only to the main host profile and does not describe additional profiles;
- the service class `ZabbixHostBinding` supports the extended logic. One card of this class represents the link `CMDBuild class + card id + hostProfile -> Zabbix host`. It is needed when one CMDBuild card creates several Zabbix hosts through additional `hostProfiles`;
- the administrator chooses in the CMDBuild tree where `ZabbixHostBinding` should be created. Its baseline attributes are `OwnerClass`, `OwnerCardId`, `OwnerCode`, `HostProfile`, `ZabbixHostId`, `ZabbixHostName`, `BindingStatus`, `RulesVersion`, and `LastSyncAt`;
- attribute meaning: `OwnerClass`/`OwnerCardId`/`OwnerCode` identify the source card, `HostProfile` identifies the profile from rules, `ZabbixHostId`/`ZabbixHostName` identify the Zabbix object, `BindingStatus` stores binding state, `RulesVersion` stores the rules version, and `LastSyncAt` stores the last successful synchronization time.
- `zabbixbindings2cmdbuild` fills these elements automatically after a successful Zabbix write: the main profile writes `zabbix_main_hostid` to the source card, while additional profiles write separate `ZabbixHostBinding` cards.
- quick audit in the `Audit` section performs a read-only comparison between selected CMDBuild classes and Zabbix: using current conversion rules it calculates the expected host/profile, binding (`zabbix_main_hostid` or `ZabbixHostBinding`), interface address, host groups, templates, maintenance, and status, then compares them with `host.get` and bulk `maintenance.get`. It does not perform auto-fixes and is intended as the first discrepancy check before full audit. CMDBuild cards are read in `limit/offset` batches: `Run quick audit` reads the current offset, while `Next batch` increases offset by the current max-cards-per-class limit;

The Rules view loads current JSON, validates local JSON, performs dry-run, creates an empty production starter, and saves JSON through the browser. `monitoring-ui-api` does not write active rules files and does not commit/push git.

`Create empty` generates a no-op starter from runtime settings and CMDBuild/Zabbix catalog caches. CMDBuild cache must contain classes/attributes, and Zabbix cache must contain host groups/templates. The generated JSON is stored in the local file area and saved only through the browser.

Conversion Rules Management supports reference expansion, domain expansion, add/modify/delete rules, undo/redo, and `Save file as`. In edit mode the lower three-column preview is hidden; the CMDBuild class selector shows the class hierarchy with indentation and disables superclass/prototype classes, falling back to the nearest concrete subclass when a superclass was previously selected. Modification starts with no rule selected automatically; the operator can start from a rule, CMDBuild class, class attribute field, or conversion structure. Linked lists are filtered, and when a single matching rule remains it is selected automatically and loaded into the same editor form. The editor filters dependent fields, clears the leaf field and target after class changes, and saves changed class/field/structure/target/priority/regex/name back into draft JSON. The add/modify editor exposes virtual `hostProfile` and `outputProfile` fields; the converter fills them for each `hostProfiles[]` entry, so they can restrict a template/group/tag rule to a specific fan-out profile. For `interfaceAddress`, the editor validates target semantics: an IP-looking CMDBuild attribute cannot be saved as DNS target `interfaces[].dns/useip=0`, a DNS/FQDN-looking attribute cannot be saved as IP target `interfaces[].ip/useip=1`, and an unconfirmed address field must be made explicit through name/source metadata or `validationRegex`. For `Tag rule` and `Host group rule`, the editor can save a dynamic target from a CMDBuild leaf only when the matching runtime switch is enabled; in the UI this is a separate target option, not an empty field. For templates, interfaces, inventory, and macros, an empty target remains an error. Template targets are additionally checked against `Zabbix Metadata`: if the selected template plus defaults/selected templates after `templateConflictRules` still leaves a duplicate item key, duplicate LLD rule key, or duplicate inventory link, the target is marked red and save is blocked. `Reset fields` clears the selected rule and filters in modify mode and clears leaf/target in add mode. Green borders mean compatible, red borders mean required/conflicting, and yellow borders mean the value came from the rule but is not confirmed by the current catalog/filter. `Current rule target / missing from Zabbix catalog` is inconsistent, shown in red, and blocks saving just like a missing CMDBuild class/attribute. The dedicated `Monitoring profiles` block manages `hostProfiles[]`: the operator selects CMDBuild class, `Main`/`Additional` profile type, IP/DNS leaf, IP/DNS mode, local Zabbix `interfaces[]` profile, and `createOnUpdateWhenMissing`. Adding or modifying a normal conversion rule no longer creates `hostProfiles[]` implicitly; if a class has no applicable profile, Logical Control reports the `no_host_profile_matched` risk and the profile must be created in the dedicated block. An additional profile is created as a separate fan-out profile with the `HostProfileName` suffix, a filled-leaf-or-`delete` condition, its own `interfaces[].valueField`, and the selected `interfaceProfileRef`; when an existing profile is renamed, exact `hostProfile` conditions in scoped rules are renamed too. Deleting a profile from this block removes `hostProfiles[]` and rules explicitly scoped to that `hostProfile`; it does not delete a Zabbix host in the managed system. Templates, groups, and tags for that profile are assigned by separate rules through the virtual `hostProfile` field or through the `Limit rule to selected hostProfile` checkbox in the add/modify form; this allows the main rule condition to remain on a normal class attribute such as `description`, a lookup, or a domain leaf while the rule is still scoped to the selected profile. The `Assignments` counter counts only rules with an explicit `hostProfile` condition. Logical Control highlights missing CMDBuild/Zabbix elements, also treats a source class without a matching `hostProfiles[]` as a rules error that would become `no_host_profile_matched`, highlights incompatible Zabbix template sets found through `Zabbix Metadata`, and, when CMDBuild webhooks are loaded in the current UI session, shows warnings for missing managed webhooks or payload fields required by rules; the operator saves the corrected JSON through the browser.

`Webhook Setup` is available to `editor` and `admin`. Using it is optional: operators can configure webhooks manually in CMDBuild or use the webhook files saved together with the conversion rules file. `Load from CMDB` reads current CMDBuild ETL webhooks through the BFF and session-scoped CMDBuild credentials; after load, current webhooks are shown for reference, and the create/update/delete plan is built separately by `Analyze rules`. `Analyze rules` reloads the current conversion rules and CMDBuild catalog cache every time, treats conversion rules as the source of truth for webhook payload, builds `webhook requirements` for all used source fields, and derives desired webhooks from those requirements. When rules use a lookup/reference/domain leaf, the webhook payload receives only the nearest required CMDBuild placeholder for the current card, while the converter later resolves the leaf by `source.fields[].cmdbPath` metadata. Missing webhook records are proposed as `Create`, records with different body/event/target/method/url/headers/active/language as `Update`, and obsolete managed `cmdbwebhooks2kafka-*` records as `Delete`. If an existing CMDBuild webhook lacks payload fields required by rules for that class, the summary, row details, and operation reason show the concrete payload keys and the rules that require them; without applying that operation or manually updating the webhook, those values will not reach the Kafka event and will not be available to the converter. Each table row can expand its payload: green marks added values, red marks deleted values, and black marks current values. Clicking the value in the `Action` column opens details under that same row; the shared `Details` panel is below the table and uses the same highlighting for current/desired/delete text. When existing webhooks are analyzed, their loaded body is preserved and optional source fields are added only when rules for that class actually need them; adding an independent class must not turn unrelated hooks into `Update`. The UI must not add a duplicate key with another case or alias, for example `OS` next to an existing `os`. A `cmdbPath` rooted in another class, for example `OtherClass.Attribute1.Attribute2`, must not create a placeholder in the current class webhook. The row `Edit` button opens JSON for that concrete webhook; saving the edit changes only the current plan, and for a loaded CMDB row it creates a selected `update` operation. Delete operations are not selected by default. `Delete selected` applies only selected `Delete` operations and does not send `Create`/`Update` operations; other changes are applied by the general `Load into CMDB` button. Undo/redo works on the in-session operation selection and does not roll back an already executed `Load into CMDB` command, because that command changes the managed system. `Save file as` exports only the JSON plan through the browser and does not change CMDBuild, the backend rules file, or git; token/password/secret/API key/Authorization values in exported webhook JSON are masked as `XXXXX`. `Load into CMDB` applies only selected operations through REST v3 `/etl/webhook/`; the backend restricts this workflow to the managed `cmdbwebhooks2kafka-` prefix, and for `update`/`delete` it reloads current CMDBuild webhooks and applies the action only to the found managed record with the same `code`.

## Runtime Cache And State

Do not commit:

- `src/monitoring-ui-api/data/*.json` catalog cache;
- `src/monitoring-ui-api/state/ui-settings.json`;
- `src/monitoring-ui-api/state/users.json`;
- runtime state files under service `state/`;
- production secrets.

## Rules Conversion Model

`Model.*` in T4 templates is the intermediate `cmdbkafka2zabbix` model, not a direct CMDBuild or Zabbix object.

Supported data groups include base fields, dynamic source fields through `Model.Field("fieldName")`, `Interface` for backward compatibility, `Interfaces` for multiple interfaces, host identity, groups/templates/tags, and extended host parameters: `Status`, `ProxyId`, `ProxyGroupId`, `TlsPsk`, `Macros`, `InventoryFields`, `Maintenances`, `ValueMaps`.

`hostProfiles[]` controls two scenarios:

- one CMDB object -> one Zabbix host with several `interfaces[]`;
- one CMDB object -> several Zabbix hosts through fan-out when profiles need different names, templates, groups, or lifecycle.

CMDBuild class names, attributes, and source field names are not built-in product constraints. They are defined by webhook body and rules: `source.fields`, `source.fields[].source`, `source.fields[].cmdbAttribute`, `source.fields[].cmdbPath`, `hostProfiles[].interfaces[].valueField`, selection rules, and T4.

The active demo/e2e file `rules/cmdbuild-to-zabbix-host-create.json` remains a dev verification ruleset. Its base model is the abstract `C2MTest*` test model, but concrete classes from the current CMDBuild catalog can be added during smoke checks. That is not a product constraint or a hard-coded model dependency: each added class must have `source.entityClasses`, an IP/DNS source field, a matching `hostProfiles[]` entry, and webhooks.

For `C2MTestCI`, `main` maps `PrimaryIp`/`DnsName` to `ip_address`/`dns_name`, adds `ExtraInterface1Ip` and `ExtraInterface2Ip` as SNMP interfaces on the same Zabbix host, resolves reference/domain leaf paths through `source.fields[].cmdbPath`, and creates separate hosts from `SeparateProfile1Ip`/`SeparateProfile2Ip` with suffixes `-separate-profile-1` and `-separate-profile-2`.

To add a new fixed IP to the main host, add a CMDBuild attribute, webhook field, `source.fields`, and a `hostProfiles[].interfaces` entry. To add a separate monitoring profile, add a named source field and a separate `hostProfile` with its own suffix; in the UI this is done through the dedicated `Monitoring profiles` block before assigning templates/groups/tags through the virtual `hostProfile` field. Arbitrary or unknown-size IP arrays in a single webhook field are not currently supported.

## ELK Logging

Until ELK exists, .NET services write structured JSON logs to Kafka log topics.
When ELK is available, set `ElkLogging:Mode=Elk` or enable `ElkLogging:Elk:Enabled`, fill endpoint/index/API key, and disable Kafka log sink if needed.

## Pre-Commit / Pre-Push Checks

```bash
./scripts/test-configs.sh
./scripts/dotnet build src/cmdbwebhooks2kafka/cmdbwebhooks2kafka.csproj -v minimal
./scripts/dotnet build src/cmdbkafka2zabbix/cmdbkafka2zabbix.csproj -v minimal
./scripts/dotnet build src/zabbixrequests2api/zabbixrequests2api.csproj -v minimal
./scripts/dotnet build src/zabbixbindings2cmdbuild/zabbixbindings2cmdbuild.csproj -v minimal
./scripts/dotnet build tests/configvalidation/configvalidation.csproj -v minimal
./scripts/dotnet build tests/cmdbresolver/cmdbresolver.csproj -v minimal
node src/monitoring-ui-api/scripts/validate-config.mjs
git diff --check
```

Smoke checks:

- `create`: CMDBuild -> Kafka -> Zabbix `host.create` -> response topic -> host exists in Zabbix;
- `update`: CMDBuild -> Kafka -> fallback `host.get -> host.update` -> response topic -> fields changed in Zabbix;
- `update` with a new profile: fallback `host.get -> host.create` when `createOnUpdateWhenMissing` is enabled;
- `delete`: fallback `host.get -> host.delete` -> host removed from Zabbix;
- binding: successful `host.create/update/delete` -> `zabbix.host.bindings.*` -> `zabbixbindings2cmdbuild` -> `zabbix_main_hostid` or `ZabbixHostBinding` updated in CMDBuild.

The fast regression suite `tests/cmdbresolver` is included in `./scripts/test-configs.sh` and does not require live CMDBuild/Zabbix/Kafka. It verifies that two consecutive update events using the same resolver instance reread CMDBuild lookup values, reference leaf cards, and domain leaf cards. A separate scenario checks the full path into converter output: the updated domain leaf value must appear in dynamic `groups[]` as a host group with `createIfMissing=true`.

The editor completeness plan is in `TEST_PLAN_MAPPING_EDITOR.md` and `TEST_PLAN_MAPPING_EDITOR.en.md`.

Demo order:

```bash
node scripts/cmdbuild-demo-schema.mjs --apply
node scripts/cmdbuild-demo-instances.mjs --apply
node scripts/cmdbuild-demo-e2e.mjs --apply
```

`--cleanup-zabbix` deletes only old demo hosts `cmdb-c2mtestci-*`. The current live E2E does not include a DNS-only host; all demo cards have `PrimaryIp`. DNS fallback exists in rules and should be covered by a future `C2M-DEMO-013-DNS-ONLY` scenario.

`rules/cmdbuild-to-zabbix-host-create.json` remains the populated demo/e2e rules file, and the default active `RulesFilePath` still points to it. It is populated only for the `C2MTestCI` test model and related reference/domain leaf paths. `rules/cmdbuild-to-zabbix-host-create.production-empty.json` is the clean production no-op starter. `rules/cmdbuild-to-zabbix-host-create.dev-empty.json` is the clean dev no-op starter generated from the empty installation profile; it already points to `cmdbuild.webhooks.dev` and `http://localhost:8081/api_jsonrpc.php`. Both starter files keep routes at `publish=false` until the operator fills classes, source fields, host profiles, Zabbix catalog IDs, T4 templates, and enables publication after verification. To work with the empty dev starter, load it in the UI or point `Rules.RulesFilePath` to it through config/env or Runtime settings.

## Git And Artifacts

One commit should contain related code, configs, `TZ_cmdb2monitoring.txt`, non-architecture documentation and English companions, relevant `aa/` artifacts when architecture changes, checks/tests, and documentation.

Do not commit `bin/`, `obj/`, `state/`, `.dotnet/`, `.nuget/`, `.env*`, runtime caches, or production secrets.
