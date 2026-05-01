# Changelog

## Unreleased

### Changed

- Documentation now separates product conversion capabilities from the concrete dev CMDBuild/Zabbix model names such as `Computer`, `Server`, `zabbixTag`, `iLo`, and `mgmt`.

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
