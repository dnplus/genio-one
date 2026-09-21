import { expect, test } from "bun:test"
import { beginBrowserLogin } from "./browser-oidc"

test("account switching forces a fresh OIDC account selection", async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  const originalSessionStorage = globalThis.sessionStorage
  const values = new Map<string, string>()
  let assigned = ""
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      host: "one.example.test",
      hostname: "one.example.test",
      origin: "https://one.example.test",
      protocol: "https:",
      assign: (value: string | URL) => { assigned = String(value) },
    },
  })
  globalThis.fetch = (async () => new Response(JSON.stringify({
    authorization_endpoint: "https://identity.example.test/realms/genio-one/protocol/openid-connect/auth",
    token_endpoint: "https://identity.example.test/realms/genio-one/protocol/openid-connect/token",
    management_client_id: "genio-one-management-console",
    management_scopes: ["openid", "genioone-management"],
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch
  try {
    await beginBrowserLogin("/management", true, { forceReauthentication: true })
    const authorization = new URL(assigned)
    expect(authorization.searchParams.get("prompt")).toBe("login")
    expect(authorization.searchParams.get("max_age")).toBe("0")
    expect(authorization.searchParams.get("client_id")).toBe("genio-one-management-console")
    expect(values.get("genioone.pkce.state:/management")).toBeTruthy()
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation })
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: originalSessionStorage })
  }
})

test("beginBrowserLogin fails securely when crypto.getRandomValues is unavailable", async () => {
  const originalFetch = globalThis.fetch
  const originalCrypto = globalThis.crypto
  const originalLocation = globalThis.location
  const originalSessionStorage = globalThis.sessionStorage
  const values = new Map<string, string>()

  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      host: "one.example.test",
      hostname: "one.example.test",
      origin: "https://one.example.test",
      protocol: "https:",
      assign: () => {},
    },
  })
  globalThis.fetch = (async () => new Response(JSON.stringify({
    authorization_endpoint: "https://identity.example.test/realms/genio-one/protocol/openid-connect/auth",
    token_endpoint: "https://identity.example.test/realms/genio-one/protocol/openid-connect/token",
    management_client_id: "genio-one-management-console",
    management_scopes: ["openid", "genioone-management"],
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch

  // Mock crypto without getRandomValues
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      subtle: originalCrypto?.subtle,
      getRandomValues: undefined,
    },
  })

  try {
    expect(
      beginBrowserLogin("/management", true, { forceReauthentication: true }),
    ).rejects.toThrow("Cryptographically secure random number generator is unavailable.")
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto })
    Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation })
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: originalSessionStorage })
  }
})
