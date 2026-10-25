# Chart and documentation review

No findings.

Read-only adversarial review of tracked and untracked changes against `0f891046df8900d1881de92fff558a28092a9c2d`. Applied the interrogate reviewer prompt, rubric, and code-quality lens. This is an independent GPT fallback review, not a claim of Claude/Grok model diversity. No tests, deployments, or heavy commands were run.

Evidence checked.

- `deploy/helm/genio-one/values.schema.json` requires `bot.replicas` as an integer in `[0, 1]`, independently of `bot.enabled`. It permits unrelated component and unknown configuration values.
- `tooling/ce-helm-bot.test.mjs:45` onward checks actual Helm output for default and CE profiles, zero/one replicas, invalid numeric/type/null inputs, disabled Bot validation, and unrelated platform replicas. Invalid cases require the schema-specific failure and empty manifest output, avoiding false positives from unrelated template requirements.
- `deploy/helm/genio-one/templates/bot.yaml:20` retains the existing StatefulSet topology. The existing direct replica rendering at line 28 consumes schema-validated values. No Deployment surge or new HPA path was introduced.
- `docs/public/ce/helm.md:114` onward uses ordinary Helm lint, template, and upgrade commands. Repository search found no deployment path using `--skip-schema-validation`.
- `apps/bot/docs/codex-upgrade-20261025.md:50` onward explicitly discloses schema bypass, manual scaling/processes/releases, the absence of runtime fencing, E2B version overrides, missing real Endpoint acceptance, live-provider gates, and untested saved rollout/pending approval migration.
- The official [0.163 release](https://github.com/openai/codex/releases/tag/rust-v0.163.0) and [0.164 release](https://github.com/openai/codex/releases/tag/rust-v0.164.0) support the release-change summaries. The latter shows stable version 0.164.0 and commit prefix `6aaac69`.
- The pinned Rakazo source supports the cited durable wakeup, transactional fencing, and upload-before-CAS observations. Reviewed `run-wakeup.ts`, `computer-lifecycle.ts` lines 516 onward, and `home-object-store.ts` lines 189 onward at commit `01744dd87d83298a448c353885775bea9df68416`.

Review limits.

- npm registry metadata and GitHub tag-object API URLs were inaccessible through the web reader. Their exact package metadata and full tag-object claims were not independently reverified here.
- Verification JSON and decision TSV were still being finalized by the parent. Their eventual contents and final remote SHA/CI results require the parent's final check.
- Runtime/native correctness is covered by the other independent reviewer. This review inspected those tests only to check documentation claims and scope boundaries.
