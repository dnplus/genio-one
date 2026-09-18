# GenioOne Platform

Platform is the GenioOne control plane. It owns the Management UI, Product API, Resource and Connection lifecycle, entitlement and policy decisions, Gateway publication, Activity, and Audit. Gateway and Bot workloads use published state; they do not write the Platform database directly. Self-service is a Platform Web UI surface, not a fourth deployable.

## Run locally

Use the workspace-level [CE quickstart](../../docs/public/ce/quickstart.md). It includes prerequisites, local URLs, successful-start conditions, and the service lifecycle commands.

From the repository root, create the local environment files once and start the supervisor:

```sh
cp apps/platform/.env.example apps/platform/.env.local
cp apps/bot/.env.example apps/bot/.env.local
pnpm dev
```

Management is at http://127.0.0.1:5173/management and the local test account is `admin` / `admin`. The Product API is at http://127.0.0.1:58082; its interactive contracts are `/openapi.json` and `/docs`.

The next user path is [local Gateway setup](../../docs/public/product/en/initial-setup.md#local-gateway-runtime), then [a first governed MCP request](../../docs/public/ce/first-mcp-request.md).

## Work on Platform

The application code is in `platform-api/` and `platform-web/`; `config/` holds local development configuration. Run focused checks from this directory:

```sh
bun run typecheck
bun run test
bun run check
```

`pnpm dev clean` is a separate, interactive local-test-data cleanup command. It does not run as part of normal startup; read the prompt before confirming it.

For architecture terminology, see [CONTEXT.md](CONTEXT.md). Product guides are under [docs/public/product](../../docs/public/product/README.md).
