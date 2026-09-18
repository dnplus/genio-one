# CE first-run demo

The primary CE demo is a governed documentation-to-product workflow. A fictional logistics company, Stellar Freight, uses Context7 for source-linked Next.js research and the bundled Product Management Bot to turn those findings into a concise product brief for its claims portal. Archify and Gemini are optional extensions, not prerequisites for the main story.

The CE Helm profile also enables a small, in-cluster Archify service. It listens only through its ClusterIP Service and requires a bearer token generated in the protected Helm values file. The token is never a browser setting or public endpoint.

After completing the [local installation](quickstart.md) or the [Helm installation](helm.md), sign in to Management and create or select an Organization. For Helm, wait for the post-install Job to complete first. Open **Overview**, choose the CE starter demo, and install it for that Organization. The installation creates the following governed entries:

- Context7 MCP for documentation lookup.
- Archify MCP for constrained architecture-diagram rendering.
- Google Gemini as an OpenAI-compatible model connection.
- The bundled Product Management Bot package.
- A Codex entry that opens the configured Genio Bot public origin.

The installer records an Organization-scoped installation. It can be safely repeated for the same Organization; selecting another Organization after installation requires an explicit operator decision.

The CE and local Helm profiles also configure Bot's GenioOne model directory with the demo Gemini public model. The Bot reaches the chart's internal AI Gateway listener, while its per-session Responses relay remains on the Bot service. Production deployments can provide their own `bot.modelGatewayBaseUrl`, `modelGatewayModels`, and `modelGatewayRelayOrigin`; do not point the chart at a developer loopback address.

## Configure the user-owned services

The first-run install creates the catalog entries, but does not place personal or provider credentials in the chart.

1. Open Genio Bot and sign in to Codex with the user's own account.
2. Confirm the Context7 connection from Management. Its public endpoint may be unavailable from restricted networks.
3. Open a Bot session using the bundled Product Management package. Ask it to research the Stellar Freight Claims Portal through managed Context7, then produce a product brief with verified source links.
4. Optionally configure Gemini and render a constrained diagram through Archify.

Archify accepts only its supported JSON diagram specifications. It does not expose shell execution, arbitrary paths, or an unauthenticated renderer endpoint.

## Optional Notion OAuth and Bot setup

Use this path when a recording needs a personal Notion connection. It configures access for the Bot user and leaves the Context7 and Product Management story unchanged.

1. An administrator publishes the Notion MCP Resource in Management.
2. The Bot user opens **Connections**, selects the Notion connection, chooses **Configure MCP tools**, then selects **Authorize**. Each user completes OAuth with that user's Notion account.
3. The administrator opens **Access** and uses **Grant Entitlement** for the same user and Notion Resource. Grant `mcp.invoke`, `notion-search`, and `notion-fetch`. Do not grant Notion write capabilities for this path.
4. The Bot user opens Bot settings, selects **Capabilities / tools**, finds Notion, and chooses **Add this Bot**. This binds the Resource to that Bot. Management evaluates the user's entitlement when the Bot requests a tool.

After you complete these steps, treat the connection and access scope as configured. Describe a Notion tool call as successful only after Bot displays a result and Management shows the matching Connection, Gateway revision, correlation ID, and Activity or audit record.

### English recording and a clean Bot

Open the CE task at `?demo=documents&lang=en`. Open an existing Bot roster with `?lang=en`.

For screenshots with an empty conversation, sign in as the Bot owner, open **Bot settings** for the existing CE Bot, select **Sharing & @**, and choose **Duplicate Bot**. Close and reopen settings on the selected copy before renaming it. The copy has a separate Bot ID and session while retaining the source package reference and Resource bindings. Keep the original Bot for its history. Record from the selected copy in the normal roster, because a fresh CE task load chooses the first matching package Bot. Do not use **Install my demo Bot** as a conversation reset.

## Suggested English demo brief

Use a fictional but operationally realistic case so the result can be shown without exposing customer data:

> Stellar Freight is a regional logistics company. Product owners Maya Chen and Jordan Lee need a first release of a claims portal for intake and review. Research the relevant Next.js App Router form and server-side validation guidance through the managed Context7 connection, then produce three implementation notes with verified source links.

Follow that research request with **Create the product brief**. Its prompt includes `@product-management:write-spec` so Bot supplies the installed skill content, not just its name. When writing your own request, select that skill from the composer's `@` menu. Ask for the problem statement, target users, user stories, in-scope requirements, acceptance criteria, and open questions. Keep the verified Context7 links in the final brief.

## Verify the path

Verify the visible result in Genio Bot, then inspect the corresponding Connection and Activity records in Management. A ready pod, a Helm render, or a catalog entry alone does not prove a usable tool path. Record the Organization, actor, connection revision, correlation ID, result, and matching audit evidence for the run. If a step behaves differently from this guide, record it in [Known issues and follow-ups](known-issues.md) with the observed state and a reproducible next step.
