import { describe, expect, test } from "bun:test"

import {
  appendDesktopLocationCleanup,
  DesktopBrowserGrants,
  desktopBrowserCookie,
  DESKTOP_BROWSER_COOKIE,
  DESKTOP_BROWSER_GRANT_QUERY,
  proxiedDesktopUrl,
  readDesktopBrowserCookie,
} from "./desktop-proxy"
import type { RuntimeSession } from "./runtime-broker"

function runtimeSession(id = "runtime-1") {
  const desktop = {
    details: {
      kind: "e2b-self-hosted" as const,
      tier: "desktop" as const,
      cwd: "/home/user",
      desktopUrl: "https://desktop.example/vnc.html",
      sandboxId: "sandbox-1",
      environmentId: "e2b-sandbox-1",
      execServerUrl: "ws://executor.example",
      execReady: true,
    },
    proxy: {
      executor: { url: "http://e2b.test/", headers: { "E2b-Sandbox-Id": "sandbox-1", "E2b-Sandbox-Port": "4512" } },
      desktop: { url: "http://e2b.test/", headers: { "E2b-Sandbox-Id": "sandbox-1", "E2b-Sandbox-Port": "6080" } },
    },
    close: async () => {},
  }
  return {
    id,
    principal: { tenant_id: "tenant-1", subject_id: "subject-1", acting_client_id: "genio-one-bot", scopes: [] },
    details: desktop.details,
    runtimeDetails: { desktop: desktop.details },
    leases: { desktop },
    desktop,
    relaySecret: "relay",
    eventBuffer: [],
  } as RuntimeSession
}

describe("proxiedDesktopUrl", () => {
  test("keeps VNC-only options in the fragment and routes its websocket through the runtime session", () => {
    const credential = "a".repeat(43)
    expect(proxiedDesktopUrl(
      "runtime-1",
      "https://6080-sandbox.e2b.example/vnc.html?autoconnect=true&resize=scale&password=secret",
      credential,
    )).toBe(
      `/api/desktop/runtime-1/vnc.html?${DESKTOP_BROWSER_GRANT_QUERY}=${credential}#autoconnect=true&resize=scale&password=secret&path=%2Fapi%2Fdesktop%2Fruntime-1%2Fwebsockify`,
    )
  })

  test("rejects a non-noVNC URL and duplicated or unrecognized VNC options", () => {
    const credential = "a".repeat(43)
    for (const upstream of [
      "https://desktop.example/other.html?password=secret",
      "ftp://desktop.example/vnc.html?password=secret",
      "https://user:password@desktop.example/vnc.html?password=secret",
      "https://desktop.example/vnc.html?password=secret#fragment",
      "https://desktop.example/vnc.html?password=one&password=two",
      "https://desktop.example/vnc.html?password=secret&host=untrusted",
    ]) {
      expect(proxiedDesktopUrl("runtime-1", upstream, credential)).toBeNull()
    }
  })
})

describe("DesktopBrowserGrants", () => {
  test("binds a grant to its current runtime desktop lease and expires it", () => {
    const previous = process.env.E2B_SANDBOX_URL
    process.env.E2B_SANDBOX_URL = "http://e2b.test"
    try {
      let now = 1_000
      const session = runtimeSession()
      const broker = { get: (id: string) => id === session.id ? session : undefined } as any
      const grants = new DesktopBrowserGrants(100, () => now)
      const credential = grants.issue(broker, session.id)
      expect(credential).not.toBeNull()
      expect(grants.validate(broker, session.id, credential!)).toMatchObject({ target: { headers: { "E2b-Sandbox-Id": "sandbox-1" } }, grantExpiresAt: 1_100 })
      expect(grants.validate(broker, "other-runtime", credential!)).toBeNull()

      session.leases.desktop = { ...session.leases.desktop! }
      expect(grants.validate(broker, session.id, credential!)).toBeNull()

      const renewed = grants.issue(broker, session.id)
      expect(renewed).not.toBeNull()
      now = 1_100
      expect(grants.validate(broker, session.id, renewed!)).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.E2B_SANDBOX_URL
      else process.env.E2B_SANDBOX_URL = previous
    }
  })
})

test("desktop cookie is path-scoped and async VNC startup retains configuration after page load", async () => {
  const credential = "a".repeat(43)
  const cookie = desktopBrowserCookie("runtime-1", credential, 2_000, 1_000)
  expect(cookie).toContain(`${DESKTOP_BROWSER_COOKIE}=${credential}`)
  expect(cookie).toContain("Path=/api/desktop/runtime-1/")
  expect(cookie).toContain("HttpOnly")
  expect(cookie).toContain("SameSite=Strict")
  expect(readDesktopBrowserCookie(`${cookie}; unrelated=value`)).toBe(credential)
  const html = appendDesktopLocationCleanup(Buffer.from("<body>noVNC</body>")).toString()
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!
  let url = new URL(`http://bot.test/api/desktop/runtime-1/vnc.html?desktop_grant=${credential}#autoconnect=true&password=private-vnc-password`)
  let onLoad: (() => void) | undefined
  new Function("addEventListener", "history", "location", script)(
    (event: string, listener: () => void) => {
      expect(event).toBe("load")
      onLoad = listener
    },
    { replaceState: (_state: unknown, _title: string, path: string) => { url = new URL(path, url) } },
    url,
  )
  expect(onLoad).toBeDefined()
  onLoad!()
  await Promise.resolve()
  const startupConfig = new URLSearchParams(url.hash.slice(1))
  expect(url.search).toBe("")
  expect(startupConfig.get("autoconnect")).toBe("true")
  expect(startupConfig.get("password")).toBe("private-vnc-password")
})
