# Initial setup

## Community Edition paths

For a new local CE installation, start with the [CE quickstart](../../ce/quickstart.md). It covers prerequisite checks, startup, local URLs, logs, restart, and what local data is retained. Then follow [the first governed MCP request](../../ce/first-mcp-request.md). For a Kubernetes deployment, use the [CE Helm guide](../../ce/helm.md); build and publish images to a registry you control before installing.

Use the Management Console setup guide to establish durable Tenant evidence in this order:

1. Confirm enterprise sign-in and a recovery Tenant Administrator.
2. Connect or maintain the directory and local accounts.
3. Define Organization boundaries and delegated roles.
4. Register the required Gateway deployments.
5. Create governed Resources and attach usable Connections.
6. Publish a baseline One Policy.
7. Verify one attributed request across Activity and Audit.

## Local Gateway runtime

The local runtime runs the same Gateway Runtime controller and native Envoy AI Gateway binary used by the product release path. It is for local development and configuration validation. Kubernetes and Gateway API remain the supported production deployment path.

1. From the repository root, copy `apps/platform/.env.example` to `apps/platform/.env.local` if it does not already exist. Before starting the Platform, add the following local-only publication setting when you will publish to `localhost` or a `*.localhost` hostname:

   ```dotenv
   GENIO_ONE_PUBLICATION_DNS_ALLOW_LOCALHOST=1
   ```

   This local verifier accepts only `localhost` and `*.localhost` with a loopback DNS target. Leave the setting unset when publishing to other hostnames so the standard DNS verifier is used. Then start the local platform:

   ```bash
   pnpm dev
   ```

   If an earlier `pnpm dev` process is already running, stop that supervisor completely before restarting it. Startup seeds the local Bot Resource and Connection from the configured service endpoint; an already-running Platform API does not repeat that bootstrap.

2. Open [Management Console](http://127.0.0.1:5173/management) and sign in with `admin` / `admin`. In **Runtimes**, select **Register Gateway**, enter a local display name, site, and region, then save the one-time bootstrap configuration before closing the sheet. It contains the dedicated runtime OIDC client credential and cannot be retrieved from the UI later.

3. Save the copied JSON under the ignored local directory with mode `0600`. Replace the placeholder with a descriptive runtime name.

   ```bash
   mkdir -p apps/platform/.local/gateway-bootstrap
   umask 077
   $EDITOR apps/platform/.local/gateway-bootstrap/<runtime-name>.json
   chmod 600 apps/platform/.local/gateway-bootstrap/<runtime-name>.json
   ```

4. Install the Envoy AI Gateway binary pinned by `apps/platform/config/ai-mcp-gateway/provider-versions.env`. The installer downloads the official release only when needed, verifies its published SHA-256 digest, and stores it in ignored local state.

   ```bash
   pnpm --filter genio-one gateway:install:local
   ```

5. Start the Gateway Runtime with the saved OIDC bootstrap:

   ```bash
   pnpm --filter genio-one gateway:start:local -- \
     --bootstrap apps/platform/.local/gateway-bootstrap/<runtime-name>.json
   ```

   The launcher requires that path to be an ignored regular file with mode `0600`, uses `apps/platform/.local/aigw/current/aigw`, and creates separate absolute runtime state at `apps/platform/.local/gateway-runtime/<runtime-id>`. On the first release it prepares Envoy through the native AIGW CLI in a stable, runtime-private cache; later releases reuse the verified cache. Preparation has a separate 10-minute timeout, configurable with `GENIO_ONE_AIGW_DOWNLOAD_TIMEOUT_SECONDS` from `1` through `3600`, so it is not limited by normal Gateway readiness. A failed or interrupted staged download is never adopted. Each native AIGW child receives an owned `0700` short-lived runtime directory outside the checkout for its Unix socket, then removes it after the child exits. It maps the existing local `GENIO_ONE_VALKEY_URL` to the Gateway sidecars' `GENIO_ONE_VALKEY_ORIGIN`, and keeps a generated 32-byte token-vault key at `apps/platform/.local/gateway-runtime/keys/token-vault.key` with mode `0600`, so encrypted local token entries remain readable after restart. A secret-manager `GENIO_ONE_TOKEN_VAULT_KEY` override must be a base64-encoded 32-byte key. It does not create a Control Plane, mint a static runtime token, or install fixture principals. The bootstrap supplies the Platform API origin and the runtime's OIDC client credentials.

6. Return to **Runtimes** in Management Console. The registered runtime should synchronize its capability and current release status. Publish a release and confirm its revision reaches `READY` before sending a governed request.

If a published local release references credential material, provide only the required local secret values through `GENIO_ONE_LOCAL_CREDENTIALS_JSON` from your local secret manager or terminal environment. Do not put provider credentials or the bootstrap JSON in tracked files. The controller starts its local authorizer and processor children on loopback ports when a release needs them; do not configure separate Control Plane host or static identity variables. The runtime defaults to admin port `1064`, listener port `1975`, and observation port `9090`; set `GENIO_ONE_AIGW_ADMIN_PORT`, `GENIO_ONE_AIGW_LISTENER_PORT`, or `GENIO_ONE_GATEWAY_OBSERVATION_PORT` before starting only when a local port is already occupied. Configure `GENIO_ONE_GATEWAY_OTEL_HOST` and its ports only when local telemetry collection is required.

## Before production

Use the Kubernetes installation and post-install flow for production, upgrades, rollback, fleet readiness, and Gateway API reconciliation. Do not treat a standalone local Gateway health check as Kubernetes deployment evidence.

- Replace all placeholder endpoints and credentials.
- Confirm runtime health and configuration revision status.
- Verify recovery access before enforcing enterprise sign-in.
