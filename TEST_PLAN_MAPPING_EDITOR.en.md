# Conversion Rules Editor Test Plan

## Goal

Verify that the `Conversion Rules Management` UI can create the full supported set of rules for an arbitrary CMDBuild model, and that invalid CMDBuild source field to Zabbix target combinations are blocked before rules are saved.

Generic examples in this document use abstract names:

- `Class` is a CMDBuild class name, not a card instance.
- `Instance` is a concrete card of a class and arrives in the webhook as `id`.
- `ScalarAttribute` is a regular readable scalar attribute.
- `LookupAttribute` is a lookup attribute.
- `ReferenceAttribute` is a reference attribute to another class.
- `RelatedClass` is the class at the other end of a CMDBuild domain.

## Test Result Storage

All live-run and manual scenario results are stored in `reports/`.

The automated coverage development plan is stored separately in `TESTING_DEVELOPMENT_PLAN.en.md`. It records the full additional 80+ scenario set, the first implementation package, the `No Silent Actions` UI regression class, and visual diff checks for `Webhook Setup`.

The main automated E2E runner writes:

```text
reports/cmdbuild-demo-e2e-<timestamp>.md
```

Manual checks that are not built into the runner must be stored next to it as separate markdown files with the same timestamp or a clear scenario prefix, for example:

- `reports/zabbix-update-merge-<timestamp>.md`;
- `reports/webhook-ui-<timestamp>.md`;
- `reports/mapping-editor-ui-<timestamp>.md`.

## Test CMDBuild Model

The reproducible demo model is built under the abstract `CI` / configuration item class.

Schema commands:

```bash
node scripts/cmdbuild-demo-schema.mjs --dry-run
node scripts/cmdbuild-demo-schema.mjs --apply
```

Default settings:

```bash
CMDBUILD_BASE_URL=http://localhost:8090/cmdbuild/services/rest/v3
CMDBUILD_USERNAME=admin
CMDBUILD_PASSWORD=admin
C2M_DEMO_PREFIX=C2MTest
```

Created classes:

| Class | Parent | Purpose |
| --- | --- | --- |
| `C2MTestCI` | `CI` | Main test configuration item |
| `C2MTestAddress` | `CI` | Related address or endpoint |
| `C2MTestReferenceLevel1` | `CI` | First reference-chain level |
| `C2MTestReferenceLevel2` | `CI` | Second reference-chain level |

Created lookup types:

| Lookup type | Purpose |
| --- | --- |
| `C2MTestLifecycleState` | production/test/retired/do_not_monitor |
| `C2MTestMonitoringPolicy` | monitor_always/monitor_business_hours/do_not_monitor |
| `C2MTestAddressRole` | primary/extra_interface/separate_profile/backup |
| `C2MTestAddressState` | active/standby/do_not_monitor |

Created relations:

| Relation | Purpose |
| --- | --- |
| `C2MTestCIAddressDomain` | N:N domain for `Class.{domain:RelatedClass}.Attribute` |
| `C2MTestAddressReferenceDomain` | Reference from the main CI to an address |
| `C2MTestReferenceLevel1Domain` | First reference hop |
| `C2MTestReferenceLevel2Domain` | Second reference hop |

## Source Path Matrix

| Scenario | Abstract path | Expected UI behavior |
| --- | --- | --- |
| Scalar | `Class.ScalarAttribute` | Field can be used to create rules |
| Lookup | `Class.LookupAttribute` | Field is available and lookup metadata is stored |
| Reference -> scalar | `Class.ReferenceAttribute.ScalarAttribute` | UI expands the target class reference |
| Reference -> lookup | `Class.ReferenceAttribute.LookupAttribute` | UI stores `cmdbPath` and lookup leaf metadata |
| Reference -> reference -> scalar | `Class.ReferenceAttribute1.ReferenceAttribute2.ScalarAttribute` | UI supports deep iteration |
| Reference -> reference -> lookup | `Class.ReferenceAttribute1.ReferenceAttribute2.LookupAttribute` | UI supports deep iteration and lookup leaf metadata |
| Domain -> scalar | `Class.{domain:RelatedClass}.ScalarAttribute` | UI creates a domain path |
| Domain -> lookup | `Class.{domain:RelatedClass}.LookupAttribute` | UI creates a domain path with lookup leaf metadata |
| Domain -> reference -> scalar | `Class.{domain:RelatedClass}.ReferenceAttribute.ScalarAttribute` | UI expands the reference after the domain hop |
| Domain -> reference -> lookup | `Class.{domain:RelatedClass}.ReferenceAttribute.LookupAttribute` | UI expands the reference after the domain hop and stores lookup leaf metadata |

## Zabbix Target Matrix

Regular scalar/reference/lookup fields can be used in scalar and selection targets.

A domain path can return multiple values. The UI must:

- allow it for selection/list-like rules where the value is used as a selection condition;
- block it for scalar Zabbix structures;
- allow a scalar target only when the field already exists in rules with `resolve.collectionMode=first`.

Scalar targets that must block a multi-value domain field:

- `interfaceAddress`;
- `interface`;
- `proxies`;
- `proxyGroups`;
- `hostMacros`;
- `inventoryFields`;
- `interfaceProfiles`;
- `hostStatuses`;
- `tlsPskModes`;
- `valueMaps`.

For `interfaceAddress`, semantic mode is also checked: an IP-looking field is valid only for the IP target `interfaces[].ip/useip=1`, and a DNS/FQDN-looking field is valid only for the DNS target `interfaces[].dns/useip=0`. Negative test: choose an IP attribute of a class as the DNS target; the form must mark the field and target red, explain the reason, and block rule saving.

The live E2E runner also verifies that Zabbix hosts received assignments from CMDBuild/rules:

- technical host name `host`;
- visible name `name`;
- `interfaces[]`;
- `groups[]`;
- `templates[]`;
- `tags[]`;
- `macros[]`;
- `inventory`;
- `status`;
- TLS/PSK mode.

Separate update scenarios must verify preservation of external Zabbix assignments and the explicit difference between `interfaces[]` and merge fields. They are described below in `Zabbix Host Update Scenarios`.

Zabbix `host.get` does not return the PSK secret and may omit PSK identity in the dev environment, so the live assertion checks applied TLS mode fields (`tls_connect`, `tls_accept`); PSK identity remains a request payload/rules check.

`proxy`/`proxy group` require pre-created Zabbix proxy objects. `maintenance` and `value maps` require separate Zabbix API operations or dedicated catalog setup. They are not part of the current automated host-create runner and are checked through separate manual or future dedicated E2E scenarios.

## Demo Instances

Command order for creating test objects in CMDBuild:

```bash
node scripts/cmdbuild-demo-schema.mjs --apply
node scripts/cmdbuild-demo-instances.mjs --apply
```

The first script creates classes, lookup types, attributes, and domains. The second creates or updates cards with `C2M-DEMO-*` codes. The scripts are idempotent.

Preview without writing:

```bash
node scripts/cmdbuild-demo-schema.mjs --dry-run
node scripts/cmdbuild-demo-instances.mjs --dry-run
```

| Code | What the instance verifies |
| --- | --- |
| `C2M-DEMO-001-SCALAR` | Scalar attribute: `Class.ScalarAttribute` |
| `C2M-DEMO-002-LOOKUP` | Lookup attribute: `Class.LookupAttribute` |
| `C2M-DEMO-003-REFERENCE-LEAF` | Reference -> scalar: `Class.ReferenceAttribute.ScalarAttribute` |
| `C2M-DEMO-004-DEEP-REFERENCE` | Reference -> reference -> scalar/lookup |
| `C2M-DEMO-005-DOMAIN-SINGLE` | Domain -> scalar with one related object |
| `C2M-DEMO-006-DOMAIN-MULTI` | Domain -> collection with two related objects |
| `C2M-DEMO-007-MULTI-IP-SAME-HOST` | Multiple IP addresses as several `interfaces[]` of one Zabbix host |
| `C2M-DEMO-008-SEPARATE-PROFILES` | Multiple IP addresses as separate host profiles and separate Zabbix hosts |
| `C2M-DEMO-009-DONT-MONITOR-INSTANCE` | Instance must not be put on monitoring |
| `C2M-DEMO-010-BUSINESS-HOURS` | Test environment: monitor only from 08:00 to 18:00 |
| `C2M-DEMO-011-DOMAIN-LEAF-DONT-MONITOR` | Related address exists, but its leaf is marked `do_not_monitor` |
| `C2M-DEMO-012-DISABLED-STATUS` | Zabbix host is created but receives `status=1` through a rule |
| `C2M-DEMO-013-DNS-ONLY` | PrimaryIp is empty, so the object is put on monitoring by DNS hostname through `interfaces[].dns/useip=0` |

## E2E Run

After schema and instances are created, run the full demo through local `cmdbwebhooks2kafka`, `cmdbkafka2zabbix`, `zabbixrequests2api`, Kafka, and Zabbix:

```bash
node scripts/cmdbuild-demo-e2e.mjs --dry-run
node scripts/cmdbuild-demo-e2e.mjs --apply
```

Add `--cleanup-zabbix` to delete old demo hosts `cmdb-c2mtestci-*` before the run. It is not needed when cleanup is done manually.

The runner:

- reloads conversion rules through `POST /admin/reload-rules`;
- deletes old demo hosts when `--cleanup-zabbix` is set;
- sends `create` events to `POST /webhooks/cmdbuild`;
- waits for Zabbix hosts;
- reads assigned `host`, `name`, `interfaces`, `groups`, `parentTemplates`, `tags`, `macros`, `inventory`, `status`, and TLS mode from Zabbix;
- writes `reports/cmdbuild-demo-e2e-*.md`.

Expected Zabbix hosts:

- 12 main hosts for `C2M-DEMO-001`, `002`, `003`, `004`, `005`, `006`, `007`, `008`, `010`, `011`, `012`, `013`;
- 2 separate hosts for `C2M-DEMO-008-SEPARATE-PROFILES`: `separate-profile-1` and `separate-profile-2`;
- no host for `C2M-DEMO-009-DONT-MONITOR-INSTANCE`.

Run one scenario with `--code`, for example:

```bash
node scripts/cmdbuild-demo-e2e.mjs --apply --cleanup-zabbix --code C2M-DEMO-013-DNS-ONLY
```

For `C2M-DEMO-013-DNS-ONLY`, expect Zabbix host `cmdb-c2mtestci-c2m-demo-013-dns-only` with interface `dns=demo-dns-only.example.test`, `useip=0`.

## Zabbix Host Update Scenarios

These scenarios verify the latest `zabbixrequests2api` behavior: some `host.update` fields must be merged with the current Zabbix host state, while `interfaces[]` remain authoritative from rules.

Store results in `reports/zabbix-update-merge-<timestamp>.md`. If the scenarios run as part of the common E2E runner, add the corresponding section to `reports/cmdbuild-demo-e2e-<timestamp>.md`.

Preconditions:

- a Zabbix host exists from demo rules, for example the main host for `C2M-DEMO-001-SCALAR`;
- the host has rule-managed values: at least one group, template, tag, macro, and inventory field;
- before update, the test can add external values directly in Zabbix: an extra host group, linked template, tag, macro, and inventory field that are absent from rules.

Scenario `UPDATE-MERGE-001`: preserve external assignments.

1. Add external values to the Zabbix host: group, template, tag, macro, and inventory field.
2. Update the CMDBuild card so `cmdbkafka2zabbix` renders `host.get -> host.update`.
3. Verify that `zabbixrequests2api` reads the current host through `host.get` before update.
4. Verify the final Zabbix host: rule values are present and external values remain.
5. Matching keys must be overridden by rules: group by `groupid`, template by `templateid`, tag by `tag`, macro by `macro`, inventory by field name.

Scenario `UPDATE-MERGE-002`: `templates_clear` removes only actually linked conflicting templates.

1. Prepare a host with a template that must be removed by `templates_clear`.
2. Run an update that selects the conflicting target template and renders `templates_clear`.
3. Verify that Zabbix removes only the template that is actually linked to the host and appears in `templates_clear`.
4. Verify that unrelated templates added manually and absent from `templates_clear` remain linked.

Scenario `UPDATE-MERGE-003`: direct `host.update` with `hostid` and merge fields.

1. Send direct JSON-RPC `host.update` with `hostid`, `groups[]`, `templates[]`, `tags[]`, `macros[]`, or `inventory` to `zabbix.host.requests.dev`.
2. Verify that the service performs an internal `host.get` by `hostids` before the actual update.
3. Verify that the final update preserves external values the same way as fallback `host.get -> host.update`.
4. Verify that `host.get` with `hostids` passes validation.

Scenario `UPDATE-BINDING-001`: update/delete use hostid from CMDBuild binding data.

1. Create a host through the normal create flow and verify that `zabbixbindings2cmdbuild` wrote `zabbix_main_hostid` for the main profile or a `ZabbixHostBinding` card for an additional profile.
2. Change the CMDBuild card so the technical host name could change or fallback by name would be undesirable.
3. Run update and verify that `cmdbkafka2zabbix` rendered direct `host.update` with `hostid`, not fallback `host.get`.
4. Run delete and verify that `cmdbkafka2zabbix` rendered direct `host.delete` with the same `hostid`, while the binding event cleared `zabbix_main_hostid` or marked `ZabbixHostBinding` as `deleted`.

Scenario `AUDIT-QUICK-001`: quick audit detects main discrepancies without fixing them.

1. Prepare CMDBuild cards with a main profile and an additional `hostProfile`; verify that rules contain expected host groups/templates/maintenance/status.
2. In `Audit`, select root `Class` or a concrete participating class, enable child classes and the rules-only filter, then run `Quick audit`.
3. Verify that the report shows OK for cards where binding, host name, interface address, host groups, templates, maintenance, and status match.
4. Set `Cards offset` to the first batch size or click `Next batch`, and verify that the next run reads the next card batch for the selected classes.
5. Manually remove or change one host group/template/maintenance/address in Zabbix and run quick audit again.
6. Verify that the report shows an error only for the affected object/profile and does not offer an auto-fix.

Scenario `UPDATE-MERGE-004`: `interfaces[]` are not a merge field.

1. Add an external interface to the Zabbix host that is absent from rules.
2. Update the CMDBuild card.
3. Verify that the final `interfaces[]` list matches rules, not a union of current and desired interfaces.
4. Verify that the writer carries over `interfaceid` values for existing interfaces so IP/DNS changes update the current interface instead of creating a duplicate host.

Scenario `UPDATE-MERGE-005`: primary interface IP change.

1. Create a host with the original `PrimaryIp`.
2. Change `PrimaryIp` on the CMDBuild card.
3. Send an update event.
4. Verify that the host is found by technical host name, not by IP.
5. Verify that the first existing `interfaceid` is used for update and the Zabbix host is not duplicated.

## Webhook UI Verification

Goal: confirm that `Webhook Setup` creates and changes only the CMDBuild webhook records that actually follow from the current rules, and that events start arriving after the plan is applied.

Initial cleanup:

- delete all managed CMDBuild webhooks with prefix `cmdbwebhooks2kafka-*`;
- delete or reset the test rules/objects that will be recreated in the scenario;
- leave unmanaged webhooks without this prefix untouched;
- after cleanup, open `Webhook Setup`, click `Load from CMDB`, and verify that managed records are absent or do not participate in the plan.

Create webhooks through the UI:

1. Prepare rules through `Conversion Rules Management` or load the rules file under test.
2. Open `Webhook Setup`.
3. Click `Load from CMDB`.
4. Click `Analyze rules`.
5. Verify that classes from current rules get `Create` operations for the required `create/update/delete` events.
6. Verify that `Update` operations are absent for classes that were not changed, and unmanaged webhooks are not proposed for update or deletion.
7. Verify the `Webhook requirements from rules` summary: class and payload-field counts must follow rules, not all CMDBuild catalog attributes.
8. Expand payload and `Details` for several rows: body must remain flat and must not contain duplicate keys with another case or alias; details must show `webhook requirements from rules` and, when payload is incomplete, `missing payload requirements` with rule names.
9. Click `Load into CMDB` and confirm apply.
10. Click `Load from CMDB` and `Analyze rules` again.
11. Expected result: the plan is empty or contains only deliberate changes for the current scenario; records just created must not be proposed again as `Update`.

Verify data arrival:

1. Create or update a test card of the verified class through CMDBuild UI or demo script.
2. In `Events`, verify that a message appears in `cmdbuild.webhooks.dev`.
3. Verify that the envelope contains `className`, `eventType`, `id/code`, and configured source keys.
4. Verify the downstream flow: `zabbix.host.requests.dev` receives a request and `zabbix.host.responses.dev` receives a Zabbix API response.
5. For delete events, verify that the event also arrives, and suppression rules for "do not monitor" do not block removal from monitoring.

Regression: new class added:

1. Start from a state where webhooks are synchronized and repeated analysis returns an empty plan.
2. Through `Conversion Rules Management`, add a new class `NewClass` and the minimal source fields/rules only for that class.
3. Open `Webhook Setup`, run `Load from CMDB` and `Analyze rules`.
4. Expected result: the plan contains `Create` only for `NewClass` and required events.
5. Existing classes must not get `Update`, either fully or partially: body, event, target, method, url, headers, active, and language must have no diff.
6. Payloads for existing classes must not receive fields that belong to `NewClass`, for example `NewAttribute` or reference/domain leaf fields of another class.

Regression: attribute added to an existing class:

1. Start from a state where webhooks are synchronized and repeated analysis returns an empty plan.
2. In CMDBuild, add or select `NewAttribute` only on `ClassA`.
3. Through `Conversion Rules Management`, add a source field and rule using `ClassA.NewAttribute`.
4. Open `Webhook Setup`, run `Load from CMDB` and `Analyze rules`.
5. Expected result: `Update` appears only for webhook records of `ClassA`, and only in the body/payload part where the source key for `NewAttribute` is added.
6. For every other class the plan is empty: there must be no `NewAttribute`, lookup/reference/domain path, or any unrelated source field added.
7. After `Load into CMDB`, create or update a `ClassA` card and verify that the new source key arrives in `cmdbuild.webhooks.dev`.
8. Create or update a card of another class and verify that the new source key is absent from that webhook payload.

Regression: leaf through reference/domain:

1. Add a source field `ClassA.ReferenceAttribute.LeafAttribute` to rules and add a rule that really uses that field.
2. Run `Load from CMDB` and `Analyze rules`.
3. Expected result for a reference/lookup path: payload adds only that field source key with value `{card:ReferenceAttribute}`; the final leaf is not added as a separate webhook placeholder.
4. Add a source field `ClassA.{domain:ClassB}.LeafAttribute` to rules and add a rule that uses it.
5. Expected result for a domain path: payload adds that field source key with value `{card:Id}`, while `cmdbPath` remains metadata for the converter.
6. In `Logical Control of Conversion Rules`, when CMDBuild webhooks are already loaded, warnings must appear if a managed webhook is missing or does not send payload fields required by rules.

## Attribute-Based Do Not Monitor Scenario

This scenario checks an intentional rule decision, not missing data: the CMDBuild instance is read correctly, but its attribute values say monitoring must not be created.

Test instance:

- `C2M-DEMO-009-DONT-MONITOR-INSTANCE`;
- `MonitoringPolicy = do_not_monitor`;
- `LifecycleState = do_not_monitor`;
- `PrimaryIp` is populated with a valid IP so the skip cannot be confused with `missing_interface_address`.

Expected behavior:

- UI allows source fields for `Class.MonitoringPolicyAttribute` and `Class.LifecycleStateAttribute`;
- rules store them as condition fields; when webhook carries lookup id, `cmdbPath/resolve` metadata must exist so the converter obtains code `do_not_monitor`;
- `monitoringSuppressionRules` fires on `create/update`;
- `cmdbkafka2zabbix` returns skip reason `monitoring_suppressed:object-policy-do-not-monitor:object_policy_do_not_monitor`;
- no message is published to the Zabbix requests topic;
- no Zabbix host appears for this instance;
- `delete` is not suppressed, so a previously created host can be removed from monitoring.

Separate leaf scenario:

- `C2M-DEMO-011-DOMAIN-LEAF-DONT-MONITOR`;
- the main CI is allowed for monitoring, so this is not a whole-object "do not monitor" scenario;
- the related object through domain has `AddressState = do_not_monitor`;
- rules use this leaf as a selection point: the address does not become a separate profile/interface, while the CI can still be processed through other allowed addresses;
- this leaf flag must not "stop object monitoring": the Zabbix host must exist, and the interface for the related address must be absent.

Separate status scenario:

- `C2M-DEMO-012-DISABLED-STATUS`;
- the main CI is allowed for monitoring, so suppression must not fire;
- `hostStatusSelectionRules` passes `status=1` to Zabbix;
- the report shows the host exists and its Zabbix status is `disabled (1)`.

## UI Verification

1. Run schema script with `--apply`.
2. Run instances script with `--apply`.
3. In `monitoring-ui-api`, run `CMDBuild Catalog -> Sync`.
4. Open `Conversion Rules Management`.
5. Enable edit mode and verify that the lower three-column CMDBuild -> rules -> Zabbix preview is hidden.
6. Verify the class menu: hierarchy is shown with indentation, superclass/prototype classes are not selectable, and opening a rule that points to a superclass moves the form to the nearest concrete subclass.
7. Select `C2MTestCI`.
8. Verify paths:
   - `C2MTestCI.PrimaryIp`;
   - `C2MTestCI.LifecycleState`;
   - `C2MTestCI.AddressRef.AddressValue`;
   - `C2MTestCI.Reference1.Reference2.LeafIp`;
   - `C2MTestCI.{domain:C2MTestAddress}.AddressValue`.
9. Create a rule for each path in an appropriate Zabbix target.
10. Choose `Modify rule` and verify that the first rule in the list is not selected automatically.
11. Start modification from a CMDBuild class instead of a rule; verify that rule/field/conversion structure/Zabbix target lists narrow to linked values, and a single matching rule is selected automatically.
12. Repeat modification start from a class attribute field and from a conversion structure: linked lists must narrow, while ambiguous choices remain available for manual selection.
13. Open one of the created or demo rules, change target/priority/regex/name, save it, and verify the draft JSON change.
14. Verify `Reset fields`: after manual edits in modify mode it must clear the selected rule, class, field, conversion structure, and target; in add mode it must clear the leaf field and Zabbix target.
15. Verify cascade behavior: changing class clears leaf field and target, changing field filters conversion structures, and changing conversion structure filters fields/targets.
16. Verify form states: green borders for compatible values, red for required/conflicting values, yellow for rule values not confirmed by the current catalog/filter; `Save changes` is enabled only in a valid state.
17. Verify `Undo`: the latest rule change must be fully reverted in draft JSON, including target/priority/regex/name and movement between rule collections when the conversion structure changed.
18. Verify `Redo`: the reverted change must be fully restored, and the rule list and selected rule must match the state after modification.
19. Verify draft JSON: `source.fields[].cmdbPath`, `resolve.mode`, lookup metadata, and `collectionMode`.
20. Verify negative scenarios: a domain multi-value field must not be available for scalar targets.
21. Create or verify `monitoringSuppressionRules` for `MonitoringPolicy=do_not_monitor`.
22. Verify the interface-address negative scenario: an unconfirmed address field must not be saved as an IP/DNS interface until it has an explicit IP/DNS name/source metadata or `validationRegex`.
23. Add a rule for a new concrete CMDBuild class from the current catalog that has no `hostProfiles[]` entry yet: choose an IP or DNS leaf, save the rule, and verify that draft JSON receives `source.entityClasses`, `source.fields`, the selection rule, and a minimal `hostProfiles[]` with a `className` condition.
24. Add a `Template rule` with the virtual `hostProfile` field, a regex matching the fan-out profile name, and a selected template; verify that the rule condition uses `hostProfile` and `source.fields.hostProfile` is not added to draft JSON.
25. For an additional profile, select it in the `Monitoring profiles` block, add a `Template rule` whose primary condition uses a normal class attribute field such as `description` with regex `(?i).*`, enable `Limit rule to selected hostProfile`, and save. Verify that the profile `Assignments` counter increases and the rule contains both `description` and `hostProfile` conditions.
26. Remove or temporarily disable that `hostProfiles[]` only in draft JSON and run Logical Control of Conversion Rules: the class must be highlighted as a rules error with the `Create host profile` action, and applying it must restore the profile through the shared undo/redo flow.
27. Run Logical Control of Conversion Rules.
28. Run `Save file as` and verify that webhook body remains flat while path metadata is stored next to the source key.

## Automated Binding-Loop Regressions

The `tests/zabbixbindings` package checks the new `Zabbix hostid -> CMDBuild -> next update/delete` loop without live Kafka, CMDBuild, or Zabbix:

- `ZabbixBindingEventReader` parses create/update/delete events, applies defaults, and rejects messages without required fields;
- `zabbixbindings2cmdbuild` writes or clears `zabbix_main_hostid` for the main profile;
- `zabbixbindings2cmdbuild` creates or updates `ZabbixHostBinding` cards for additional `hostProfiles[]` by `OwnerClass + OwnerCardId + HostProfile`;
- the `cmdbkafka2zabbix` resolver reads `zabbix_main_hostid` and active `ZabbixHostBinding`, ignores `BindingStatus=deleted`, and returns `null` on CMDBuild errors so the converter can continue to fallback `host.get`;
- `zabbixrequests2api` contract tests verify `hostid` extraction from successful create/update results and the binding publisher payload/header contract;
- the full local run goes through `./scripts/test-configs.sh`, where `tests/zabbixbindings` runs after `tests/cmdbresolver`.

## Acceptance Criteria

The feature is accepted when every matrix row passes:

```text
CMDBuild catalog -> Mapping editor option -> Add/Modify rule -> draft JSON -> validation -> webhook metadata -> converter dry-run/e2e
```

The following prohibitions must also be confirmed:

- multi-value domain field cannot be linked to a scalar Zabbix target;
- unrelated domain is not shown for the selected class;
- superclass/prototype class cannot be selected as the rule class;
- the first rule is not selected automatically when entering `Modify rule`;
- modification can start from a rule, CMDBuild class, class attribute field, or conversion structure; linked lists are filtered, and a single matching rule is selected automatically;
- a new concrete CMDBuild class must not remain only in `source.entityClasses`: a matching `hostProfiles[]` is created or clearly diagnosed, otherwise the converter would skip the event with `no_host_profile_matched`;
- the webhook plan is empty after synchronization, and adding a new class or attribute changes only the corresponding managed webhooks;
- webhook payloads for existing classes do not receive source keys of the new class or attribute;
- CMDBuild events arrive in `cmdbuild.webhooks.dev` after webhooks are applied and continue to Zabbix request/response topics;
- Zabbix host update preserves external `groups[]`, `templates[]`, `tags[]`, `macros[]`, and `inventory` unless rules explicitly replace them;
- `templates_clear` removes only actually linked templates marked as conflicting;
- direct `host.update` with `hostid` and merge fields goes through an internal `host.get` by `hostids`;
- `interfaces[]` remain authoritative from rules and are not merged with external interfaces;
- modification save is unavailable until an unambiguous leaf/source field and compatible Zabbix target are selected;
- a target missing from Zabbix catalog/options is red and blocks saving as an inconsistent second side of the chain;
- `Reset fields` clears the selected rule and filters without side effects in draft JSON;
- `Undo` and `Redo` correctly revert and restore rule add, modify, and delete actions without losing draft JSON;
- reference path does not expand forever on cycles;
- path deeper than the configured limit is not offered;
- instances and related leaf objects with policy/state `do_not_monitor` are used as rule selection points, not as mandatory monitoring objects.
