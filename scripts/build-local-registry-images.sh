#!/usr/bin/env bash
set -euo pipefail

registry="${REGISTRY:-localhost:5000}"
namespace="${NAMESPACE:-cmdb2monitoring}"
push_images="${PUSH:-true}"
context="${BUILD_CONTEXT:-.}"

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

for service in "${services[@]}"; do
  image="${registry}/${namespace}/${service}:${version}"
  latest="${registry}/${namespace}/${service}:latest"
  dockerfile="deploy/dockerfiles/${service}.Dockerfile"
  build_args=()
  if [[ "$service" == "monitoring-ui-api" ]]; then
    build_args=(--build-arg "APPLICATION_VERSION=${version}")
  fi

  docker build \
    "${build_args[@]}" \
    --file "${dockerfile}" \
    --tag "${image}" \
    --tag "${latest}" \
    "${context}"

  if [[ "${push_images}" == "true" ]]; then
    docker push "${image}"
    docker push "${latest}"
  fi
done
