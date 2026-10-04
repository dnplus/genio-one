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

async function withLoginBrowser(
  initialHref: string,
  run: (browser: {
    values: Map<string, string>
    destination: () => string
    restored: () => number
    callback: () => void
  }) => Promise<void>,
) {
  const originals = Object.fromEntries(["fetch", "location", "sessionStorage", "history", "window", "PopStateEvent"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const values = new Map<string, string>()
  let current = new URL(initialHref)
  let restored = 0
  const events = new EventTarget()
  events.addEventListener("popstate", () => restored++)
  const location = {
    get href() { return current.href },
    get origin() { return current.origin },
    get pathname() { return current.pathname },
    get search() { return current.search },
    get host() { return current.host },
    get hostname() { return current.hostname },
    get protocol() { return current.protocol },
    assign() {},
  }
  const globals = {
    location,
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
    history: {
      replaceState: (_state: unknown, _unused: string, url: string) => { current = new URL(url, current.origin) },
    },
    window: events,
    PopStateEvent: Event,
    fetch: async (url: string) => new Response(JSON.stringify(String(url).includes("/token")
      ? { access_token: "test-access-token" }
      : {
          authorization_endpoint: "https://identity.example.test/auth",
          token_endpoint: "https://identity.example.test/token",
          management_client_id: "console",
          management_scopes: ["openid", "genioone-management"],
        }), { status: 200 }),
  }
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  try {
    await run({
      values,
      destination: () => current.pathname + current.search + current.hash,
      restored: () => restored,
      callback: () => {
        current = new URL(`https://one.example.test/management?code=test-code&state=${values.get("genioone.pkce.state:/management")}&session_state=session&iss=issuer`)
      },
    })
  } finally {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test("OIDC completion restores the requested management view and notifies navigation", async () => {
  const { completeBrowserLogin } = await import("./browser-oidc")
  for (const view of ["access", "audit"]) await withLoginBrowser(`https://one.example.test/management?view=${view}`, async (browser) => {
    await beginBrowserLogin("/management", true)
    browser.callback()
    expect(await completeBrowserLogin("/management")).toBe("test-access-token")
    expect(browser.destination()).toBe(`/management?view=${view}`)
    expect(browser.restored()).toBe(1)
    expect(browser.values.has("genioone.oidc.destination:/management")).toBe(false)
    expect(browser.destination()).not.toContain("test-code")
  })
})

test("OIDC return locations stay on the callback path and remove protocol parameters", async () => {
  const { completeBrowserLogin } = await import("./browser-oidc")
  for (const [saved, expected] of [
    ["https://other.example.test/management", "/management"],
    ["//other.example.test/management", "/management"],
    ["/self-service?view=access", "/management"],
    ["/management?view=access&code=old&state=old&error=old#review", "/management?view=access#review"],
  ]) await withLoginBrowser("https://one.example.test/management?view=access", async (browser) => {
    await beginBrowserLogin("/management", true)
    browser.values.set("genioone.oidc.destination:/management", saved)
    browser.callback()
    await completeBrowserLogin("/management")
    expect(browser.destination()).toBe(expected)
  })
})

test("an invalid OIDC state does not restore a destination or persist a token", async () => {
  const { completeBrowserLogin, clearBrowserSession } = await import("./browser-oidc")
  await withLoginBrowser("https://one.example.test/management?view=access", async (browser) => {
    await beginBrowserLogin("/management", true)
    browser.callback()
    browser.values.set("genioone.pkce.state:/management", "different-state")
    await expect(completeBrowserLogin("/management")).rejects.toThrow("OIDC_STATE_INVALID")
    expect(browser.restored()).toBe(0)
    expect(browser.values.has("genioone.management_token")).toBe(false)
    clearBrowserSession("/management")
    expect(browser.values.has("genioone.oidc.destination:/management")).toBe(false)
  })
})
