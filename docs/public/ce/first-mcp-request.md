# First governed MCP request

This walkthrough uses the public upstream DeepWiki MCP server at `https://mcp.deepwiki.com/mcp` and exposes exactly one tool, `read_wiki_structure`, for the public `facebook/react` repository. It does not import a private fixture or store a static bearer token.

Choose the prerequisite that matches your installation:

- For the Compose local stack, complete [local Gateway Runtime setup](../product/en/initial-setup.md#local-gateway-runtime). It registers the Runtime and starts the listener on port `1975`.
- For the Helm chart, the post-install Job bootstraps the Gateway Runtime. Follow [the Helm first-login flow](helm.md#first-management-login), then port-forward the Gateway listener in a separate terminal:

  ```sh
  kubectl -n genio-one port-forward service/genio-one-aigw-internal 1975:1975
  ```

For either installation, open **Runtimes** and confirm the registration is valid and its control channel is connected before publishing. A newly registered Runtime has no release to report, so its health and reconciliation may say that they are waiting for a report. This is expected before the first publication; do not wait for `READY` yet. Do not run the standalone local Gateway bootstrap flow for a Helm installation.

## 1. Create the MCP Resource and its owner

In Management, open **Resources** and create an **MCP** Resource. Give it a clear name such as `DeepWiki React`, and select the Organization that owns the Resource. The owner is accountable for its Connection, selected capabilities, publication, and grants.

Create the Resource-owned Connection with this upstream URL:

```text
https://mcp.deepwiki.com/mcp
```

Use the unauthenticated upstream mode for this public server. Set the Connection's **MCP tool namespace** to `ce-deepwiki`, save it, choose **Test connection**, and require a successful result before continuing. This namespace creates the stable Gateway tool prefix; it is independent of the Resource display name. A test result proves the upstream is reachable; it does not grant anyone access.

## 2. Discover and select one tool

On the Connection, choose **Discover tools**. When discovery completes, select only `read_wiki_structure` under **Published tools**, save the selection, and enable the Connection. Do not publish every discovered tool merely because the service is public.

Create or update a One Policy that permits the intended subject to discover and invoke this single capability. Publish the saved policy revision. The Resource remains draft until it is separately published.

## 3. Publish a localhost route and grant access

For the Compose local stack, add this to `apps/platform/.env.local` before starting Platform:

```dotenv
GENIO_ONE_PUBLICATION_DNS_ALLOW_LOCALHOST=1
```

If Platform is already running, stop its `pnpm dev` supervisor and start it again after saving this setting. For a Helm installation using `values-local.yaml`, this loopback opt-in is already set in the chart; do not add or restart a Compose `.env.local` file. This opt-in accepts only `localhost` and `*.localhost` that resolve to loopback. In the Resource's **Configure endpoint** flow, choose the registered Gateway, use hostname `localhost` and base path `/ce-mcp`, then verify DNS. Save and publish the Resource. This first publication creates the Gateway revision; wait until the publication, Gateway revision, health, and reconciliation reach `READY` before sending traffic.

Create a time-bounded Entitlement for the calling subject and the `read_wiki_structure` Capability, following the active One Policy and the Resource owner's approval flow. A completed access request is history; confirm that the resulting Entitlement is active before invoking.

## 4. Make the OIDC-authenticated request

The CE smoke helper performs the required anonymous denial, MCP initialize, tool listing, and one tool call. It uses the public `codex-mcp` OIDC client with code flow and PKCE; it prints a login URL, keeps the access token only in memory, and prints a correlation summary.

```sh
node tooling/ce-mcp-smoke.mjs \
  --url http://localhost:1975/ce-mcp \
  --issuer http://127.0.0.1:58080/realms/genio-one \
  --tool ce-deepwiki__read_wiki_structure \
  --argument repoName=facebook/react
```

Open the printed URL in a browser, sign in as the Subject that has the active Entitlement, and finish the redirect. The `ce-deepwiki` Connection namespace makes `ce-deepwiki__read_wiki_structure` the Gateway-visible name for the selected DeepWiki tool. Success means the helper reports an anonymous `401`, sees that tool in `tools/list`, receives a successful `tools/call`, and prints its correlation identifier.

For a non-interactive or production caller, issue an OIDC client only after an active Application Entitlement exists. Store the one-time client secret in your secret manager, provide it to the workload at runtime, acquire a short-lived token from the issued token endpoint, and send it as `Authorization: Bearer <token>` to the published MCP URL. Do not put client secrets, static bearer tokens, bootstrap JSON, or provider credentials in source files, shell history, or this guide.

## 5. Verify the evidence

In Management, find the request by the correlation identifier in **Activity**, then open its related **Audit** records. Confirm the authenticated Subject and acting client, Resource, `read_wiki_structure` capability, active Entitlement, One Policy decision, selected Connection, Gateway revision, and outcome. That evidence is the completion condition for this walkthrough.
