# Changelog

## Unreleased

### Added

- `hostProfiles[]` conversion model for one CMDB object -> multiple Zabbix hosts and one host -> multiple `interfaces[]`.
- `Model.Interfaces` T4 model field with `Model.Interface` retained as backward-compatible first interface.
- Mapping/Help documentation for host profiles and interface profile/valueField behavior.

### Changed

- `cmdbkafka2zabbix` can publish multiple Zabbix request messages for one CMDB event and writes state only after all messages are published.
- `zabbixrequests2api` update fallback now matches existing interfaces by type/ip/dns/port when several interfaces are present.

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
