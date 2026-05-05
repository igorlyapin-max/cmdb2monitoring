# System Administrator Guide

This guide describes how to prepare and operate `cmdb2monitoring` from the system administrator side: service settings, CMDBuild, Zabbix, webhooks, reverse bindings, and common human-factor failure scenarios.

## Responsibilities

The system administrator is responsible for:
- microservice, Kafka topic, CMDBuild, and Zabbix availability;
- UI/BFF and microservice runtime settings;
- service accounts and minimum permissions;
- CMDBuild model preparation for monitoring audit;
- CMDBuild webhook loading and control;
- publishing the rules file to the agreed production storage;
- pressing `Reload conversion rules` after publishing rules;
- checking rules versions on the Dashboard.

The rule developer is responsible for rules-file content: source fields, `cmdbPath`, host profiles, selection rules, templates, groups, tags, suppression, and T4 payload. An administrator can publish the file, but should not make semantic mapping decisions without the rule developer.

## Initial Preparation

1. Check environment compatibility.
   - CMDBuild: `4.x` with REST API v3 and flat webhook JSON.
   - Zabbix: `7.0.x LTS` or a compatible 7.x JSON-RPC version.
   - Kafka: `3.x`, topics are created by external infrastructure.
   - Audit storage: PostgreSQL for medium and large installations; SQLite is allowed for development and small installations.

2. Prepare Kafka topics.
   - CMDBuild events: topic for `cmdbwebhooks2kafka`.
   - Zabbix requests: topic for `cmdbkafka2zabbix -> zabbixrequests2api`.
   - Zabbix responses: topic for `zabbixrequests2api`.
   - Zabbix bindings: topic for `zabbixrequests2api -> zabbixbindings2cmdbuild`.
   - Log topics for services when enabled in configuration.

3. Configure microservices.
   - `cmdbwebhooks2kafka`: webhook URL, network access or reverse proxy auth for inbound webhooks, Kafka input.
   - `cmdbkafka2zabbix`: CMDBuild REST URL, rules provider, `HostBindingLookupEnabled`, Kafka input/output.
   - `zabbixrequests2api`: Zabbix API URL/token, validation settings, dynamic host group creation.
   - `zabbixbindings2cmdbuild`: CMDBuild REST URL, service account for writing bindings.
   - `monitoring-ui-api`: endpoints, Kafka Event Browser, auth, runtime settings, git settings.
   - Docker image build, local registry publishing, Kafka topics, per-service secrets, and external-system permissions are described in `DEPLOYMENT_LOCAL_REGISTRY.md`.

4. Configure UI roles.
   - `viewer`: Dashboard and Events.
   - `editor`: rule, catalog, webhook, and audit work sections without admin settings.
   - `admin`: all menus, including Authorization, Runtime settings, and Git Settings.
   - When `MS AD` or `IdP` is enabled, roles are assigned through groups; local users remain a fallback/service mechanism.

## Minimum Permissions

CMDBuild:
- UI catalog sync: read-only access to metadata classes/attributes/domains, lookup types/values, target class cards, related reference/domain classes, and current-card relations.
- Webhook Setup, `Load from CMDB`: read access to ETL/webhook records.
- Webhook Setup, `Load into CMDB`: create/update/delete or equivalent modify permissions on ETL/webhook records.
- Audit, `Run quick audit`: read-only access to metadata classes/attributes, selected class cards, and `ZabbixHostBinding`; Zabbix needs read-only `host.get` with interfaces, groups, and parent templates, plus `maintenance.get` to check membership for expected maintenances.
- Audit, `Apply CMDBuild preparation`: model administrator permissions to create classes and attributes.
- `cmdbkafka2zabbix`: read-only access to source cards and `ZabbixHostBinding` when `Cmdbuild:HostBindingLookupEnabled` is enabled.
- `zabbixbindings2cmdbuild`: read/update on participating class cards for `zabbix_main_hostid`, read/create/update on `ZabbixHostBinding`.

Zabbix:
- UI catalog sync: API access and read-only access to host groups, template groups, templates, hosts/tags, and extended catalogs.
- `zabbixrequests2api`: host create/update/delete, group/template read access, and `hostgroup.create` when dynamic host group creation is enabled.
- If a Zabbix API token is used, store it as a secret/env value. Login/password values are not persisted in runtime state.

## Runtime Settings

The `Runtime settings` menu configures UI/BFF operational endpoints and parameters:
- CMDBuild URL;
- Zabbix API URL and optional API key;
- Kafka Event Browser topics/security;
- AuditStorage provider/connection string/schema;
- dynamic Zabbix expansion from CMDBuild leaf;
- service health/reload endpoints.

AuditStorage:
- `postgresql` is the main option for medium and large installations.
- `sqlite` is for development and small installations. Estimate: up to 1000 monitored objects, acceptable up to 2000 with moderate event flow and short audit retention.
- Use PostgreSQL for high user concurrency, long audit retention, or larger object counts.

Important separation:
- UI/BFF settings in `Runtime settings` do not automatically change microservice configuration;
- `cmdbkafka2zabbix`, `zabbixrequests2api`, and `zabbixbindings2cmdbuild` settings live in their `appsettings*.json` or env/secret values;
- external UI authentication through MS AD/IdP is not used as CMDBuild/Zabbix API credentials.
- service accounts can use `Secrets:Provider=IndeedPamAapm` and `secret://id` references; the actual secret is read from Indeed PAM/AAPM and must not be stored in git or Docker images.
- the AAPM application token or application login/password is the application's bootstrap secret and must be provided through a Docker/Kubernetes secret, protected mount, another deployment-layer mechanism, or `PAMURL`/`PAMUSERNAME`/`PAMPASSWORD` env aliases.
- Kafka SASL can use the corporate `SASLUSERNAME`/`SASLPASSWORD`/`SASLPASSWORDSECRET` format; `SASLPASSWORDSECRET=AAA.LOCAL\PROD.contractorProfiles` becomes `secret://AAA.LOCAL\PROD.contractorProfiles` and is read from PAM/AAPM.

## Git Settings And Rules File

The `Git Settings` menu manages only local rules-file copies for the management UI. The `cmdbkafka2zabbix` microservice reads rules according to its own `ConversionRules` configuration.

Recommended flow:
1. The rule developer saves JSON from the browser or through a local git working copy.
2. The administrator reviews the diff.
3. The administrator publishes the file to the agreed git repository or local path used by the microservice.
4. The administrator presses `Reload conversion rules` on the Dashboard.
5. The administrator compares:
   - the rules version loaded by the microservice;
   - the rules version visible to the management UI.

`rulesVersion` should include date and time, for example `2026.05.05-1530-change-name`, so revisions are visually distinguishable.

## CMDBuild Preparation

### Catalog Sync

Run CMDBuild catalog sync in the UI before working with rules or audit. Repeat it after adding a class, attribute, lookup, or domain.

### Main Zabbix Host Attribute

Every concrete CMDBuild class participating in conversion rules needs a string attribute:

| Attribute | Purpose |
| --- | --- |
| `zabbix_main_hostid` | `hostid` of the main Zabbix host for a concrete CMDBuild card |

Recommended creation:
1. Open `Audit`.
2. Press `Check CMDBuild model`.
3. Review participating classes.
4. As administrator, press `Apply CMDBuild preparation`.

Manual creation is possible but less controlled. Attribute type: string/text, length up to 64.

### Additional Profile Class

When one CMDBuild card can create several Zabbix hosts through additional `hostProfiles[]`, the service class `ZabbixHostBinding` is required. It is general infrastructure for extended logic, not only a class for currently populated profiles. Actual cards are created for additional profiles.

Class attributes:

| Attribute | Type | Purpose |
| --- | --- | --- |
| `OwnerClass` | string 100 | Source CMDBuild class |
| `OwnerCardId` | string 64 | Source card id |
| `OwnerCode` | string 100 | Source card code |
| `HostProfile` | string 128 | `hostProfile` name from rules |
| `ZabbixHostId` | string 64 | Zabbix `hostid` |
| `ZabbixHostName` | string 255 | Zabbix technical host name |
| `BindingStatus` | string 32 | `active` or `deleted` |
| `RulesVersion` | string 128 | Rules version that created the binding |
| `LastSyncAt` | string 64 | Last write timestamp |

Recommended creation is through the `Audit` menu: the administrator selects where to create `ZabbixHostBinding` in the CMDBuild tree and applies preparation. This reduces the risk of wrong attribute names or types.

### Quick Audit

`Run quick audit` is read-only. The administrator or rule developer selects a CMDBuild class, enables child classes and the rules-only filter when needed, and the UI reads cards in `limit/offset` batches, calculates expected host/profile/interface/groups/templates/maintenance/status from the current rules file, and compares the result with Zabbix `host.get` and bulk `maintenance.get`. `Cards offset` sets the start of the batch for every selected class; `Next batch` increases offset by the current max-cards-per-class limit.

Use quick audit after changing rules, webhooks, or the CMDBuild model. Reported discrepancies mean the object was not created, binding was not written, the host still has an old name/address, host groups/templates/maintenance did not arrive, or monitoring status differs from rules. Quick audit does not fix data automatically.

## Webhook Setup

Webhooks must send flat JSON. Reference/lookup/domain values normally remain ids in the webhook, while the path to the leaf is stored in rules as `cmdbPath` metadata.

Workflow:
1. Sync CMDBuild catalog.
2. In `Webhook Setup`, press `Load from CMDB`.
3. Press `Analyze rules`.
4. Expand payload rows and check:
   - green - added;
   - red - deleted;
   - black - current actual state.
5. Edit a specific webhook if needed.
6. Apply selected operations with `Load into CMDB`.

Notes:
- UI undo/redo does not roll back changes already loaded into CMDBuild;
- `Save file as` can write a neighboring webhook-instructions file, but token/secret values are masked as `XXXXX`;
- if a rule requires a new source field and the webhook is not updated, the converter receives an empty or missing field and the rule will not fire;
- analyze webhooks again after each rules change.

## Zabbix Preparation

1. Create or check host groups, template groups, templates, macros, inventory fields, proxies, and other objects used by rules.
2. Run Zabbix catalog sync in the UI.
3. Sync `Zabbix Metadata`.
4. Check template conflicts.

Runtime protection:
- `zabbixrequests2api` validates host groups, templates, and template compatibility before `host.create/update`;
- on `template_conflict`, the service does not send the request to Zabbix and returns a clear error;
- conflicts are fixed in rules, Zabbix templates, or `templateConflictRules`.

## Dynamic Zabbix Expansion From CMDBuild Leaf

There are two independent levels:
- UI Runtime settings allow the rule editor to save dynamic targets for Tags and Host groups.
- `zabbixrequests2api`: `Zabbix:AllowDynamicHostGroupCreate` allows the writer to create missing host groups.

Behavior:
- Tags have no separate Zabbix catalog object in this flow; tag/value is sent directly in `params.tags[]`.
- A Host group is looked up through `hostgroup.get`; if missing and creation is allowed, `hostgroup.create` is called and the new `groupid` is substituted into the same host payload.
- If the UI switch is enabled but writer creation is disabled, the rule can be saved, but execution returns `auto_expand_disabled`.

Use dynamic leaf only after analyzing value variety. An uncontrolled CMDBuild attribute can create many host groups or tags.

## Update Behavior And Concurrent Edits

Zabbix host identification during update/delete:
1. explicit `zabbix_hostid` from webhook/source fields;
2. CMDBuild binding:
   - main host: `zabbix_main_hostid`;
   - additional hostProfile: `ZabbixHostBinding`;
3. fallback `host.get` by technical host name.

Merge with manual Zabbix changes:
- `groups[]`, `templates[]`, `tags[]`, `macros[]`, and `inventory` are applied as a merge with the current host state;
- external values not present in rules payload are preserved;
- values from rules are added or override matching keys;
- `templates_clear` is an explicit operation for removing conflicting templates;
- `interfaces[]` are not a free merge: their set is considered rules-owned, while the writer only substitutes existing `interfaceid` values for update.

Practical consequences:
- if another administrator manually added an extra host group, a normal rules update will not remove it;
- if a rule changes the same tag/value, macro, or inventory field, the rule-owned value will override it;
- interface set changes should be made through rules, not manually in Zabbix.

## Human-Factor Scenarios

| Scenario | What happens | Prevention |
| --- | --- | --- |
| CMDBuild class/attribute was added but catalog was not resynced | UI does not see the field or marks it inconsistent | Sync CMDBuild catalog before editing rules |
| Zabbix template/group was added but catalog was not resynced | UI cannot select it or logical control shows it missing | Sync Zabbix catalog and metadata |
| Rules were saved in the browser but not published to the microservice source | Dashboard shows different versions, converter keeps old rules | Check Dashboard versions and reload after publishing |
| Rule needs a new webhook field but webhook was not updated | Converter receives no value, mapping does not fire | Analyze and load webhooks after rules changes |
| Only a referenced/domain object changed, while the source card did not | Source-card webhook is not emitted, monitoring may not update | Touch the source card, add webhook logic for the related class, or plan a separate process |
| A domain returns several related objects and the rule writes to a scalar Zabbix field | UI should block the mapping; manual JSON can be ambiguous | Use Zabbix multi-value structures or separate hostProfiles |
| Dynamic host group is enabled without value control | Many Zabbix groups can be created | Analyze values first, normalize lookup values, restrict with regex |
| `zabbixbindings2cmdbuild` is stopped or lacks permissions | Host is created, but `zabbix_main_hostid`/binding is not written; update uses fallback | Check health 5083, logs, and CMDBuild permissions |
| `hostProfile` is renamed | Computed additional Zabbix host name changes; old host is not deleted automatically | Treat rename as a migration: rules, cleanup, binding check |
| Technical host is manually renamed in Zabbix before a binding exists | fallback `host.get` may not find it | Do not rename technical hosts manually, or ensure binding exists first |
| A superclass is selected in rules | UI should replace it with the nearest concrete class or block selection | Use only concrete CMDBuild classes |
| Template conflict was missed because metadata was stale | Runtime still blocks `host.create/update` | Sync metadata and fix `templateConflictRules` |

## Operational Checklist After Rules Change

1. Sync CMDBuild catalog if the model changed.
2. Sync Zabbix catalog and metadata if Zabbix objects changed.
3. In `Conversion Rules Management`, check hostProfiles, assignments, and dynamic targets.
4. In `Conversion Rules Logical Control`, fix critical errors.
5. In `Webhook Setup`, build the plan and apply CMDBuild changes.
6. Save rules JSON and check `rulesVersion`.
7. Publish rules to the agreed storage location.
8. Press `Reload conversion rules`.
9. On the Dashboard, compare the microservice rules version and the UI source version.
10. Check Events: CMDBuild event -> Zabbix request -> Zabbix response -> binding event.
11. For new classes, verify that `zabbix_main_hostid` or `ZabbixHostBinding` is filled after successful create/update.
