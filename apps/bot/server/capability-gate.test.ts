import { describe, expect, test } from "bun:test"

import {
  CapabilityDeniedError,
  PERSONAL_BOT_COMPUTER_USE,
  PERSONAL_BOT_USE,
  assertCapability,
  createCapabilityGate,
} from "./capability-gate"
import type { GenioPrincipal } from "./runtime-broker"

const entitled: GenioPrincipal = {
  tenant_id: "tenant-keycloak-local",
  subject_id: "person-platform-admin",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

const stranger: GenioPrincipal = {
  ...entitled,
  subject_id: "person-other",
}

describe("CapabilityGate", () => {
  test("open mode admits every verified principal", async () => {
    const gate = createCapabilityGate({ mode: "open" })
    expect(await gate.require(stranger, PERSONAL_BOT_USE)).toBe("allow")
  })

  test("fixture allowlist admits only named subjects for personal bot", async () => {
    const gate = createCapabilityGate({
      mode: "fixture",
      personalBotAllowlist: ["tenant-keycloak-local:person-platform-admin"],
    })
    expect(await gate.require(entitled, PERSONAL_BOT_USE)).toBe("allow")
    expect(await gate.require(stranger, PERSONAL_BOT_USE)).toBe("deny")
    expect(await gate.require(entitled, PERSONAL_BOT_COMPUTER_USE)).toBe("deny")
  })

  test("assertCapability fails closed with a session-close error", async () => {
    const gate = createCapabilityGate({
      mode: "fixture",
      personalBotAllowlist: ["tenant-keycloak-local:person-platform-admin"],
    })
    await expect(assertCapability(gate, stranger, PERSONAL_BOT_USE)).rejects.toBeInstanceOf(CapabilityDeniedError)
  })

  test("control-plane mode consumes the One Policy decision", async () => {
    const gate = createCapabilityGate({
      environment: { GENIO_ONE_PLATFORM_ORIGIN: "http://platform.test" },
      fetch: async () => new Response(JSON.stringify({
        tenant_id: entitled.tenant_id,
        subject_id: entitled.subject_id,
        client_id: entitled.acting_client_id,
        resource_id: "genio.personal-bot",
        capability_id: PERSONAL_BOT_USE,
        decision: "ALLOW",
        policy_id: "one-policy.first-party.bot-default",
        policy_revision: 1,
        model_route: "codex-subscription",
        reason_code: "DEFAULT_ADMIN_BOT_ACCESS",
      }), { status: 200 }),
    })
    const decision = await gate.resolve(entitled, PERSONAL_BOT_USE, "access-token")
    expect(decision.decision).toBe("ALLOW")
    expect(decision.model_route).toBe("codex-subscription")
    expect(await gate.require(entitled, PERSONAL_BOT_USE, "access-token")).toBe("allow")
  })

  test("preserves the Platform denial reason for the runtime bridge", async () => {
    const gate = createCapabilityGate({
      environment: { GENIO_ONE_PLATFORM_ORIGIN: "http://platform.test" },
      fetch: async () => new Response(JSON.stringify({
        tenant_id: entitled.tenant_id,
        subject_id: entitled.subject_id,
        client_id: entitled.acting_client_id,
        resource_id: "genio.personal-bot",
        capability_id: PERSONAL_BOT_USE,
        decision: "DENY",
        policy_id: "one-policy.first-party.bot-default",
        policy_revision: 2,
        model_route: null,
        reason_code: "BOT_CONNECTION_DISABLED",
      }), { status: 200 }),
    })

    await expect(assertCapability(gate, entitled, PERSONAL_BOT_USE, "access-token")).rejects.toMatchObject({
      message: "BOT_CONNECTION_DISABLED",
      reasonCode: "BOT_CONNECTION_DISABLED",
    })
  })
})
