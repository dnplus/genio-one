import { expect, test } from "bun:test"

import { authenticateDesktopProxySession, authenticateExecutorProxySession } from "./auth"
import { desktopBrowserGrants, DESKTOP_BROWSER_COOKIE, DESKTOP_BROWSER_GRANT_QUERY } from "./desktop-proxy"
import type { RuntimeSession } from "./runtime-broker"

function runtimeSession() {
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
    close: async () => {},
  }
  return {
    id: "runtime-1",
    relaySecret: "relay",
    principal: { tenant_id: "tenant-1", subject_id: "subject-1", acting_client_id: "genio-one-bot", scopes: [] },
    details: desktop.details,
    runtimeDetails: { desktop: desktop.details },
    leases: { desktop },
    desktop,
    eventBuffer: [],
  } as RuntimeSession
}

test("desktop grants bootstrap the VNC document once and become cookie-only browser credentials", () => {
  const previous = process.env.E2B_SANDBOX_URL
  process.env.E2B_SANDBOX_URL = "http://e2b.test"
  try {
    const runtime = runtimeSession()
    const broker = { get: (id: string) => id === runtime.id ? runtime : undefined } as any
    const credential = desktopBrowserGrants.issue(broker, runtime.id)!
    const initial = authenticateDesktopProxySession(broker, runtime.id, {
      headers: {},
      query: { [DESKTOP_BROWSER_GRANT_QUERY]: credential },
    }, true)
    expect(initial).toMatchObject({ sandboxId: "sandbox-1", bootstrap: true })
    expect(authenticateDesktopProxySession(broker, runtime.id, {
      headers: {},
      query: { [DESKTOP_BROWSER_GRANT_QUERY]: credential },
    }, false)).toBeNull()
    expect(authenticateDesktopProxySession(broker, runtime.id, {
      headers: { cookie: `${DESKTOP_BROWSER_COOKIE}=${credential}` },
    }, false)).toMatchObject({ sandboxId: "sandbox-1", bootstrap: false })
    const renewed = desktopBrowserGrants.issue(broker, runtime.id)!
    expect(authenticateDesktopProxySession(broker, runtime.id, {
      headers: { cookie: `${DESKTOP_BROWSER_COOKIE}=${credential}` },
      query: { [DESKTOP_BROWSER_GRANT_QUERY]: renewed },
    }, true)).toMatchObject({ sandboxId: "sandbox-1", bootstrap: true })
    expect(authenticateDesktopProxySession(broker, runtime.id, {
      headers: { cookie: `${DESKTOP_BROWSER_COOKIE}=${credential}` },
      query: { [DESKTOP_BROWSER_GRANT_QUERY]: "invalid" },
    }, true)).toMatchObject({ sandboxId: "sandbox-1", bootstrap: false })
  } finally {
    if (previous === undefined) delete process.env.E2B_SANDBOX_URL
    else process.env.E2B_SANDBOX_URL = previous
  }
})

test("desktop grant cannot authenticate the executor proxy", async () => {
  const previous = process.env.E2B_SANDBOX_URL
  process.env.E2B_SANDBOX_URL = "http://e2b.test"
  try {
    const runtime = runtimeSession()
    const broker = { get: (id: string) => id === runtime.id ? runtime : undefined } as any
    const credential = desktopBrowserGrants.issue(broker, runtime.id)!
    expect(await authenticateExecutorProxySession(broker, runtime.id, "desktop", {
      headers: {},
      query: { [DESKTOP_BROWSER_GRANT_QUERY]: credential },
    } as any)).toBeNull()
  } finally {
    if (previous === undefined) delete process.env.E2B_SANDBOX_URL
    else process.env.E2B_SANDBOX_URL = previous
  }
})
