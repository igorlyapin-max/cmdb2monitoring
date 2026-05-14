# MUST: cmdb2monitoring Development Agreements

This file records mandatory project development rules. If a rule conflicts with older documentation, `must.md` has priority, then `TZ_cmdb2monitoring.txt`, then documents under `aa/`.

## General Principles

- The project is maintained as a single monorepo.
- Each microservice lives under `src/<service-name>`.
- Backend microservices are implemented in C# / .NET.
- A Node.js frontend/BFF is allowed as long as the browser does not call Kafka, CMDBuild, or Zabbix directly.
- All settings must be externalized into configuration files and environment overrides. Do not hardcode addresses, topics, credentials, tokens, state-file paths, or endpoints.
- Every network flow in documentation and architecture artifacts must include a port number when the port is known.
- When non-architecture documentation changes, update the adjacent English version as well. The current English companions are `PROJECT_DOCUMENTATION.en.md`, `TZ_cmdb2monitoring.en.txt`, `TEST_PLAN_MAPPING_EDITOR.en.md`, and `must.en.md`. Architecture artifacts under `aa/` are translated only on explicit request.
- Kafka topics are provisioned by external infrastructure. Microservice code must not create topics at startup.
- Logs are designed for ELK. Until ELK is available, structured JSON logs are written to Kafka log topics.
- Runtime state is stored in `state/*.json` and must not be committed.
- Production secrets must not be stored in git. Use environment variables, secret storage, or local config excluded from git.
- Until an explicit instruction changes this, release version `z.x.y` must be bumped only in the patch component `y`; do not change `z` or `x`.
- Frontend credentials must not be stored in the browser; use a server-side session.
- `monitoring-ui-api` main menu text, Help text, and base selector tooltips must support Russian and English locales. When adding a menu item, Help text, or selector tooltip, update both `ru` and `en` dictionaries.
- SAML2 must be implemented through a proven library with mandatory IdP signing certificate validation and InResponseTo validation. Do not hand-roll XML signature checks.

## Microservice Agreements

- Every service must expose `GET /health`.
- Every service must have `appsettings.json` and `appsettings.Development.json`.
- Configurations must pass `scripts/test-configs.sh`.
- Kafka configuration must include bootstrap servers, topic, client id, consumer group id where applicable, security protocol, SASL mechanism, username, password, acks, idempotence, and timeouts.
- Kafka offsets are committed only after successful processing, successful result publication, or an intentional skip/error response.
- Services that can fail during processing must persist the last processed object and Kafka input offset in a state file.
- On startup, a consumer must read the state file and resume from `lastInputOffset + 1` for the relevant topic/partition. The state file must not be only diagnostic output.
- If a service runs on the dev host and the source system runs in Docker, the HTTP endpoint must listen on more than loopback. The current webhook dev bind is `0.0.0.0:5080`, and CMDBuild calls `http://192.168.202.100:5080/webhooks/cmdbuild`.

## Kafka And Contracts

- Dev topics use the `.dev` suffix.
- Base/prod topics do not use the `.dev` suffix.
- Current business chain: `cmdbuild.webhooks.*`, `zabbix.host.requests.*`, `zabbix.host.responses.*`.
- Log topics: `cmdbwebhooks2kafka.logs.*`, `cmdbkafka2zabbix.logs.*`, `zabbixrequests2api.logs.*`.
- Any Kafka message structure change must update `TZ_cmdb2monitoring.txt`, `aa/asyncapi/cmdb2monitoring.asyncapi.yaml`, config validation tests when required fields/connectivity rules change, and relevant `aa/` documentation when information flows change.

## Zabbix Lifecycle

- `create` must produce `host.create`.
- `update` without `zabbix_hostid` must use fallback `host.get -> host.update`.
- For profile rules with `createOnUpdateWhenMissing=true`, update fallback may upsert: if `host.get` finds no host, `zabbixrequests2api` validates `fallbackCreateParams` and executes `host.create`.
- `delete` without `zabbix_hostid` must use fallback `host.get -> host.delete`.
- Service metadata `cmdb2monitoring` is allowed only inside the internal Kafka request and must be removed before the Zabbix API call.
- Before `host.create` and `host.update`, verify that referenced host groups, templates, and template groups exist.
- Zabbix templates are not project JSON files. Rules contain references to existing Zabbix templates by `templateid`.
- If a Zabbix payload contains `inventory`, `inventory_mode` must not be `-1`, because `-1` disables inventory and Zabbix rejects inventory fields.
- During `host.update`, `groups[]`, `templates[]`, `tags[]`, `macros[]`, and `inventory` must preserve external Zabbix values unless rules explicitly replace them; `interfaces[]` remain authoritative and are defined by rules.

## Rules And T4

- Conversion rules are stored as Git-managed JSON.
- Current demo rules file: `rules/cmdbuild-to-zabbix-host-create.json`.
- `monitoring-ui-api` does not commit or push rules. `Git Settings` may only read/write a local working copy and neighboring `*.webhooks.json`; secrets in webhook artifacts must be masked as `XXXXX`.
- Regex is used both for validation and for selecting groups, templates, interfaces, and tags.
- Rules must support extended Zabbix host parameters without code changes: proxy, proxy group, interface profile, host status, TLS/PSK, host macros, inventory fields, maintenances, and value maps.
- Rules must support `hostProfiles[]`: one CMDB object can produce one Zabbix host with multiple `interfaces[]` or multiple Zabbix hosts through fan-out.
- The current contract models IP addresses through explicit named rules/webhook fields. Arbitrary IP arrays are not supported without a separate model change.
- CMDBuild class names, attribute names, and source field names are not product constraints. The concrete model is defined by webhook body and rules: `source.entityClasses`, `source.fields`, `source.fields[].source`, `source.fields[].cmdbAttribute`, `source.fields[].cmdbPath`, `hostProfiles[]`, selection rules, and T4. Names such as `Computer`, `Notebook`, `Server`, `zabbixTag`, `iLo`, `mgmt`, `interface`, or `profile` are dev-model examples unless explicitly stated otherwise.
- Webhook payload remains flat. Reference/lookup metadata is stored in rules: `source.fields[].cmdbPath`, `lookupType`, and `resolve`; the converter resolves the leaf through CMDBuild REST by paths such as `Class.ReferenceAttribute.LeafAttribute`.
- Normal webhook-plan apply must not change `headers.Authorization` on existing CMDBuild webhooks. Token rotation is allowed only through a separate Authorization synchronization operation and only for owned managed records.
- For lookup source fields, the normal value before regex/T4 is lookup `code`; numeric ids are only fallback values when the CMDBuild resolver is not configured.
- For multiple Zabbix interfaces of the same type in one host, exactly one interface must have `main=1`; the rest must have `main=0`.
- Incompatible Zabbix templates must be handled through `templateConflictRules`; update fallback passes already linked conflicting templates through `templates_clear`.
- Dynamic host groups from a CMDBuild leaf must not only be created/resolved in Zabbix; their `groupid` must be substituted into the same `host.create`/`host.update` payload. Dynamic tags are sent directly in `params.tags[]` of the current host payload.
- `zabbixrequests2api` must not execute `host.create/update/delete` for a host payload or found host with the aggregate marker `cmdb2monitoring:aggregate=true` or a protected aggregate host name; this does not prohibit lifecycle changes to normal CMDB source hosts.
- New T4 templates must use `Model.Interfaces`; `Model.Interface` is kept only for backward compatibility with the first interface.
- Final JSON-RPC payload is rendered by T4 templates from the rules file.
- After changing a rules file, run `./scripts/test-configs.sh` and build affected `.csproj` files through `./scripts/dotnet build <project>.csproj -v minimal`.

## Technical Specification And Architecture Artifacts

- Any behavior, contract, topic, configuration, processing schema, or integration change must be reflected in `TZ_cmdb2monitoring.txt`.
- Any configuration, startup, secret, runtime state/cache, or operations workflow change must be reflected in `PROJECT_DOCUMENTATION.md`.
- `aa/` is mandatory for architecture artifacts.
- When architecture changes, update the relevant `aa/` files: business process, information model, deployment, configuration, AsyncAPI/OpenAPI, and maps.
- Diagrams must be stored as diagram-as-code (`.mmd`) or another text format suitable for git diff. Image/VSDX exports are allowed as derived artifacts only.
- When a product version or major/minor compatibility changes for CMDBuild, Zabbix, Kafka, .NET SDK, or Node.js, update the compatibility matrix in `TZ_cmdb2monitoring.txt`, `PROJECT_DOCUMENTATION.md`, and relevant `aa/` artifacts. A Docker `latest` tag is not a fixed version without runtime/API verification.

## Testing

Before commit/push, run:

```bash
./scripts/test-configs.sh
./scripts/dotnet build src/cmdbwebhooks2kafka/cmdbwebhooks2kafka.csproj -v minimal
./scripts/dotnet build src/cmdbkafka2zabbix/cmdbkafka2zabbix.csproj -v minimal
./scripts/dotnet build src/zabbixrequests2api/zabbixrequests2api.csproj -v minimal
./scripts/dotnet build tests/configvalidation/configvalidation.csproj -v minimal
node src/monitoring-ui-api/scripts/validate-config.mjs
git diff --check
```

For business-logic changes, also run the relevant smoke scenario: create, update with fallback, profile upsert, or delete with fallback.

For configuration changes, update checks under `tests/configvalidation`; `scripts/test-configs.sh` must remain fast and must not require live Kafka/Zabbix/CMDBuild.

## Git

- Work in `main` unless agreed otherwise.
- Versions follow SemVer. Minor releases add features or contract extensions; patch releases are only fixes without behavior expansion.
- Release commits update `CHANGELOG.md`, `TZ_cmdb2monitoring.txt`, `README.md`, and affected package/version metadata.
- A commit must include the code, technical specification, documentation, and tests related to one change.
- Do not commit `bin/`, `obj/`, `state/`, `.dotnet/`, `.nuget/`, `.env*`, local secrets, or `rules/.backup/`.
- Check `git status --short` before commit.
- Before push, verify that builds and config tests passed.
- After push, verify that the working tree is clean.

## Minimum Definition Of Done

A change is complete when code is implemented, configs are updated, `TZ_cmdb2monitoring.txt` and English companion docs are updated, architecture artifacts are updated when applicable, operational docs are updated, tests/check scripts are updated, validation passes, affected projects build, changes are committed and pushed, and the working tree is clean.
