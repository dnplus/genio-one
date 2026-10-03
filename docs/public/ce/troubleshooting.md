# CE troubleshooting

## `pnpm dev` does not become ready

Confirm the prerequisites in [quickstart](quickstart.md), then inspect the support containers from `apps/platform`:

```sh
pnpm env:status
pnpm env:logs
```

The normal startup output ends with `local-dev.ready`. If a local port is already occupied, do not assume its process belongs to this checkout; stop or inspect that process first, then rerun `pnpm dev`.

## Another installation owns the supporting services

The startup diagnostic identifies the conflicting project or checkout without starting containers or changing the existing installation. A healthy Keycloak at `58080` does not mean it belongs to this checkout. Stopping the containers also does not remove their retained data.

Choose the matching path in [quickstart](quickstart.md):

- For an independent installation, use a separate host or VM with its own Docker daemon and loopback network, and run the original quickstart there. A new directory or a different Compose project name alone is insufficient because the application addresses and identity redirects remain fixed.
- For an intentional shared development installation, start compatible supporting services from their owning checkout, configure this checkout for the same identity and data, and run `pnpm dev --reuse-support`. The option does not repair mismatched configuration or start missing shared services.

If only retained volumes remain and their ownership cannot be verified, recover the original checkout and its local installation state, or use an independent environment. Do not remove the volumes to get past the diagnostic unless you have separately chosen to discard that installation's data.

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
