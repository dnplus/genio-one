# CE known issues and follow-ups

This is a living list of issues observed while installing and validating the CE export locally. These entries are follow-ups, not claims that the public release is complete. Re-run the affected product path after each fix.

## 2026-09-17 local validation

### Gateway restart can leave an old Envoy process serving traffic — fixed

Stopping the local Gateway left an orphan Envoy process on the MCP listener. A new run could then report Ready after observing the old listener, despite its own bind failure.

The local Runtime now stops the detached process group, including workers whose parent has exited, with bounded TERM and KILL waits. Readiness checks use the current run's Envoy admin address instead of a shared listener. Regression tests cover a stale admin address and a TERM-ignoring orphan worker. Existing orphan processes from older versions may need a one-time, identity-checked shutdown before restarting.

### OAuth succeeds but MCP tool discovery reports an invalid token — fixed

Notion OAuth completed, but Gateway discovery reported `Missing or invalid access token`. MCP SDK 2 reports HTTP errors through `SdkHttpError.status`; the Gateway checked the error code instead and did not request the user's OAuth credential after HTTP 401.

The Gateway now recognizes the SDK's HTTP 401 response and retries discovery against the same endpoint with the user's credential. Seven regression tests pass, including checks that 403, 429, and 500 do not trigger credential retrieval. After exporting and restarting CE, the Management UI reported successful discovery of 44 tools from Notion MCP 1.2.0. This confirms OAuth-backed discovery; Bot invocation requires separate acceptance evidence.

### Account and language menus could blank the page — fixed

Opening the Management account menu threw `MenuGroupContext is missing` because a Base UI group label was rendered outside a group. The same composition defect existed in the Self-service language menu. Both callers now supply the required group. The independent CE checkout was re-tested through the Management account menu, Personal settings, and English language selection successfully. The Self-service language menu also opened and selected English without a crash.

### Documentation prompts could incorrectly request a Headless workspace — fixed

The English starter prompt mentions “document upload” as a product requirement. A frontend keyword check treated the word “document” as an execution request and tried to provision Headless before sending the research prompt. The Headless policy rejection was then incorrectly described as a personal Codex restriction, even though the Codex subscription policy was enabled.

The request classifier now requires an execution action and target rather than the word “document” alone. Runtime policy errors also distinguish execution authorization from Codex subscription authorization. Focused regression tests pass. In the independent CE checkout, the unmodified English starter completed managed Context7 research, returned three source-linked notes, and returned the Bot to Ready without provisioning Headless.

### Bot sign-in loses the selected demo and language — fixed

Opening `?demo=documents&lang=en` while signed out showed a Traditional Chinese login screen. Successful OIDC login returned to `/` and dropped both query parameters.

The Bot login surface now honors the English locale, and the callback restores a validated same-origin local return path. Focused tests cover the demo/language parameters and reject external redirects. The independent CE browser run completed sign-in and returned to `?demo=documents&lang=en`. The identity provider has its own language selector; its language is separate from the Bot URL.

### Capability visibility and invocation are easy to confuse

Context7 being healthy does not by itself make its resources or upstream MCP tools available to an actor. A private publication with no entitlement can correctly return zero results from Discovery. Granting the resource-level entitlement can make the resource visible while the individual `resolve-library-id` and `query-docs` capabilities are still unavailable.

Follow-up: make the demo guide explain the two authorization layers and show the exact capability state before the first request. Consider a clearer Management representation of publication visibility, resource entitlement, and tool entitlement.

### Grant Entitlement can hide follow-on capabilities after refresh — fixed

During the local run, the Grant Entitlement sheet sometimes listed only capabilities already visible through the selected resource. A follow-on grant then showed “No Capabilities found” even though the publication had additional published capabilities. The temporary resource grant had to be revoked and the tool capabilities granted from a refreshed state.

The sheet now loads fresh canonical Resources and Capabilities when it opens, instead of relying on an older overview snapshot. Loading failures are shown separately from an empty inventory. In the independent CE UI, the operator successfully granted `mcp.invoke`, `notion-search`, and `notion-fetch` on the newly published Notion Resource to Local Platform Admin. All three appeared as Active entitlements; no write tools were granted.

### Repeated grants can create duplicate active entitlements

Repeatedly granting the same Context7 capability during recovery created duplicate active `query-docs` entitlements in the local validation data.

The grant sheet now sends an `Idempotency-Key` and reuses it for retries of the same submission. The API checks the request payload and enforces a tenant-scoped unique request identity. Migration 100 adds nullable request metadata and an index; it does not revoke or delete existing grants. Distinct intentional grants, including different time windows, remain supported. API callers that omit the key retain the previous non-idempotent behavior. Existing duplicate demo grants remain visible and have not been silently removed.

### Long-lived Bot sessions can retain an expired Codex token

After browser reauthentication, the already-running local Bot app-server continued using the bearer token captured when it was spawned and returned `401 Bearer token rejected`. Restarting the Bot service created a fresh session and allowed the request to continue.

Session-bound managed MCP requests now use the Bot relay by default, which resolves the current bearer token per request instead of retaining the process-start token. Regression tests pass. The exported Bot subsequently completed Context7 tool calls; a complete timed token-expiry and browser-reauthentication cycle still requires a separate live re-test.

### English Bot locale is intentionally incremental

The Management UI supports the English route. The CE Bot source and current export now honor `?lang=en` for the launcher, roster, workspace header, composer, timestamps, and inspector surfaces used by the main recording path. Optional dialogs and historical messages can still contain Traditional Chinese copy because they are not part of the minimal demo locale.

Follow-up: finish the remaining Bot surface inventory before claiming full product localization. Keep user-entered prompts and generated demo content in the selected locale.

### A stale browser tab can retain a closed Codex client

After the CE export services were restarted, an already-open browser tab briefly showed `CODEX_CLIENT_CLOSED`. The Bot recovered automatically to `Ready` before the attempted reconnect click completed, without deleting its durable history. The stale tab retained earlier failed demo messages; manual reconnect recovery was not verified in that attempt.

Follow-up: make the reconnect boundary explicit in the Bot UI, recover a closed native client with a fresh session, and provide a clean recording reset or new-thread path that does not require deleting shared validation data.

### Pinned Gateway dependency download needs a clear network prerequisite

Installing the pinned local AI Gateway binary was blocked once by sandbox DNS access to `archive.tetratelabs.io`. The install path succeeded after the development machine was allowed to reach the dependency host and the downloaded artifact passed its digest check.

Follow-up: document the network prerequisite, retain checksum verification, and provide a precise diagnostic when the archive host cannot be resolved.

### CE Bot MCP targets must match the published endpoint shape

The local Gateway publication used a per-resource hostname with `/` as its canonical MCP endpoint. The CE Bot initially built `/mcp/<resource-id>`, which returned Gateway `404 route_not_found`. The first relay retry also omitted the Gateway listener port and attempted `127.0.0.1:80`.

Follow-up: keep explicit `GENIO_ONE_MCP_ORIGIN` targets rooted at the publication hostname and preserve the legacy path-based fallback for `GENIO_ONE_MCP_URL`. Re-run Context7 and Product Management after any endpoint or relay change.

### Private Context7 publication needs an explicit demo setup step

The local Context7 connection was healthy, but its publication was `PRIVATE`. That is a valid security posture, yet the first demo request then failed at Discovery until the demo actor received the required entitlement.

Follow-up: either ship a clearly documented demo entitlement step or provide a safe, local-only starter fixture whose visibility and entitlements are explicit. Do not weaken the default publication security silently.

### A global MCP origin cannot represent multiple publication hosts

The current `GENIO_ONE_MCP_ORIGIN` override targets a single publication hostname. Both Context7 and Archify mounts resolve to that same origin, so the Context7-only validation does not prove Archify routing. Do not present the optional Archify path as verified in this configuration.

Follow-up: resolve each authorized Resource's actual published hostname and base path through the catalog/session contract, instead of applying one origin to every MCP resource. Keep missing or unauthorized publication endpoints fail-closed.

### Envoy rejects the current Context7 certificate — TLS fix implemented

The real Context7 MCP endpoint completes a TLS handshake and returns MCP tools when called directly from the development host. The local Envoy AI Gateway data plane nevertheless fails while proxying the same endpoint with `BAD_ECC_CERT` and returns `503` before the upstream MCP session is created. The generated Backend uses the system CA store and the correct SNI, so disabling certificate verification is not an acceptable workaround. Envoy AI Gateway's upstream MCP example currently records the same Context7 certificate failure.

The upstream TLS projection now explicitly includes `X25519`, `P-256`, and `P-384`. With native Envoy 1.38.1, an isolated proxy test reproduced HTTP 503 with the default curves, then completed MCP initialization and `resolve-library-id` with HTTP 200 after adding P-384. System CA validation, SNI, and the expected DNS SAN remain enabled. The CE Connection has been restored to the official HTTPS endpoint and verified. A complete Bot and correlated Activity rerun is still required before claiming that the whole demo path passes.
