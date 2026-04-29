# cmdb2monitoring

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
- `cmdbkafka2zabbix`: reads CMDB events from Kafka, applies JSON/T4 conversion rules, and publishes Zabbix JSON-RPC requests.
- `zabbixrequests2api`: reads Zabbix JSON-RPC requests from Kafka, validates them, calls Zabbix API, and publishes responses.

Service settings live in `src/cmdbwebhooks2kafka/appsettings.json`.
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

- `TZ_cmdb2monitoring.txt`: project technical specification.
- `aa/`: architecture artifacts, AsyncAPI/OpenAPI, maps, diagrams, and configuration documentation.
- `aa/configuration-files.md`: what to configure in each microservice and when.

## Checks

```bash
./scripts/test-configs.sh
./scripts/dotnet build cmdb2monitoring.slnx
```
