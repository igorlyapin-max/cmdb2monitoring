#!/usr/bin/env bash
set -euo pipefail

registry="${REGISTRY:-localhost:5000}"
namespace="${NAMESPACE:-cmdb2monitoring}"
push_images="${PUSH:-true}"
context="${BUILD_CONTEXT:-.}"
build_target="${BUILD_TARGET:-}"
node_runtime_image="${NODE_RUNTIME_IMAGE:-node:22-alpine}"
dotnet_sdk_image="${DOTNET_SDK_IMAGE:-mcr.microsoft.com/dotnet/sdk:10.0}"
dotnet_runtime_image="${DOTNET_RUNTIME_IMAGE:-mcr.microsoft.com/dotnet/aspnet:10.0}"

phase() {
  printf '%s [cmdb2monitoring image build] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

if [[ -f VERSION ]]; then
  version="$(tr -d '\r\n' < VERSION)"
  [[ "$version" =~ ^[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[0-9]{2}$ ]] \
    || { echo "VERSION must have format XX.YY.ZZ.NN" >&2; exit 1; }
else
  version="0.0.0.0"
fi

if [[ -n "${VERSION:-}" && "${VERSION}" != "${version}" ]]; then
  echo "VERSION is derived from the root VERSION file; expected ${version}, got ${VERSION}" >&2
  exit 1
fi

services=(
  cmdbwebhooks2kafka
  cmdbkafka2zabbix
  zabbixrequests2api
  zabbixbindings2cmdbuild
  monitoring-ui-api
)

target_args=()
if [[ -n "$build_target" ]]; then
  target_args=(--target "$build_target")
fi

for service in "${services[@]}"; do
  image="${registry}/${namespace}/${service}:${version}"
  latest="${registry}/${namespace}/${service}:latest"
  dockerfile="deploy/dockerfiles/${service}.Dockerfile"
  build_args=()
  if [[ "$service" == "monitoring-ui-api" ]]; then
    build_args=(
      --build-arg "APPLICATION_VERSION=${version}"
      --build-arg "NODE_RUNTIME_IMAGE=${node_runtime_image}"
    )
  else
    build_args=(
      --build-arg "DOTNET_SDK_IMAGE=${dotnet_sdk_image}"
      --build-arg "DOTNET_RUNTIME_IMAGE=${dotnet_runtime_image}"
    )
  fi

  phase "build ${service}:${version}${build_target:+ target=${build_target}}"
  docker build \
    "${target_args[@]}" \
    "${build_args[@]}" \
    --file "${dockerfile}" \
    --tag "${image}" \
    --tag "${latest}" \
    "${context}"

  if [[ "${push_images}" == "true" ]]; then
    phase "push ${image} and ${latest}"
    docker push "${image}"
    docker push "${latest}"
  fi
done
