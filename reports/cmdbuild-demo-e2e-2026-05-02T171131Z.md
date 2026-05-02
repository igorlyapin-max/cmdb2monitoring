# CMDBuild Demo E2E Report

Generated: 2026-05-02T17:11:31.821Z
CMDBuild class: C2MTestCI

## Zabbix Assignment Coverage

Checked live on Zabbix hosts: technical host name, visible name, interfaces, host groups, templates, tags, host macros, inventory fields, host status, TLS/PSK mode. Zabbix host.get does not expose the PSK secret and may omit PSK identity, so the live assertion checks the effective TLS mode fields.

Not checked by this host-create demo: proxy/proxy group, maintenance, value maps. They require dedicated Zabbix catalog objects or API operations outside the direct host payload currently applied by this runner.

## Expected Zabbix Hosts

| Expected Host | Zabbix Host Name | Visible Name | Scenario | Presence | Zabbix Status | Interfaces | Groups | Templates | Macros | Inventory | TLS/PSK | Tags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cmdb-c2mtestci-c2m-demo-001-scalar |  |  | scalar source field | missing |  |  |  |  |  |  |  |  |
| cmdb-c2mtestci-c2m-demo-002-lookup |  |  | lookup source field and business-hours policy tag | missing |  |  |  |  |  |  |  |  |
| cmdb-c2mtestci-c2m-demo-003-reference-leaf |  |  | reference leaf interface | missing |  |  |  |  |  |  |  |  |
| cmdb-c2mtestci-c2m-demo-004-deep-reference |  |  | deep reference leaf and lookup tag | missing |  |  |  |  |  |  |  |  |
| cmdb-c2mtestci-c2m-demo-005-domain-single |  |  | single domain relation leaf | missing |  |  |  |  |  |  |  |  |
| cmdb-c2mtestci-c2m-demo-006-domain-multi |  |  | domain relation collection with collectionMode=first | missing |  |  |  |  |  |  |  |  |
| cmdb-c2mtestci-c2m-demo-007-multi-ip-same-host |  |  | multiple IPs as interfaces[] in one host | missing |  |  |  |  |  |  |  |  |
| cmdb-c2mtestci-c2m-demo-008-separate-profiles |  |  | base host for separate monitoring profiles | missing |  |  |  |  |  |  |  |  |
| cmdb-c2mtestci-c2m-demo-008-separate-profiles-separate-profile-1 |  |  | first separate Zabbix host profile | missing |  |  |  |  |  |  |  |  |
| cmdb-c2mtestci-c2m-demo-008-separate-profiles-separate-profile-2 |  |  | second separate Zabbix host profile | missing |  |  |  |  |  |  |  |  |
| cmdb-c2mtestci-c2m-demo-010-business-hours |  |  | business-hours policy tag | missing |  |  |  |  |  |  |  |  |
| cmdb-c2mtestci-c2m-demo-011-domain-leaf-dont-monitor |  |  | domain leaf do_not_monitor does not become interface | missing |  |  |  |  |  |  |  |  |
| cmdb-c2mtestci-c2m-demo-012-disabled-status |  |  | host status assignment from conversion rules | missing |  |  |  |  |  |  |  |  |
| cmdb-c2mtestci-c2m-demo-013-dns-only |  |  | DNS-only hostname interface | missing |  |  |  |  |  |  |  |  |

## Suppressed Hosts

| Host | Scenario | Status |
| --- | --- | --- |
| cmdb-c2mtestci-c2m-demo-009-dont-monitor-instance | suppressed by monitoringPolicy=do_not_monitor | absent |

## Checks

| Check | Result | Details |
| --- | --- | --- |
| all expected hosts: Zabbix host name | OK | 14 host name assignment(s) |
| all expected hosts: Zabbix visible name | OK | 14 visible name assignment(s) |
| C2M-DEMO-007-MULTI-IP-SAME-HOST: expected interfaces | FAIL | missing 10.20.7.10, 10.20.7.11, 10.20.7.12 |
| C2M-DEMO-007-MULTI-IP-SAME-HOST/main: interface 10.20.7.11 type | FAIL | missing |
| C2M-DEMO-001-SCALAR/main: group Linux servers | FAIL | missing |
| C2M-DEMO-001-SCALAR/main: template Linux by Zabbix agent | FAIL | missing |
| C2M-DEMO-001-SCALAR/main: macro {$CMDB_CLASS} | FAIL | missing |
| C2M-DEMO-001-SCALAR/main: macro {$C2M_DEMO_CODE} | FAIL | missing |
| C2M-DEMO-001-SCALAR/main: inventory alias | FAIL | missing |
| C2M-DEMO-001-SCALAR/main: inventory asset_tag matches cmdb.id | FAIL | missing |
| C2M-DEMO-001-SCALAR/main: Zabbix status 0 | FAIL | missing |
| C2M-DEMO-008-SEPARATE-PROFILES/separate-profile-1: group Discovered hosts | FAIL | missing |
| C2M-DEMO-008-SEPARATE-PROFILES/separate-profile-1: template Generic by SNMP | FAIL | missing |
| C2M-DEMO-010-BUSINESS-HOURS: tag monitoring.policy | FAIL | missing |
| C2M-DEMO-004-DEEP-REFERENCE: tag cmdb.deepReference.lookup | FAIL | missing |
| C2M-DEMO-004-DEEP-REFERENCE/main: TLS/PSK mode | FAIL | connect=, accept=; identity is not returned by host.get |
| C2M-DEMO-012-DISABLED-STATUS/main: Zabbix status 1 | FAIL | missing |
| C2M-DEMO-011-DOMAIN-LEAF-DONT-MONITOR: excluded domain leaf interface | OK | 10.20.11.10 is absent |
| C2M-DEMO-013-DNS-ONLY: DNS interface useip=0 | FAIL | missing |
