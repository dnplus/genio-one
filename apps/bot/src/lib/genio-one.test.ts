import { beforeEach, describe, expect, test } from "bun:test"
import { beginGenioLogin, BOT_OIDC_DEFAULT_SCOPES, clearGenioTokens, completeGenioLogin, decodeJwtPayload, isJwtExpired, loadGenioRefreshToken, loadGenioToken, resolveBotOidcScopes, storeGenioTokens } from "./genio-one"

describe("Genio token storage", () => {
  const localStore = new Map<string, string>()
  const sessionStore = new Map<string, string>()
  let cookieStr = ""

  beforeEach(() => {
    localStore.clear()
    sessionStore.clear()
    cookieStr = ""

    globalThis.localStorage = {
      getItem: (key: string) => localStore.get(key) ?? null,
      setItem: (key: string, value: string) => { localStore.set(key, value) },
      removeItem: (key: string) => { localStore.delete(key) },
      clear: () => { localStore.clear() },
      length: 0,
      key: () => null,
    } as unknown as Storage

    globalThis.sessionStorage = {
      getItem: (key: string) => sessionStore.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionStore.set(key, value) },
      removeItem: (key: string) => { sessionStore.delete(key) },
      clear: () => { sessionStore.clear() },
      length: 0,
      key: () => null,
    } as unknown as Storage

    globalThis.document = {
      get cookie() { return cookieStr },
      set cookie(val: string) {
        if (val.includes("max-age=0")) {
          const name = val.split("=")[0].trim()
          cookieStr = cookieStr.split(";").filter((c) => !c.trim().startsWith(`${name}=`)).join(";").trim()
        } else {
          const pair = val.split(";")[0].trim()
          cookieStr = cookieStr ? `${cookieStr}; ${pair}` : pair
        }
      },
    } as unknown as Document
  })

  test("stores and loads tokens strictly in localStorage", () => {
    clearGenioTokens()
    expect(loadGenioToken()).toBe("")
    expect(loadGenioRefreshToken()).toBe("")

    storeGenioTokens("access-123", "refresh-456")
    expect(loadGenioToken()).toBe("access-123")
    expect(loadGenioRefreshToken()).toBe("refresh-456")
    expect(cookieStr).toBe("")

    clearGenioTokens()
    expect(loadGenioToken()).toBe("")
    expect(loadGenioRefreshToken()).toBe("")
  })

  test("migrates legacy token from sessionStorage to localStorage and clears sessionStorage", () => {
    sessionStore.set("genioone.bot.access_token", "legacy-session-token")
    sessionStore.set("genioone.bot.refresh_token", "legacy-session-refresh")

    expect(loadGenioToken()).toBe("legacy-session-token")
    expect(loadGenioRefreshToken()).toBe("legacy-session-refresh")

    // After migration, it should be in localStorage and removed from sessionStorage
    expect(localStore.get("genioone.bot.access_token")).toBe("legacy-session-token")
    expect(localStore.get("genioone.bot.refresh_token")).toBe("legacy-session-refresh")
    expect(sessionStore.has("genioone.bot.access_token")).toBe(false)
    expect(sessionStore.has("genioone.bot.refresh_token")).toBe(false)
  })

  test("migrates legacy token from cookie to localStorage and clears cookie", () => {
    cookieStr = "genioone.bot.access_token=legacy-cookie-token; genioone.bot.refresh_token=legacy-cookie-refresh"

    expect(loadGenioToken()).toBe("legacy-cookie-token")
    expect(loadGenioRefreshToken()).toBe("legacy-cookie-refresh")

    // After migration, it should be in localStorage and cookie deleted (max-age=0)
    expect(localStore.get("genioone.bot.access_token")).toBe("legacy-cookie-token")
    expect(localStore.get("genioone.bot.refresh_token")).toBe("legacy-cookie-refresh")
    expect(cookieStr).not.toContain("genioone.bot.access_token")
    expect(cookieStr).not.toContain("genioone.bot.refresh_token")
  })

  test("decodes unpadded JWT payloads for proactive refresh", () => {
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60, sub: "person-platform-admin" })).toString("base64url")
    const token = `eyJhbGciOiJub25lIn0.${payload}.signature`
    expect(decodeJwtPayload(token)?.sub).toBe("person-platform-admin")
    expect(isJwtExpired(token, 15)).toBe(true)
  })
})


describe("Bot OIDC scope contract", () => {
  async function completeOidcLogin(initialSearch: string, returnToOverride?: string) {
    const originalFetch = globalThis.fetch
    const originalLocation = globalThis.location
    const originalHistory = globalThis.history
    let redirect: string | URL | null = null
    let restoredTo = ""
    const callbackLocation = {
      origin: "https://bot.test",
      protocol: "https:",
      hostname: "bot.test",
      pathname: "/",
      search: initialSearch,
      hash: "",
      assign: (value: string | URL) => { redirect = value },
    }
    Object.defineProperty(globalThis, "location", { configurable: true, value: callbackLocation })
    Object.defineProperty(globalThis, "history", {
      configurable: true,
      value: { replaceState: (_state: unknown, _unused: string, url?: string | URL | null) => { restoredTo = String(url) } },
    })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "/v1/identity/browser-configuration") {
        return Response.json({
          authorization_endpoint: "https://identity.test/realms/genio-one/protocol/openid-connect/auth",
          token_endpoint: "https://identity.test/realms/genio-one/protocol/openid-connect/token",
        })
      }
      return Response.json({ access_token: "access-token", refresh_token: "refresh-token" })
    }) as unknown as typeof fetch
    try {
      await beginGenioLogin()
      if (returnToOverride) sessionStorage.setItem("genioone.bot.pkce.return_to", returnToOverride)
      const authorization = new URL(String(redirect))
      callbackLocation.search = `?code=authorization-code&state=${authorization.searchParams.get("state")}`
      await completeGenioLogin()
      return restoredTo
    } finally {
      globalThis.fetch = originalFetch
      Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation })
      Object.defineProperty(globalThis, "history", { configurable: true, value: originalHistory })
    }
  }

  test("does not reuse self-service browser-configuration scopes with the bot client", () => {
    const scopes = resolveBotOidcScopes({
      management_scopes: ["openid", "genioone-management"],
    })
    expect(scopes).toContain("openid")
    expect(scopes).toContain("genioone-invocation")
    expect(scopes).toContain("genioone-management")
    // Self-service-only shape must not be what we authorize with.
    expect(scopes).not.toEqual(["openid", "genioone-invocation"])
  })

  test("defaults include management even when management_scopes omitted", () => {
    expect(resolveBotOidcScopes()).toEqual([...BOT_OIDC_DEFAULT_SCOPES])
  })

  test("explicit account switching starts login with reauthentication", async () => {
    const originalFetch = globalThis.fetch
    const originalLocation = globalThis.location
    let redirect: string | URL | null = null
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        origin: "https://bot.test",
        protocol: "https:",
        hostname: "bot.test",
        pathname: "/",
        search: "",
        hash: "",
        assign: (value: string | URL) => { redirect = value },
      },
    })
    globalThis.fetch = (async () => Response.json({
      authorization_endpoint: "https://identity.test/realms/genio-one/protocol/openid-connect/auth",
      token_endpoint: "https://identity.test/realms/genio-one/protocol/openid-connect/token",
    })) as unknown as typeof fetch
    try {
      await beginGenioLogin({ forceReauthentication: true })
      const authorization = new URL(String(redirect))
      expect(authorization.searchParams.get("prompt")).toBe("login")
      expect(authorization.searchParams.get("max_age")).toBe("0")
      expect(authorization.searchParams.get("client_id")).toBe("genio-one-bot")
    } finally {
      globalThis.fetch = originalFetch
      Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation })
    }
  })

  test("normal login keeps the existing SSO request", async () => {
    const originalFetch = globalThis.fetch
    const originalLocation = globalThis.location
    let redirect: string | URL | null = null
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        origin: "https://bot.test",
        protocol: "https:",
        hostname: "bot.test",
        pathname: "/",
        search: "",
        hash: "",
        assign: (value: string | URL) => { redirect = value },
      },
    })
    globalThis.fetch = (async () => Response.json({
      authorization_endpoint: "https://identity.test/realms/genio-one/protocol/openid-connect/auth",
      token_endpoint: "https://identity.test/realms/genio-one/protocol/openid-connect/token",
    })) as unknown as typeof fetch
    try {
      await beginGenioLogin()
      const authorization = new URL(String(redirect))
      expect(authorization.searchParams.has("prompt")).toBe(false)
      expect(authorization.searchParams.has("max_age")).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation })
    }
  })

  test("preserves the local CE demo and locale query after OIDC", async () => {
    expect(await completeOidcLogin("?demo=documents&lang=en")).toBe("/?demo=documents&lang=en")
    expect(sessionStorage.getItem("genioone.bot.pkce.return_to")).toBeNull()
  })

  test("does not restore an external OIDC return target", async () => {
    expect(await completeOidcLogin("?demo=documents&lang=en", "https://attacker.test/redirect")).toBe("/")
    expect(await completeOidcLogin("?demo=documents&lang=en", "//attacker.test/redirect")).toBe("/")
  })
})
