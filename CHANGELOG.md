# Changelog

## Unreleased

### Added

- Added `DebugLogging` settings for all .NET microservices with `Basic` and `Verbose` levels; extended debug events are emitted through regular `ILogger` at `Information`.
- Added static Bearer-token validation to `cmdbwebhooks2kafka` for inbound CMDBuild webhooks before JSON parsing and Kafka publish.

## 0.8.2 - 2026-05-05

### Changed

- Renamed the audit placeholder menu to `Аудит` / `Audit` and allowed the `administrator` role alias to resolve to `admin` access.
- Added `cmdbresolver` regression tests for update events that must reread CMDBuild lookup, reference, and domain leaf values, including the dynamic host group JSON-RPC output built from a domain leaf.
- Added a dedicated Conversion Rules Management block for creating, modifying, and deleting monitoring `hostProfiles[]`; normal rule add/modify no longer creates profiles implicitly.
- Webhook Setup now derives desired CMDBuild webhooks from explicit rule-based webhook requirements and shows the rules that require missing payload fields.
- Added unit coverage for webhook requirement generation, including reference leaves, domain leaves, foreign-root paths, virtual fields, and obsolete managed hooks.
- Conversion Rules Management now has an explicit selected-`hostProfile` scope checkbox for add/modify rules, so template/group/tag assignments can keep a normal condition such as `description` while still counting as assignments to an additional profile.
- Runtime Settings now expose `AuditStorage` for the Audit menu: PostgreSQL for production, SQLite for development, connection string, schema, auto-migrate, and command timeout.
- Audit now includes a read-only Quick audit that compares selected CMDBuild cards with Zabbix hosts by binding, host name, interface address, groups, templates, and status.
- Quick audit now includes a Zabbix maintenance column and checks expected maintenance membership in bulk through `maintenance.get`.
- Quick audit can now read CMDBuild cards by offset and provides a `Next batch` action for paged class-card scanning.
- Clarified that SQLite audit storage is supported for development and small installations, with PostgreSQL expected for larger monitored-object counts or longer audit retention.
- Added separate administrator and rule-developer guides covering CMDBuild/Zabbix preparation, webhooks, dynamic leaf behavior, update merge behavior, and human-factor failure scenarios.
- Added Dockerfiles, a local-registry build/push script, and Russian/English deployment instructions for microservices and the UI, including Kafka topics, per-service secrets, and external-system permissions.
- Added `Secrets:Provider=IndeedPamAapm` support for `secret://id` service-account secret references in .NET microservices and `monitoring-ui-api`; secrets are fetched from AAPM into process memory, including the corporate `PAMURL`/`PAMUSERNAME`/`PAMPASSWORD` and `SASLUSERNAME`/`SASLPASSWORDSECRET` env alias format.
- Added `tests/zabbixbindings` regression coverage for the Zabbix host binding loop: binding event parsing, CMDBuild writes, binding lookup fallback, and publisher payload/header contracts.
- Audit now plans CMDBuild model preparation for `zabbix_main_hostid` and `ZabbixHostBinding`, with documentation for why the class and attributes are needed.
- Added `zabbixbindings2cmdbuild`, a Kafka consumer that writes Zabbix host bindings back to CMDBuild as `zabbix_main_hostid` for the main profile and `ZabbixHostBinding` cards for additional profiles.
- `zabbixrequests2api` now publishes `zabbix.host.bindings.*` events after successful `host.create/update/delete`; Dashboard and Events config include the new service, binding topic, and log topic.
- `cmdbkafka2zabbix` now reads stored CMDBuild host bindings before fallback `host.get`: `zabbix_main_hostid` for the main profile and `ZabbixHostBinding` for additional profiles.

### Fixed

- Conversion Rules Management no longer treats a raw CMDBuild reference id such as `ipaddress` as a direct IP/DNS leaf; operators must choose the resolved nested leaf like `ipaddress -> ipAddr`.
- Conversion Rules Management no longer offers CMDBuild 1:N domains that are already represented by reference attributes, preventing duplicate leaf choices such as both `ipaddress -> ipAddr` and `domain IpAddress -> ipAddr`.
- Conversion Rules Management now scopes catalog leaf options by `cmdbPath` root class, so adding an `Application.hostname` monitoring profile no longer reuses an existing `hostname / serveri.hostname` source field.
- Conversion Rules Logical Control now includes the same pre-save IP/DNS and host profile consistency checks as Mapping `Save file as`, so classes left without applicable rules are visible before saving.
- Conversion Rules Logical Control can now fix an existing host profile whose interface address still points to an invalid/raw field by replacing it with a class-scoped IP/DNS leaf.
- Conversion Rules Management now classifies `cmdbPath` address fields by the final leaf instead of the reference root, so `ipaddress.Code` is no longer treated as an IP candidate while `mgmt.ipAddr` remains valid.
- Conversion Rules Management now shows configured `cmdbPath` fields in editor/profile dropdowns as readable paths such as `mgmt -> ipAddr / routeCore`, keeping generated source keys like `routeCoreMgmtIpAddr` only in tooltips/JSON.
- Conversion Rules Management now preselects the rule class from the selected monitoring profile when adding a rule, avoiding a duplicate class choice for profile-scoped assignments.
- Hardened Webhook Setup apply so update/delete operations reload CMDBuild webhooks and resolve the target by managed `code`, preventing a crafted client payload from applying a managed-code operation to an unrelated webhook id.
- Dashboard rules-version rows now show the exact disk/git source path and warn when the converter-loaded rules version differs from the management UI source.
- Conversion Rules Management view now keeps the Zabbix side visible when selecting a CMDBuild attribute, including ordinary payload mappings and dynamic Host group mappings from CMDBuild leaf values.
- Conversion Rules Management now identifies `interfaceAddress` targets by address mode (`ip`/`dns`), so editing a DNS rule that uses a concrete CMDBuild leaf such as `hostname` no longer blocks save because the target option used a different default leaf.
- Renamed interface-related UI terms: `interfaceAddress` is shown as an interface address selection rule, `interfaceSelectionRules` as legacy interface fallback rules, and interface profiles as Zabbix `interfaces[]` profiles.
- Conversion Rules Management add/modify now exposes virtual `hostProfile` and `outputProfile` fields for restricting template/group/tag rules to a specific fan-out profile without adding those fields to `source.fields`.
- `cmdbkafka2zabbix` now scopes runtime CMDBuild card/lookup caches to one resolver event so source-card updates can pick up changed linked lookup/reference/domain leaves.
- Fixed CMDBuild domain leaf resolution so an unresolved relation id is not used as a dynamic Zabbix host group name.
- Stopped caching CMDBuild relation lists in `cmdbkafka2zabbix`, so relations created after the source card create event can be seen by later update events.

## 0.8.0 - 2026-05-03

### Added

- Added the `Аудит систем` / `Systems Audit` menu placeholder for `editor` and `admin` roles.
- Added explicit Webhook Setup reminders for CMDBuild webhook payload fields that are required by current rules but missing from loaded CMDBuild webhooks.
- Fixed Webhook Setup analysis to reload the current rules file and CMDBuild catalog each time before building the create/update/delete plan, so newly added reference/domain leaf fields are proposed for webhook payload updates without requiring a UI reload.
- Added a Webhook Setup `Удалить выбранные` / `Delete selected` action that applies only selected CMDBuild webhook delete operations.
- Added current `serveri.serialnum` source mapping and `inventory.serialno_a` demo rule so the webhook plan exposes the missing `serialnum` payload field before converter processing.

## 0.7.0 - 2026-05-03

### Added

- Added admin runtime switches for dynamic Zabbix Tags and Host groups from CMDBuild leaf values, with explicit `targetMode=dynamicFromLeaf` rule serialization in Conversion Rules Management.
- Added converter and Zabbix writer support for dynamic host groups: resolve by name, optionally create with `Zabbix:AllowDynamicHostGroupCreate`, and return `auto_expand_disabled` when creation is disabled.
- Added a regression fixture for first-seen dynamic leaf host groups: the writer creates/resolves the group and attaches the returned `groupid` to the same host payload; dynamic tags stay in that payload.
- Extended mapping regression tests and the testing development plan for dynamic target behavior.
- Added pre-send Zabbix template compatibility validation in `zabbixrequests2api`: conflicting item keys, LLD keys, or inventory links return `template_conflict` with `zabbixRequestSent=false` before `host.create/update`.
- Switched Zabbix template metadata reads to the 7+ non-deprecated `template.get` subselects `selectTemplateGroups` and `selectDiscoveryRules`.
- Added `Метаданные Zabbix` for `editor`/`admin`: template item keys, LLD rule keys, inventory links, existing host templates, and a template conflict index used by Mapping and Logical Control.
- Added admin `Настройка git`, separating conversion-rules storage settings from Runtime settings and showing resolved path, `schemaVersion`, and `rulesVersion`.
- Added local git-copy load/export in `Настройка git`: UI can load rules from disk/git working copy and write rules plus a redacted `*.webhooks.json` artifact without commit/push.
- Added converter rules status display on the Dashboard: the `cmdbkafka2zabbix` card now shows the microservice-loaded rules version and the management-system rules version next to reload.

## 0.6.2 - 2026-05-03

### Fixed

- Fixed browser loading of the extracted mapping logic module by serving/importing it as JavaScript, restoring the login screen after the 0.6.1 test refactor.

## 0.6.1 - 2026-05-03

### Changed

- Added a testing development plan with the first automation package, `No Silent Actions` UI regression class, and Webhook visual diff checks.
- Started the first package by extracting reusable mapping/rules logic into a pure UI module and adding Node.js regression tests for host profile creation, IP/DNS target compatibility, and domain collection semantics.

## 0.6.0 - 2026-05-03

### Changed

- Conversion Rules Management now auto-creates a minimal `hostProfiles[]` entry when adding or modifying a rule for a new concrete CMDBuild class with an IP/DNS leaf.
- Conversion Rules Management now blocks unconfirmed address fields for IP/DNS `interfaceAddress` targets until the field has explicit IP/DNS metadata or validation.
- Conversion Rules Logical Control now detects `source.entityClasses` entries without a matching `hostProfiles[]` as `no_host_profile_matched` risks and can create the missing host profile in the in-session draft.
- Config validation now requires every active source entity class to have a matching host profile instead of banning specific historical demo class names.

## 0.5.0 - 2026-05-02

### Changed

- `monitoring-ui-api` local login now uses local UI users with roles `viewer`, `editor`, and `admin`, stored with hashed passwords in `state/users.json`.
- Settings is split into two admin menu items: `Авторизация` and `Runtime-настройки`; CMDBuild/Zabbix credentials are no longer prefilled from development config.
- Authorization now has three explicit modes: local users, MS AD over LDAP/LDAPS, and IdP over SAML2/OAuth2.
- In IdP mode, SAML2/OAuth2 identifies the user while MS AD LDAP/LDAPS settings remain available for AD group-to-role mapping; the BFF reads AD groups when service bind is configured.
- The local user administration panel is now labeled as local users, shows an active/inactive checkbox, and becomes inactive in MS AD or IdP mode.
- `cmdbkafka2zabbix` now exposes a Bearer-protected rules reload endpoint, and the dashboard shows `Перечитать правила конвертации` for the converter service to trigger it through the BFF.
- CMDBuild/Zabbix login/password are requested only when an API operation first needs them, while Zabbix uses the configured API key when present.
- Runtime settings no longer contain persistent CMDBuild/Zabbix service login/password fields.
- Runtime settings no longer expose CMDBuild/Zabbix `Use IdP` switches; backend access uses Zabbix API key when configured or session-scoped CMDBuild/Zabbix credentials requested on demand.
- Runtime settings now show the conversion rules file path, `Read from git` switch, and git repository URL; `cmdbkafka2zabbix` has the matching `ConversionRules:ReadFromGit` and `RepositoryUrl` config fields.
- Runtime settings help now states the dev/test disk file and the expected rules filename inside the git repository: `rules/cmdbuild-to-zabbix-host-create.json`.
- Conversion Rules Management now warns that reference-attribute changes do not update monitoring unless the source object card itself is modified.
- Conversion Rules Management now supports CMDBuild domain paths such as `Класс.{domain:СвязанныйКласс}.Атрибут`, and blocks potentially multi-value domain fields for scalar Zabbix structures.
- Conversion Rules Management edit mode now hides the lower preview, supports rule modification, and shows CMDBuild class hierarchy while blocking superclass/prototype selection.
- Rule modification now has `Сбросить поля`, dependent field filtering, invalid/stale/valid visual states, and disabled save until the rule chain has an unambiguous leaf/source field and compatible Zabbix target.
- Conversion Rules Management now validates IP/DNS interface target semantics: an IP-looking CMDBuild attribute cannot be added as `interfaces[].dns`, and a DNS/FQDN-looking attribute cannot be added as `interfaces[].ip`.
- `zabbixrequests2api` now merges `groups[]`, `templates[]`, `tags[]`, `macros[]`, and `inventory` on `host.update` so external Zabbix assignments are preserved; `interfaces[]` remain rules-authoritative.
- Rule modification no longer auto-selects the first rule; the operator can start from a rule, CMDBuild class, class attribute field, or conversion structure, with linked lists narrowed and a single matching rule auto-selected.
- `Сбросить поля` in rule modification now clears the selected rule and all modification filters instead of restoring the selected rule.
- Zabbix targets loaded from a rule but missing from the current catalog/options are now treated as inconsistent red blocking errors, not as editable stale values.
- Conversion Rules Management delete mode now provides CMDBuild, Zabbix, and rules trees with group checkboxes for removing all rules tied to a class, CMDBuild attribute, Zabbix payload field, Zabbix object group, or rule collection.
- Conversion Rules Logical Control now has undo/redo for in-session fixes and lets operators select inconsistent conversion rules directly in the middle column.
- Conversion Rules Logical Control now marks rules that reference missing Zabbix targets, missing CMDBuild class conditions, or undeclared class attribute fields.
- Conversion Rules Logical Control no longer offers `eventRoutingRules` as direct delete fixes for catalog mismatches; only rules that contain the concrete inconsistent condition/target become selectable.
- Conversion Rules Logical Control rule deletion checkboxes are now bound to concrete rule identities instead of shared condition tokens, preventing unrelated profile/tag rules from being offered for deletion.
- Conversion Rules Logical Control now treats `hostProfile` and `outputProfile` as known virtual fields, so fan-out profile routing rules are not flagged as missing CMDBuild attributes.
- Conversion Rules Logical Control fixes now stay in the in-session draft with undo/redo and no longer open browser save-as after every delete; a separate `Save file as` button exports the accumulated draft.
- Added `Настройка webhooks` for `editor`/`admin`: load CMDBuild webhooks, analyze current rules into a create/update/delete plan, undo/redo operation selection, export the plan through browser save-as, and explicitly apply selected managed `cmdbwebhooks2kafka-*` operations to CMDBuild.
- `Настройка webhooks` now shows loaded CMDBuild webhooks even before rules analysis, states that the page is optional, and clarifies that undo/redo does not roll back already applied CMDBuild configuration.
- `Настройка webhooks` table rows can now expand payload diffs with green additions, red deletions, and black current values, and each row has an edit action that changes the current webhook plan.
- `Настройка webhooks` now opens row details from the `Действие` column directly under the clicked row, moves the shared details panel below the table, highlights details text, and preserves existing webhook bodies so unrelated records are not mass-marked as `Изменить` when an independent class is added.
- `Настройка webhooks` no longer adds duplicate body keys with different case/aliases, respects nested class filters, and ignores `cmdbPath` roots that belong to another class when deciding which source fields are needed for a class.
- About text now identifies Igor Lyapin as designer/author and states GNU GPLv3 licensing.
- Runtime settings now expose CMDBuild domain/reference/lookup recursion depth, clamped to `2..5` with default `2`; changes take effect after logout and CMDBuild catalog resync.
- `cmdbkafka2zabbix` now supports `monitoringSuppressionRules` so object attributes such as `monitoringPolicy=do_not_monitor` can intentionally skip host create/update without publishing a Zabbix request.
- Documentation now distinguishes object-level "не ставить на мониторинг" suppression from domain leaf `do_not_monitor`, which only excludes a related endpoint and must not "остановить мониторинг объекта".
- Added an abstract CI/КЕ mapping-editor test plan plus CMDBuild demo schema and instance scripts for repeatable rule-editor checks.
- Extended the mapping-editor test plan with Webhook Setup checks: clean managed webhook deletion, UI recreate/apply, event arrival, no unrelated class updates, and class-local payload changes when a new attribute is added.
- Added a CMDBuild demo E2E runner that sends demo webhook events, verifies Zabbix hosts, and writes a markdown report.
- Demo E2E now verifies Zabbix assignment targets on live hosts: host name, visible name, groups, templates, interfaces, tags, macros, inventory, status, and TLS mode.
- Demo E2E now includes DNS-only monitoring through `interfaces[].dns/useip=0` and supports `--code` for running one scenario.
- Mapping editor test plan now records report locations and covers Zabbix host update merge scenarios for groups, templates, tags, macros, inventory, `templates_clear`, direct `host.update`, and authoritative `interfaces[]`.
- Added a clean no-op production starter rules file next to the demo conversion rules.
- Added a clean no-op dev starter rules file with dev topic/API defaults next to the demo and production starter rules.
- Rebuilt the active demo/e2e conversion rules from the clean dev starter around the C2MTest model only, removing the old `Computer`/`Notebook`/`PC`/`Server`/`tk` dev rules and legacy fields from `rules/cmdbuild-to-zabbix-host-create.json`.
- Rules UI now has `Создать пустой`, which generates a no-op production starter from current runtime settings and CMDBuild/Zabbix catalog caches for browser save-as; empty caches now return a clear backend error.
- Conversion rules now carry `rulesVersion`; monitoring-ui-api no longer writes active rules files or performs git commit/push, leaving publication to the operator outside the application.
- Documentation now states minimum permissions by operation, including CMDBuild ETL/webhook read and create/update/delete requirements for Webhook Setup apply.
- Documentation now separates product conversion capabilities from the concrete dev CMDBuild/Zabbix model names such as `Computer`, `Server`, `zabbixTag`, `iLo`, and `mgmt`.
- Documentation now records the tested compatibility matrix for CMDBuild `4.1.0`, Zabbix `7.0.25`, Kafka `3.9.2`, .NET `10.0.203`, and Node.js `>=22`.

## 0.4.0 - 2026-05-01

### Added

- `cmdbkafka2zabbix` resolves CMDBuild lookup ids and iterative reference paths from `source.fields[].cmdbPath`.
- Mapping edit mode can expand reference attributes to readable leaf fields and store the selected path in rules.
- `monitoring-ui-api` has an About menu item and a login-screen language selector for Russian/English menu, Help, and interface tooltip text.
- Architecture artifacts document the CMDBuild resolver flow, UI localization, and updated conversion rules menu names.

### Changed

- Current `OS` and `zabbixTag` lookup source fields now declare lookup resolution metadata while keeping numeric-id regex fallback.
- CMDBuild catalog sync in `monitoring-ui-api` stores lookup values under lookup types when enabled.

## 0.3.0 - 2026-05-01

### Added

- `hostProfiles[]` conversion model for one CMDB object -> multiple Zabbix hosts and one host -> multiple `interfaces[]`.
- `Model.Interfaces` T4 model field with `Model.Interface` retained as backward-compatible first interface.
- Mapping/Help documentation for host profiles and interface profile/valueField behavior.
- Server multi-address rules: the main Server Zabbix host now uses `ip_address`, `interface` and `interface2` as three interfaces, while `profile` and `profile2` create separate additional monitoring hosts.
- `createOnUpdateWhenMissing` host profile policy for Server `profile`/`profile2`: update fallback can create the additional Zabbix host when it does not exist yet.
- Documentation for IP-count limits in `hostProfiles[].interfaces` and Server additional profiles.
- Config-driven `templateConflictRules` for removing conflicting Zabbix templates such as `ICMP Ping` and agent templates when SNMP templates already provide `icmpping` or the same inventory field.
- Dev Server webhook/rules naming uses `interface/interface2/profile/profile2` for additional interfaces and profiles, but product behavior is driven by rules-defined source fields.
- Mapping metadata `source.fields[].cmdbAttribute` links Server webhook keys `interface/interface2/profile/profile2` to real CMDBuild attributes `iLo/iLo2/mgmt/mgmt2` without restoring legacy input aliases.

### Changed

- `cmdbkafka2zabbix` can publish multiple Zabbix request messages for one CMDB event and writes state only after all messages are published.
- `zabbixrequests2api` update fallback now matches existing interfaces by type/ip/dns/port when several interfaces are present.
- `zabbixrequests2api` filters `templates_clear` against currently linked Zabbix templates before host.update fallback calls.

## 0.2.0 - 2026-04-30

### Added

- `monitoring-ui-api` Mapping edit mode with add/delete rule workflows, undo/redo session history, and `Save file as`.
- Session-scoped webhook body text generation for Mapping changes: only added/deleted classes, fields, and rules are emitted; deletions are marked explicitly.
- Mapping save validation for required IP/DNS binding to Zabbix interface rules.
- Lazy-loaded Zabbix catalog sections for Mapping, including proxies, proxy groups, host macros, inventory fields, interface profiles, host statuses, maintenances, TLS/PSK modes, and value maps.
- Extended CMDBuild-to-Zabbix rules/model support for additional Zabbix host payload structures.

### Changed

- Mapping and Validate rules mapping now normalize CMDBuild class names such as `NetworkDevice` and `Network device` as the same class and prefer the CMDBuild catalog display name.
- Event browser and Mapping UI documentation now describe topic browsing, timestamp sorting, collapsed sections, lookup-specific highlighting, and edit/delete behavior.
- Version metadata for `monitoring-ui-api` moved from `0.1.0` to `0.2.0`.

### Notes

- Kafka topics remain externally managed; microservices still do not create topics at startup.
- ELK remains a planned target; current structured logs continue to use Kafka log topics.
