# CE local quickstart

## Before you start

Use a Linux or macOS host with Docker Engine and Docker Compose available to your user, Git, Node.js, pnpm `12.4.2`, and Bun `1.4.2`. The local Gateway Runtime downloads the native Envoy AI Gateway binary; its supported host combinations are Linux or macOS (`darwin`) on `x64` or `arm64`.

Windows users should use a supported Linux environment with Docker access. Check the tools before installing:

```sh
node --version
pnpm --version
bun --version
docker version
docker compose version
```

## Start the stack

Choose the installation scope before starting. The local quickstart uses one set of fixed service addresses and the Docker Compose project `genio-one-dev`. A new directory, Git checkout, or Docker context pointing at the same daemon does not create an independent installation.

For a **new independent installation**, use a separate Linux or macOS host, or a Linux VM with its own Docker daemon and loopback network. Run the commands below inside that environment and open Management in a browser inside the same environment. Do not mount another installation's Docker socket, named volumes, `.env.local` files, or `.local` state. This keeps the existing host's services and data available while the new installation uses the documented addresses. Simultaneous independent installations sharing one host's loopback ports are outside this quickstart's scope.

Clone the CE repository, install dependencies, and create local-only environment files. Do not commit either `.env.local` file.

```sh
git clone https://github.com/dnplus/genio-one.git
cd genio-one
pnpm install --frozen-lockfile
cp apps/platform/.env.example apps/platform/.env.local
cp apps/bot/.env.example apps/bot/.env.local
pnpm dev
```

`pnpm dev` checks the existing supporting resources before creating local keys, starting containers, or launching applications. It starts or reuses this checkout's local Keycloak, brings up the analytics Compose profile, then supervises Platform API and Web, Bot server and Web, and the included local support processes. Resources belonging to another checkout, unknown retained volumes, incompatible configuration, and occupied service addresses stop startup with a diagnostic. A successful identity discovery response alone does not establish installation ownership. The first run may take time to pull container images. It prints `local-dev.ready` after the supervised application services pass their health checks.

Open these local endpoints:

| Service | Address |
| --- | --- |
| Identity | http://127.0.0.1:58080 |
| Management | http://127.0.0.1:5173/management |
| Platform API | http://127.0.0.1:58082 |
| Genio Bot | http://127.0.0.1:5180/ |

Sign in to Management with `admin` / `admin`. The local stack is ready when Management reaches its home after sign-in and `http://127.0.0.1:58082/healthz` returns `status: "ok"`.

Before a governed MCP or Bot tool call, complete [local Gateway Runtime setup](../product/en/initial-setup.md#local-gateway-runtime). It registers and starts the local Runtime. A newly registered Runtime can correctly wait for its first published release; after a Resource is published, wait for the Gateway revision to reach `READY` before sending traffic.

## Share an existing development installation

Use this path only when another checkout is intentionally using the same development identity and data. This is a shared installation, so its existing accounts and records remain visible; it is not a clean-install validation.

Start the supporting services from their owning checkout first. Configure this checkout's `.env.local` files for that installation, then run:

```sh
pnpm dev --reuse-support
```

The explicit option still checks the supporting services and identity configuration. Shared services must already be running and compatible; this checkout does not reconcile or restart their Compose project. If validation fails, correct the configuration or start the missing services from the owning checkout, then retry.

Only one checkout can run the application services on the documented local addresses at a time. Stop the previous application's supervisor before switching checkouts; keep its supporting containers running. Use the owning checkout for support-service changes and `env:down`, and do not use `pnpm dev clean` to establish an independent installation.

## Stop, restart, and inspect

Press `Ctrl-C` in the terminal running `pnpm dev` to stop the application supervisor. The Docker support services intentionally remain available so a later `pnpm dev` can reuse their data.

Run these commands from `apps/platform` when you need the service state:

```sh
pnpm env:status
pnpm env:logs
pnpm env:down
```

`env:down` stops the Docker support services. Start them again by running `pnpm dev` from the repository root. `pnpm dev clean` is different: it is an interactive local-test-data cleanup command that displays its scope and requires the literal confirmation `CLEAN LOCAL GENIO DATA` before removing anything.

## Data that persists

Docker named volumes retain PostgreSQL, Valkey, identity, and analytics data across restarts. Local Runtime state is stored under `apps/platform/.local/`. The ignored `apps/platform/.local/support-ownership.json` records this checkout's supporting-volume identities so `pnpm dev` can recognize them after `env:down` removes the containers. Preserve that file with the installation; do not copy it to claim another environment's volumes. Keep the Gateway bootstrap JSON and provider credentials out of source control. To reset local test data, use only the reviewed `pnpm dev clean` flow; ordinary restart and `env:down` do not clear it.
