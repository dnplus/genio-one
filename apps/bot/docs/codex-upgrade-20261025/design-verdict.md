# Design verdict

## Decision

Use Candidate B as the base. Graft Candidate A's package-derived Local Hands pin through `apps/bot/shared/codex-version.ts`, exporting a plain validated string for E2B, Local Hands, and UI. Do not add A's branded version type, template helper, or a reusable RPC module.

## Scores

| Rubric | A | B | Judgment |
| --- | ---: | ---: | --- |
| Boundary preservation | 1 | 2 | B validates chart input without changing the render path. A validates only inside the enabled Bot template, so `bot.enabled=false,bot.replicas=2` preserves invalid dormant state. |
| Version authority coherence | 2 | 1 | A derives E2B and Local Hands from `package.json`. B leaves `EXECUTOR_VERSION` as a second executable pin and relies on a drift test. |
| Observable native coverage | 2 | 2 | Both exercise package app-server and exec-server without a model call. B states the private Endpoint limit more precisely. |
| Reject multi-writer and retain maintenance | 2 | 2 | Both allow `0`, allow `1`, and reject `2`. Neither claims distributed fencing. |
| Smallest maintainable diff | 1 | 2 | B adds one schema and one test-local lifecycle. A adds template policy and a branded production type that do not earn their cost. |
| Total | **8/10** | **9/10** | B wins with A's version-authority fix. |

## Required design

1. Add `deploy/helm/genio-one/values.schema.json`. Define `bot.replicas` as an integer enum containing only `0` and `1`. Keep unrelated properties open. Do not add a duplicate `fail` guard to `bot.yaml`.
2. Apply the schema even when `bot.enabled=false`. Reject disabled Bot configurations with replica count `2`.
3. Test defaults, CE values, `0`, and `1`. Reject `2`, negative values, fractions, booleans, null, and numeric strings. Prove that another component may use replica count `2` and that unknown unrelated values remain accepted.
4. Document that `helm template --skip-schema-validation` and manual Kubernetes scaling bypass this guard. Release automation must leave schema validation enabled. If the supported delivery path skips it, release is blocked. Do not compensate with a second template rule.
5. Keep `apps/bot/package.json` as the executable version authority. Update the lockfile, `codex-upstream.json`, `pnpm-workspace.yaml`, and generated `tooling/oss-export.mjs` policy together. Verify the tag's peeled commit before recording it.
6. Move the current E2B package parse into `apps/bot/shared/codex-version.ts`. Export one validated `string`. Keep `DEFAULT_CODEX_VERSION` as the E2B alias and keep its explicit override. Consume the same value in Local Hands and UI. A brand, public parser, or version registry adds no safety.
7. Regenerate the complete protocol directory from the package binary into an empty directory, replace the old set, and require a second generation to produce no diff. Adapt only callers broken by observed `0.164.0` changes.

## Native compatibility gate

Keep the native gate in one test file. Reuse `server/jsonl.ts` for framing. Do not add a production process manager or general JSON-RPC module.

Start package-owned app-server and exec-server directly, with separate temporary `HOME` and `CODEX_HOME` values and no model credentials. Initialize both transports, register exec-server through app-server `environment/add`, and assert `environment/info`. Exercise `thread/start` and `thread/read` only as metadata operations. Do not call `turn/start`, `model/list`, login, MCP discovery, a custom provider, or an external service.

Exercise process and filesystem behavior through exec-server's public RPC. Assert output bytes, exit status, file bytes, one deterministic RPC error, connection usability after the error, and termination of a long-running process. This proves the package pair and its integration seam. It does not prove Bot routes, policy, or Endpoint transport.

Make cleanup observable. Give every request and notification wait a deadline. Reject pending RPCs on child `error`, `close`, or `exit`. Use stdin shutdown only if `0.164.0` supports it. Await both server exits and long-running process termination. Use bounded force termination only in `finally`, then await forced exits before removing temporary directories.

For restart, use fresh native homes and a fresh exec-server port while retaining only the workspace. Reinitialize both servers, register the environment, read persisted file bytes, run another command, and shut down cleanly. This proves process restart around workspace bytes. It does not prove thread, turn, broker, or lease recovery.

## Evidence and blockers

- `apps/bot/docs/bot-continuity-decisions.md:69` names one writer and one replica as the safety baseline. `apps/bot/server/runtime-broker.ts:150-155` and `pending-interactions.ts:7` confirm process-local maps.
- `deploy/helm/genio-one/templates/bot.yaml:28` renders arbitrary counts. `evidence/baseline-bot-replicas-two.yaml:2795` proves that `2` renders today.
- `apps/bot/server/e2b-self-host.ts:4-10` derives its default from `package.json`. `apps/bot/server/local-hands.ts:23` is the duplicate executable literal that the graft removes.
- `apps/bot/tests/local-hands/native.test.ts:96-156` proves the initialize, environment, process, filesystem, and app-server seams exist. Its teardown sends signals without awaiting every child exit, so the new gate must strengthen cleanup.
- `apps/bot/package.json:20` references `genio-one-endpoint`, but this checkout has no `runtimes/endpoint`. Release remains blocked until the private workspace updates and builds its Rust pin and runs the real Local Hands native test. The public smoke cannot prove pairing, policy revocation, Endpoint cleanup, or Rust dependency coherence.

## Principles applied

Boundary Discipline selected Helm schema validation and one package-version parse. Separate Before Serializing Shared State rejected unsupported multi-writer deployment. Laziness Protocol removed the template guard, branded type, and shared RPC abstraction. Test Behavior, Not Implementation selected rendered counts, RPC results, bytes, exits, and restart behavior. Prove It Works keeps the missing private Endpoint run as a release blocker.
