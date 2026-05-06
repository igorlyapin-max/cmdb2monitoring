# CMDBuild REST API Integration

This document records the current `cmdb2monitoring` contract with CMDBuild. It is not a full CMDBuild REST API reference; it describes the endpoints used by this product and the operational details that matter for this integration.

Verified version: CMDBuild `4.1.0`, REST API v3, base URL:

```text
http://<host>:<port>/cmdbuild/services/rest/v3
```

## Where CMDBuild REST API Is Used

| Component | Purpose |
| --- | --- |
| `monitoring-ui-api` | CMDBuild catalog sync, webhook read/write, audit model preparation, quick audit |
| `cmdbkafka2zabbix` | Lookup/reference/domain leaf resolution by `source.fields[].cmdbPath`, host binding lookup for exact update/delete |
| `zabbixbindings2cmdbuild` | Reverse writes of `zabbix_main_hostid` and `ZabbixHostBinding` cards |
| `scripts/cmdbuild-*.mjs` | Test model, test cards, and relation creation |

The browser never calls CMDBuild directly. REST calls are performed by the BFF or a microservice.

## Authentication

Current operating model:
- `monitoring-ui-api` asks the user for CMDBuild login/password on the first operation that needs CMDBuild API access and stores them only in the server-side session.
- `cmdbkafka2zabbix` and `zabbixbindings2cmdbuild` use a service account from `appsettings*.json`, env, or PAM.
- External UI authentication through MS AD/IdP is not reused as CMDBuild API credentials.
- Production passwords are not stored in git. Use env/secret storage or PAM/AAPM `secret://id`.

HTTP headers:

```text
Accept: application/json
Authorization: Basic <base64(username:password)>
Content-Type: application/json   # only when a body is present
CMDBuild-View: admin             # for ETL/webhook and selected admin/write operations
```

`monitoring-ui-api` can technically send `Authorization: Bearer <accessToken>` when the credential object already contains `accessToken`, but the normal user flow currently uses Basic credentials.

## Endpoints

### Catalog Sync

Used by the UI to build the class/attribute tree and validate rules.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/classes` | List classes |
| `GET` | `/classes/{class}/attributes` | Class attributes |
| `GET` | `/lookup_types` | Lookup types |
| `GET` | `/lookup_types/{lookupType}/values` | Lookup values |
| `GET` | `/domains` | List domains |
| `GET` | `/domains/{domain}` | Domain details |

Notes:
- Class/domain/lookup names must be URL-encoded.
- The UI filters inactive classes unless `IncludeInactiveClasses` is enabled.
- The UI reads attributes for the first 250 selected classes; lookup types and domains are limited to 500 items. Large models require a separate limit review.
- CMDBuild responses are normalized from `data[]`, `items[]`, or a single `data` object.

### Webhook Setup

Used by the `Webhook Setup` menu.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/etl/webhook/?detailed=true` | Load current CMDBuild webhooks |
| `POST` | `/etl/webhook/` | Create managed webhook |
| `PUT` | `/etl/webhook/{id}/` | Update managed webhook |
| `DELETE` | `/etl/webhook/{id}/` | Delete managed webhook |

Notes:
- These calls use `CMDBuild-View: admin`.
- The UI applies changes only to webhooks with the `cmdbwebhooks2kafka-` prefix.
- UI undo/redo does not roll back changes already applied to CMDBuild.
- `Save file as` can export a webhook artifact next to the rules file, but token/password/secret/API key/Authorization values must be masked as `XXXXX`.
- Webhook payload is expected to be flat. Reference, lookup, and domain values usually arrive as ids, while the leaf path is stored in rules.

### Card Read / Quick Audit

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/classes/{class}/cards?limit={n}&offset={m}` | Paged read of selected class cards |
| `GET` | `/classes/ZabbixHostBinding/cards?limit=5000` | Read additional-profile bindings |

Notes:
- Quick audit reads cards through `limit/offset`.
- One request is made for each selected class.
- Card values are normalized: lookup/reference objects can be reduced to `code`, `_description_translation`, `description`, `_id`, or `id`.

### Lookup/Reference/Domain Leaf Resolver

Used by `cmdbkafka2zabbix` while processing a Kafka event.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/classes/{class}/attributes` | Read attribute type, target class, and lookup type |
| `GET` | `/classes/{class}/cards/{cardId}` | Read referenced card leaf |
| `GET` | `/lookup_types/{lookupType}/values` | Convert lookup id to code/description/translation |
| `GET` | `/classes/{sourceClass}/cards/{sourceCardId}/relations` | Find related cards for domain path |

Notes:
- If resolver rules are configured but `Cmdbuild:BaseUrl/Username/Password` is empty, lookup/reference/domain values stay unresolved.
- For normal reference/lookup errors, the resolver keeps the original value to avoid losing the event.
- For domain path errors, the unresolved relation id is removed from source fields to avoid sending a numeric id to Zabbix as a leaf value.
- Lookup default `valueMode` is `code`. Supported modes are `code`, `description`, `translation`, and `id`.
- If a CMDBuild card already contains companion fields like `_{Attribute}_code`, `_{Attribute}_description`, or `_{Attribute}_description_translation`, the resolver uses them before calling lookup values.
- Reference paths are protected by `MaxPathDepth` and cycle checks.
- Runtime cache is scoped to one resolver event: update events reread lookup/reference/domain leaf values.

Example `cmdbPath` values:

```text
Class.ReferenceAttribute.LeafAttribute
Class.Reference1.Reference2.LookupAttribute
Class.{domain:RelatedClass}.LeafAttribute
Class.{domain:RelatedClass}.ReferenceAttribute.LookupAttribute
```

For `{domain:RelatedClass}`, the segment names the class on the other side of the relation, not the domain name. The resolver reads source-card relations and selects the endpoint whose class matches the target class.

### Reverse Binding

Used by `zabbixbindings2cmdbuild` after successful Zabbix writes.

| Method | Path | Purpose |
| --- | --- | --- |
| `PUT` | `/classes/{sourceClass}/cards/{sourceCardId}` | Write or clear `zabbix_main_hostid` for the main profile |
| `GET` | `/classes/ZabbixHostBinding/cards?limit={n}` | Find an existing binding card |
| `POST` | `/classes/ZabbixHostBinding/cards` | Create an additional-profile binding |
| `PUT` | `/classes/ZabbixHostBinding/cards/{bindingCardId}` | Update an additional-profile binding |

Minimum model:
- `zabbix_main_hostid` attribute on every concrete CMDBuild class participating in rules;
- service class `ZabbixHostBinding` for additional profiles.

Notes:
- The main profile is stored directly on the source card.
- Additional profiles are stored as separate `ZabbixHostBinding` cards.
- Binding lookup currently reads up to `BindingLookupLimit` cards and filters locally by `OwnerClass + OwnerCardId + HostProfile`. Large installations need limit control and preferably CMDBuild-side indexes/constraints on these fields.
- On `host.delete`, `zabbix_main_hostid` is cleared and additional-profile binding status becomes `deleted`.

### Audit Model Preparation

Used by the UI `Audit` menu.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/classes` | Create service class `ZabbixHostBinding` |
| `POST` | `/classes/{class}/attributes` | Create `zabbix_main_hostid` or binding-class attributes |

CMDBuild model administrator rights are required. They are not required to analyze the plan.

### Demo/Test Scripts

Test scripts use additional write endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/classes` | Create test classes |
| `POST` | `/classes/{class}/attributes` | Create attributes |
| `POST` | `/lookup_types` | Create lookup type |
| `POST` | `/lookup_types/{lookupType}/values` | Create lookup value |
| `POST` | `/domains` | Create domain |
| `POST` | `/classes/{class}/cards` | Create card |
| `PUT` | `/classes/{class}/cards/{cardId}` | Update card |
| `POST` | `/domains/{domain}/relations` | Create relation, primary option |
| `POST` | `/classes/{sourceClass}/cards/{sourceId}/relations` | Create relation, fallback options |

These scripts are for dev/test CMDBuild. Do not run them in production without a separate plan.

## CMDBuild Permissions

Minimum permissions depend on the scenario:

| Scenario | Permissions |
| --- | --- |
| Catalog sync | Read metadata classes/attributes/domains and lookup types/values |
| Rule editor with catalog validation | Read catalog cache; catalog refresh needs catalog-sync permissions |
| Webhook load | Read ETL/webhook records |
| Webhook apply | Create/update/delete ETL/webhook records |
| Converter resolver | Read attributes, cards, relations, and lookup values for participating classes |
| Quick audit | Read classes/cards for participating classes and `ZabbixHostBinding` |
| Audit model apply | Model admin: create class/attributes |
| Reverse binding writer | Read/update participating cards, read/create/update `ZabbixHostBinding` |

## Main Notes And Risks

1. **Webhook is not the full object source.** It sends a flat payload. If a leaf is needed through reference/domain/lookup, metadata must be in rules and the actual leaf is read through REST.

2. **Changing a related card does not update the source card monitoring by itself.** If a reference/domain leaf changed but the source card was not modified and no source-card webhook was sent, the converter receives no event.

3. **Lookup id must not be sent to Zabbix as a business value.** Convert it to `code`/`description`/`translation` through lookup values or card companion fields.

4. **N:N domain is not a card attribute.** It requires `/classes/{class}/cards/{id}/relations` and a `cmdbPath` segment `{domain:RelatedClass}`.

5. **Reference paths are depth-limited.** Default depth is 2, runtime range is 2-5. This protects against cycles and expensive chains.

6. **Class and attribute names are not product constraints.** The concrete CMDBuild model is defined by catalog + webhook + rules. Documentation should use abstract names unless describing a concrete test object.

7. **Superclasses/prototypes should not be leaf targets for rules.** The UI should use concrete classes.

8. **Large models require limit control.** UI catalog sync and audit have protective limits. Large CMDBuild installations need separate sizing of classes/cards/lookups/domains and performance.

9. **ETL/webhook operations are not reverted by UI undo.** Undo/redo changes only the local UI draft, not REST changes already applied to CMDBuild.

10. **Do not access the CMDBuild database directly.** This product integrates through REST API. Direct CMDBuild DB access is not part of the compatibility contract.

## Checklist After CMDBuild Model Changes

1. Sync CMDBuild catalog in the UI.
2. Confirm that new classes/attributes/lookups/domains are visible in catalog cache.
3. Create or update rules in the rule editor.
4. In Webhook Setup, run `Analyze rules`.
5. Apply missing webhook payload fields.
6. Save rules and publish the file to external git/working copy.
7. Press `Reload conversion rules` for the converter.
8. Create or update a test CMDBuild card.
9. Check Events: CMDBuild event -> Zabbix request -> Zabbix response -> binding event.
10. Run Quick audit for the selected class.

