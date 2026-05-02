# CMDBuild Demo E2E Report

Generated: 2026-05-02T16:38:40.099Z
CMDBuild class: C2MTestCI

## Zabbix Assignment Coverage

Checked live on Zabbix hosts: technical host name, visible name, interfaces, host groups, templates, tags, host macros, inventory fields, host status, TLS/PSK mode. Zabbix host.get does not expose the PSK secret and may omit PSK identity, so the live assertion checks the effective TLS mode fields.

Not checked by this host-create demo: proxy/proxy group, maintenance, value maps. They require dedicated Zabbix catalog objects or API operations outside the direct host payload currently applied by this runner.

## Expected Zabbix Hosts

| Expected Host | Zabbix Host Name | Visible Name | Scenario | Presence | Zabbix Status | Interfaces | Groups | Templates | Macros | Inventory | TLS/PSK | Tags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cmdb-c2mtestci-c2m-demo-001-scalar | cmdb-c2mtestci-c2m-demo-001-scalar | C2MTestCI C2M-DEMO-001-SCALAR | scalar source field | present | monitored (0) | 10.20.1.10 (type 1) | Linux servers (2) | Linux by Zabbix agent (10001)<br>ICMP Ping (10564) | {$CMDB_CLASS}=C2MTestCI<br>{$CMDB_ID}=218048<br>{$C2M_DEMO_CODE}=C2M-DEMO-001-SCALAR | alias=C2M-DEMO-001-SCALAR<br>asset_tag=218048 | connect=1<br>accept=1 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=218048<br>cmdb.event=create<br>cmdb.hostProfile=main |
| cmdb-c2mtestci-c2m-demo-002-lookup | cmdb-c2mtestci-c2m-demo-002-lookup | C2MTestCI C2M-DEMO-002-LOOKUP | lookup source field and business-hours policy tag | present | monitored (0) | 10.20.2.10 (type 1) | Linux servers (2) | Linux by Zabbix agent (10001)<br>ICMP Ping (10564) | {$CMDB_CLASS}=C2MTestCI<br>{$CMDB_ID}=218055<br>{$C2M_DEMO_CODE}=C2M-DEMO-002-LOOKUP | alias=C2M-DEMO-002-LOOKUP<br>asset_tag=218055 | connect=1<br>accept=1 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=218055<br>cmdb.event=create<br>cmdb.hostProfile=main<br>monitoring.policy=business_hours_08_18 |
| cmdb-c2mtestci-c2m-demo-003-reference-leaf | cmdb-c2mtestci-c2m-demo-003-reference-leaf | C2MTestCI C2M-DEMO-003-REFERENCE-LEAF | reference leaf interface | present | monitored (0) | 10.20.3.1 (type 1)<br>10.20.3.10 (type 2) | Linux servers (2) | HP iLO by SNMP (10256) | {$CMDB_CLASS}=C2MTestCI<br>{$CMDB_ID}=218062<br>{$C2M_DEMO_CODE}=C2M-DEMO-003-REFERENCE-LEAF | alias=C2M-DEMO-003-REFERENCE-LEAF<br>asset_tag=218062 | connect=1<br>accept=1 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=218062<br>cmdb.event=create<br>cmdb.hostProfile=main |
| cmdb-c2mtestci-c2m-demo-004-deep-reference | cmdb-c2mtestci-c2m-demo-004-deep-reference | C2MTestCI C2M-DEMO-004-DEEP-REFERENCE | deep reference leaf and lookup tag | present | monitored (0) | 10.20.4.1 (type 1)<br>10.20.4.20 (type 2) | Linux servers (2) | HP iLO by SNMP (10256) | {$CMDB_CLASS}=C2MTestCI<br>{$CMDB_ID}=218070<br>{$C2M_DEMO_CODE}=C2M-DEMO-004-DEEP-REFERENCE | alias=C2M-DEMO-004-DEEP-REFERENCE<br>asset_tag=218070 | connect=2<br>accept=2 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=218070<br>cmdb.event=create<br>cmdb.hostProfile=main<br>cmdb.deepReference.lookup=production |
| cmdb-c2mtestci-c2m-demo-005-domain-single | cmdb-c2mtestci-c2m-demo-005-domain-single | C2MTestCI C2M-DEMO-005-DOMAIN-SINGLE | single domain relation leaf | present | monitored (0) | 10.20.5.1 (type 1)<br>10.20.5.10 (type 2) | Linux servers (2) | HP iLO by SNMP (10256) | {$CMDB_CLASS}=C2MTestCI<br>{$CMDB_ID}=218085<br>{$C2M_DEMO_CODE}=C2M-DEMO-005-DOMAIN-SINGLE | alias=C2M-DEMO-005-DOMAIN-SINGLE<br>asset_tag=218085 | connect=1<br>accept=1 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=218085<br>cmdb.event=create<br>cmdb.hostProfile=main |
| cmdb-c2mtestci-c2m-demo-006-domain-multi | cmdb-c2mtestci-c2m-demo-006-domain-multi | C2MTestCI C2M-DEMO-006-DOMAIN-MULTI | domain relation collection with collectionMode=first | present | monitored (0) | 10.20.6.1 (type 1)<br>10.20.6.10 (type 2) | Linux servers (2) | HP iLO by SNMP (10256) | {$CMDB_CLASS}=C2MTestCI<br>{$CMDB_ID}=218113<br>{$C2M_DEMO_CODE}=C2M-DEMO-006-DOMAIN-MULTI | alias=C2M-DEMO-006-DOMAIN-MULTI<br>asset_tag=218113 | connect=1<br>accept=1 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=218113<br>cmdb.event=create<br>cmdb.hostProfile=main |
| cmdb-c2mtestci-c2m-demo-007-multi-ip-same-host | cmdb-c2mtestci-c2m-demo-007-multi-ip-same-host | C2MTestCI C2M-DEMO-007-MULTI-IP-SAME-HOST | multiple IPs as interfaces[] in one host | present | monitored (0) | 10.20.7.10 (type 1)<br>10.20.7.11 (type 2)<br>10.20.7.12 (type 2) | Linux servers (2) | HP iLO by SNMP (10256) | {$CMDB_CLASS}=C2MTestCI<br>{$CMDB_ID}=218134<br>{$C2M_DEMO_CODE}=C2M-DEMO-007-MULTI-IP-SAME-HOST | alias=C2M-DEMO-007-MULTI-IP-SAME-HOST<br>asset_tag=218134 | connect=1<br>accept=1 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=218134<br>cmdb.event=create<br>cmdb.hostProfile=main |
| cmdb-c2mtestci-c2m-demo-008-separate-profiles | cmdb-c2mtestci-c2m-demo-008-separate-profiles | C2MTestCI C2M-DEMO-008-SEPARATE-PROFILES | base host for separate monitoring profiles | present | monitored (0) | 10.20.8.10 (type 1) | Linux servers (2) | Linux by Zabbix agent (10001)<br>ICMP Ping (10564) | {$CMDB_CLASS}=C2MTestCI<br>{$CMDB_ID}=218141<br>{$C2M_DEMO_CODE}=C2M-DEMO-008-SEPARATE-PROFILES | alias=C2M-DEMO-008-SEPARATE-PROFILES<br>asset_tag=218141 | connect=1<br>accept=1 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=218141<br>cmdb.event=create<br>cmdb.hostProfile=main |
| cmdb-c2mtestci-c2m-demo-008-separate-profiles-separate-profile-1 | cmdb-c2mtestci-c2m-demo-008-separate-profiles-separate-profile-1 | C2MTestCI C2M-DEMO-008-SEPARATE-PROFILES separate profile 1 | first separate Zabbix host profile | present | monitored (0) | 10.20.8.21 (type 2) | Discovered hosts (5) | Generic by SNMP (10563) | {$CMDB_CLASS}=C2MTestCI<br>{$CMDB_ID}=218141<br>{$C2M_DEMO_CODE}=C2M-DEMO-008-SEPARATE-PROFILES | alias=C2M-DEMO-008-SEPARATE-PROFILES<br>asset_tag=218141 | connect=1<br>accept=1 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=218141<br>cmdb.event=create<br>cmdb.hostProfile=separate-profile-1 |
| cmdb-c2mtestci-c2m-demo-008-separate-profiles-separate-profile-2 | cmdb-c2mtestci-c2m-demo-008-separate-profiles-separate-profile-2 | C2MTestCI C2M-DEMO-008-SEPARATE-PROFILES separate profile 2 | second separate Zabbix host profile | present | monitored (0) | 10.20.8.22 (type 2) | Discovered hosts (5) | Generic by SNMP (10563) | {$CMDB_CLASS}=C2MTestCI<br>{$CMDB_ID}=218141<br>{$C2M_DEMO_CODE}=C2M-DEMO-008-SEPARATE-PROFILES | alias=C2M-DEMO-008-SEPARATE-PROFILES<br>asset_tag=218141 | connect=1<br>accept=1 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=218141<br>cmdb.event=create<br>cmdb.hostProfile=separate-profile-2 |
| cmdb-c2mtestci-c2m-demo-010-business-hours | cmdb-c2mtestci-c2m-demo-010-business-hours | C2MTestCI C2M-DEMO-010-BUSINESS-HOURS | business-hours policy tag | present | monitored (0) | 10.20.10.10 (type 1) | Linux servers (2) | Linux by Zabbix agent (10001)<br>ICMP Ping (10564) | {$CMDB_CLASS}=C2MTestCI<br>{$CMDB_ID}=218155<br>{$C2M_DEMO_CODE}=C2M-DEMO-010-BUSINESS-HOURS | alias=C2M-DEMO-010-BUSINESS-HOURS<br>asset_tag=218155 | connect=1<br>accept=1 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=218155<br>cmdb.event=create<br>cmdb.hostProfile=main<br>monitoring.policy=business_hours_08_18 |
| cmdb-c2mtestci-c2m-demo-011-domain-leaf-dont-monitor |  |  | domain leaf do_not_monitor does not become interface | missing |  |  |  |  |  |  |  |  |
| cmdb-c2mtestci-c2m-demo-012-disabled-status | cmdb-c2mtestci-c2m-demo-012-disabled-status | C2MTestCI C2M-DEMO-012-DISABLED-STATUS | host status assignment from conversion rules | present | disabled (1) | 10.20.12.10 (type 1) | Linux servers (2) | Linux by Zabbix agent (10001)<br>ICMP Ping (10564) | {$CMDB_CLASS}=C2MTestCI<br>{$CMDB_ID}=218186<br>{$C2M_DEMO_CODE}=C2M-DEMO-012-DISABLED-STATUS | alias=C2M-DEMO-012-DISABLED-STATUS<br>asset_tag=218186 | connect=1<br>accept=1 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=218186<br>cmdb.event=create<br>cmdb.hostProfile=main |

## Suppressed Hosts

| Host | Scenario | Status |
| --- | --- | --- |
| cmdb-c2mtestci-c2m-demo-009-dont-monitor-instance | suppressed by monitoringPolicy=do_not_monitor | absent |

## Checks

| Check | Result | Details |
| --- | --- | --- |
| all expected hosts: Zabbix host name | OK | 13 host name assignment(s) |
| all expected hosts: Zabbix visible name | OK | 13 visible name assignment(s) |
| C2M-DEMO-007-MULTI-IP-SAME-HOST: expected interfaces | OK | 10.20.7.10, 10.20.7.11, 10.20.7.12 |
| C2M-DEMO-007-MULTI-IP-SAME-HOST/main: interface 10.20.7.11 type | OK | type=2 |
| C2M-DEMO-001-SCALAR/main: group Linux servers | OK | Linux servers (2) |
| C2M-DEMO-008-SEPARATE-PROFILES/separate-profile-1: group Discovered hosts | OK | Discovered hosts (5) |
| C2M-DEMO-001-SCALAR/main: template Linux by Zabbix agent | OK | Linux by Zabbix agent (10001) |
| C2M-DEMO-008-SEPARATE-PROFILES/separate-profile-1: template Generic by SNMP | OK | Generic by SNMP (10563) |
| C2M-DEMO-010-BUSINESS-HOURS: tag monitoring.policy | OK | business_hours_08_18 |
| C2M-DEMO-004-DEEP-REFERENCE: tag cmdb.deepReference.lookup | OK | production |
| C2M-DEMO-001-SCALAR/main: macro {$CMDB_CLASS} | OK | C2MTestCI |
| C2M-DEMO-001-SCALAR/main: macro {$C2M_DEMO_CODE} | OK | C2M-DEMO-001-SCALAR |
| C2M-DEMO-001-SCALAR/main: inventory alias | OK | C2M-DEMO-001-SCALAR |
| C2M-DEMO-001-SCALAR/main: inventory asset_tag matches cmdb.id | OK | 218048 |
| C2M-DEMO-001-SCALAR/main: Zabbix status 0 | OK | monitored (0) |
| C2M-DEMO-012-DISABLED-STATUS/main: Zabbix status 1 | OK | disabled (1) |
| C2M-DEMO-004-DEEP-REFERENCE/main: TLS/PSK mode | OK | connect=2, accept=2; identity is not returned by host.get |
| C2M-DEMO-011-DOMAIN-LEAF-DONT-MONITOR: excluded domain leaf interface | OK | 10.20.11.10 is absent |
