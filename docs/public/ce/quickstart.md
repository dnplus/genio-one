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

Clone the CE repository, install dependencies, and create local-only environment files. During private review, use a GitHub account with repository access. Do not commit either `.env.local` file.

```sh
git clone https://github.com/dnplus/genio-one.git
cd genio-one
pnpm install --frozen-lockfile
cp apps/platform/.env.example apps/platform/.env.local
cp apps/bot/.env.example apps/bot/.env.local
pnpm dev
```

`pnpm dev` starts or verifies the local identity and supporting containers, then starts Platform API, Platform Web, Bot server, and Bot Web. The first run may take time to pull container images. It prints a `local-dev.ready` event after all application services pass their health checks.

Open these local endpoints:

| Service | Address |
| --- | --- |
| Identity | http://127.0.0.1:58080 |
| Management | http://127.0.0.1:5173/management |
| Platform API | http://127.0.0.1:58082 |
| Genio Bot | http://127.0.0.1:5180/ |

Sign in to Management with `admin` / `admin`. A successful quickstart reaches the Management home after sign-in and returns `status: "ok"` from `http://127.0.0.1:58082/healthz`. Next, complete [local Gateway Runtime setup](../product/en/initial-setup.md#local-gateway-runtime).

## Stop, restart, and inspect

Press `Ctrl-C` in the terminal running `pnpm dev` to stop the application supervisor. The Docker support services intentionally remain available so a later `pnpm dev` can reuse their data.

Run these commands from `apps/platform` when you need the service state:

```sh
pnpm env:status
pnpm env:logs
pnpm env:down
```

`env:down` stops the Docker support services. Start them again by running `pnpm dev` from the repository root. `pnpm dev clean` is different: it is an interactive local-test-data cleanup command and will display its scope and require the literal confirmation before it removes anything.

## Data that persists

Docker named volumes retain PostgreSQL, Valkey, identity, and analytics data across restarts. Local Runtime state is stored under `apps/platform/.local/`. Keep the Gateway bootstrap JSON and provider credentials out of source control. To reset local test data, use only the reviewed `pnpm dev clean` flow; ordinary restart and `env:down` do not clear it.
