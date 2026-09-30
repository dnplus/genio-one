import {
  initializePosthogProductAnalytics,
  resetPosthogProductAnalytics,
  type InitializePosthogProductAnalyticsInput,
} from "@genioone/telemetry/posthog-product-analytics"

export {
  captureProductEvent,
  type ProductEventName,
  type ProductEventProperties,
  type ProductJourneyAction,
} from "@genioone/telemetry/posthog-product-analytics"

export function resetPosthogAnalytics() {
  resetPosthogProductAnalytics()
}

export function initializePosthogAnalytics(input: Omit<InitializePosthogProductAnalyticsInput, "surface">) {
  return initializePosthogProductAnalytics({ ...input, surface: "bot" })
}
