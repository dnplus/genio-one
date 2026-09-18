# GenioOne Community Edition

[繁體中文](README.zh-TW.md)

GenioOne Community Edition (CE) is the source-first distribution for running the Platform control plane, Gateway Runtime, and Genio Bot on infrastructure you control. This repository contains the CE source and documentation; it does not imply a hosted service, a public image registry, or a published binary release.

English is the canonical CE documentation and demo language. The [繁體中文 version](README.zh-TW.md) is maintained as the localized counterpart. The Bot recording path uses `?lang=en`; user-entered prompts and generated content should use the same language as the selected demo path.

## Scope and prerequisites

CE includes the Platform control plane, a locally managed Gateway Runtime, and Genio Bot. You provide the host, supporting containers, provider credentials, connection approvals, and any external MCP service access. The repository does not contain provider secrets or claim that a connection is usable merely because it is configured.

Before starting, use a Linux or macOS host with Docker Engine, Docker Compose, Git, Node.js, pnpm `10.32.1`, and Bun `1.4.0`. The [Quickstart](quickstart.md) is the source of truth for local prerequisites and service addresses.

## The first useful path

The primary CE demonstration is a governed documentation-to-product workflow:

1. Start the local stack with the [Quickstart](quickstart.md).
2. Register and start a local Gateway Runtime using [Initial setup](../product/en/initial-setup.md#local-gateway-runtime).
3. Install the CE starter project for an Organization from Management.
4. Use managed Discovery to find the Context7 connection and verify its published capabilities.
5. Ask the bundled Product Management Bot to use the verified Context7 tools to produce a source-linked product brief.
6. Confirm the result and its attributable activity in Management.

The complete walkthrough, including the fictional Stellar Freight Claims Portal case used for local validation, is in the [CE first-run demo](demo.md). Context7 and Product Management are the required narrative; Archify and Gemini are optional extensions.

For an optional personal Notion OAuth recording, use [Notion OAuth and Bot setup](demo.md#optional-notion-oauth-and-bot-setup) to configure the published Resource, the user's authorization, three read-only entitlements, Bot binding, English UI, and a clean Bot copy. Claim a Notion tool result only after Bot and Management show matching evidence.

## Evidence boundary

The demo is complete only when the intended Bot request returns a real result and Management shows the matching Connection, Gateway revision, correlation ID, and Activity or audit record for the same actor and Organization. A healthy Connection, a published Resource, a ready pod, or a direct upstream MCP request is useful diagnostic evidence but is not a successful CE data-plane run by itself.

## Other guides

- [First governed MCP request](first-mcp-request.md) walks through publishing and calling the public DeepWiki `read_wiki_structure` tool through the Gateway.
- [Helm](helm.md) describes a Kubernetes deployment after you build and publish your own images.
- [Troubleshooting](troubleshooting.md) lists expected local failures and diagnostic commands.
- [Known issues and follow-ups](known-issues.md) records problems observed during the CE installation and demo validation.

For a localized product setup guide, see [繁體中文產品初始設定](../product/zh-TW/initial-setup.md). Keep the Organization, actor, connection revision, correlation ID, result, and matching activity or audit evidence for every acceptance run.

Check [Known issues and follow-ups](known-issues.md) for current limitations and the status of fixes.
