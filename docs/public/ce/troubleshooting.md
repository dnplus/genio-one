# CE troubleshooting

## `pnpm dev` does not become ready

Confirm the prerequisites in [quickstart](quickstart.md), then inspect the support containers from `apps/platform`:

```sh
pnpm env:status
pnpm env:logs
```

The normal startup output ends with `local-dev.ready`. If a local port is already occupied, do not assume its process belongs to this checkout; stop or inspect that process first, then rerun `pnpm dev`.

## Management sign-in or API health fails

Check the identity discovery document and Platform API health:

```sh
curl -fsS http://127.0.0.1:58080/realms/genio-one/.well-known/openid-configuration
curl -fsS http://127.0.0.1:58082/healthz
```

The local account is `admin` / `admin`. If the API did not start, leave `pnpm dev` output visible and use `pnpm env:logs` for container dependencies.

## The Runtime never reaches `READY`

Revisit [local Gateway Runtime setup](../product/en/initial-setup.md#local-gateway-runtime). The bootstrap JSON is one-time sensitive material: it must be a regular ignored file with mode `0600`. Ensure the native Gateway host is Linux or macOS on `x64` or `arm64`, and that the Runtime has the correct Platform API origin from its bootstrap. Do not replace its OIDC credential with a static token.

## A local publication cannot verify DNS

For the local walkthrough, set `GENIO_ONE_PUBLICATION_DNS_ALLOW_LOCALHOST=1`, restart the Platform supervisor, and use only `localhost` or a loopback `*.localhost` hostname. This is a local opt-in, not a production DNS bypass. For every other hostname, configure its real DNS target and complete the normal verification before publishing.

## Discovery, publication, or invocation fails

Work in order: Connection test must succeed; MCP discovery must finish; a non-empty explicit tool selection must be saved; the Resource and One Policy must be published; Gateway revision must be `READY`; and the caller must have an active Entitlement. Check **Activity** and **Audit** with the smoke helper's correlation identifier to distinguish an upstream failure from a policy or grant denial.

## I need a clean local environment

`pnpm env:down` stops support containers but retains their volumes. `pnpm dev clean` is the deliberate local-test-data cleanup operation: it lists the scope and requires interactive confirmation. Do not delete Docker volumes or local Runtime state as a substitute unless you intentionally want to discard the corresponding data.
