# Deployment Through A Local Docker Registry

This document describes how to build microservice and UI images, push them to a local Docker registry, and choose the right configuration files for runtime.

## Images

| Image | Dockerfile | Internal port | Purpose |
| --- | --- | --- | --- |
| `cmdbwebhooks2kafka` | `deploy/dockerfiles/cmdbwebhooks2kafka.Dockerfile` | `8080` | Receives CMDBuild webhooks |
| `cmdbkafka2zabbix` | `deploy/dockerfiles/cmdbkafka2zabbix.Dockerfile` | `8080` | Converts CMDBuild events to Zabbix requests |
| `zabbixrequests2api` | `deploy/dockerfiles/zabbixrequests2api.Dockerfile` | `8080` | Calls Zabbix JSON-RPC |
| `zabbixbindings2cmdbuild` | `deploy/dockerfiles/zabbixbindings2cmdbuild.Dockerfile` | `8080` | Writes Zabbix hostids back to CMDBuild |
| `monitoring-ui-api` | `deploy/dockerfiles/monitoring-ui-api.Dockerfile` | `5090` | UI/BFF |

Typical external development port mappings are `5080:8080`, `5081:8080`, `5082:8080`, `5083:8080`, and `5090:5090`.

## Local Registry

Start the registry if it is not running yet:

```bash
docker run -d --restart=always -p 5000:5000 --name registry registry:2
```

Check it:

```bash
curl http://localhost:5000/v2/_catalog
```

If the registry is on another host and runs without TLS, Docker daemons on deployment nodes must allow it as an `insecure-registries` entry.

## Build And Push

Recommended command:

```bash
REGISTRY=localhost:5000 VERSION=0.8.0 ./scripts/build-local-registry-images.sh
```

The script builds and pushes:

```text
localhost:5000/cmdb2monitoring/cmdbwebhooks2kafka:0.8.0
localhost:5000/cmdb2monitoring/cmdbkafka2zabbix:0.8.0
localhost:5000/cmdb2monitoring/zabbixrequests2api:0.8.0
localhost:5000/cmdb2monitoring/zabbixbindings2cmdbuild:0.8.0
localhost:5000/cmdb2monitoring/monitoring-ui-api:0.8.0
```

It also applies the `latest` tag. For a local build without push:

```bash
PUSH=false VERSION=0.8.0 ./scripts/build-local-registry-images.sh
```

Manual build for one image:

```bash
docker build \
  -f deploy/dockerfiles/cmdbkafka2zabbix.Dockerfile \
  -t localhost:5000/cmdb2monitoring/cmdbkafka2zabbix:0.8.0 \
  .

docker push localhost:5000/cmdb2monitoring/cmdbkafka2zabbix:0.8.0
```

The build needs access to `mcr.microsoft.com` for .NET runtime/sdk images, `docker.io` for the Node.js image, and NuGet/npm registries for dependency restore/install.

## Configuration Files

Images include base config from the repository. For real runtime, do not edit files inside the image; use mounted config, environment overrides, or secret storage.

| Component | Base config | Dev config | Production/local override |
| --- | --- | --- | --- |
| `cmdbwebhooks2kafka` | `src/cmdbwebhooks2kafka/appsettings.json` | `src/cmdbwebhooks2kafka/appsettings.Development.json` | mounted `/app/appsettings.Production.json` or env `Kafka__...`, `CmdbWebhook__...` |
| `cmdbkafka2zabbix` | `src/cmdbkafka2zabbix/appsettings.json` | `src/cmdbkafka2zabbix/appsettings.Development.json` | mounted `/app/appsettings.Production.json` or env `Kafka__...`, `ConversionRules__...`, `Cmdbuild__...` |
| `zabbixrequests2api` | `src/zabbixrequests2api/appsettings.json` | `src/zabbixrequests2api/appsettings.Development.json` | mounted `/app/appsettings.Production.json` or env `Kafka__...`, `Zabbix__...` |
| `zabbixbindings2cmdbuild` | `src/zabbixbindings2cmdbuild/appsettings.json` | `src/zabbixbindings2cmdbuild/appsettings.Development.json` | mounted `/app/appsettings.Production.json` or env `Kafka__...`, `Cmdbuild__...` |
| `monitoring-ui-api` | `src/monitoring-ui-api/config/appsettings.json` | `src/monitoring-ui-api/config/appsettings.Development.json` | mounted `/app/config/appsettings.Production.json`, env `CMDBUILD_BASE_URL`, `ZABBIX_API_ENDPOINT`, `RULES_*`, `MONITORING_UI_*` |

`appsettings.Development.json` files are for the local development stand. Inside containers, `localhost` means the container itself, so Kafka/CMDBuild/Zabbix usually need Docker-network names or host gateway URLs.

.NET services use standard `__` environment overrides:

```bash
Kafka__Input__BootstrapServers=kafka:29092
Kafka__Output__BootstrapServers=kafka:29092
Cmdbuild__BaseUrl=http://cmdbuild:8080/cmdbuild/services/rest/v3
Zabbix__ApiEndpoint=http://zabbix-web:8080/api_jsonrpc.php
```

The UI/BFF reads `config/appsettings.json`, then `config/appsettings.${NODE_ENV}.json`, then `state/ui-settings.json`, then env overrides. The UI Dockerfile sets `NODE_ENV=Production`; mount an override as `/app/config/appsettings.Production.json` when needed.

## Indeed PAM/AAPM Secret Provider

All microservices and `monitoring-ui-api` support corporate service-secret storage through the `Secrets` section.
The provider is disabled by default:

```json
"Secrets": {
  "Provider": "None",
  "References": {},
  "IndeedPamAapm": {
    "BaseUrl": "",
    "PasswordEndpointPath": "/sc_aapm_ui/rest/aapm/password",
    "ApplicationToken": "",
    "ApplicationTokenFile": "",
    "ApplicationUsername": "",
    "ApplicationPassword": "",
    "DefaultAccountPath": "",
    "SendApplicationCredentialsInQuery": false,
    "ResponseType": "json",
    "ValueJsonPath": "password",
    "PasswordExpirationInMinute": "30",
    "PasswordChangeRequired": false,
    "Comment": "cmdb2monitoring {service} {secretId}",
    "TenantId": "",
    "TimeoutMs": 10000
  }
}
```

To use Indeed PAM/AAPM:

```json
"Secrets": {
  "Provider": "IndeedPamAapm",
  "References": {
    "cmdbuild-resolver-password": {
      "AccountPath": "/cmdb2monitoring/cmdbuild",
      "AccountName": "cmdbuild-resolver",
      "ValueJsonPath": "password"
    },
    "zabbix-api-token": {
      "AccountPath": "/cmdb2monitoring/zabbix",
      "AccountName": "zabbix-api-token",
      "ValueJsonPath": "password"
    }
  },
  "IndeedPamAapm": {
    "BaseUrl": "https://pam.example.org",
    "PasswordEndpointPath": "/sc_aapm_ui/rest/aapm/password",
    "ApplicationTokenFile": "/run/secrets/indeed-pam-aapm-token",
    "ApplicationUsername": "",
    "ApplicationPassword": "",
    "DefaultAccountPath": "",
    "SendApplicationCredentialsInQuery": false,
    "ResponseType": "json",
    "ValueJsonPath": "password",
    "PasswordExpirationInMinute": "30",
    "PasswordChangeRequired": false,
    "Comment": "cmdb2monitoring {service} {secretId}",
    "TenantId": "",
    "TimeoutMs": 10000
  }
}
```

Sensitive fields contain a reference instead of the value:

```json
"Cmdbuild": {
  "Username": "cmdbuild-resolver",
  "Password": "secret://cmdbuild-resolver-password"
}
```

Both `secret://id` and `aapm://id` references are supported; `id` can be described under `Secrets:References` or passed as `AccountPath.AccountName`/`AccountPath/AccountName`.
At service startup, the value is requested from AAPM and substituted only in process memory. The Docker image and production config keep the reference, not the password.

Operational rules:
- `ApplicationToken`/`ApplicationTokenFile` or `ApplicationUsername`/`ApplicationPassword` is the bootstrap secret used by the application to access AAPM; provide it through a Docker/Kubernetes secret, PAM env, or another protected mount;
- `PasswordEndpointPath` is configurable because the concrete AAPM URL can differ between Indeed PAM versions/publications;
- when AAPM returns plain text, set `ResponseType` to a value other than `json`;
- when AAPM returns JSON with another field, set `ValueJsonPath`, for example `result.password`;
- `monitoring-ui-api` shows `secret://id` in runtime settings instead of the resolved secret value;
- `secret://id` changes made through UI apply immediately to the UI/BFF; .NET microservices pick them up after restart or after the deployment layer rereads their configuration.

The corporate env alias format is supported by all .NET microservices and `monitoring-ui-api`:

```bash
PAMURL=https://pam.localhost
PAMUSERNAME=MS_PRO
PAMPASSWORD='*****'

SASLUSERNAME=MS_SUN
SASLPASSWORD=
SASLPASSWORDSECRET=AAA.LOCAL\PROD.contractorProfiles
```

When `PAMURL` is provided with `PAMUSERNAME`/`PAMPASSWORD` or `PAMTOKEN`, and `Secrets:Provider=None`, the provider is treated as `IndeedPamAapm`. `SASLUSERNAME` fills empty Kafka SASL username fields, `SASLPASSWORD` fills empty password fields, and `SASLPASSWORDSECRET` becomes `secret://...`. In the example, `AAA.LOCAL\PROD.contractorProfiles` is split on the last dot as `AccountPath=AAA.LOCAL\PROD` and `AccountName=contractorProfiles`. Explicit fields such as `Kafka__Input__Password` take precedence and are not overwritten by alias variables.

Any sensitive field can reference a PAM/AAPM secret in two equivalent ways.

Direct reference in the target field:

```bash
Kafka__Input__Password=secret://AAA.LOCAL\PROD.contractorProfiles
Zabbix__ApiToken=secret://AAA.LOCAL\PROD.zabbixApiToken
Service__RulesReloadToken=secret://AAA.LOCAL\PROD.rulesReloadToken
AuditStorage__ConnectionString=secret://AAA.LOCAL\PROD.auditStorageConnection
```

Companion field with the `Secret` suffix, when the target field exists and is empty:

```bash
Kafka__Input__Password=
Kafka__Input__PasswordSecret=AAA.LOCAL\PROD.contractorProfiles

Zabbix__ApiToken=
Zabbix__ApiTokenSecret=AAA.LOCAL\PROD.zabbixApiToken

Service__RulesReloadToken=
Service__RulesReloadTokenSecret=AAA.LOCAL\PROD.rulesReloadToken

AuditStorage__ConnectionString=
AuditStorage__ConnectionStringSecret=AAA.LOCAL\PROD.auditStorageConnection
```

General rule: `<FieldName>Secret` fills the empty `<FieldName>` with `secret://...`. For example, `PasswordSecret` fills `Password`, `ApiTokenSecret` fills `ApiToken`, `RulesReloadTokenSecret` fills `RulesReloadToken`, and `ConnectionStringSecret` fills `ConnectionString`. The companion field is applied only when a sibling target field without `Secret` already exists; this prevents ordinary fields such as `OAuth2:ClientSecret` from being misread as a reference to a non-existing `OAuth2:Client` field.

Typical fields that can be replaced with `secret://id`:

| Service | Fields |
| --- | --- |
| `cmdbwebhooks2kafka` | `Kafka:Password`, `ElkLogging:Kafka:Password`, `ElkLogging:Elk:ApiKey` |
| `cmdbkafka2zabbix` | `Cmdbuild:Password`, `Service:RulesReloadToken`, `Service:RulesStatusToken`, `Kafka:Input:Password`, `Kafka:Output:Password`, `ElkLogging:Kafka:Password`, `ElkLogging:Elk:ApiKey` |
| `zabbixrequests2api` | `Zabbix:ApiToken`, `Zabbix:Password`, `Kafka:Input:Password`, `Kafka:Output:Password`, `Kafka:BindingOutput:Password`, `ElkLogging:Kafka:Password`, `ElkLogging:Elk:ApiKey` |
| `zabbixbindings2cmdbuild` | `Cmdbuild:Password`, `Kafka:Input:Password`, `ElkLogging:Kafka:Password`, `ElkLogging:Elk:ApiKey` |
| `monitoring-ui-api` | `Zabbix:ApiToken`, `EventBrowser:Password`, `Idp:OAuth2:ClientSecret`, `Idp:Ldap:BindPassword`, `AuditStorage:ConnectionString`, `Services:HealthEndpoints[].RulesReloadToken`, `Services:HealthEndpoints[].RulesStatusToken` |

## Kafka Topics And ACLs

Topics are created by external infrastructure before services start. Microservice code must not create Kafka topics on startup.

Main flow:

| Base/prod topic | Dev topic | Producer | Consumer | Purpose |
| --- | --- | --- | --- | --- |
| `cmdbuild.webhooks` | `cmdbuild.webhooks.dev` | `cmdbwebhooks2kafka` | `cmdbkafka2zabbix` | Normalized CMDBuild webhook events |
| `zabbix.host.requests` | `zabbix.host.requests.dev` | `cmdbkafka2zabbix` | `zabbixrequests2api` | Zabbix JSON-RPC requests |
| `zabbix.host.responses` | `zabbix.host.responses.dev` | `zabbixrequests2api` | UI/Event Browser or external consumer | Zabbix API processing results |
| `zabbix.host.bindings` | `zabbix.host.bindings.dev` | `zabbixrequests2api` | `zabbixbindings2cmdbuild` | Reverse binding `CMDBuild card/profile -> Zabbix hostid` |

Log topics are required when `ElkLogging:Enabled=true`, `ElkLogging:Mode=Kafka`, and `ElkLogging:Kafka:Enabled=true`:

| Base/prod topic | Dev topic | Producer |
| --- | --- | --- |
| `cmdbwebhooks2kafka.logs` | `cmdbwebhooks2kafka.logs.dev` | `cmdbwebhooks2kafka` |
| `cmdbkafka2zabbix.logs` | `cmdbkafka2zabbix.logs.dev` | `cmdbkafka2zabbix` |
| `zabbixrequests2api.logs` | `zabbixrequests2api.logs.dev` | `zabbixrequests2api` |
| `zabbixbindings2cmdbuild.logs` | `zabbixbindings2cmdbuild.logs.dev` | `zabbixbindings2cmdbuild` |

Minimum Kafka ACLs when authentication is enabled:

| Principal/service | Topic ACL | Group ACL |
| --- | --- | --- |
| `cmdbwebhooks2kafka` | `WRITE`, `DESCRIBE` on `cmdbuild.webhooks`; `WRITE`, `DESCRIBE` on the log topic when Kafka logging is enabled | Not required |
| `cmdbkafka2zabbix` | `READ`, `DESCRIBE` on `cmdbuild.webhooks`; `WRITE`, `DESCRIBE` on `zabbix.host.requests`; `WRITE`, `DESCRIBE` on the log topic | `READ` on group `cmdbkafka2zabbix` |
| `zabbixrequests2api` | `READ`, `DESCRIBE` on `zabbix.host.requests`; `WRITE`, `DESCRIBE` on `zabbix.host.responses` and `zabbix.host.bindings`; `WRITE`, `DESCRIBE` on the log topic | `READ` on group `zabbixrequests2api` |
| `zabbixbindings2cmdbuild` | `READ`, `DESCRIBE` on `zabbix.host.bindings`; `WRITE`, `DESCRIBE` on the log topic | `READ` on group `zabbixbindings2cmdbuild` |
| `monitoring-ui-api` | When `EventBrowser:Enabled=true`: `READ`, `DESCRIBE` on browsed topics | `READ` on ephemeral groups with prefix `monitoring-ui-api-events-` or the configured `EventBrowser:ClientId` prefix |

## Secrets And Accounts By Service

Secrets are provided through env/secret storage or mounted config excluded from git. Do not bake them into Docker images.

| Service | Secrets/accounts | Config/env | Usage |
| --- | --- | --- | --- |
| `cmdbwebhooks2kafka` | Kafka SASL username/password | `Kafka__Username`, `Kafka__Password`, `ElkLogging__Kafka__Username`, `ElkLogging__Kafka__Password` | Publish CMDBuild events and logs to Kafka |
| `cmdbwebhooks2kafka` | ELK API key when direct ELK sink is used | `ElkLogging__Elk__ApiKey` | Write logs to ELK |
| `cmdbwebhooks2kafka` | Built-in webhook Bearer token is not implemented | No built-in config field | Protect inbound webhooks through network policy, reverse proxy, or external gateway when required |
| `cmdbkafka2zabbix` | CMDBuild service login/password | `Cmdbuild__Username`, `Cmdbuild__Password` | Read cards, attributes, lookup/reference/domain leaves, and `ZabbixHostBinding` |
| `cmdbkafka2zabbix` | Rules reload/status Bearer tokens | `Service__RulesReloadToken`, `Service__RulesStatusToken` | Protect `/admin/reload-rules` and `/admin/rules-status`; the same values are configured in UI `Services:HealthEndpoints` |
| `cmdbkafka2zabbix` | Kafka SASL username/password | `Kafka__Input__Username`, `Kafka__Input__Password`, `Kafka__Output__Username`, `Kafka__Output__Password`, `ElkLogging__Kafka__Username`, `ElkLogging__Kafka__Password` | Read CMDBuild events, publish Zabbix requests and logs |
| `zabbixrequests2api` | Zabbix API token or login/password | `Zabbix__ApiToken` or `Zabbix__User`, `Zabbix__Password`, `Zabbix__AuthMode` | Zabbix JSON-RPC calls |
| `zabbixrequests2api` | Kafka SASL username/password | `Kafka__Input__Username`, `Kafka__Input__Password`, `Kafka__Output__Username`, `Kafka__Output__Password`, `Kafka__BindingOutput__Username`, `Kafka__BindingOutput__Password`, `ElkLogging__Kafka__Username`, `ElkLogging__Kafka__Password` | Read requests, publish responses/bindings/logs |
| `zabbixbindings2cmdbuild` | CMDBuild service login/password | `Cmdbuild__Username`, `Cmdbuild__Password` | Write `zabbix_main_hostid` and `ZabbixHostBinding` cards |
| `zabbixbindings2cmdbuild` | Kafka SASL username/password | `Kafka__Input__Username`, `Kafka__Input__Password`, `ElkLogging__Kafka__Username`, `ElkLogging__Kafka__Password` | Read binding events and publish logs |
| `monitoring-ui-api` | Local UI users file | `MONITORING_UI_USERS_FILE`, `Auth:UsersFilePath` | Local UI users; the file contains PBKDF2 hashes/salts |
| `monitoring-ui-api` | Zabbix API token for UI catalog/audit | `ZABBIX_API_TOKEN`, `Zabbix:ApiToken` | Read Zabbix catalog/metadata/audit without asking users for login/password |
| `monitoring-ui-api` | Session CMDBuild/Zabbix login/password | Entered by the user in UI | Stored only in the server-side session and used for UI operations against CMDBuild/Zabbix |
| `monitoring-ui-api` | Kafka Event Browser SASL username/password | `MONITORING_UI_KAFKA_USERNAME`, `MONITORING_UI_KAFKA_PASSWORD` | Read-only Kafka topic browsing |
| `monitoring-ui-api` | OAuth2 client secret | `OAUTH2_CLIENT_SECRET` | External login through OAuth2/OIDC |
| `monitoring-ui-api` | LDAP bind password | `LDAP_BIND_PASSWORD` | MS AD/LDAP bind and group reads for role mapping |
| `monitoring-ui-api` | SAML SP private key/cert and IdP cert | `SAML2_SP_PRIVATE_KEY_PATH`, `SAML2_SP_CERT_PATH`, `SAML2_IDP_CERT_PATH` or inline env | SAML2 login, request signing, and assertion decryption when enabled |
| `monitoring-ui-api` | Audit DB password | `AUDIT_STORAGE_CONNECTION_STRING` | PostgreSQL/SQLite audit storage; SQLite does not need a password |
| `monitoring-ui-api` | Converter rules reload/status tokens | `Services:HealthEndpoints[].RulesReloadToken`, `Services:HealthEndpoints[].RulesStatusToken` | `Reload conversion rules` and converter rules-version reads |

Any listed secret can stay as `secret://id` when `Secrets:Provider=IndeedPamAapm`; `id` can be described in `Secrets:References` or parsed as `AccountPath.AccountName`/`AccountPath/AccountName`.
If `ConversionRules:ReadFromGit=true` and the git repository is private, git credentials must be provided by the deployment layer: mounted SSH key, credential-helper token, or read-only deploy key. Appsettings contain the URL/path, not the git password.

## Permissions In External Systems

CMDBuild:

| Caller | Minimum permissions |
| --- | --- |
| `cmdbkafka2zabbix` | Read-only REST access to metadata classes/attributes/domains, lookup types/values, participating class cards, related reference/domain cards, relations; read access to `zabbix_main_hostid` and `ZabbixHostBinding` when `HostBindingLookupEnabled=true` |
| `zabbixbindings2cmdbuild` | Read/update on participating class cards for `zabbix_main_hostid`; read/create/update on service class `ZabbixHostBinding` |
| `monitoring-ui-api` catalog/rules/audit | Read-only access to metadata, lookup values, relations, and selected class cards; Quick audit also needs read access to `ZabbixHostBinding` |
| `monitoring-ui-api` Webhook Setup | Read access to ETL/webhook records for `Load from CMDB`; create/update/delete access to ETL/webhook records for `Load into CMDB` and `Delete selected` |
| `monitoring-ui-api` Audit model preparation | CMDBuild model administrator permissions to create attributes/classes, including `zabbix_main_hostid` and `ZabbixHostBinding` |
| CMDBuild webhook caller | Network access from CMDBuild to `cmdbwebhooks2kafka` route `/webhooks/cmdbuild`; no CMDBuild login is needed by the service because CMDBuild calls the webhook itself |

Zabbix:

| Caller | Minimum permissions |
| --- | --- |
| `monitoring-ui-api` catalog/metadata/audit | API read access to `hostgroup.get`, `templategroup.get`, `template.get` with subselects, `host.get`, `proxy.get`, `proxygroup.get`, `globalmacro.get`, `usermacro.get`, `maintenance.get`, `valuemap.get`; Quick audit uses `host.get` and `maintenance.get` |
| `zabbixrequests2api` base host flow | API read access to `host.get`, `hostgroup.get`, `template.get`; write access to `host.create`, `host.update`, `host.delete` |
| `zabbixrequests2api` dynamic host groups | Additional `hostgroup.create` when `Zabbix:AllowDynamicHostGroupCreate=true` and rules use dynamic host groups from CMDBuild leaf values |
| `zabbixrequests2api` extended rules | Permissions must match JSON-RPC methods actually generated by rules/T4, for example `maintenance.create/update/delete` when those operations are enabled by rules |

MS AD/LDAP/IdP:

| Caller | Minimum permissions |
| --- | --- |
| `monitoring-ui-api` LDAP/MS AD | Bind as a service account, read user attributes and group membership attributes used by `Idp:Ldap:*` and `Idp:RoleMapping` |
| `monitoring-ui-api` SAML2/OAuth2 | Registered service provider/client, UI redirect/ACS URL, login/email/displayName/groups claims or LDAP group lookup capability |

## State, Rules, And Volumes

At minimum, keep these paths on volumes:

| Component | What to persist |
| --- | --- |
| `cmdbkafka2zabbix` | `/app/state`, rules file or rules git working copy |
| `zabbixrequests2api` | `/app/state` |
| `zabbixbindings2cmdbuild` | `/app/state` |
| `monitoring-ui-api` | `/app/state`, `/app/data`, rules working copy when `Git Settings` is used |

Typical converter rules override in a container:

```bash
ConversionRules__RepositoryPath=/app
ConversionRules__RulesFilePath=rules/cmdbuild-to-zabbix-host-create.json
ConversionRules__ReadFromGit=false
```

If rules are read from a git working copy:

```bash
ConversionRules__ReadFromGit=true
ConversionRules__RepositoryPath=/app/rules-git-working-copy
ConversionRules__RepositoryUrl=https://git.example.org/cmdb2monitoring/conversion-rules.git
ConversionRules__RulesFilePath=rules/cmdbuild-to-zabbix-host-create.json
ConversionRules__PullOnStartup=true
ConversionRules__PullOnReload=true
```

The repository is expected to contain `rules/cmdbuild-to-zabbix-host-create.json` unless `RulesFilePath`/`ConversionRules:RulesFilePath` is overridden.

## Default Credentials

| System | Login/password | Purpose |
| --- | --- | --- |
| UI local users | `viewer/viewer`, `editor/editor`, `admin/admin` | Created on first startup when `state/users.json` does not exist; passwords are stored as PBKDF2-SHA256 hash/salt |
| CMDBuild dev stand | `admin/admin` | Test environment only |
| Zabbix dev stand | `Admin/zabbix` | Test environment only |
| Kafka dev stand | no login/password | Local Docker PLAINTEXT Kafka |

In production, change initial UI passwords after first login or mount a prepared `state/users.json`. CMDBuild/Zabbix login/password values are not stored in UI runtime state: the UI asks for them for the server-side session on first use, and Zabbix can use `Zabbix:ApiToken`. Service accounts for `cmdbkafka2zabbix`, `zabbixrequests2api`, and `zabbixbindings2cmdbuild` are configured through env/secret values, not through startup UI users.

## Single-Service Run Example

```bash
docker run --rm \
  --name cmdbkafka2zabbix \
  -p 5081:8080 \
  -v "$PWD/state/cmdbkafka2zabbix:/app/state" \
  -v "$PWD/rules:/app/rules:ro" \
  -e ASPNETCORE_ENVIRONMENT=Production \
  -e Kafka__Input__BootstrapServers=kafka:29092 \
  -e Kafka__Output__BootstrapServers=kafka:29092 \
  -e ConversionRules__RepositoryPath=/app \
  -e ConversionRules__RulesFilePath=rules/cmdbuild-to-zabbix-host-create.json \
  -e Cmdbuild__BaseUrl=http://cmdbuild:8080/cmdbuild/services/rest/v3 \
  -e Cmdbuild__Username='<secret>' \
  -e Cmdbuild__Password='<secret>' \
  localhost:5000/cmdb2monitoring/cmdbkafka2zabbix:0.8.0
```

## Smoke Check

After startup, check:

```bash
curl http://localhost:5080/health
curl http://localhost:5081/health
curl http://localhost:5082/health
curl http://localhost:5083/health
curl http://localhost:5090/health
```

Then in UI:

1. Log in as `admin/admin` and change the password.
2. Fill `Runtime settings`: CMDBuild URL, Zabbix API URL/API token, Kafka Events, AuditStorage.
3. Check `Git Settings` or the local rules-file path.
4. Sync CMDBuild catalog, Zabbix catalog, and Zabbix metadata.
5. Press `Reload conversion rules` and compare the rules version in UI and on the converter.

## Do Not Commit Or Bake Into Images

- `state/users.json`;
- `state/ui-settings.json`;
- `data/*-catalog-cache.json`;
- service offset state files;
- `appsettings.Production.json` with secrets;
- Zabbix API token, CMDBuild/Zabbix passwords, Kafka SASL passwords, LDAP bind password, webhook Bearer tokens.
