<a id="ce-first-run-demo"></a>

# CE first team workflow

This walkthrough starts a team workflow: use an Organization-owned Context7 Resource to research technical documentation, then turn the verified sources into a product brief in Genio Bot. It uses the fictional Stellar Freight Claims Portal and the included CE starter package. Archify and Gemini are optional extensions after the primary path works.

## 1. Prepare the Gateway path

Complete one installation path before opening a Bot task:

- **Local CE:** finish the [local quickstart](quickstart.md), then complete [local Gateway Runtime setup](../product/en/initial-setup.md#local-gateway-runtime). In **Runtimes**, confirm the registration is valid and its control channel is connected. Before the first Resource publication, the Runtime can correctly wait for a report; continue with the demo setup rather than waiting for `READY` at this point.
- **Helm:** complete the [Helm installation](helm.md), including the post-install Job and [first Management login](helm.md#first-management-login). The chart bootstraps the Gateway Runtime; do not run the standalone local Gateway bootstrap flow for this installation.

The demo installer publishes the first Context7 Resource. Once it has done so, wait for the Resource's Gateway revision to reach `READY` before sending the Bot task.

## 2. Install the CE Demo Project

In Management, create or select an Organization that you administer. On **Overview**, find **CE Demo Project**, choose **Install Demo**, and select that Organization. The starter material is scoped to that Organization and includes Context7, optional Archify and Gemini entries, and the Bot packages used by the tasks.

Review the status shown on the card after installation. Context7 must be verified, enabled, and published before the documentation-research task can use it. If the card shows a configuration or discovery prerequisite, resolve the indicated setup and use **Complete Demo setup** to retry it. The Context7 public endpoint can be unavailable from restricted networks. The installer does not add a user's personal or provider credentials.

<a id="configure-the-user-owned-services"></a>

## 3. Share the path with the team

The Resource and Connection belong to the selected Organization, so a technical champion can prepare the route once. Give each Person, Application, or Agent only the Capability it needs through the active Policy and Entitlement flow; access is evaluated for every caller. Do not treat a Connection or Organization membership as a user grant.

For a team-owned external service, configure the approved connection and credential at its owning boundary. For a personal OAuth connection, each person must complete that provider's authorization for their own account.

## 4. Run the first team task

1. In **CE Demo Project**, choose **Open Demo**, then choose **Open in Bot** under **Research technical documentation**.
2. Sign in to Codex with the user's own account when the Bot asks. Install the demo Bot on first use, or continue with the existing installed Bot.
3. Run the supplied task. It uses managed Discovery to find Context7, verifies the visible tools, and asks for three Next.js implementation notes with documentation sources.
4. Return to **Open Demo** and choose **Open in Bot** under **Create a product spec and diagram**. This opens the **Create the product brief** task in Bot. Continue with the installed Bot that has the research result; the supplied prompt selects the Product Management skill and retains verified sources in the brief.

If the documentation task identifies a missing Discovery, Resource, Connection, or tool configuration step, fix that path instead of treating an unmanaged substitute as completion.

<a id="suggested-english-demo-brief"></a>

## Optional custom brief prompt

Use a fictional but operationally realistic case when adapting the task without exposing customer data:

> Stellar Freight is a regional logistics company. Product owners Maya Chen and Jordan Lee need a first release of a claims portal for intake and review. Research the relevant Next.js App Router form and server-side validation guidance through the managed Context7 connection, then produce three implementation notes with verified source links.

Follow the research with a product brief that covers the problem statement, target users, user stories, in-scope requirements, acceptance criteria, and open questions. When writing your own request, select `@product-management:write-spec` from the composer's `@` menu to attach the installed skill. Keep verified Context7 links in the brief.

## Optional Archify and Gemini extensions

The CE Helm profile includes an in-cluster Archify service with a bearer token generated in the protected Helm values file. Archify accepts supported JSON diagram specifications. Use its managed MCP connection for diagram rendering after the primary workflow succeeds.

The CE and local Helm profiles also configure Bot's GenioOne model directory with the demo Gemini model. Configure provider credentials before using it. Bot reaches the chart's internal AI Gateway listener, while its per-session Responses relay stays on the Bot service. For a different deployment, set `bot.modelGatewayBaseUrl`, `bot.modelGatewayModels`, and `bot.modelGatewayRelayOrigin` to match that environment; see the [Helm guide](helm.md).

## Optional Notion OAuth and Bot setup

Use this path only when the team chooses to connect a personal Notion account. It is separate from the Context7 first-team workflow.

1. An administrator publishes the Notion MCP Resource in Management.
2. The Bot user opens **Connections**, selects the Notion connection, chooses **Configure MCP tools**, then selects **Authorize**. Each user completes OAuth with that user's Notion account.
3. The administrator opens **Access** and uses **Grant Entitlement** for the same user and Notion Resource. Grant `mcp.invoke`, `notion-search`, and `notion-fetch`. Do not grant Notion write capabilities for this path.
4. The Bot user opens Bot settings, selects **Capabilities / tools**, finds Notion, and chooses **Add this Bot**. This binds the Resource to that Bot. Management evaluates the user's entitlement when the Bot requests a tool.

Treat a Notion tool call as successful only after Bot displays a result and Management shows the matching Connection, Gateway revision, correlation ID, and Activity or Audit record.

<a id="english-recording-and-a-clean-bot"></a>

### Optional recording preparation

These steps are only for preparing screenshots or a recording. They do not configure access or complete the team workflow.

Open the CE task at `?demo=documents&lang=en`. Open an existing Bot roster with `?lang=en`.

For an empty conversation, sign in as the Bot owner, open **Bot settings** for the existing CE Bot, select **Sharing & @**, and choose **Duplicate Bot**. Close and reopen settings on the selected copy before renaming it. The copy has a separate Bot ID and session while retaining the source package reference and Resource bindings. Keep the original Bot for its history. Use the selected copy in the normal roster, because a fresh CE task load chooses the first matching package Bot. Do not use **Install my demo Bot** as a conversation reset.

## Verify the path

Confirm the visible result in Genio Bot, then inspect the matching Connection and Activity or Audit record in Management. A ready pod, Helm render, or catalog entry alone does not prove a usable tool path. If a step differs from this guide, record the observed state and a reproducible next step in [Known issues and follow-ups](known-issues.md).
