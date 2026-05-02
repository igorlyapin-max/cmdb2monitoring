# CMDBuild Demo E2E Report

Generated: 2026-05-02T05:49:58.391Z
CMDBuild class: C2MTestCI

## Expected Zabbix Hosts

| Host | Scenario | Status | Interfaces | Tags |
| --- | --- | --- | --- | --- |
| cmdb-c2mtestci-c2m-demo-001-scalar | scalar source field | present | 10.20.1.10 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=190499<br>cmdb.event=create |
| cmdb-c2mtestci-c2m-demo-002-lookup | lookup source field and business-hours policy tag | present | 10.20.2.10 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=190506<br>cmdb.event=create<br>monitoring.policy=business_hours_08_18 |
| cmdb-c2mtestci-c2m-demo-003-reference-leaf | reference leaf interface | present | 10.20.3.1<br>10.20.3.10 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=190513<br>cmdb.event=create |
| cmdb-c2mtestci-c2m-demo-004-deep-reference | deep reference leaf and lookup tag | present | 10.20.4.1<br>10.20.4.20 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=190521<br>cmdb.event=create<br>cmdb.deepReference.lookup=production |
| cmdb-c2mtestci-c2m-demo-005-domain-single | single domain relation leaf | present | 10.20.5.1<br>10.20.5.10 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=190536<br>cmdb.event=create |
| cmdb-c2mtestci-c2m-demo-006-domain-multi | domain relation collection with collectionMode=first | present | 10.20.6.1<br>10.20.6.10 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=190755<br>cmdb.event=create |
| cmdb-c2mtestci-c2m-demo-007-multi-ip-same-host | multiple IPs as interfaces[] in one host | present | 10.20.7.10<br>10.20.7.11<br>10.20.7.12 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=190776<br>cmdb.event=create |
| cmdb-c2mtestci-c2m-demo-008-separate-profiles | base host for separate monitoring profiles | present | 10.20.8.10 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=190783<br>cmdb.event=create |
| cmdb-c2mtestci-c2m-demo-008-separate-profiles-separate-profile-1 | first separate Zabbix host profile | present | 10.20.8.21 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=190783<br>cmdb.event=create<br>cmdb.hostProfile=c2m-separate-profile-1 |
| cmdb-c2mtestci-c2m-demo-008-separate-profiles-separate-profile-2 | second separate Zabbix host profile | present | 10.20.8.22 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=190783<br>cmdb.event=create<br>cmdb.hostProfile=c2m-separate-profile-2 |
| cmdb-c2mtestci-c2m-demo-010-business-hours | business-hours policy tag | present | 10.20.10.10 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=190797<br>cmdb.event=create<br>monitoring.policy=business_hours_08_18 |
| cmdb-c2mtestci-c2m-demo-011-domain-leaf-dont-monitor | domain leaf do_not_monitor does not become interface | present | 10.20.11.1 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=190811<br>cmdb.event=create |

## Suppressed Hosts

| Host | Scenario | Status |
| --- | --- | --- |
| cmdb-c2mtestci-c2m-demo-009-dont-monitor-instance | suppressed by monitoringPolicy=do_not_monitor | absent |

## Checks

| Check | Result | Details |
| --- | --- | --- |
| C2M-DEMO-007-MULTI-IP-SAME-HOST: expected interfaces | OK | 10.20.7.10, 10.20.7.11, 10.20.7.12 |
| C2M-DEMO-010-BUSINESS-HOURS: tag monitoring.policy | OK | business_hours_08_18 |
| C2M-DEMO-004-DEEP-REFERENCE: tag cmdb.deepReference.lookup | OK | production |
| C2M-DEMO-011-DOMAIN-LEAF-DONT-MONITOR: excluded domain leaf interface | OK | 10.20.11.10 is absent |
