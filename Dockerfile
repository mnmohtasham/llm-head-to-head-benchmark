# syntax=docker/dockerfile:1
# Model Duel in a container. Use docker-compose.yml to run it: docker compose up -d
#
# The same Node version as a native install, on glibc like most Linux desktops, so the controller
# measures the same way in both.
ARG NODE_IMAGE=node:22.22.2-trixie-slim

# Builds the page and the controller. Manifests first, so the dependency layer is reused until
# package-lock.json changes.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
COPY mock/package.json mock/
COPY e2e/package.json e2e/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# Only what the controller loads at run time: its bundle keeps fastify, @fastify/static, undici
# and zod outside, and everything of ours inside.
FROM ${NODE_IMAGE} AS runtime-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
COPY mock/package.json mock/
COPY e2e/package.json e2e/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DUEL_DATA_DIR=/app/data \
    DUEL_CLIENT_DIR=/app/client/dist \
    DUEL_IN_CONTAINER=1
WORKDIR /app
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
# Owned by the app's user, so a new volume mounted here starts writable.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server/dist/index.js"]
