FROM oven/bun:1.4.0 AS build

WORKDIR /workspace
RUN bun add --global pnpm@10.32.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/platform/package.json apps/platform/package.json
COPY apps/connectors/package.json apps/connectors/package.json
COPY runtimes/gateway/package.json runtimes/gateway/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/policy/package.json packages/policy/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
RUN pnpm install --filter @genioone/gateway... --frozen-lockfile --filter genio-one... --filter genio-connectors...

COPY runtimes/gateway/controller runtimes/gateway/controller
COPY runtimes/gateway/services runtimes/gateway/services
COPY packages packages
COPY apps/platform/platform-api apps/platform/platform-api
COPY apps/connectors/configuration.ts apps/connectors/configuration.ts
RUN cd apps/platform \
    && bun build ../../runtimes/gateway/controller/server.ts --target=bun --outfile=../../runtimes/gateway/controller/dist/server.js

FROM debian:bookworm-slim AS kubectl
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.36.2
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && curl --fail --location --silent --show-error \
      --output /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
    && curl --fail --location --silent --show-error \
      --output /tmp/kubectl.sha256 \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256" \
    && echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum --check \
    && chmod 0755 /usr/local/bin/kubectl

FROM oven/bun:1.4.0

WORKDIR /opt/genio-one
COPY --from=kubectl /usr/local/bin/kubectl /usr/local/bin/kubectl
COPY --from=build --chown=bun:bun \
  /workspace/runtimes/gateway/controller/dist/server.js ./server.js

ENV NODE_ENV=production \
    GENIO_ONE_GATEWAY_APPLY_MODE=KUBERNETES \
    GENIO_ONE_KUBECTL=/usr/local/bin/kubectl

USER bun
CMD ["bun", "server.js"]
