FROM node:22-alpine AS deps
WORKDIR /app

COPY src/monitoring-ui-api/package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=Production
ENV MONITORING_UI_HOST=0.0.0.0
ENV PORT=5090

EXPOSE 5090

RUN addgroup -S appgroup && adduser -S -G appgroup appuser

COPY --from=deps /app/node_modules ./node_modules
COPY src/monitoring-ui-api/package*.json ./
COPY src/monitoring-ui-api/server.mjs ./server.mjs
COPY src/monitoring-ui-api/config ./config
COPY src/monitoring-ui-api/public ./public
COPY src/monitoring-ui-api/scripts ./scripts
RUN mkdir -p /app/state /app/data && chown -R appuser:appgroup /app
USER appuser
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:5090/health >/dev/null || exit 1

CMD ["npm", "start"]
