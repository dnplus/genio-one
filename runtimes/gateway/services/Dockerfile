FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build

COPY --from=oven/bun:1.4.2-alpine /usr/local/bin/bun /usr/local/bin/bun

RUN corepack enable && corepack prepare pnpm@12.10.1 --activate

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY runtimes/gateway/package.json runtimes/gateway/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/policy/package.json packages/policy/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json

RUN pnpm install --filter @genioone/gateway... --frozen-lockfile

WORKDIR /workspace/apps/platform

COPY runtimes/gateway/services /workspace/runtimes/gateway/services
COPY packages /workspace/packages
COPY apps/platform/scripts/build-gateway-services.mjs ./scripts/build-gateway-services.mjs
COPY apps/connectors/mail2000/metadata.ts /workspace/apps/connectors/mail2000/metadata.ts

RUN bun scripts/build-gateway-services.mjs

FROM oven/bun:1.4.2-alpine

RUN addgroup -S -g 65532 genio \
  && adduser -S -D -H -u 65532 -G genio genio

WORKDIR /opt/genio-one
COPY --from=build --chown=65532:65532 \
  /workspace/runtimes/gateway/services/dist ./

USER 65532:65532

ENTRYPOINT ["bun"]
CMD ["authorizer.js"]
