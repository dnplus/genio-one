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

`GENIO_BOT_RUNTIME=local` is for local protocol development only. The `?demo=1` browser mode is a visual demo and does not execute an agent task. Set `GENIO_BOT_RUNTIME=e2b-self-hosted` or `cloudflare-hands` to choose the default remote Hands provider. Both require their own operated execution service; neither is required for the CE Platform and Gateway quickstart. See [Hands providers](docs/hands-providers.md) for configuration and workspace behavior.

This implementation pins each workspace to one provider and blocks new execution with `POLICY_PLACEMENT_CHANGED` when policy placement changes. Brain runtime replacement ([#79](https://github.com/dnplus/genioone-private/issues/79)) and a user-guided workspace migration at the next execution ([#80](https://github.com/dnplus/genioone-private/issues/80)) remain follow-up work.

## First governed capability

The supported introductory path uses the public DeepWiki MCP server, one selected tool, a policy and a time-bounded grant: [make the first MCP request](../../docs/public/ce/first-mcp-request.md). It does not require a Bot model subscription, private fixture, static bearer token, or provider credential.

## Develop Bot

Run focused checks from the workspace root:

```sh
pnpm --filter genio-one-bot typecheck
pnpm --filter genio-one-bot test
```

The Bot server API is under `/api`; development-only protocol bindings are generated with `pnpm --filter genio-one-bot generate:codex-protocol`. For the upstream protocol, see [Codex App Server](https://developers.openai.com/codex/app-server).
