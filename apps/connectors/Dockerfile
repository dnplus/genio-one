FROM oven/bun:1.4.0 AS build
WORKDIR /workspace
RUN bun add --global pnpm@10.32.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/platform/package.json apps/platform/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY apps/connectors/package.json apps/connectors/package.json
COPY runtimes/endpoint/package.json runtimes/endpoint/package.json
COPY runtimes/gateway/package.json runtimes/gateway/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/policy/package.json packages/policy/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
RUN pnpm install --frozen-lockfile --filter genio-connectors...
COPY apps/connectors apps/connectors
COPY runtimes/gateway/services/shared runtimes/gateway/services/shared
COPY packages packages
RUN bun build apps/connectors/servicenow-csm/main.ts --target=bun --outfile=dist/servicenow-csm.js \
    && bun build apps/connectors/mail2000/main.ts --target=bun --outfile=dist/mail2000.js
FROM oven/bun:1.4.0
WORKDIR /app
COPY --from=build --chown=bun:bun /workspace/dist ./
USER bun
ENV CONNECTOR_HOST=0.0.0.0
CMD ["bun", "servicenow-csm.js"]
