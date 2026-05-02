# CMDBuild Demo E2E Report

Generated: 2026-05-02T16:53:43.086Z
CMDBuild class: C2MTestCI

## Zabbix Assignment Coverage

Checked live on Zabbix hosts: technical host name, visible name, interfaces, host groups, templates, tags, host macros, inventory fields, host status, TLS/PSK mode. Zabbix host.get does not expose the PSK secret and may omit PSK identity, so the live assertion checks the effective TLS mode fields.

Not checked by this host-create demo: proxy/proxy group, maintenance, value maps. They require dedicated Zabbix catalog objects or API operations outside the direct host payload currently applied by this runner.

## Expected Zabbix Hosts

| Expected Host | Zabbix Host Name | Visible Name | Scenario | Presence | Zabbix Status | Interfaces | Groups | Templates | Macros | Inventory | TLS/PSK | Tags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cmdb-c2mtestci-c2m-demo-013-dns-only | cmdb-c2mtestci-c2m-demo-013-dns-only | C2MTestCI C2M-DEMO-013-DNS-ONLY | DNS-only hostname interface | present | monitored (0) | demo-dns-only.example.test (type 1) | Linux servers (2) | Linux by Zabbix agent (10001)<br>ICMP Ping (10564) | {$C2M_DEMO_CODE}=C2M-DEMO-013-DNS-ONLY<br>{$CMDB_CLASS}=C2MTestCI<br>{$CMDB_ID}=218810 | alias=C2M-DEMO-013-DNS-ONLY<br>asset_tag=218810 | connect=1<br>accept=1 | source=cmdbuild<br>cmdb.class=C2MTestCI<br>cmdb.id=218810<br>cmdb.event=create<br>cmdb.hostProfile=main |

## Suppressed Hosts

| Host | Scenario | Status |
| --- | --- | --- |

## Checks

| Check | Result | Details |
| --- | --- | --- |
| all expected hosts: Zabbix host name | OK | 1 host name assignment(s) |
| all expected hosts: Zabbix visible name | OK | 1 visible name assignment(s) |
| C2M-DEMO-013-DNS-ONLY: DNS interface useip=0 | OK | demo-dns-only.example.test, useip=0, type=1 |
