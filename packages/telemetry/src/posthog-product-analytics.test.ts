import { expect, mock, test } from "bun:test"

const capture = mock((..._args: unknown[]) => undefined)
const optIn = mock((..._args: unknown[]) => undefined)
const optOut = mock(() => undefined)
const reset = mock(() => undefined)
const init = mock((..._args: unknown[]) => ({
  capture,
  opt_in_capturing: optIn,
  opt_out_capturing: optOut,
  reset,
}))

mock.module("posthog-js/no-external", () => ({ default: { init } }))

const {
  captureProductEvent,
  initializePosthogProductAnalytics,
  resetPosthogProductAnalytics,
} = await import("./posthog-product-analytics")

test("does not initialize or capture when the tenant has not opted in", async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = mock(async () => Response.json(null)) as unknown as typeof fetch
    await initializePosthogProductAnalytics({
      accessToken: "access-token",
      role: "TENANT_ADMINISTRATOR",
      surface: "management",
      tenantId: "tenant-default",
    })
    captureProductEvent("genioone_journey_action", { action: "audit_opened" })

    expect(init).toHaveBeenCalledTimes(0)
    expect(capture).toHaveBeenCalledTimes(0)
  } finally {
    resetPosthogProductAnalytics()
    globalThis.fetch = originalFetch
  }
})

test("a tenant change starts a new anonymous client even for the same PostHog project", async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = mock(async () => Response.json({
      enabled: true,
      host: "https://us.i.posthog.com",
      project_id: 123,
      project_token: "phc_browser_token",
    })) as unknown as typeof fetch
    const initializationsBefore = init.mock.calls.length
    const capturesBefore = capture.mock.calls.length

    for (const tenantId of ["tenant-one", "tenant-two"]) {
      await initializePosthogProductAnalytics({
        accessToken: "access-token",
        role: "USER",
        surface: "bot",
        tenantId,
      })
    }

    expect(init.mock.calls.length - initializationsBefore).toBe(2)
    expect(capture.mock.calls.slice(capturesBefore).filter(([name]) => name === "genioone_workspace_opened")).toHaveLength(2)
  } finally {
    resetPosthogProductAnalytics()
    globalThis.fetch = originalFetch
  }
})

test("flushes one queued journey action after browser analytics initialization", async () => {
  const originalFetch = globalThis.fetch
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location")
  let resolveConfiguration: (value: Record<string, unknown>) => void = () => undefined
  const configuration = new Promise<Record<string, unknown>>((resolve) => {
    resolveConfiguration = resolve
  })
  try {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://console.example/management/activity?resource=resource-123#entry"),
    })
    globalThis.fetch = mock(async () => Response.json(await configuration)) as unknown as typeof fetch
    const capturesBefore = capture.mock.calls.length
    const initialization = initializePosthogProductAnalytics({
      accessToken: "access-token",
      role: "TENANT_ADMINISTRATOR",
      surface: "management",
      tenantId: "tenant-default",
    })

    captureProductEvent("genioone_journey_action", { action: "audit_opened" })
    expect(capture.mock.calls.length).toBe(capturesBefore)

    resolveConfiguration({
      enabled: true,
      host: "https://us.i.posthog.com",
      project_id: 123,
      project_token: "phc_browser_token",
    })
    await initialization

    expect(capture.mock.calls.slice(capturesBefore)).toEqual([
      ["genioone_workspace_opened", { role: "TENANT_ADMINISTRATOR", surface: "management" }],
      ["$pageview", {
        $current_url: "https://console.example/management",
        role: "TENANT_ADMINISTRATOR",
        route_family: "management",
        surface: "management",
      }],
      ["genioone_journey_action", {
        action: "audit_opened",
        role: "TENANT_ADMINISTRATOR",
        surface: "management",
      }],
    ])

    await initializePosthogProductAnalytics({
      accessToken: "access-token",
      role: "TENANT_ADMINISTRATOR",
      surface: "management",
      tenantId: "tenant-default",
    })
    expect(capture.mock.calls.slice(capturesBefore)).toHaveLength(3)
  } finally {
    resetPosthogProductAnalytics()
    globalThis.fetch = originalFetch
    if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor)
    else delete (globalThis as { location?: Location }).location
  }
})

test("discards queued journey actions when browser analytics initialization fails", async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = mock(async () => { throw new Error("configuration unavailable") }) as unknown as typeof fetch
    const capturesBefore = capture.mock.calls.length
    const initialization = initializePosthogProductAnalytics({
      accessToken: "access-token",
      role: "TENANT_ADMINISTRATOR",
      surface: "management",
      tenantId: "tenant-default",
    })

    captureProductEvent("genioone_journey_action", { action: "audit_opened" })
    await initialization

    expect(capture.mock.calls.slice(capturesBefore)).toEqual([])
  } finally {
    resetPosthogProductAnalytics()
    globalThis.fetch = originalFetch
  }
})

test("discards queued journey actions when browser analytics is disabled", async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = mock(async () => Response.json(null)) as unknown as typeof fetch
    const capturesBefore = capture.mock.calls.length
    const initialization = initializePosthogProductAnalytics({
      accessToken: "access-token",
      role: "TENANT_ADMINISTRATOR",
      surface: "management",
      tenantId: "tenant-default",
    })

    captureProductEvent("genioone_journey_action", { action: "audit_opened" })
    await initialization

    expect(capture.mock.calls.slice(capturesBefore)).toEqual([])
  } finally {
    resetPosthogProductAnalytics()
    globalThis.fetch = originalFetch
  }
})

test("discards queued journey actions when browser analytics is reset", async () => {
  const originalFetch = globalThis.fetch
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location")
  let resolveConfiguration: (response: Response) => void = () => undefined
  const configuration = new Promise<Response>((resolve) => {
    resolveConfiguration = resolve
  })
  try {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://console.example/management/activity?resource=resource-123#entry"),
    })
    globalThis.fetch = mock(() => configuration) as unknown as typeof fetch
    const capturesBefore = capture.mock.calls.length
    const initialization = initializePosthogProductAnalytics({
      accessToken: "access-token",
      role: "TENANT_ADMINISTRATOR",
      surface: "management",
      tenantId: "tenant-default",
    })

    captureProductEvent("genioone_journey_action", { action: "audit_opened" })
    resetPosthogProductAnalytics()
    resolveConfiguration(Response.json({
      enabled: true,
      host: "https://us.i.posthog.com",
      project_id: 123,
      project_token: "phc_browser_token",
    }))
    await initialization

    expect(capture.mock.calls.slice(capturesBefore)).toEqual([
      ["genioone_workspace_opened", { role: "TENANT_ADMINISTRATOR", surface: "management" }],
      ["$pageview", {
        $current_url: "https://console.example/management",
        role: "TENANT_ADMINISTRATOR",
        route_family: "management",
        surface: "management",
      }],
    ])
  } finally {
    resetPosthogProductAnalytics()
    globalThis.fetch = originalFetch
    if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor)
    else delete (globalThis as { location?: Location }).location
  }
})

test("captures allowlisted journey actions and an explicit sanitized standard pageview", async () => {
  const originalFetch = globalThis.fetch
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location")
  try {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://console.example/management/resources/resource-123?email=person@example.com#prompt-secret"),
    })
    globalThis.fetch = mock(async () => Response.json({
      enabled: true,
      host: "https://us.i.posthog.com",
      project_id: 123,
      project_token: "phc_browser_token",
    })) as unknown as typeof fetch
    const capturesBefore = capture.mock.calls.length
    const initializationsBefore = init.mock.calls.length

    await initializePosthogProductAnalytics({
      accessToken: "access-token",
      role: "TENANT_ADMINISTRATOR",
      surface: "management",
      tenantId: "tenant-default",
    })

    expect(init).toHaveBeenCalledTimes(initializationsBefore + 1)
    expect(optIn).toHaveBeenCalledWith({ captureEventName: false })
    expect(capture).toHaveBeenNthCalledWith(capturesBefore + 1, "genioone_workspace_opened", {
      role: "TENANT_ADMINISTRATOR",
      surface: "management",
    })
    expect(capture).toHaveBeenNthCalledWith(capturesBefore + 2, "$pageview", {
      $current_url: "https://console.example/management",
      role: "TENANT_ADMINISTRATOR",
      route_family: "management",
      surface: "management",
    })

    captureProductEvent("genioone_journey_action", { action: "access_request_submitted" })
    captureProductEvent("genioone_journey_action", { action: "prompt secret" } as never)

    expect(capture.mock.calls.slice(capturesBefore)).toHaveLength(3)
    expect(capture).toHaveBeenLastCalledWith("genioone_journey_action", {
      action: "access_request_submitted",
      role: "TENANT_ADMINISTRATOR",
      surface: "management",
    })

    const options = init.mock.calls[initializationsBefore]?.[1] as unknown as Record<string, unknown>
    expect(options).toMatchObject({
      advanced_disable_feature_flags: true,
      advanced_disable_feature_flags_on_first_load: true,
      advanced_disable_flags: true,
      advanced_disable_toolbar_metrics: true,
      api_host: "https://us.i.posthog.com",
      api_transport: "fetch",
      autocapture: false,
      capture_dead_clicks: false,
      capture_exceptions: false,
      capture_heatmaps: false,
      capture_pageleave: false,
      capture_pageview: false,
      capture_performance: false,
      disable_conversations: true,
      disable_external_dependency_loading: true,
      disable_persistence: true,
      disable_product_tours: true,
      disable_session_recording: true,
      disable_surveys: true,
      disable_surveys_automatic_display: true,
      disable_web_experiments: true,
      person_profiles: "never",
      persistence: "memory",
      request_batching: false,
      save_campaign_params: false,
      save_referrer: false,
    })

    const beforeSend = options.before_send as (event: unknown) => unknown
    const timestamp = new Date("2026-09-27T00:00:00.000Z")
    expect(beforeSend({
      event: "$pageview",
      $set: { email: "person@example.com" },
      $set_once: { name: "Person" },
      $unset: ["email"],
      properties: {
        $current_url: "https://console.example/management",
        $device_id: "device-id",
        $pathname: "/management/resources/resource-123",
        $referrer: "https://referrer.example/?email=person@example.com",
        $session_id: "019932c4-1b2f-7a3c-8d4e-5f60718293a4",
        $window_id: "019932c4-1b2f-7b4d-9e5f-60718293a4bc",
        distinct_id: "anonymous-id",
        email: "person@example.com",
        prompt: "prompt secret",
        role: "TENANT_ADMINISTRATOR",
        route_family: "management",
        surface: "management",
        token: "phc_browser_token",
      },
      timestamp,
      unapproved_top_level_field: "prompt secret",
      uuid: "event-id",
    })).toEqual({
      event: "$pageview",
      properties: {
        $current_url: "https://console.example/management",
        $session_id: "019932c4-1b2f-7a3c-8d4e-5f60718293a4",
        $window_id: "019932c4-1b2f-7b4d-9e5f-60718293a4bc",
        distinct_id: "anonymous-id",
        role: "TENANT_ADMINISTRATOR",
        route_family: "management",
        surface: "management",
        token: "phc_browser_token",
      },
      timestamp,
      uuid: "event-id",
    })
    expect(beforeSend({
      event: "$pageleave",
      properties: {
        $current_url: "https://console.example/management",
        $session_id: "019932c4-1b2f-7a3c-8d4e-5f60718293a4",
        $window_id: "019932c4-1b2f-7b4d-9e5f-60718293a4bc",
        $pageview_id: "pageview-id",
        $prev_pageview_duration: 12.5,
        $prev_pageview_id: "previous-pageview-id",
        $prev_pageview_max_scroll: 999,
        $prev_pageview_max_scroll_percentage: 1,
        $prev_pageview_pathname: "/management/resources/resource-123",
        distinct_id: "anonymous-id",
        role: "TENANT_ADMINISTRATOR",
        route_family: "management",
        surface: "management",
        token: "phc_browser_token",
      },
      uuid: "event-id",
    })).toEqual({
      event: "$pageleave",
      properties: {
        $current_url: "https://console.example/management",
        $session_id: "019932c4-1b2f-7a3c-8d4e-5f60718293a4",
        $window_id: "019932c4-1b2f-7b4d-9e5f-60718293a4bc",
        $prev_pageview_duration: 12.5,
        $prev_pageview_pathname: "/management",
        distinct_id: "anonymous-id",
        role: "TENANT_ADMINISTRATOR",
        route_family: "management",
        surface: "management",
        token: "phc_browser_token",
      },
      uuid: "event-id",
    })
    expect(beforeSend({
      event: "genioone_journey_action",
      properties: {
        action: "access_request_submitted",
        distinct_id: "anonymous-id",
        resource_id: "resource-123",
        role: "TENANT_ADMINISTRATOR",
        subject_id: "person-admin",
        surface: "management",
        token: "phc_browser_token",
      },
      uuid: "event-id",
    })).toEqual({
      event: "genioone_journey_action",
      properties: {
        action: "access_request_submitted",
        distinct_id: "anonymous-id",
        role: "TENANT_ADMINISTRATOR",
        surface: "management",
        token: "phc_browser_token",
      },
      uuid: "event-id",
    })
    expect(beforeSend({ event: "$pageview", properties: { token: "phc_browser_token" }, uuid: "event-id" })).toBeNull()
    expect(beforeSend({
      event: "$pageview",
      properties: {
        $current_url: "https://console.example/management",
        $session_id: "session-secret",
        $window_id: "019932c4-1b2f-4b4d-9e5f-60718293a4bc",
        distinct_id: "anonymous-id",
        role: "TENANT_ADMINISTRATOR",
        route_family: "management",
        surface: "management",
        token: "phc_browser_token",
      },
      uuid: "event-id",
    })).toEqual({
      event: "$pageview",
      properties: {
        $current_url: "https://console.example/management",
        distinct_id: "anonymous-id",
        role: "TENANT_ADMINISTRATOR",
        route_family: "management",
        surface: "management",
        token: "phc_browser_token",
      },
      uuid: "event-id",
    })
    expect(beforeSend({ event: "$web_vitals", properties: { token: "phc_browser_token" }, uuid: "event-id" })).toBeNull()
    expect(beforeSend({ event: "unapproved_event", properties: { token: "phc_browser_token" }, uuid: "event-id" })).toBeNull()

    capture.mockImplementationOnce(() => { throw new Error("capture unavailable") })
    expect(() => captureProductEvent("genioone_journey_action", { action: "audit_opened" })).not.toThrow()
  } finally {
    resetPosthogProductAnalytics()
    globalThis.fetch = originalFetch
    if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor)
    else delete (globalThis as { location?: Location }).location
  }
})

test("captures one sanitized pageleave for each browser visibility interval", async () => {
  const originalFetch = globalThis.fetch
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location")
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
  const browserWindow = new EventTarget()
  const browserDocument = new EventTarget()
  let visibilityState = "visible"
  try {
    Object.defineProperty(browserDocument, "visibilityState", { get: () => visibilityState })
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://console.example/management/resources/resource-123?email=person@example.com"),
    })
    Object.defineProperty(globalThis, "window", { configurable: true, value: browserWindow })
    Object.defineProperty(globalThis, "document", { configurable: true, value: browserDocument })
    globalThis.fetch = mock(async () => Response.json({
      enabled: true,
      host: "https://us.i.posthog.com",
      project_id: 123,
      project_token: "phc_browser_token",
    })) as unknown as typeof fetch
    const capturesBefore = capture.mock.calls.length

    await initializePosthogProductAnalytics({
      accessToken: "access-token",
      role: "TENANT_ADMINISTRATOR",
      surface: "management",
      tenantId: "tenant-default",
    })

    expect(capture.mock.calls.slice(capturesBefore)).toEqual([
      ["genioone_workspace_opened", { role: "TENANT_ADMINISTRATOR", surface: "management" }],
      ["$pageview", {
        $current_url: "https://console.example/management",
        role: "TENANT_ADMINISTRATOR",
        route_family: "management",
        surface: "management",
      }],
    ])

    visibilityState = "hidden"
    browserDocument.dispatchEvent(new Event("visibilitychange"))
    browserWindow.dispatchEvent(new Event("pagehide"))

    expect(capture.mock.calls.slice(capturesBefore + 2)).toEqual([[
      "$pageleave",
      {
        $current_url: "https://console.example/management",
        role: "TENANT_ADMINISTRATOR",
        route_family: "management",
        surface: "management",
      },
      { send_instantly: true, transport: "sendBeacon" },
    ]])

    visibilityState = "visible"
    browserDocument.dispatchEvent(new Event("visibilitychange"))
    browserWindow.dispatchEvent(new Event("pageshow"))

    expect(capture.mock.calls.slice(capturesBefore + 3)).toEqual([[
      "$pageview",
      {
        $current_url: "https://console.example/management",
        role: "TENANT_ADMINISTRATOR",
        route_family: "management",
        surface: "management",
      },
    ]])

    resetPosthogProductAnalytics()
    expect(capture.mock.calls.slice(capturesBefore + 4)).toEqual([[
      "$pageleave",
      {
        $current_url: "https://console.example/management",
        role: "TENANT_ADMINISTRATOR",
        route_family: "management",
        surface: "management",
      },
      { send_instantly: true, transport: "sendBeacon" },
    ]])
    const capturesAfterReset = capture.mock.calls.length
    browserWindow.dispatchEvent(new Event("pagehide"))
    browserDocument.dispatchEvent(new Event("visibilitychange"))
    expect(capture.mock.calls.length).toBe(capturesAfterReset)
  } finally {
    resetPosthogProductAnalytics()
    globalThis.fetch = originalFetch
    if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor)
    else delete (globalThis as { location?: Location }).location
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor)
    else delete (globalThis as { window?: Window }).window
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor)
    else delete (globalThis as { document?: Document }).document
  }
})

test("sends pageleave through the real SDK beacon before unload", async () => {
  const originalFetch = globalThis.fetch
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location")
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  const screenDescriptor = Object.getOwnPropertyDescriptor(globalThis, "screen")
  const innerWidthDescriptor = Object.getOwnPropertyDescriptor(globalThis, "innerWidth")
  const innerHeightDescriptor = Object.getOwnPropertyDescriptor(globalThis, "innerHeight")
  const devicePixelRatioDescriptor = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio")
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, "performance")
  const historyDescriptor = Object.getOwnPropertyDescriptor(globalThis, "history")
  const browserWindow = new EventTarget() as unknown as Record<string, unknown> & EventTarget
  const browserDocument = new EventTarget() as unknown as Record<string, unknown> & EventTarget
  const locationValue = new URL("https://console.example/management?view=access")
  const beaconCalls: { path: string; size: number }[] = []
  const browserNavigator = {
    userAgent: "Mozilla/5.0",
    sendBeacon(url: string | URL, body?: unknown) {
      const size = body && typeof body === "object" && "size" in body && typeof body.size === "number" ? body.size : 0
      beaconCalls.push({ path: new URL(url).pathname, size })
      return true
    },
    language: "en-US",
    languages: ["en-US"],
    cookieEnabled: false,
    doNotTrack: "1",
    maxTouchPoints: 0,
    onLine: true,
  }
  browserWindow.location = locationValue
  browserWindow.navigator = browserNavigator
  browserWindow.screen = { width: 1440, height: 1100, availWidth: 1440, availHeight: 1100, colorDepth: 24, pixelDepth: 24 }
  browserWindow.innerWidth = 1440
  browserWindow.innerHeight = 1100
  browserWindow.devicePixelRatio = 1
  browserWindow.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} })
  browserWindow.document = browserDocument
  browserWindow.history = { length: 1 }
  browserWindow.performance = { getEntriesByType: () => [], now: () => 1 }
  browserWindow.setTimeout = setTimeout
  browserWindow.clearTimeout = clearTimeout
  browserWindow.window = browserWindow
  Object.defineProperty(browserDocument, "visibilityState", { configurable: true, writable: true, value: "visible" })
  browserDocument.referrer = ""
  browserDocument.title = ""
  browserDocument.documentElement = { clientWidth: 1440, clientHeight: 1100 }
  browserDocument.body = {}
  browserDocument.cookie = ""
  browserDocument.defaultView = browserWindow
  browserDocument.createElement = (tag: string) => {
    if (tag !== "a") return {}
    let value = ""
    return {
      set href(input: string) { value = new URL(input, locationValue).href },
      get href() { return value },
      get protocol() { return new URL(value).protocol },
      get hostname() { return new URL(value).hostname },
      get port() { return new URL(value).port },
      get pathname() { return new URL(value).pathname },
      get search() { return new URL(value).search },
      get hash() { return new URL(value).hash },
      get host() { return new URL(value).host },
    }
  }
  try {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: locationValue,
    })
    Object.defineProperty(globalThis, "window", { configurable: true, value: browserWindow })
    Object.defineProperty(globalThis, "document", { configurable: true, value: browserDocument })
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: browserNavigator })
    Object.defineProperty(globalThis, "screen", { configurable: true, value: browserWindow.screen })
    Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: 1440 })
    Object.defineProperty(globalThis, "innerHeight", { configurable: true, value: 1100 })
    Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: 1 })
    Object.defineProperty(globalThis, "performance", { configurable: true, value: browserWindow.performance })
    Object.defineProperty(globalThis, "history", { configurable: true, value: browserWindow.history })
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), locationValue).pathname
      if (path.includes("browser-configuration")) return Response.json({
        enabled: true,
        host: "https://us.i.posthog.com",
        project_id: 123,
        project_token: "phc_browser_token",
      })
      return Response.json({})
    }) as unknown as typeof fetch
    const realPosthog = await import("../node_modules/posthog-js/dist/module.no-external.js")
    init.mockImplementation((...args: unknown[]) => realPosthog.default.init(...args as Parameters<typeof realPosthog.default.init>) as unknown as ReturnType<typeof init>)

    await initializePosthogProductAnalytics({
      accessToken: "access-token",
      role: "TENANT_ADMINISTRATOR",
      surface: "management",
      tenantId: "tenant-default",
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(beaconCalls).toEqual([])
    browserWindow.dispatchEvent(new Event("beforeunload"))
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(beaconCalls).toHaveLength(1)
    expect(beaconCalls[0]?.path).toBe("/e/")
    expect(beaconCalls[0]?.size).toBeGreaterThan(0)
    browserWindow.dispatchEvent(new Event("pagehide"))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(beaconCalls).toHaveLength(1)
  } finally {
    resetPosthogProductAnalytics()
    init.mockImplementation((..._args: unknown[]) => ({
      capture,
      opt_in_capturing: optIn,
      opt_out_capturing: optOut,
      reset,
    }))
    globalThis.fetch = originalFetch
    if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor)
    else delete (globalThis as { location?: Location }).location
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor)
    else delete (globalThis as { window?: Window }).window
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor)
    else delete (globalThis as { document?: Document }).document
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor)
    else delete (globalThis as { navigator?: Navigator }).navigator
    if (screenDescriptor) Object.defineProperty(globalThis, "screen", screenDescriptor)
    else delete (globalThis as { screen?: Screen }).screen
    if (innerWidthDescriptor) Object.defineProperty(globalThis, "innerWidth", innerWidthDescriptor)
    else delete (globalThis as { innerWidth?: number }).innerWidth
    if (innerHeightDescriptor) Object.defineProperty(globalThis, "innerHeight", innerHeightDescriptor)
    else delete (globalThis as { innerHeight?: number }).innerHeight
    if (devicePixelRatioDescriptor) Object.defineProperty(globalThis, "devicePixelRatio", devicePixelRatioDescriptor)
    else delete (globalThis as { devicePixelRatio?: number }).devicePixelRatio
    if (performanceDescriptor) Object.defineProperty(globalThis, "performance", performanceDescriptor)
    else delete (globalThis as { performance?: Performance }).performance
    if (historyDescriptor) Object.defineProperty(globalThis, "history", historyDescriptor)
    else delete (globalThis as { history?: History }).history
  }
})

test("does not substitute a fake host when the browser origin is unavailable", async () => {
  const originalFetch = globalThis.fetch
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location")
  try {
    Object.defineProperty(globalThis, "location", { configurable: true, value: undefined })
    globalThis.fetch = mock(async () => Response.json({
      enabled: true,
      host: "https://us.i.posthog.com",
      project_id: 123,
      project_token: "phc_browser_token",
    })) as unknown as typeof fetch
    const capturesBefore = capture.mock.calls.length
    await initializePosthogProductAnalytics({
      accessToken: "access-token",
      role: "USER",
      surface: "self_service",
      tenantId: "tenant-default",
    })

    expect(capture.mock.calls.slice(capturesBefore)).toEqual([[
      "genioone_workspace_opened",
      { role: "USER", surface: "self_service" },
    ]])
  } finally {
    resetPosthogProductAnalytics()
    globalThis.fetch = originalFetch
    if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor)
    else delete (globalThis as { location?: Location }).location
  }
})

test("does not let SDK reset errors interrupt logout", async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = mock(async () => Response.json({
      enabled: true,
      host: "https://us.i.posthog.com",
      project_id: 123,
      project_token: "phc_browser_token",
    })) as unknown as typeof fetch
    await initializePosthogProductAnalytics({
      accessToken: "access-token",
      role: "USER",
      surface: "self_service",
      tenantId: "tenant-default",
    })

    const optOutCalls = optOut.mock.calls.length
    reset.mockImplementationOnce(() => { throw new Error("reset unavailable") })
    optOut.mockImplementationOnce(() => { throw new Error("opt out unavailable") })

    expect(() => resetPosthogProductAnalytics()).not.toThrow()
    expect(optOut.mock.calls.length).toBe(optOutCalls + 1)
  } finally {
    resetPosthogProductAnalytics()
    globalThis.fetch = originalFetch
  }
})
