# Codex app-server ownership boundary

Genio Bot pins Codex CLI/app-server `0.153.4` to upstream tag `rust-v0.153.4` and commit
`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`. The executable and the generated
TypeScript protocol must move together.

## Owned by Codex app-server

- Codex account login, logout, usage, and rate limits
- model and model-provider discovery; the Bot selects a route from the server
  model directory and passes native `modelProvider` when a custom provider is configured
- thread, turn, item, history, search, archive, resume, and interruption lifecycle
- command, file-change, permission, MCP tool, and elicitation approvals
- filesystem and process operations inside the runtime workspace
- Streamable HTTP MCP connection, bearer authentication, status, resources,
  tool calls, progress, and tool-call lifecycle events
- MCP tool exposure and per-tool approval modes

Genio Bot may render and answer these protocol messages. It must not define a
parallel lifecycle, approval vocabulary, MCP client, or persistence model.

## Owned by GenioOne

- enterprise OIDC identity and acting-client binding
- the `one.<domain>/mcp` subject surface
- entitlement, auto-grant, requestability, approval, and revocation semantics
- Resource and Capability publication into the One MCP tool surface
- ServiceNow Case and later enterprise-system capabilities
- policy, audit, correlation, and runtime evidence
- runtime entitlement, policy, lifecycle intent, and business correlation
- product onboarding and the minimal rich-client presentation

## Managed Desktop ownership

The Genio Bot backend is the T3 Runtime Broker. After GenioOne validates the
browser token, the broker binds the canonical tenant, Subject, acting client,
and a server-generated runtime session to exactly one runtime provider. It owns
create and terminate orchestration plus the subject-to-sandbox mapping. It does
not perform placement or run a VM itself.

The Codex app-server and its `CODEX_HOME` run in the Genio Bot server boundary.
The browser reconnects to a new app-server transport while the server-owned
account and thread data remains available for resume.

The customer-local self-hosted E2B control plane owns placement, quota
enforcement, sandbox routing, and the Orchestrator call. The E2B data plane owns
the Firecracker Desktop, filesystem, browser traffic, process execution, and
artifacts. E2B runs only the native `codex exec-server`, which app-server selects
through the upstream `environment/add` and thread/turn environment contracts.
Those payloads do not traverse the GenioOne management plane.

The browser and Codex app-server never receive the E2B API credential. The
browser receives only the authenticated desktop stream URL and opaque runtime
and sandbox identifiers needed for display and correlation.

## Walking skeleton

1. The browser completes GenioOne OIDC.
2. The Bot server verifies the access token and the Personal Bot Entitlement
   (`personal_bot.use`) before opening a session.
3. The Bot server starts the pinned `codex app-server` with a server-owned
   `CODEX_HOME`. Chat and One MCP do not wait for a sandbox.
4. The first remote exec need provisions a user-scoped self-hosted E2B sandbox
   that starts only `codex exec-server`. Managed Desktop is a separate
   `personal_bot.computer_use` Capability.
5. The Bot registers that executor through `environment/add` and selects it for
   the thread and each turn.
6. App-server connects to `GENIO_ONE_MCP_URL` through native
   `mcp_servers.genio_one` configuration.
7. The verified GenioOne access token is exposed only to server-side app-server
   through `bearer_token_env_var`; the sandbox never receives it.
8. The Bot starts or resumes a model present in the selected route catalog.
   A saved selection takes precedence; the Codex subscription route prefers
   GPT-5.3-Codex-Spark when available. An empty catalog keeps the composer blocked.
   MCP availability is independent of the model loop, so an unavailable Resource
   tool never disables ordinary chat.
9. The Bot renders app-server turn, item, tool, progress, and approval events.

`default_tools_approval_mode="writes"` lets read-only tools run directly while
write tools use app-server's approval path.

The live runtime bridge smoke registers an E2B `codex exec-server` with
server-side app-server and reads `file:///home/user` plus the remote Bash shell
through `environment/info`. The ServiceNow Connection fixture is published as
`servicenow__read_case` behind the One MCP AI Gateway route; a Bot turn must
still prove the complete tool call and correlated Activity/Audit before the
walking skeleton is sealed.

## Remaining product boundaries

- `one.<domain>/mcp` is the Gateway-owned aggregate route used by the Bot.
  Subject-filtered Resource tools must continue to be published there; the Bot
  server does not proxy or bypass the Connection fixture.
- The ServiceNow Case golden path needs a real published Resource, connection,
  subject entitlement, visible tool call, outcome, and correlated audit record.
- Multi-replica ownership still needs a durable runtime-session lease rather
  than the current single-process subject-to-runtime map.
- Bot package bytes are materialized in the Bot server file store for the
  showcase; production can move that store to GCS/MinIO without changing
  BotBinding digests or native app-server installation calls.
- Cross-owner invocation uses a server-only agent credential exchange. The
  exchanged token starts a short-lived server-side target app-server in
  production and is never exposed to the browser or E2B. Development without
  `GENIO_ONE_AGENT_TOKEN_EXCHANGE_URL` can bind an already authenticated owner
  session as a local fixture path.
- The short-lived browser access token currently seeds the app-server MCP
  connection. Production needs a server-owned delegated token refresh path
  without placing a refresh token in E2B.

## Audited upstream source at the original 0.151.0 boundary

- [MCP app-server request processing](https://github.com/openai/codex/blob/78c290807ce710180111df227df3b7a4fe845452/codex-rs/app-server/src/request_processors/mcp_processor.rs)
- [MCP app-server protocol](https://github.com/openai/codex/blob/78c290807ce710180111df227df3b7a4fe845452/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs)
- [MCP configuration](https://github.com/openai/codex/blob/78c290807ce710180111df227df3b7a4fe845452/codex-rs/config/src/mcp_types.rs)
- [MCP tool call and approval lifecycle](https://github.com/openai/codex/blob/78c290807ce710180111df227df3b7a4fe845452/codex-rs/core/src/mcp_tool_call.rs)
- [Thread request processing](https://github.com/openai/codex/blob/78c290807ce710180111df227df3b7a4fe845452/codex-rs/app-server/src/request_processors/thread_processor.rs)
- [Remote exec-server contract](https://github.com/openai/codex/blob/78c290807ce710180111df227df3b7a4fe845452/codex-rs/exec-server/README.md)
- [Environment add protocol](https://github.com/openai/codex/blob/78c290807ce710180111df227df3b7a4fe845452/codex-rs/app-server-protocol/src/protocol/v2/environment.rs)

## 0.153.4 upgrade verification

The Docker runtime, E2B exec-server default, local development dependency, and
upstream manifest are pinned to 0.153.4. Run protocol generation through the Bot
package script so it resolves the package-owned executable rather than a global
CLI. The checked-in protocol already matched this release and regeneration was
byte-identical. See [upgrade comparison](codex-app-server-upgrade-20260908.md) for
verified behavior and remaining deployment boundaries.
