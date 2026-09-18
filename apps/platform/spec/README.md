# GenioOne machine-readable specification boundary

`source-registry.json` is the only discovery entry point for automated
architecture and acceptance review. Review agents must not search Notion or the
repository for additional requirements and must not infer scenarios from prose.
Consumer contracts are fixed under `schema/`; changing one requires a schema
version change rather than an unannounced prompt adjustment.

The registry distinguishes three things:

- Notion authority identifies the human-owned source.
- A normalized local snapshot is the only input accepted by the bundle
  compiler.
- Snapshot classification prevents a historical export from being mistaken for
  the current acceptance matrix.

V1.5 has a strict current snapshot for canonical Epic 12–18. It preserves 49
Notion Gherkin scenarios and classifies 48 as the Core Product Journey
denominator. `US-13.2-S02` remains a non-blocking Core Invariant that prevents a
generic CapacityGroup from becoming canonical authority. Earlier matrix rows
remain historical evidence. V1.1 still requires a separate synchronizer and
validation before it can be compiled. `grok_spec_steward` routes free-form V1.1
source records through the bounded Grok admission gate described below; it does
not let the bundle compiler infer requirements from prose.

## Grok specification admission

Create an intake matching `schema/grok-spec-intake.schema.json`. Every source
record has a stable ID, locator and verbatim content. Existing artifacts are
declared explicitly instead of rediscovered by Grok.

Validate an intake without calling Grok:

```sh
bun run spec:grok:check
```

Run the isolated, single-turn structured review:

```sh
bun run spec:grok:review -- \
  --input spec/grok-spec-intake.example.json \
  --out-dir /tmp/genio-one-grok-review
```

The runner first restricts Grok to the web-search tool and then disables that
tool, leaving no file, shell, web or subagent surface. It also uses an empty
temporary working directory, constrains output with
`grok-spec-review.schema.json`, and then
rechecks source references and status invariants itself. `READY` and
`GENERATED_READY` admit implementation. `BLOCKED_CONFLICT` and
`BLOCKED_DECISION` write their attributed review and exit with status 2.

Grok may generate missing BDD or formalize an already-settled architecture
boundary as a `proposed` ADR. It cannot mark its own ADR accepted. Details that
do not change admitted behavior belong in `open_details`; missing material
choices belong in `blocking_questions`. A generated review must be deliberately
promoted to the release's validated local snapshot before `spec:bundle` treats
it as an acceptance baseline.

## Automated implementation gate

For a new implementation task, create a manifest matching
`schema/spec-pipeline-manifest.schema.json`; the catalog access-request example
is `pipeline/catalog-access-request.example.json`. A manifest pins exact Notion
page headings or data-source properties, local architecture sources, focused
checks, and the minimum user fixture needed for blind acceptance.

Prepare the task before editing product code:

```sh
bun run spec:pipeline:prepare -- \
  --manifest spec/pipeline/catalog-access-request.example.json \
  --run-dir /tmp/genio-one-catalog-access
```

Preparation exports Notion non-interactively, rejects truncation or ambiguous
heading matches, hashes every source, and sends only the immutable intake to
Grok. The admitted `codex-packet.md` is the implementation scope. Generated
BDD is a run-local candidate and generated ADRs remain `proposed`; neither is
silently written back to Notion or canonical documentation.

After Codex implements the packet, verify the same run:

```sh
bun run spec:pipeline:verify -- --run-dir /tmp/genio-one-catalog-access
```

Verification re-exports every source and blocks on drift, executes the declared
checks as argument arrays without a shell, then invokes Hermes in this shape:

```text
hermes chat --in <isolated-dir> -c <unique-session> --create-if-missing \
  -t browser --ignore-rules -Q --query-file <0600-mission-file>
```

Hermes gets the entry URL, test username/password, tenant, fixture, and one
Grok-selected BDD scenario. It does not get source paths, code, ADRs, logs,
terminal tools, or APIs. `PASS` requires a visible UI outcome; readiness checks
and login alone cannot pass. Product mismatch is `FAIL`; missing services,
identity, fixture, source stability, or an unparseable tester report is
`BLOCKED`. The final decision and exact input/output hashes are recorded in
`final-receipt.json`.

`spec:pipeline:all` is only for a candidate that is already implemented: it
runs preparation and verification together. Normal implementation work uses
the two commands above so Grok admission precedes the sole mutating Codex lane.
Rerunning preparation with the same manifest reuses its immutable admission;
different content requires a new run directory.

## Commands

Validate the registry and architecture inputs without generating artifacts:

```sh
bun run spec:check
```

Compile the existing historical V1 snapshot as a clearly labelled demonstration:

```sh
bun run spec:bundle -- --release V1 --allow-historical --out-dir /tmp/genio-one-spec
```

The output directory contains:

- `grok-review-bundle.json`: architecture, ADR and normalized BDD input. It
  contains no implementation source.
- `hermes-user-missions.json`: only scenarios explicitly selected in
  `hermes-mission-selection.*.json`, expressed as user-visible preconditions,
  actions and expected outcomes. It contains no ADRs, implementation paths or
  evidence links. Unselected contract scenarios never become fake user E2E.
- `receipt.json`: hashes and source classification for exact-run attribution.

Without `--allow-historical`, historical snapshots fail closed. A release with
no validated local snapshot also fails closed.
