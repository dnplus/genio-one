FROM oven/bun:1.4.2 AS build

WORKDIR /workspace

RUN bun add --global pnpm@12.4.2

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/connectors/package.json apps/connectors/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
RUN pnpm install --frozen-lockfile --filter genio-connectors...

COPY apps/connectors/archify apps/connectors/archify
RUN bun build apps/connectors/archify/main.ts --target=bun --outfile=dist/archify.js

FROM oven/bun:1.4.2 AS runtime

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && chown -R 1000:1000 /app

COPY --from=build --chown=1000:1000 /workspace/dist/archify.js ./archify.js
COPY --from=build --chown=1000:1000 /workspace/apps/connectors/archify/vendor ./vendor

USER 1000:1000

ENV NODE_ENV=production \
    CONNECTOR_HOST=127.0.0.1 \
    CONNECTOR_PORT=5193 \
    ARCHIFY_NODE_EXECUTABLE=/usr/bin/node

EXPOSE 5193
CMD ["bun", "archify.js"]
