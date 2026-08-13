#!/usr/bin/env bash
set -euo pipefail

registry="${REGISTRY:-localhost:5000}"
namespace="${NAMESPACE:-cmdb2monitoring}"
push_images="${PUSH:-true}"
context="${BUILD_CONTEXT:-.}"
delivery_mode="${DELIVERY_MODE:-manual}"
node_runtime_image="${NODE_RUNTIME_IMAGE:-node:22-alpine}"
dotnet_sdk_image="${DOTNET_SDK_IMAGE:-mcr.microsoft.com/dotnet/sdk:10.0}"
dotnet_runtime_image="${DOTNET_RUNTIME_IMAGE:-mcr.microsoft.com/dotnet/aspnet:10.0}"

phase() {
  printf '%s [cmdb2monitoring image build] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [[ -f VERSION ]]; then
  version="$(tr -d '\r\n' < VERSION)"
  [[ "$version" =~ ^[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[0-9]{2}$ ]] \
    || fail "VERSION must have format XX.YY.ZZ.NN"
else
  version="0.0.0.0"
fi

if [[ -n "${VERSION:-}" && "${VERSION}" != "${version}" ]]; then
  fail "VERSION is derived from the root VERSION file; expected ${version}, got ${VERSION}"
fi

case "$delivery_mode" in
  manual)
    build_target="${BUILD_TARGET:-gkm-runtime}"
    [[ "$build_target" == "gkm-runtime" ]] || fail "Manual images must use BUILD_TARGET=gkm-runtime."
    git_revision="${GIT_REVISION:-unknown}"
    provenance="unverified-local"
    source_state="dirty-or-unverified"
    ;;
  canonical)
    [[ "$push_images" == "true" ]] || fail "Canonical delivery requires PUSH=true."
    [[ "$version" != "0.0.0.0" ]] || fail "Canonical delivery requires a versioned root VERSION file."
    [[ -z "${BUILD_TARGET:-}" || "$BUILD_TARGET" == "gkm-runtime-canonical" ]] \
      || fail "Canonical delivery requires BUILD_TARGET=gkm-runtime-canonical."
    [[ -z "$(git status --porcelain --untracked-files=all)" ]] \
      || fail "Canonical delivery requires a clean source tree."
    git_revision="${GIT_REVISION:-$(git rev-parse HEAD)}"
    [[ "$git_revision" =~ ^[0-9a-fA-F]{40}$ ]] || fail "Canonical delivery requires a full 40-character Git revision."
    build_target="gkm-runtime-canonical"
    provenance="verified"
    source_state="clean"
    ;;
  *)
    fail "DELIVERY_MODE must be manual or canonical."
    ;;
esac

services=(
  cmdbwebhooks2kafka
  cmdbkafka2zabbix
  zabbixrequests2api
  zabbixbindings2cmdbuild
  monitoring-ui-api
)

verify_image_identity() {
  local image="$1"
  local embedded_version image_version image_revision image_provenance image_source_state image_user
  phase "image identity extraction ${image}"
  embedded_version="$(docker run --rm --entrypoint cat "$image" /app/VERSION)"
  image_version="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$image")"
  image_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
  image_provenance="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.provenance" }}' "$image")"
  image_source_state="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.source-state" }}' "$image")"
  image_user="$(docker image inspect --format '{{ .Config.User }}' "$image")"
  [[ "$embedded_version" == "$version" ]] || fail "$image embedded VERSION does not match $version."
  [[ "$image_version" == "$version" ]] || fail "$image OCI version does not match $version."
  [[ "$image_revision" == "$git_revision" ]] || fail "$image OCI revision does not match expected revision."
  [[ "$image_provenance" == "$provenance" ]] || fail "$image OCI provenance does not match $provenance."
  [[ "$image_source_state" == "$source_state" ]] || fail "$image OCI source state does not match $source_state."
  [[ "$image_user" == "appuser" ]] || fail "$image must run as appuser, got '${image_user:-<empty>}'."
}

if [[ "$delivery_mode" == "canonical" && "${GKM_CA_PROFILE_ENABLED:-false}" == "true" ]]; then
  phase "customer CA preflight"
  GKM_NODE_RUNTIME_IMAGE="$node_runtime_image" \
    GKM_DOTNET_RUNTIME_IMAGE="$dotnet_runtime_image" \
    ./scripts/verify-gkm-base-trust.sh
fi

for service in "${services[@]}"; do
  image="${registry}/${namespace}/${service}:${version}"
  dockerfile="deploy/dockerfiles/${service}.Dockerfile"
  build_args=(
    --build-arg "APPLICATION_VERSION=${version}"
    --build-arg "GIT_REVISION=${git_revision}"
    --build-arg "BUILD_PROVENANCE=${provenance}"
    --build-arg "SOURCE_STATE=${source_state}"
  )
  if [[ "$service" == "monitoring-ui-api" ]]; then
    build_args+=(--build-arg "NODE_RUNTIME_IMAGE=${node_runtime_image}")
  else
    build_args+=(
      --build-arg "DOTNET_SDK_IMAGE=${dotnet_sdk_image}"
      --build-arg "DOTNET_RUNTIME_IMAGE=${dotnet_runtime_image}"
    )
  fi

  phase "image build ${service}:${version} target=${build_target}; dependencies execute inside Docker"
  docker build \
    --target "$build_target" \
    "${build_args[@]}" \
    --file "$dockerfile" \
    --tag "$image" \
    "$context"

  verify_image_identity "$image"
  if [[ "$delivery_mode" == "canonical" ]]; then
    phase "runtime smoke ${service}:${version}"
    IMAGE="$image" SERVICE="$service" ./scripts/smoke-service-image.sh
  fi

  if [[ "$push_images" == "true" ]]; then
    phase "registry push ${image}"
    docker push "$image"
    if [[ "$delivery_mode" == "manual" ]]; then
      latest="${registry}/${namespace}/${service}:latest"
      phase "registry push ${latest} (unverified-local convenience tag)"
      docker tag "$image" "$latest"
      docker push "$latest"
    else
      digest="$(docker image inspect --format '{{ index .RepoDigests 0 }}' "$image")"
      [[ "$digest" == *@sha256:* ]] || fail "Canonical image $image has no registry digest after push."
      phase "registry digest ${digest}"
    fi
  fi
done
