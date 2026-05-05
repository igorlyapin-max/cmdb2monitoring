FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY global.json Directory.Build.props cmdb2monitoring.slnx ./
COPY src/zabbixrequests2api/zabbixrequests2api.csproj src/zabbixrequests2api/
RUN dotnet restore src/zabbixrequests2api/zabbixrequests2api.csproj

COPY src/zabbixrequests2api/ src/zabbixrequests2api/
RUN dotnet publish src/zabbixrequests2api/zabbixrequests2api.csproj \
    --configuration Release \
    --output /app/publish \
    --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app

ENV ASPNETCORE_URLS=http://0.0.0.0:8080
EXPOSE 8080

COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "zabbixrequests2api.dll"]
