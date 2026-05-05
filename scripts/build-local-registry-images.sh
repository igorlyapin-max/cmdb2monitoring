#!/usr/bin/env bash
set -euo pipefail

registry="${REGISTRY:-localhost:5000}"
namespace="${NAMESPACE:-cmdb2monitoring}"
version="${VERSION:-0.8.0}"
push_images="${PUSH:-true}"
context="${BUILD_CONTEXT:-.}"

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

  docker build \
    --file "${dockerfile}" \
    --tag "${image}" \
    --tag "${latest}" \
    "${context}"

  if [[ "${push_images}" == "true" ]]; then
    docker push "${image}"
    docker push "${latest}"
  fi
done
