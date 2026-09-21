import { describe, expect, test } from "bun:test"

import { DEFAULT_CODEX_VERSION, selfHostedE2BConfiguration } from "./e2b-self-host"

const base = {
  E2B_DOMAIN: "e2b.internal.example",
  E2B_API_URL: "https://api.e2b.internal.example",
  E2B_SANDBOX_URL: "https://sandbox.e2b.internal.example",
  E2B_API_KEY: "self-host-issued-key",
  GENIO_BOT_E2B_DESKTOP_BASE_TEMPLATE: "desktop-self-hosted",
  GENIO_BOT_E2B_TEMPLATE: "genio-bot-desktop",
  GENIO_BOT_E2B_DESKTOP_TEMPLATE: "genio-bot-desktop",
  GENIO_BOT_E2B_HEADLESS_TEMPLATE: "genio-bot-headless",
}

describe("selfHostedE2BConfiguration", () => {
  test("binds the SDK to the self-hosted control and sandbox planes", () => {
    expect(selfHostedE2BConfiguration(base)).toEqual({
      connection: {
        domain: "e2b.internal.example",
        apiUrl: "https://api.e2b.internal.example",
        sandboxUrl: "https://sandbox.e2b.internal.example",
        apiKey: "self-host-issued-key",
        requestTimeoutMs: 120_000,
      },
      desktopBaseTemplate: "desktop-self-hosted",
      desktopTemplate: "genio-bot-desktop",
      headlessTemplate: "genio-bot-headless",
      codexVersion: DEFAULT_CODEX_VERSION,
    })
  })

  test("uses the Bot package Codex version unless the runtime explicitly pins one", () => {
    expect(selfHostedE2BConfiguration(base).codexVersion).toBe(DEFAULT_CODEX_VERSION)
    expect(selfHostedE2BConfiguration({ ...base, GENIO_BOT_CODEX_VERSION: "0.155.1" }).codexVersion).toBe("0.155.1")
  })

  test("rejects the public E2B service and incomplete self-host configuration", () => {
    expect(() => selfHostedE2BConfiguration({ ...base, E2B_DOMAIN: "e2b.app" })).toThrow("PUBLIC_E2B_DOMAIN_NOT_ALLOWED")
    expect(() => selfHostedE2BConfiguration({ ...base, E2B_API_URL: "https://api.e2b.app" })).toThrow("PUBLIC_E2B_URL_NOT_ALLOWED")
    expect(() => selfHostedE2BConfiguration({ ...base, E2B_API_KEY: "" })).toThrow("E2B_API_KEY_REQUIRED")
    expect(() => selfHostedE2BConfiguration({ ...base, GENIO_BOT_E2B_DESKTOP_TEMPLATE: "", GENIO_BOT_E2B_TEMPLATE: "" })).toThrow("GENIO_BOT_E2B_DESKTOP_TEMPLATE_REQUIRED")
    expect(() => selfHostedE2BConfiguration({ ...base, GENIO_BOT_E2B_HEADLESS_TEMPLATE: "", GENIO_BOT_E2B_TEMPLATE: "" })).toThrow("GENIO_BOT_E2B_HEADLESS_TEMPLATE_REQUIRED")
    expect(() => selfHostedE2BConfiguration({ ...base, GENIO_BOT_E2B_REQUEST_TIMEOUT_MS: "999" })).toThrow("GENIO_BOT_E2B_REQUEST_TIMEOUT_MS_INVALID")
  })
})
