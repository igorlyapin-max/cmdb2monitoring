# cmdb2monitoring

Current release version: `0.4.0`.

Local .NET development environment is installed in `.dotnet`.
The repository wrapper also keeps .NET CLI state and NuGet packages inside this workspace, which makes it work without a global SDK installation.

## Usage

Run .NET commands through the repository wrapper:

```bash
./scripts/dotnet --info
./scripts/dotnet build
```

## Services

- `cmdbwebhooks2kafka`: receives CMDBuild webhook payloads on `POST /webhooks/cmdbuild` and publishes normalized events to Kafka.
- `cmdbkafka2zabbix`: reads CMDB events from Kafka, applies JSON/T4 conversion rules including `hostProfiles[]`, and publishes one or more Zabbix JSON-RPC requests.
- `zabbixrequests2api`: reads Zabbix JSON-RPC requests from Kafka, validates them, calls Zabbix API, and publishes responses.
- `monitoring-ui-api`: Node.js frontend/backend-for-frontend for dashboard, Events Kafka browser, rules upload/dry-run, Conversion Rules Management edit/delete, SAML2 IdP login/settings, and CMDBuild/Zabbix catalog sync.

Dev HTTP ports:

- `cmdbwebhooks2kafka`: `http://localhost:5080`, bind `0.0.0.0:5080` so CMDBuild in Docker can call `http://192.168.202.100:5080/webhooks/cmdbuild`.
- `cmdbkafka2zabbix`: `http://localhost:5081`.
- `zabbixrequests2api`: `http://localhost:5082`.
- `monitoring-ui-api`: `http://localhost:5090`.

Service settings live in each service `appsettings.json` / `appsettings.Development.json`.
For a container running in Docker network `cmdbuild_default`, override Kafka with:

```bash
Kafka__BootstrapServers=kafka:29092
```

Or source the environment once in the current shell:

```bash
source scripts/dotnet-env.sh
dotnet --info
```

## Documentation

- `CHANGELOG.md`: release history and version notes.
- `PROJECT_DOCUMENTATION.md`: full project operations and configuration guide.
- `TZ_cmdb2monitoring.txt`: project technical specification.
- `aa/`: architecture artifacts, AsyncAPI/OpenAPI, maps, diagrams, and configuration documentation.
- `aa/configuration-files.md`: what to configure in each microservice and when.

## Checks

```bash
./scripts/test-configs.sh
./scripts/dotnet build src/cmdbwebhooks2kafka/cmdbwebhooks2kafka.csproj
./scripts/dotnet build src/cmdbkafka2zabbix/cmdbkafka2zabbix.csproj
./scripts/dotnet build src/zabbixrequests2api/zabbixrequests2api.csproj
```

Run the frontend slice:

```bash
cd src/monitoring-ui-api
npm install
npm start
```
