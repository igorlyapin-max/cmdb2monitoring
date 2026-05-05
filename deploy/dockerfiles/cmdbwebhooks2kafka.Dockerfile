FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY global.json Directory.Build.props cmdb2monitoring.slnx ./
COPY src/cmdbwebhooks2kafka/cmdbwebhooks2kafka.csproj src/cmdbwebhooks2kafka/
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
ENTRYPOINT ["dotnet", "cmdbwebhooks2kafka.dll"]
