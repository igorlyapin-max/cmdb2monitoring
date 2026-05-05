FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY global.json Directory.Build.props cmdb2monitoring.slnx ./
COPY src/cmdbkafka2zabbix/cmdbkafka2zabbix.csproj src/cmdbkafka2zabbix/
RUN dotnet restore src/cmdbkafka2zabbix/cmdbkafka2zabbix.csproj

COPY src/cmdbkafka2zabbix/ src/cmdbkafka2zabbix/
RUN dotnet publish src/cmdbkafka2zabbix/cmdbkafka2zabbix.csproj \
    --configuration Release \
    --output /app/publish \
    --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app

ENV ASPNETCORE_URLS=http://0.0.0.0:8080
EXPOSE 8080

COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "cmdbkafka2zabbix.dll"]
