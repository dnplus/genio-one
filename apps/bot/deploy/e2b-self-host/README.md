# Self-hosted E2B contract

Genio Bot consumes an existing self-hosted E2B installation. Infrastructure
provisioning remains an operator concern because the official deployment needs
a cloud provider, domain, DNS, PostgreSQL, secrets, and Firecracker-capable
compute choices that are not application defaults.

Provisioning is split across three owners:

- GenioOne is the management plane for identity, entitlement, policy, desired
  runtime lifecycle, and audit correlation.
- The Genio Bot T3 Runtime Broker is the only application component that calls
  the selected runtime provider and binds a verified Subject session to the
  resulting sandbox.
- The customer-local E2B control and data planes own placement, Orchestrator,
  Firecracker execution, desktop traffic, files, and artifacts.

The broker uses the E2B API as-is. It does not duplicate E2B placement or
orchestration logic, and the E2B API credential remains server-side.

Deployment profiles belong to GenioOne Runtime Management and its installer,
not to the Bot Runtime Provider. The provider consumes the same E2B API and
client-proxy contract for every profile:

| Profile | Status | Infrastructure and discovery |
| --- | --- | --- |
| `static-gce` | Pilot | One disposable x86 GCE host with nested KVM and static local Orchestrator discovery |
| `kubernetes` | Product target | Existing or dedicated KVM node pool, Kubernetes discovery, privileged host-level Orchestrator, separate builder pool |
| `gcp-nomad` | Upstream-compatible | Official Terraform and Nomad packaging on GCP |
| `aws-nomad` | Upstream-compatible | Official Terraform and Nomad packaging on AWS |
| `static-linux` | Lab or small on-prem | Operator-provided KVM hosts and static discovery |

These profiles select how E2B infrastructure and nodes are installed. They do
not select a sandbox engine: E2B continues to own placement and executes each
sandbox through Orchestrator and Firecracker/KVM. A future non-E2B engine would
be a different Runtime Provider, not another E2B provisioner option.

The audited E2B API source supports `kubernetes` as an Orchestrator service
discovery provider. The official self-host installation guide and Terraform
modules still deploy the full platform through Nomad on AWS or GCP. A
GenioOne-owned Kubernetes profile therefore has to package and operate the same
E2B components; Kubernetes discovery support by itself is not a complete
installer.

The installation must provide:

- a private E2B domain and API credential;
- API and sandbox ingress derived from that domain or supplied explicitly;
- an E2B Desktop base template derived from the audited upstream Desktop
  contract; the pilot uses only XFCE, Chrome, noVNC, and required system tools;
- enough nested-virtualization capacity for the selected concurrency;
- network egress from sandboxes to the Codex OAuth and selected model provider;
- retention and cleanup controls for sandbox state and generated artifacts.

After the operator builds the Desktop base template, configure
`GENIO_BOT_E2B_DESKTOP_BASE_TEMPLATE` with its local alias or ID and run:

```bash
pnpm --filter genio-one-bot build:e2b-template
```

The resulting `GENIO_BOT_E2B_TEMPLATE` contains the pinned Codex CLI. Runtime
startup verifies that exact version before opening the desktop stream and
starting `codex exec-server`. App-server and its persisted state stay in the
Genio Bot server boundary.

With the self-host endpoint and template configured, exercise the application
ownership boundary directly:

```bash
pnpm --filter genio-one-bot test:e2b:live
```

The smoke calls the T3 Runtime Broker, provisions the configured Desktop,
requires a sandbox ID and authenticated desktop URL, and terminates the runtime
in a `finally` path. It does not fall back to E2B Cloud or the Bot host.

Official sources:

- [Self-hosting E2B](https://github.com/e2b-dev/infra/blob/main/self-host.md)
- [E2B Desktop template](https://github.com/e2b-dev/desktop/tree/main/template)

## Kubernetes product profile

The first product packaging should keep ordinary services and KVM workloads in
separate pools:

```text
normal nodes
  E2B API, client proxy, Postgres, Redis, object storage

builder pool
  template builder, KVM, large temporary disk, independent cleanup policy

runtime pool
  privileged Orchestrator, /dev/kvm, hugepages, sandbox microVMs
```

Runtime nodes use a dedicated label and taint such as
`genioone.io/e2b-runtime=true`. Template builds must not consume the runtime
pool's sandbox capacity or boot disk. GenioOne keeps tenant entitlement,
provider registration, lifecycle intent, quota, and audit metadata; the
customer-local E2B cluster keeps desktop traffic, files, browser sessions, and
artifacts.
