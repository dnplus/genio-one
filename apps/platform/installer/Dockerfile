FROM debian:bookworm-slim AS kubectl
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.36.4
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

FROM oven/bun:1.4.2

WORKDIR /opt/genio-one
COPY apps/platform/scripts/deployment-post-install.mjs ./scripts/deployment-post-install.mjs
COPY apps/platform/scripts/gateway-runtime-ownership-migration.mjs ./scripts/gateway-runtime-ownership-migration.mjs
COPY apps/platform/scripts/environment.mjs ./scripts/environment.mjs
COPY apps/platform/config/keycloak/genio-one-realm.json ./config/keycloak/genio-one-realm.json
COPY --from=kubectl /usr/local/bin/kubectl /usr/local/bin/kubectl

USER bun
ENV GENIO_ONE_DISABLE_DOTENV=1
ENTRYPOINT ["bun", "/opt/genio-one/scripts/deployment-post-install.mjs"]
