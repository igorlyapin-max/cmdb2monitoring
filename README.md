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
