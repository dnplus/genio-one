import posthog, { type CaptureOptions, type CaptureResult } from "posthog-js/no-external"

export type PosthogSurface = "management" | "self_service" | "bot"
export type ProductAnalyticsRole = "USER" | "ORGANIZATION_ADMINISTRATOR" | "TENANT_ADMINISTRATOR" | "UNKNOWN"
export type ProductJourneyAction =
  | "access_request_submitted"
  | "access_request_approved"
  | "access_request_denied"
  | "entitlement_revoked"
  | "audit_opened"
  | "bot_message_sent"

type NoProductEventProperties = Record<string, never>

export interface ProductEventProperties {
  genioone_journey_action: { action: ProductJourneyAction }
}

export type ProductEventName = keyof ProductEventProperties
type ProductAnalyticsEventName = ProductEventName | "genioone_workspace_opened" | "$pageview" | "$pageleave"
type ProductAnalyticsEventProperties = ProductEventProperties & {
  genioone_workspace_opened: NoProductEventProperties
  $pageview: NoProductEventProperties
  $pageleave: NoProductEventProperties
}
type ProductRouteFamily = PosthogSurface

interface BrowserConfiguration {
  enabled: true
  host: "https://us.i.posthog.com" | "https://eu.i.posthog.com"
  project_id: number
  project_token: string
}

export interface InitializePosthogProductAnalyticsInput {
  accessToken: string
  role?: string
  signal?: AbortSignal
  surface: PosthogSurface
  tenantId: string
}

const posthogHosts = new Set<BrowserConfiguration["host"]>([
  "https://us.i.posthog.com",
  "https://eu.i.posthog.com",
])
const posthogProjectToken = /^phc_[A-Za-z0-9_-]+$/
const productEventNames = new Set<ProductAnalyticsEventName>([
  "genioone_workspace_opened",
  "$pageview",
  "$pageleave",
  "genioone_journey_action",
])
const productRoles = new Set<ProductAnalyticsRole>([
  "USER",
  "ORGANIZATION_ADMINISTRATOR",
  "TENANT_ADMINISTRATOR",
])
const productJourneyActions = new Set<ProductJourneyAction>([
  "access_request_submitted",
  "access_request_approved",
  "access_request_denied",
  "entitlement_revoked",
  "audit_opened",
  "bot_message_sent",
])
const maximumPendingJourneyEvents = 20

let activeClient: ReturnType<typeof posthog.init> | null = null
let activeConfiguration = ""
let activeContext: { role: ProductAnalyticsRole; surface: PosthogSurface } | null = null
let initialEventsCaptured = false
let initializationRequests = 0
let pageviewOpen = false
let pageLifecycleCleanup: (() => void) | null = null
let pendingJourneyEvents: ProductEventProperties["genioone_journey_action"][] = []
let nextClientNumber = 0

function browserConfiguration(value: unknown): BrowserConfiguration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const configuration = value as Record<string, unknown>
  if (
    configuration.enabled !== true ||
    typeof configuration.host !== "string" ||
    !posthogHosts.has(configuration.host as BrowserConfiguration["host"]) ||
    typeof configuration.project_id !== "number" ||
    !Number.isSafeInteger(configuration.project_id) ||
    configuration.project_id <= 0 ||
    typeof configuration.project_token !== "string" ||
    !posthogProjectToken.test(configuration.project_token)
  ) return null
  return {
    enabled: true,
    host: configuration.host as BrowserConfiguration["host"],
    project_id: configuration.project_id,
    project_token: configuration.project_token,
  }
}

function productRole(value: string | undefined): ProductAnalyticsRole {
  const normalized = value?.trim()
  return normalized && productRoles.has(normalized as ProductAnalyticsRole)
    ? normalized as ProductAnalyticsRole
    : "UNKNOWN"
}

function routeFamilyPath(surface: PosthogSurface) {
  if (surface === "management") return "/management"
  if (surface === "self_service") return "/self-service"
  return "/"
}

function routeFamilyUrl(surface: PosthogSurface) {
  if (typeof location === "undefined") return null
  try {
    const origin = new URL(location.origin)
    if (origin.protocol !== "http:" && origin.protocol !== "https:") return null
    return `${origin.origin}${routeFamilyPath(surface)}`
  } catch {
    return null
  }
}

function isEmptyProductEventProperties(value: unknown): value is NoProductEventProperties {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0
}

function productEventPayload(
  event: ProductAnalyticsEventName,
  properties: ProductAnalyticsEventProperties[ProductAnalyticsEventName],
): Record<string, string> | null {
  if (!activeContext) return null
  if (event === "genioone_workspace_opened" && isEmptyProductEventProperties(properties)) return { ...activeContext }
  if ((event === "$pageview" || event === "$pageleave") && isEmptyProductEventProperties(properties)) {
    const url = routeFamilyUrl(activeContext.surface)
    return url ? { ...activeContext, $current_url: url, route_family: activeContext.surface } : null
  }
  if (
    event === "genioone_journey_action" &&
    properties &&
    typeof properties === "object" &&
    !Array.isArray(properties) &&
    Object.keys(properties).length === 1 &&
    typeof properties.action === "string" &&
    productJourneyActions.has(properties.action as ProductJourneyAction)
  ) return { ...activeContext, action: properties.action }
  return null
}

function pendingJourneyAction(value: unknown): ProductEventProperties["genioone_journey_action"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const properties = value as Record<string, unknown>
  if (
    Object.keys(properties).length !== 1 ||
    typeof properties.action !== "string" ||
    !productJourneyActions.has(properties.action as ProductJourneyAction)
  ) return null
  return { action: properties.action as ProductJourneyAction }
}

function queuePendingJourneyEvent(
  event: ProductEventName,
  properties: ProductEventProperties[ProductEventName],
) {
  if (event !== "genioone_journey_action" || initializationRequests === 0) return
  const pending = pendingJourneyAction(properties)
  if (!pending) return
  if (pendingJourneyEvents.length >= maximumPendingJourneyEvents) pendingJourneyEvents.shift()
  pendingJourneyEvents.push(pending)
}

function clearPendingJourneyEvents() {
  pendingJourneyEvents = []
}

function flushPendingJourneyEvents() {
  const pending = pendingJourneyEvents
  pendingJourneyEvents = []
  for (const properties of pending) captureProductEventSafely("genioone_journey_action", properties)
}

function productEventResult(event: CaptureResult, properties: Record<string, unknown>): CaptureResult {
  const result: CaptureResult = {
    event: event.event,
    properties,
    uuid: event.uuid,
  }
  if (event.timestamp instanceof Date && Number.isFinite(event.timestamp.getTime())) result.timestamp = event.timestamp
  return result
}

function eventForProductAnalytics(event: CaptureResult | null): CaptureResult | null {
  if (!event) return null
  const properties = event.properties ?? {}
  if (typeof event.uuid !== "string" || typeof properties.token !== "string") return null
  const transport = {
    distinct_id: properties.distinct_id,
    token: properties.token,
  }
  if (!productEventNames.has(event.event as ProductAnalyticsEventName)) return null
  const role = productRole(typeof properties.role === "string" ? properties.role : undefined)
  const surface = typeof properties.surface === "string" && ["management", "self_service", "bot"].includes(properties.surface)
    ? properties.surface as PosthogSurface
    : null
  if (!surface) return null
  if (event.event === "genioone_workspace_opened") {
    return productEventResult(event, { ...transport, role, surface })
  }
  if (event.event === "$pageview" || event.event === "$pageleave") {
    const route = typeof properties.route_family === "string" && properties.route_family === surface
      ? properties.route_family as ProductRouteFamily
      : null
    const expectedUrl = routeFamilyUrl(surface)
    const url = typeof properties.$current_url === "string" && expectedUrl && properties.$current_url === expectedUrl
      ? properties.$current_url
      : null
    if (!route || !url) return null
    const sanitizedProperties: Record<string, unknown> = {
      ...transport,
      $current_url: url,
      role,
      route_family: route,
      surface,
    }
    if (event.event === "$pageleave") {
      sanitizedProperties.$prev_pageview_pathname = routeFamilyPath(surface)
      if (
        typeof properties.$prev_pageview_duration === "number" &&
        Number.isFinite(properties.$prev_pageview_duration) &&
        properties.$prev_pageview_duration >= 0
      ) sanitizedProperties.$prev_pageview_duration = properties.$prev_pageview_duration
    }
    return productEventResult(event, sanitizedProperties)
  }
  const action = typeof properties.action === "string" && productJourneyActions.has(properties.action as ProductJourneyAction)
    ? properties.action as ProductJourneyAction
    : null
  return action ? productEventResult(event, { ...transport, action, role, surface }) : null
}

function captureProductEventSafely<Event extends ProductAnalyticsEventName>(
  event: Event,
  properties: ProductAnalyticsEventProperties[Event],
  options?: CaptureOptions,
): boolean {
  try {
    if (!activeClient || !productEventNames.has(event)) return false
    const payload = productEventPayload(event, properties)
    if (!payload) return false
    if (options) activeClient.capture(event, payload, options)
    else activeClient.capture(event, payload)
    return true
  } catch {
    return false
  }
}

function capturePageview() {
  pageviewOpen = captureProductEventSafely("$pageview", {})
}

function capturePageleave() {
  if (!pageviewOpen) return
  pageviewOpen = false
  captureProductEventSafely("$pageleave", {}, { send_instantly: true, transport: "sendBeacon" })
}

function clearPageLifecycle() {
  pageLifecycleCleanup?.()
  pageLifecycleCleanup = null
}

function installPageLifecycle() {
  clearPageLifecycle()
  if (!pageviewOpen || typeof window === "undefined" || typeof document === "undefined") return
  const onPagehide = () => capturePageleave()
  const onPageshow = () => {
    if (!pageviewOpen) capturePageview()
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") capturePageleave()
    if (document.visibilityState === "visible" && !pageviewOpen) capturePageview()
  }
  window.addEventListener("pagehide", onPagehide)
  window.addEventListener("pageshow", onPageshow)
  document.addEventListener("visibilitychange", onVisibilityChange)
  pageLifecycleCleanup = () => {
    window.removeEventListener("pagehide", onPagehide)
    window.removeEventListener("pageshow", onPageshow)
    document.removeEventListener("visibilitychange", onVisibilityChange)
  }
}

export function captureProductEvent<Event extends ProductEventName>(
  event: Event,
  properties: ProductEventProperties[Event],
): void {
  if (!activeClient || !activeContext) {
    queuePendingJourneyEvent(event, properties)
    return
  }
  captureProductEventSafely(event, properties)
}

export function resetPosthogProductAnalytics() {
  clearPendingJourneyEvents()
  capturePageleave()
  clearPageLifecycle()
  const client = activeClient
  activeClient = null
  activeConfiguration = ""
  activeContext = null
  initialEventsCaptured = false
  if (!client) return
  try { client.reset() } catch {}
  try { client.opt_out_capturing() } catch {}
}

export async function initializePosthogProductAnalytics(input: InitializePosthogProductAnalyticsInput) {
  initializationRequests += 1
  try {
    const response = await fetch(
      `/v1/tenants/${encodeURIComponent(input.tenantId)}/telemetry/posthog/browser-configuration`,
      {
        cache: "no-store",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.accessToken}`,
        },
        signal: input.signal,
      },
    )
    if (input.signal?.aborted) {
      clearPendingJourneyEvents()
      return
    }
    if (!response.ok) {
      resetPosthogProductAnalytics()
      return
    }
    const configuration = browserConfiguration(await response.json().catch(() => null))
    if (input.signal?.aborted) {
      clearPendingJourneyEvents()
      return
    }
    if (!configuration) {
      resetPosthogProductAnalytics()
      return
    }
    const configurationKey = `${input.tenantId}\u0000${configuration.host}\u0000${configuration.project_token}\u0000${input.surface}`
    if (activeConfiguration !== configurationKey) {
      if (activeClient || activeConfiguration || activeContext || initialEventsCaptured) resetPosthogProductAnalytics()
      activeClient = posthog.init(
        configuration.project_token,
        {
          advanced_disable_feature_flags: true,
          advanced_disable_feature_flags_on_first_load: true,
          advanced_disable_flags: true,
          advanced_disable_toolbar_metrics: true,
          api_host: configuration.host,
          api_transport: "fetch",
          autocapture: false,
          before_send: eventForProductAnalytics,
          capture_dead_clicks: false,
          capture_exceptions: false,
          capture_heatmaps: false,
          capture_pageleave: false,
          capture_pageview: false,
          capture_performance: false,
          cross_subdomain_cookie: false,
          disableDeviceModel: true,
          disable_conversations: true,
          disable_external_dependency_loading: true,
          disable_persistence: true,
          disable_product_tours: true,
          disable_session_recording: true,
          disable_surveys: true,
          disable_surveys_automatic_display: true,
          disable_web_experiments: true,
          enable_recording_console_log: false,
          person_profiles: "never",
          persistence: "memory",
          request_batching: false,
          save_campaign_params: false,
          save_referrer: false,
        },
        `genioone-product-analytics-${nextClientNumber++}`,
      )
      activeClient.opt_in_capturing({ captureEventName: false })
      activeConfiguration = configurationKey
      initialEventsCaptured = false
    }
    const context = { role: productRole(input.role), surface: input.surface }
    const contextChanged = Boolean(
      activeContext && (activeContext.role !== context.role || activeContext.surface !== context.surface),
    )
    if (!activeClient || input.signal?.aborted) {
      if (input.signal?.aborted) clearPendingJourneyEvents()
      return
    }
    if (initialEventsCaptured && contextChanged) {
      capturePageleave()
      activeContext = context
      capturePageview()
      installPageLifecycle()
      flushPendingJourneyEvents()
      return
    }
    activeContext = context
    if (initialEventsCaptured) {
      flushPendingJourneyEvents()
      return
    }
    captureProductEventSafely("genioone_workspace_opened", {})
    capturePageview()
    installPageLifecycle()
    initialEventsCaptured = true
    flushPendingJourneyEvents()
  } catch {
    if (input.signal?.aborted) {
      clearPendingJourneyEvents()
      return
    }
    resetPosthogProductAnalytics()
  } finally {
    initializationRequests -= 1
  }
}
