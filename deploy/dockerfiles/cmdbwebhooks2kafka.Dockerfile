FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY global.json Directory.Build.props cmdb2monitoring.slnx ./
COPY src/cmdbwebhooks2kafka/cmdbwebhooks2kafka.csproj src/cmdbwebhooks2kafka/
COPY src/shared/ src/shared/
RUN dotnet restore src/cmdbwebhooks2kafka/cmdbwebhooks2kafka.csproj

COPY src/cmdbwebhooks2kafka/ src/cmdbwebhooks2kafka/
RUN dotnet publish src/cmdbwebhooks2kafka/cmdbwebhooks2kafka.csproj \
    --configuration Release \
    --output /app/publish \
    --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["dotnet", "cmdbwebhooks2kafka.dll"]
