ARG DOTNET_SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0
ARG DOTNET_RUNTIME_IMAGE=mcr.microsoft.com/dotnet/aspnet:10.0

FROM ${DOTNET_SDK_IMAGE} AS build
WORKDIR /src

COPY global.json Directory.Build.props cmdb2monitoring.slnx ./
COPY src/zabbixrequests2api/zabbixrequests2api.csproj src/zabbixrequests2api/
COPY src/shared/ src/shared/
RUN dotnet restore src/zabbixrequests2api/zabbixrequests2api.csproj

COPY src/zabbixrequests2api/ src/zabbixrequests2api/
RUN dotnet publish src/zabbixrequests2api/zabbixrequests2api.csproj \
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
    && groupadd --system appgroup \
    && useradd --system --gid appgroup --no-create-home --shell /usr/sbin/nologin appuser \
    && mkdir -p /app/state /app/data \
    && chown -R appuser:appgroup /app
USER appuser
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:8080/ready || exit 1
ENTRYPOINT ["dotnet", "zabbixrequests2api.dll"]

FROM runtime AS gkm-runtime-canonical
ARG APPLICATION_VERSION=0.0.0.0
ARG GIT_REVISION=unknown
ARG BUILD_PROVENANCE=verified
ARG SOURCE_STATE=clean
USER root
RUN test "$BUILD_PROVENANCE" = "verified" \
    && test "$GIT_REVISION" != "unknown" \
    && test "$SOURCE_STATE" = "clean" \
    && printf '%s\n' "$APPLICATION_VERSION" > /app/VERSION \
    && chown appuser:appgroup /app/VERSION
ENV APPLICATION_VERSION=$APPLICATION_VERSION \
    GIT_REVISION=$GIT_REVISION \
    BUILD_PROVENANCE=$BUILD_PROVENANCE \
    SOURCE_STATE=$SOURCE_STATE
LABEL org.opencontainers.image.version="$APPLICATION_VERSION" \
    org.opencontainers.image.revision="$GIT_REVISION" \
    org.opencontainers.image.provenance="$BUILD_PROVENANCE" \
    org.opencontainers.image.source-state="$SOURCE_STATE"
USER appuser

FROM runtime AS gkm-runtime
ARG APPLICATION_VERSION=0.0.0.0
ARG GIT_REVISION=unknown
ARG BUILD_PROVENANCE=unverified-local
ARG SOURCE_STATE=dirty-or-unverified
USER root
RUN test "$BUILD_PROVENANCE" = "unverified-local" \
    && test "$SOURCE_STATE" = "dirty-or-unverified" \
    && printf '%s\n' "$APPLICATION_VERSION" > /app/VERSION \
    && chown appuser:appgroup /app/VERSION
ENV APPLICATION_VERSION=$APPLICATION_VERSION \
    GIT_REVISION=$GIT_REVISION \
    BUILD_PROVENANCE=$BUILD_PROVENANCE \
    SOURCE_STATE=$SOURCE_STATE
LABEL org.opencontainers.image.version="$APPLICATION_VERSION" \
    org.opencontainers.image.revision="$GIT_REVISION" \
    org.opencontainers.image.provenance="$BUILD_PROVENANCE" \
    org.opencontainers.image.source-state="$SOURCE_STATE"
USER appuser
