ARG NODE_RUNTIME_IMAGE=node:22-alpine

FROM ${NODE_RUNTIME_IMAGE} AS deps
WORKDIR /app

COPY src/monitoring-ui-api/package*.json ./
RUN npm ci --omit=dev

FROM ${NODE_RUNTIME_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=Production
ENV MONITORING_UI_HOST=0.0.0.0
ENV PORT=5090

EXPOSE 5090

RUN apk add --no-cache shadow \
 && groupadd --system --gid 10001 appgroup \
 && useradd --system --uid 10001 --gid appgroup --no-create-home --shell /usr/sbin/nologin appuser

COPY --from=deps /app/node_modules ./node_modules
COPY src/monitoring-ui-api/package*.json ./
COPY src/monitoring-ui-api/server.mjs ./server.mjs
COPY src/monitoring-ui-api/lib ./lib
COPY src/monitoring-ui-api/config ./config
COPY src/monitoring-ui-api/public ./public
COPY src/monitoring-ui-api/scripts ./scripts
RUN mkdir -p /app/state /app/data && chown -R appuser:appgroup /app
USER appuser
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:5090/ready >/dev/null || exit 1

CMD ["npm", "start"]

FROM runtime AS gkm-runtime-canonical
ARG APPLICATION_VERSION=0.0.0.0
ARG GIT_REVISION=unknown
ARG BUILD_PROVENANCE=verified
ARG SOURCE_STATE=clean
USER root
RUN test "$BUILD_PROVENANCE" = "verified" \
 && test "$GIT_REVISION" != "unknown" \
 && test "$SOURCE_STATE" = "clean" \
 && case "$APPLICATION_VERSION" in 0.0.0.0|[0-9][0-9].[0-9][0-9].[0-9][0-9].[0-9][0-9]) ;; *) echo "Invalid APPLICATION_VERSION: $APPLICATION_VERSION" >&2; exit 1 ;; esac \
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
 && case "$APPLICATION_VERSION" in 0.0.0.0|[0-9][0-9].[0-9][0-9].[0-9][0-9].[0-9][0-9]) ;; *) echo "Invalid APPLICATION_VERSION: $APPLICATION_VERSION" >&2; exit 1 ;; esac \
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
