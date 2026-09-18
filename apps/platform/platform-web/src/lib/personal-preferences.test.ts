import assert from "node:assert/strict"
import test from "node:test"

import {
  activatePersonalPreferences,
  calendarDayStartEpochSeconds,
  currentTimeZone,
  dateKeyInTimeZone,
  formatEpochSeconds,
  savePersonalPreferences,
} from "./personal-preferences"

const storage = new Map<string, string>()

async function withBrowserStorage(run: () => void | Promise<void>) {
  storage.clear()
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    },
  })
  try {
    await run()
  } finally {
    Reflect.deleteProperty(globalThis, "window")
  }
}

test("personal time zone activates the signed-in account preference", async () => {
  await withBrowserStorage(() => {
    savePersonalPreferences("person-1", {
      timezone: "America/Los_Angeles",
      accessNotifications: true,
      securityNotifications: true,
      productNotifications: false,
    })
    storage.set("genio-one:active-time-zone", "Asia/Taipei")
    activatePersonalPreferences("person-1")
    assert.equal(currentTimeZone(), "America/Los_Angeles")
  })
})

test("personal time zone formats and groups the same instant locally", async () => {
  await withBrowserStorage(() => {
    savePersonalPreferences("person-1", {
      timezone: "America/Los_Angeles",
      accessNotifications: true,
      securityNotifications: true,
      productNotifications: false,
    })
    const timestamp = Date.parse("2026-08-30T02:30:00Z") / 1_000
    assert.equal(dateKeyInTimeZone(timestamp), "2026-08-29")
    assert.match(formatEpochSeconds(timestamp, "en-US"), /Aug 29, 2026/)
  })
})

test("personal time zone converts a calendar day to the correct UTC instant", () => {
  assert.equal(
    calendarDayStartEpochSeconds(2026, 7, 30, "Asia/Taipei"),
    Date.parse("2026-08-29T16:00:00Z") / 1_000,
  )
  assert.equal(
    calendarDayStartEpochSeconds(2026, 7, 30, "America/Los_Angeles"),
    Date.parse("2026-08-30T07:00:00Z") / 1_000,
  )
})
