# E2B source audit

The Genio Bot self-host integration was checked on 2026-09-03 against fresh
shallow clones of the three upstream repositories and the exact packages in
the workspace lockfile.

## Pinned inputs

| Surface | Revision |
| --- | --- |
| E2B infrastructure | `e2b-dev/infra` `16bd4e3ccec5b9d1f4e8fb9b5c79c92ea49e193f` |
| E2B Desktop template | `e2b-dev/desktop` `89a545e22343aa1c40f28338bf3281a6c04b1d4a` |
| E2B JavaScript SDK source | `e2b-dev/e2b` `2dbd8e1dc26da5f50b9c14f00a75a645a64f7bff` |
| Installed Desktop package | `@e2b/desktop@2.3.3`, lock integrity `sha512-C5FkdAdSJZ9cjnLu6rODEqqoiKAvDO0akE3vihuL4LDkJRomke8H/Bjg/SJdYU9wpLzs1ADe6LCZ/VmmOSE5Qw==` |
| Installed core SDK | `e2b@2.46.1`, lock integrity `sha512-OqYovS2oFrt4mk737CgfW/RoMadBYK84l5qjKpvbEoOB9KKxaZIXm7YUwOKSRTlijrrwDRX7oZlyPoVXiCpyTw==` |

The Desktop npm package metadata points at `packages/js-sdk` in the Desktop
repository, but that directory is absent from the audited current Desktop
checkout. The published package plus lockfile integrity is therefore the
reproducible source for the Desktop SDK surface used here; the Desktop repo is
used for its template build source.

## Confirmed native boundaries

- `Sandbox.create(template, opts)` accepts custom self-host `domain`, `apiUrl`,
  `sandboxUrl`, `apiKey`, metadata, timeout, and Desktop resolution through the
  installed packages.
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
The current GCP run is explicitly `static-gce`; it validates nested KVM,
Firecracker, the E2B API, client proxy, Orchestrator, template builder, and
Desktop lifecycle on one disposable host. It is not the target production
topology.

The product target is Kubernetes discovery with a dedicated privileged KVM
runtime node pool and a separate builder pool. Official GCP and AWS Nomad
packaging stays available as an upstream-compatible installation choice.
GenioOne abstracts infrastructure and node provisioning only; it does not add
a replaceable provisioner under E2B's Firecracker runtime.
