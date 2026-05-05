FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY global.json Directory.Build.props cmdb2monitoring.slnx ./
COPY src/zabbixbindings2cmdbuild/zabbixbindings2cmdbuild.csproj src/zabbixbindings2cmdbuild/
RUN dotnet restore src/zabbixbindings2cmdbuild/zabbixbindings2cmdbuild.csproj

COPY src/zabbixbindings2cmdbuild/ src/zabbixbindings2cmdbuild/
RUN dotnet publish src/zabbixbindings2cmdbuild/zabbixbindings2cmdbuild.csproj \
    --configuration Release \
    --output /app/publish \
    --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app

ENV ASPNETCORE_URLS=http://0.0.0.0:8080
EXPOSE 8080

COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "zabbixbindings2cmdbuild.dll"]
