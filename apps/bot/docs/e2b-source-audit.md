# E2B source audit

The Genio Bot self-host integration was checked on 2026-09-03 against fresh
shallow clones of the three upstream repositories and the exact packages in
the workspace lockfile. The installed package and adapter references were
rechecked on 2026-09-21. The upstream commit rows below remain historical
audit inputs; the installed packages and lockfile are the current reproducible
authority.

## Pinned inputs

| Surface | Current authority/evidence |
| --- | --- |
| E2B infrastructure (historical source audit) | `e2b-dev/infra` `16bd4e3ccec5b9d1f4e8fb9b5c79c92ea49e193f` (2026-09-03) |
| E2B Desktop template (historical source audit) | `e2b-dev/desktop` `89a545e22343aa1c40f28338bf3281a6c04b1d4a` (2026-09-03) |
| E2B JavaScript SDK | `e2b@2.50.0`; package metadata repository `e2b-dev/e2b`, directory `packages/js-sdk` |
| Installed Desktop SDK | `@e2b/desktop@2.4.0`, lock integrity `sha512-eeY4p/lz7kkDJMidREe7sp2nln16P1M1p64Fb+csn4SssxC2EjKBGqP0NEIlVDVd6iCuPbM7cVlkE/qbwJX4jg==` |
| Installed Codex CLI | `@openai/codex@0.155.0`, lock integrity `sha512-35a85Hbwy9WXkDTJumLjTcmMgpR7BMdrTloWBVGjoA+FBCh7jb3+cYp2W+3U4klqGAjAskoIvQZv7/eedmCjHA==` |

The core `e2b` package metadata points to `e2b-dev/e2b` `packages/js-sdk`; the
Desktop package points to the same repository's `packages/desktop-js`. The
installed packages plus pnpm-lock integrity are the current reproducible SDK
surface. The old Desktop repository commit remains only the 2026-09-03
template source audit input.

## Current package and adapter boundary

`apps/bot/package.json` is the current package authority for this workspace:
`e2b@2.50.0`, `@e2b/desktop@2.4.0`, and `@openai/codex@0.155.0`; matching
integrity records are in `pnpm-lock.yaml`.

GenioOne still has no native CUA driver integrated with Codex or OpenAI
computer-use. The current adapter is `apps/bot/server/desktop-driver.ts`:
`E2BDesktopDriver` translates Genio's screenshot, click, type, key, and scroll
operations into the installed `@e2b/desktop` methods while enforcing actor,
observation, revision, coordinate, key, and size limits. In
`apps/bot/server/runtime.ts`, the desktop tier calls `DesktopSandbox.create`,
starts the authenticated VNC stream, and attaches `E2BDesktopDriver`; the
headless tier continues to use `CoreSandbox.create`. This is Genio's desktop
adapter path, not native CUA integration.

## Confirmed native boundaries

- The installed `@e2b/desktop@2.4.0` surface exposes `Sandbox.create(template,
  opts)`, `screenshot("bytes")`, click methods, `write`, `press`, `scroll`,
  `getScreenSize`, and authenticated VNC stream methods; `runtime.ts` uses
  these through the adapter. Its self-host connection options include custom
  `domain`, `apiUrl`, `sandboxUrl`, `apiKey`, metadata, timeout, and Desktop
  resolution.
- E2B API owns sandbox create, list, kill, pause, resume, placement, routing,
  quotas, and persistent runtime metadata.
- E2B API discovers Orchestrators through Nomad, Kubernetes, a composed
  Nomad-plus-Kubernetes source, or a static local list. It performs best-of-K
  placement and writes the sandbox-to-node routing catalog.
- Orchestrator runs as root on sandbox nodes and owns Firecracker, namespaces,
  NBD, cgroups, hugepages, local template cache, pause, resume, and kill.
- Client proxy routes sandbox traffic directly to the selected runtime node.

GenioOne must not recreate any of those responsibilities. The T3 Runtime
Broker supplies verified product identity and lifecycle intent to the native
E2B API and retains only opaque identifiers and correlation metadata.

## Deployment-profile decision

The Runtime Provider contract remains independent of infrastructure discovery.
The historical GCP audit used `static-gce`; it validated nested KVM,
Firecracker, the E2B API, client proxy, Orchestrator, template builder, and
Desktop lifecycle on one disposable host. It is not the target production
topology. The 2026-09-21 isolated host-175 development environment and its
rebuild evidence are documented in [the 175 runbook](e2b-175-development.md).

The product target is Kubernetes discovery with a dedicated privileged KVM
runtime node pool and a separate builder pool. Official GCP and AWS Nomad
packaging stays available as an upstream-compatible installation choice.
GenioOne abstracts infrastructure and node provisioning only; it does not add
a replaceable provisioner under E2B's Firecracker runtime.

The `0.153.4` mentions in `apps/bot/docs/app-server-boundary.md`,
`apps/bot/docs/codex-app-server-upgrade-20260908.md`, and
`apps/bot/docs/local-hands.md` are historical probe or upgrade evidence. They
remain unchanged as historical records. Current install and pin authority is
`apps/bot/package.json` at `@openai/codex@0.155.0` and the matching
`pnpm-lock.yaml` entry; current guidance should not infer `0.153.4` from those
historical documents.
