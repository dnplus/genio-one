import WebSocket from "ws"
import assert from "node:assert/strict"
import { once } from "node:events"
import test from "node:test"
import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

test("Endpoint socket accepts bound credentials, records matched reports, and closes on revoke", async () => {
  const modules = createInMemoryPlatformModules()
  const bootstrap = await modules.endpointRuntime.bootstrap({ tenantId: "tenant-1", subjectId: "employee", correlationId: "bootstrap" })
  const identity = await modules.endpointRuntime.authenticateCredential({ tenantId: "tenant-1", token: bootstrap.credential.token })
  const enrolled = await modules.endpointRuntime.enroll({ tenantId: "tenant-1", subjectId: "employee", credentialId: identity.credentialId,
    value: { correlation_id: "enroll", device_id: bootstrap.device_id, endpoint_version: "0.1.0", at: 100,
      identity: { device_id: null, subject: { subject_id: "employee", evidence_level: "VERIFIED" }, acting_client: { acting_client_id: null, evidence_level: "UNKNOWN" } } } })
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: createStaticPrincipalAuthenticator({}) })
  try {
    await app.listen({ port: 0, host: "127.0.0.1" })
    const address = app.server.address()
    assert.ok(address && typeof address !== "string")
    const path = `/v1/tenants/tenant-1/runtime-control/ENDPOINT/${bootstrap.device_id}/connect`
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, { headers: { authorization: `Bearer ${enrolled.runtime_credential!.token}` } })
    const [data] = await once(socket, "message", { signal: AbortSignal.timeout(3000) })
    const command = JSON.parse(data.toString())
    assert.equal(command.desired_state.runtime_kind, "ENDPOINT")
    socket.send(JSON.stringify({ command_id: command.command_id, runtime_id: bootstrap.device_id, runtime_kind: "ENDPOINT",
      runtime_version: "0.1.0", applied_state_revision: command.desired_state.desired_state.revision,
      applied_policy_version: command.desired_state.desired_state.policy_version, health: "READY", components: [], secure_access: [] }))
    await assert.doesNotReject(async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const device = await modules.endpointRuntime.get({ tenantId: "tenant-1", deviceId: bootstrap.device_id })
        if (device.observed_state.health === "HEALTHY") return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error("Report was not persisted")
    })
    const closed = once(socket, "close", { signal: AbortSignal.timeout(3000) })
    await modules.endpointRuntime.revoke({ tenantId: "tenant-1", deviceId: bootstrap.device_id, subjectId: "admin", correlationId: "revoke", reason: "Lost" })
    assert.equal((await closed)[0], 1008)
  } finally { await app.close() }
})
