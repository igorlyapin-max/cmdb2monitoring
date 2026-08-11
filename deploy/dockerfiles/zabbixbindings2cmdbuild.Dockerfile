ARG DOTNET_SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0
ARG DOTNET_RUNTIME_IMAGE=mcr.microsoft.com/dotnet/aspnet:10.0

FROM ${DOTNET_SDK_IMAGE} AS build
WORKDIR /src

COPY global.json Directory.Build.props cmdb2monitoring.slnx ./
COPY src/zabbixbindings2cmdbuild/zabbixbindings2cmdbuild.csproj src/zabbixbindings2cmdbuild/
COPY src/shared/ src/shared/
RUN dotnet restore src/zabbixbindings2cmdbuild/zabbixbindings2cmdbuild.csproj

COPY src/zabbixbindings2cmdbuild/ src/zabbixbindings2cmdbuild/
RUN dotnet publish src/zabbixbindings2cmdbuild/zabbixbindings2cmdbuild.csproj \
    --configuration Release \
    --output /app/publish \
    --no-restore

FROM ${DOTNET_RUNTIME_IMAGE} AS runtime
WORKDIR /app

ENV ASPNETCORE_URLS=http://0.0.0.0:8080
EXPOSE 8080

COPY --from=build /app/publish .
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system appgroup \
    && adduser --system --ingroup appgroup appuser \
    && mkdir -p /app/state /app/data \
    && chown -R appuser:appgroup /app
USER appuser
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:8080/ready || exit 1
ENTRYPOINT ["dotnet", "zabbixbindings2cmdbuild.dll"]

FROM runtime AS gkm-runtime
