import { createManagedDesktop } from "./runtime"
import { RuntimeBroker } from "./runtime-broker"

const broker = new RuntimeBroker({ provision: createManagedDesktop })
let runtimeSessionId: string | null = null

try {
  const session = await broker.start({
    tenant_id: process.env.GENIO_BOT_TEST_TENANT_ID?.trim() || "tenant-keycloak-local",
    subject_id: process.env.GENIO_BOT_TEST_SUBJECT_ID?.trim() || "person-platform-admin",
    acting_client_id: "genio-one-bot",
    scopes: ["genioone-invocation"],
  }, {
    onMessage() {},
    onExit(reason) {
      console.error(JSON.stringify({ event: "runtime.live.exited", reason }))
    },
  })
  runtimeSessionId = session.id
  if (session.details.execReady) throw new Error("RUNTIME_STARTED_WITH_EAGER_SANDBOX")
  const ready = await broker.ensure(session.id, "headless", "runtime-live")
  if (ready.details.kind !== "e2b-self-hosted") throw new Error("SELF_HOSTED_E2B_RUNTIME_REQUIRED")
  if (ready.details.tier !== "headless") throw new Error("SELF_HOSTED_E2B_HEADLESS_RUNTIME_REQUIRED")
  if (!ready.details.sandboxId) throw new Error("SELF_HOSTED_E2B_SANDBOX_ID_REQUIRED")
  if (!ready.details.execReady) throw new Error("SELF_HOSTED_E2B_EXEC_NOT_READY")
  console.info(JSON.stringify({
    event: "runtime.live.provisioned",
    runtime_session_id: session.id,
    sandbox_id: ready.details.sandboxId,
    exec_ready: true,
    desktop_url_present: Boolean(ready.details.desktopUrl),
  }))
} finally {
  if (runtimeSessionId) await broker.stop(runtimeSessionId)
}
