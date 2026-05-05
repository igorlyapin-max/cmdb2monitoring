# Rule Developer Guide

This guide describes how to design and maintain conversion rules: from CMDBuild leaf-field selection to Zabbix host profiles, templates, groups, tags, suppression, and webhooks.

## Core Principles

- The rules file is not tied to concrete class or attribute names. Use neutral examples such as `CIClass`, `PrimaryIpAttribute`, `ReferenceAttribute`, `RelatedClass`, `LeafAttribute`.
- Webhook body remains flat. For lookup/reference/domain values, the webhook usually sends an id, while the path to the real leaf value is stored in rules as `cmdbPath`.
- Every new rule field must have a source in the CMDBuild webhook or resolver path.
- Create an applicable `hostProfile` first, then assign templates/groups/tags/inventory/macros.
- An additional profile is a separate Zabbix host when it needs its own name, templates, groups, or lifecycle.
- Use several interfaces inside one Zabbix host only when they describe one monitoring object.
- Rules must not create profiles implicitly: profiles are managed in the separate `Host profiles` block.

## Before Starting

1. Log in with the `editor` or `admin` role.
2. Sync CMDBuild catalog.
3. Sync Zabbix catalog.
4. Sync `Zabbix Metadata`.
5. Check that Runtime settings for dynamic leaf behavior match the task:
   - `Allow dynamic Zabbix Tags expansion from a CMDBuild leaf`;
   - `Allow dynamic Zabbix Host groups creation from a CMDBuild leaf`.
6. For host groups, ask the administrator whether `Zabbix:AllowDynamicHostGroupCreate` is enabled in `zabbixrequests2api`.
7. If a new CMDBuild class/attribute/domain is created, ask the administrator to resync catalog and check webhooks.

## Source Fields And Leaf Paths

Typical path forms:

| Scenario | Example path |
| --- | --- |
| Source-card attribute | `CIClass.PrimaryIpAttribute` |
| Lookup leaf | `CIClass.LookupAttribute` |
| Reference leaf | `CIClass.ReferenceAttribute.LeafAttribute` |
| Multi-level reference | `CIClass.ReferenceAttribute1.ReferenceAttribute2.LeafAttribute` |
| Domain leaf | `CIClass.{domain:RelatedClass}.LeafAttribute` |
| Domain + reference leaf | `CIClass.{domain:RelatedClass}.ReferenceAttribute.LeafAttribute` |

Selection rules:
- select the leaf, not the intermediate reference object;
- for lookup, check whether id, code, or display value is required;
- for domain, verify that the domain really connects the current class with `RelatedClass`;
- if a domain can return several related cards, do not use that path for a scalar Zabbix field;
- reference/domain leaf values update monitoring only when a source-card event occurs, unless a separate process initiates the source-object update.

## Creating The Main Host Profile

Use the `Host profiles` block in `Conversion Rules Management`.

1. Select a concrete CMDBuild class, not a superclass.
2. Select profile type `Main`.
3. Select the IP or DNS leaf.
4. Select address mode:
   - IP target for IP address;
   - DNS target for DNS/FQDN;
   - do not save an IP-looking field into a DNS target or a DNS-looking field into an IP target.
5. Select the Zabbix `interfaces[]` profile.
6. Save the profile.

If a class participates in rules but has no applicable profile, the converter accepts the event and skips it with `no_host_profile_matched`.

## Creating An Additional Host Profile

Use an additional profile when an address or endpoint must become a separate Zabbix host.

1. In `Host profiles`, select the class.
2. Select profile type `Additional`.
3. Set a clear profile name based on endpoint role, not a temporary attribute name.
4. Select the IP/DNS leaf for the additional host.
5. Select the Zabbix interface profile.
6. Enable `createOnUpdateWhenMissing` if update should create a missing additional host.
7. Save the profile.

Then assign templates/groups/tags to this profile:
1. Select the created profile in `Host profiles`.
2. Create a `Template rule`, `Host group rule`, or `Tag rule`.
3. Enable selected `hostProfile` scope or use the virtual field `hostProfile`/`outputProfile`.
4. Select a condition leaf, for example `CIClass.EndpointRoleAttribute` or `CIClass.{domain:RelatedClass}.TypeAttribute`.
5. Select the Zabbix target and save the rule.

The profile assignment counter counts only rules with explicit `hostProfile` scope. If the counter does not change, check that the rule is actually scoped to the desired profile.

## Assigning Host Groups, Templates, And Tags

Host groups:
- select an existing Zabbix host group from catalog;
- or use a dynamic target from CMDBuild leaf when the Runtime switch is enabled;
- for dynamic host groups, the writer creates the missing group and immediately links the current host to it when `Zabbix:AllowDynamicHostGroupCreate=true`.

Templates:
- select a template from Zabbix catalog;
- check conflict highlighting from `Zabbix Metadata` before saving;
- do not use tags as a way to select templates inside template rules. Use the same CMDBuild field as a template-rule condition.

Tags:
- tag/value is sent to the Zabbix host payload and does not require a separate Zabbix catalog object;
- allow dynamic tag from leaf only when value variety is controlled.

Inventory/macros/extended fields:
- use only leaves with predictable type and format;
- for inventory, make sure the payload does not disable inventory mode;
- if a field can be edited manually in Zabbix, agree who owns the value: rules or the Zabbix operator.

## Dynamic Expansion From CMDBuild Leaf

Dynamic target is allowed only for:
- `Tag rule`;
- `Host group rule`.

When the UI switch is enabled, the editor shows the target `Create/expand from selected CMDBuild leaf`. Empty target for templates, interfaces, inventory, and macros remains an error.

Before enabling dynamic leaf:
1. Export or inspect unique CMDBuild attribute values.
2. Check spelling and case.
3. Prefer lookup over free text when possible.
4. Restrict the rule with regex when the field can contain service or temporary values.
5. For host groups, confirm `hostgroup.create` permission with the administrator.

Risk: if CMDBuild users start entering free text, Zabbix receives the same amount of new tags or host groups.

## Monitoring Suppression

Use `monitoringSuppressionRules` when source-card attributes mean "do not monitor this object".

Example:
- `CIClass.MonitoringPolicyAttribute = do_not_monitor`;
- create/update are skipped with `monitoring_suppressed:*`;
- delete is not suppressed because delete can mean "stop monitoring the object".

Important: `do_not_monitor` on a related domain/leaf card is not the same as "stop monitoring the object". It means "do not use this related endpoint". The source card can still be monitored through other addresses.

## Update And Concurrent Edits

During update/delete, host lookup order is:
1. explicit `zabbix_hostid` from webhook/source fields;
2. `zabbix_main_hostid` for the main profile or `ZabbixHostBinding` for an additional profile;
3. fallback `host.get` by technical host name.

Merge rules:
- `groups[]`, `templates[]`, `tags[]`, `macros[]`, and `inventory` are merged with current Zabbix host state;
- external values not present in rules payload are preserved;
- matching values from rules become rules-owned and are overridden;
- `templates_clear` removes only explicitly listed conflicting templates;
- `interfaces[]` are not merged as catalogs: their set is considered rules-owned.

Human-factor checks:
- if a Zabbix operator manually added a host group, it is preserved;
- if rules add another host group from CMDBuild leaf, it is added next to the existing group;
- if an old group must be removed, an explicit cleanup process or governance change is required;
- if IP/DNS interface changes in CMDBuild, update should change the interface, but the technical host name must remain stable;
- if `hostProfile` is renamed, an existing additional host is not deleted automatically.

## Webhooks For Rule Developers

After adding or changing a source field:
1. Open `Webhook Setup`.
2. `Load from CMDB`.
3. `Analyze rules`.
4. Check that the new field appears only in the required managed webhook.
5. If another class is marked as changed without a reason, return to rules and check source field/class scope.
6. Give the plan to the administrator or apply it if you have permissions.

Remember:
- webhook payload is flat;
- for reference/lookup/domain, the webhook can send only a numeric id;
- the microservice raises the leaf through `cmdbPath` when the resolver is enabled in rules;
- if the webhook field is missing, the rule normally does not fire even when the path exists in catalog.

## Logical Control

Before handing rules to the administrator:
1. Run `Conversion Rules Logical Control`.
2. Fix critical errors.
3. Check missing CMDBuild classes/attributes and Zabbix targets.
4. Check that every monitoring class has an applicable `hostProfiles[]`.
5. Check template conflicts.
6. Check rules created manually outside the UI.

If a rule is partially inconsistent, it can be deleted or edited. Do not delete a related rule only because it is nearby in the tree: check the concrete mismatch reason.

## Common Scenarios

### Main Host By IP

1. Class: `CIClass`.
2. Leaf: `CIClass.PrimaryIpAttribute`.
3. Host profile: `Main`, IP target.
4. Host group: existing group or dynamic leaf.
5. Template: compatible template.
6. Webhook: contains source key for `PrimaryIpAttribute`.

### Main Host By DNS Only

1. Class: `CIClass`.
2. Leaf: `CIClass.DnsNameAttribute`.
3. Host profile: `Main`, DNS target.
4. Technical host name is built from stable card identity, not DNS, if DNS can change.

### Reference Leaf As Interface

1. Source path: `CIClass.ReferenceAttribute.LeafIpAttribute`.
2. Webhook contains id of `ReferenceAttribute`.
3. Rules store `cmdbPath` to `LeafIpAttribute`.
4. Converter reads the reference target and substitutes the leaf on source-card event.

### Domain Leaf As Host Group

1. Source path: `CIClass.{domain:RelatedClass}.GroupAttribute`.
2. UI dynamic host groups switch is enabled.
3. `AllowDynamicHostGroupCreate` is enabled in `zabbixrequests2api`.
4. Rule target: dynamic from leaf.
5. On first value, the writer creates the host group and links the host.

### Additional Profile For Management Endpoint

1. Create an additional `hostProfile` from `CIClass.EndpointIpAttribute`.
2. Set suffix/profile name, for example `management`.
3. Select SNMP or another required interface profile.
4. Create a template rule scoped to `hostProfile=management`.
5. Create host group/tag rules with the same scope.
6. Check that a `ZabbixHostBinding` card appears after successful create.

### "Do Not Monitor"

1. Source field: `CIClass.MonitoringPolicyAttribute`.
2. Rule: `monitoringSuppressionRules`.
3. Regex: values like `do_not_monitor`, `not_monitored`, `false`, `0`.
4. Create/update should skip, delete should pass.

## Checklist Before Saving Rules

- `rulesVersion` is updated and contains date/time.
- Every new source field has a webhook plan.
- Every class has an applicable host profile.
- Additional profiles have explicit assignments through `hostProfile`.
- Dynamic leaf is enabled only for Tags/Host groups and only after value analysis.
- Templates are checked through metadata; conflicts are fixed.
- Domain paths do not write multi-value results into scalar Zabbix fields.
- Reference/domain leaf update is not expected without a source-card event.
- Logical Control shows no critical errors.
- Save-as file and webhook artifact are given to the administrator or published through the agreed process.
