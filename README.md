<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/brand/assets/logos/genioone-horizontal-color-dark.svg">
    <img src="packages/brand/assets/logos/genioone-horizontal-color-light.svg" alt="GenioOne" width="300">
  </picture>
</p>

<h3 align="center">The control plane for every AI agent and resource</h3>

<p align="center">
  Connect your agents to the tools they need. Control access. See what happened.
</p>

<p align="center">
  <a href="https://genio.sh">Website</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="docs/public/ce/README.md">Documentation</a> ·
  <a href="https://www.producthunt.com/products/genioone?embed=true&amp;utm_source=embed&amp;utm_medium=post_embed">Product Hunt</a> ·
  <a href="README.zh-TW.md">繁體中文</a>
</p>

GenioOne is a self-hosted platform for managing AI agents, MCP tools, and model access. With Community Edition, you can publish tools, define who can use them, work with them in Genio Bot, and review requests in one management console.

![GenioOne resource management](docs/public/ce/assets/resource-management.png)

## Quickstart

You need macOS or Linux, Docker with Compose, Git, Node.js, pnpm **10.32.1**, and Bun **1.4.0**.

```sh
git clone https://github.com/dnplus/genio-one.git
cd genio-one
pnpm install --frozen-lockfile
cp apps/platform/.env.example apps/platform/.env.local
cp apps/bot/.env.example apps/bot/.env.local
pnpm dev
```

Open [Management](http://127.0.0.1:5173/management) and sign in with `admin` / `admin` for local development. Then follow [Gateway setup](docs/public/product/en/initial-setup.md#local-gateway-runtime) to connect your first Runtime.

Open [Genio Bot](http://127.0.0.1:5180/?lang=en) to start working with your tools. Configure your model account or provider credentials before starting a conversation.

See the [installation guide](docs/public/ce/quickstart.md) for prerequisites, service addresses, and restart instructions. These defaults are for local development; configure deployment credentials before exposing services.

## What you can do

- **Connect MCP tools.** Publish services in a shared catalog and connect personal accounts with OAuth.
- **Control access with One Policy.** Grant access to specific tools and apply policy at the Gateway.
- **Work in Genio Bot.** Give a Bot the tools and skills it needs for documentation research and product planning.
- **Inspect each request.** Review identities, policy decisions, selected connections, and correlated activity.

Community Edition includes the Platform management console and API, Gateway Runtime, and Genio Bot under Apache-2.0.

## Try a workflow

**Research → product brief.** Help the fictional Stellar Freight team plan a claims portal. Use Context7 to research framework documentation, then use the bundled Product Management skill to draft requirements and acceptance criteria.

Follow the [demo walkthrough](docs/public/ce/demo.md), or start with a [single MCP request](docs/public/ce/first-mcp-request.md). The walkthrough also covers [connecting Notion with OAuth](docs/public/ce/demo.md#optional-notion-oauth-and-bot-setup).

## Documentation

| Guide | Use it to |
| --- | --- |
| [Local installation](docs/public/ce/quickstart.md) | Start the stack and manage local services |
| [Initial setup](docs/public/product/en/initial-setup.md) | Configure identity, Resources, and a Gateway |
| [Kubernetes deployment](docs/public/ce/helm.md) | Build your images and deploy with Helm |
| [Troubleshooting](docs/public/ce/troubleshooting.md) | Diagnose startup and connection problems |
| [Known issues](docs/public/ce/known-issues.md) | Check current limitations and fixes |

## Feedback and contributions

Report bugs or suggest improvements in [GitHub Issues](https://github.com/dnplus/genio-one/issues). For a bug report, include reproduction steps and your environment; remove credentials and private data from logs.

For code changes, run `pnpm check`, `pnpm test`, and `pnpm build` before opening a pull request.

## Find us on Product Hunt

<table>
  <tr>
    <td><a href="https://www.producthunt.com/products/genioone?embed=true&amp;utm_source=embed&amp;utm_medium=post_embed"><img alt="GenioOne" src="https://ph-files.imgix.net/b3009653-6723-4140-9117-e777f001ff05.png?auto=compress,format&amp;codec=mozjpeg&amp;cs=strip&amp;fit=crop&amp;h=80&amp;w=80" width="64" height="64"></a></td>
    <td><strong>GenioOne</strong><br>The control plane for every AI agent and resource<br><a href="https://www.producthunt.com/products/genioone?embed=true&amp;utm_source=embed&amp;utm_medium=post_embed">Check it out on Product Hunt →</a></td>
  </tr>
</table>

## License

[Apache License 2.0](LICENSE).
