# GenioOne Community Edition

[繁體中文](README.zh-TW.md)

GenioOne Community Edition (CE) helps teams use shared tools and models to complete work, with access and request history managed in one place. It is for developers, small teams, and technical champions who can deploy services and connect resources they manage or have approval to use.

CE provides the source code for the Platform control plane, Gateway Runtime, and Genio Bot. You build and run the services on your own infrastructure.

## Start a first team workflow

1. Follow the [local quickstart](quickstart.md) to start CE and reach Management.
2. Complete [local Gateway Runtime setup](../product/en/initial-setup.md#local-gateway-runtime). A newly registered Runtime waits for its first published release; it can reach `READY` after the demo Resource is published.
3. Follow the [first team workflow](demo.md) to install the Organization-scoped starter materials and run the Context7 documentation-research task, then turn its verified sources into a product brief.
4. Confirm the Bot result and its matching Activity or Audit record. For a direct MCP caller, use the separate [first governed MCP request](first-mcp-request.md).

The workflow uses the fictional Stellar Freight Claims Portal, so you can try it before connecting your team's project data.

## Work as a team

A technical champion can publish resources for the team, then reuse them across Bots while managing connection setup centrally. Each caller uses its own access permissions; services that require personal accounts still need each user's authorization. See the [product overview](../product/en/overview.md) for the Resource and access model.

Start with the included Genio Bot, or follow the [MCP request guide](first-mcp-request.md) for a client that supports the published endpoint's transport and authentication.

## Scope and prerequisites

You provide the host, supporting containers, provider credentials, connection approvals, and access to external services. CE does not contain provider secrets.

For the local path, use a Linux or macOS host with Docker Engine, Docker Compose, Git, Node.js, pnpm `12.4.2`, and Bun `1.4.2`. The [Quickstart](quickstart.md) has the complete local prerequisites, service addresses, and restart instructions. For Kubernetes, build and publish images to a registry your cluster can pull from, then use [Helm](helm.md).

## Guides

- [First team workflow](demo.md) installs the CE starter materials for one Organization and runs the Context7-to-product-brief example in Genio Bot.
- [First governed MCP request](first-mcp-request.md) publishes and calls the public DeepWiki `read_wiki_structure` tool through the Gateway.
- [Helm](helm.md) describes a Kubernetes deployment after you build and publish your own images.
- [Troubleshooting](troubleshooting.md) lists expected local failures and diagnostic commands.
- [Known issues and follow-ups](known-issues.md) records current limitations observed during CE installation and demo validation.

For localized product setup, see [繁體中文產品初始設定](../product/zh-TW/initial-setup.md).
