import { expect, test } from "bun:test"

import {
  gatewayActivityDetailAvailability,
  shouldLoadGatewayActivityDetail,
} from "./activity-detail-policy"

const event = {
  detail_availability: "AVAILABLE" as const,
  detail_expires_at: 2_000,
  enforcement_point_id: "AI_GATEWAY" as const,
}

test("available detail loads before its expiry", () => {
  expect(gatewayActivityDetailAvailability(event, 1_999)).toBe("AVAILABLE")
})

test("expired detail is not reloaded from the Activity drawer", () => {
  expect(gatewayActivityDetailAvailability(event, 2_000)).toBe("EXPIRED")
  expect(shouldLoadGatewayActivityDetail({ ...event, detail_expires_at: 1 })).toBe(false)
})
