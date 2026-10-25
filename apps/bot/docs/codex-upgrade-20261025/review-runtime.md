# Runtime adversarial review

## Findings

### 1. Warning: the native RPC peer can consume a server request as an unrelated response

**Location:** `apps/bot/tests/codex-native-compat.test.ts:30-40`

`peer.receive` looks up `pending.get(frame.id)` before checking `frame.method`. JSON-RPC peers allocate request IDs independently, so an app-server request can legitimately reuse the numeric ID of an outstanding client request. In that case the harness deletes and resolves the client request with `frame.result` instead of recording or answering the server request. The production browser client avoids this by resolving pending calls only when `!message.method` (`apps/bot/src/lib/codex-client.ts:307-314`). This makes the harness unreliable for the approval behavior this upgrade needs to preserve, because approval requests are bidirectional requests with IDs. Classify method-bearing frames as requests/events before consulting the response map, and add an explicit response path for server requests.

### 2. Warning: a failed native smoke can leave its long-lived child process behind

**Location:** `apps/bot/tests/codex-native-compat.test.ts:179-205`

The test starts `sleep 60`, but records `longPid` only after waiting for its output. If the output event times out, is malformed, or the PID assertion fails, `longPid` remains `undefined` or `NaN`; the `if (longPid)` cleanup is skipped. The fallback then sends `SIGKILL` to the exec-server, which cannot run child cleanup handlers, so the spawned process can survive the failed test. Track process ownership before the fallible output parse, or terminate the named executor process in `finally` while the exec-server is alive, then use the OS PID as a secondary cleanup check.

### 3. Warning: a current repository document still advertises Codex 0.162.0

**Location:** `apps/connectors/breeze-asr/README.md:67`

The text says the Bot-pinned app-server is 0.162.0 and cites the live generated protocol files, while the package authority, Local Hands handshake, E2B default, generated tree, and upgrade docs now select 0.164.0. This is not a historical upgrade record and contradicts the intended shared release authority. Update the current statement to 0.164.0 or make it explicitly historical. The intentional 0.162.0 occurrences in the migration test and mismatch test are valid baselines and should remain.

## Verified

- `pnpm-lock.yaml` changes only the `@openai/codex` importer, package variants, integrity records, and snapshots from 0.162.0 to 0.164.0. No unrelated lock metadata changed.
- The checked-in protocol matches the 0.164.0 package generator twice at 904 files, according to `evidence/protocol-drift-first.log` and `evidence/protocol-drift-second.log`.
- Package authority feeds E2B, Local Hands, and the UI through `apps/bot/shared/codex-version.ts`; focused tests and native baseline, upgraded, and config-migration evidence pass.
- Private Rust Endpoint, live E2B and Cloudflare paths, saved rollout migration, pending approval migration, and authenticated identity remain explicitly unverified rather than silently claimed by the runtime evidence.
