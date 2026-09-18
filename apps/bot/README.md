# Genio Bot

Genio Bot is the optional browser client for governed agent work. It signs the user in through GenioOne and invokes only the Resources and Capabilities that the user can discover and use. The Platform remains the authority for Resources, Connections, Entitlements, One Policy, and Audit.

## Run it locally

Start the complete local stack from the workspace root by following the [CE quickstart](../../docs/public/ce/quickstart.md):

```sh
cp apps/platform/.env.example apps/platform/.env.local
cp apps/bot/.env.example apps/bot/.env.local
pnpm dev
```

Open http://127.0.0.1:5180/ and sign in with `admin` / `admin`. The browser is ready when it reaches the Bot workspace after sign-in. Use Management at http://127.0.0.1:5173/management to set up governed resources first.

`GENIO_BOT_RUNTIME=local` is for local protocol development only. The `?demo=1` browser mode is a visual demo and does not execute an agent task. Remote sandbox and desktop settings require a separately operated E2B-compatible environment; they are not required for the CE Platform and Gateway quickstart.

## First governed capability

The supported introductory path uses the public DeepWiki MCP server, one selected tool, a policy and a time-bounded grant: [make the first MCP request](../../docs/public/ce/first-mcp-request.md). It does not require a Bot model subscription, private fixture, static bearer token, or provider credential.

## Develop Bot

Run focused checks from the workspace root:

```sh
pnpm --filter genio-one-bot typecheck
pnpm --filter genio-one-bot test
```

The Bot server API is under `/api`; development-only protocol bindings are generated with `pnpm --filter genio-one-bot generate:codex-protocol`. For the upstream protocol, see [Codex App Server](https://developers.openai.com/codex/app-server).
