import { expect, test } from "bun:test"

import { blankScheduleDraft, rebaseScheduleDraft, scheduleFromDraft, validateScheduleDraft, type ScheduleDraft } from "./BotSchedulesPanel"

test("validates schedule inputs before submitting them", () => {
  expect(validateScheduleDraft({ ...blankScheduleDraft(), prompt: "", onceAt: "2030-01-02T09:00" })).toBe("SCHEDULE_PROMPT_REQUIRED")
  expect(validateScheduleDraft({ ...blankScheduleDraft(), prompt: "Review tickets", onceAt: "" })).toBe("SCHEDULE_ONCE_AT_INVALID")
  expect(validateScheduleDraft({ ...blankScheduleDraft(), prompt: "Review tickets", onceAt: "2020-01-02T09:00" })).toBe("SCHEDULE_ONCE_AT_PAST")
  expect(validateScheduleDraft({ ...blankScheduleDraft(), prompt: "Review tickets", kind: "weekly", time: "09:00", timezone: "Asia/Taipei", weekdays: [] })).toBe("SCHEDULE_WEEKDAYS_REQUIRED")
  expect(validateScheduleDraft({ ...blankScheduleDraft(), prompt: "Review tickets", kind: "daily", time: "25:00", timezone: "Asia/Taipei" })).toBe("SCHEDULE_TIME_INVALID")
})

test("creates readable recurring schedule contracts", () => {
  expect(scheduleFromDraft({ ...blankScheduleDraft(), prompt: "Review tickets", kind: "daily", time: "08:30", timezone: "Asia/Taipei" })).toEqual({
    kind: "recurring",
    frequency: "daily",
    time: "08:30",
    timezone: "Asia/Taipei",
  })
  expect(scheduleFromDraft({ ...blankScheduleDraft(), prompt: "Review tickets", kind: "weekly", time: "08:30", timezone: "Asia/Taipei", weekdays: ["MO", "FR"] })).toEqual({
    kind: "recurring",
    frequency: "weekly",
    time: "08:30",
    timezone: "Asia/Taipei",
    weekdays: ["MO", "FR"],
  })
})


test("rebases untouched schedule fields while preserving local edits", () => {
  const base: ScheduleDraft = { ...blankScheduleDraft(), prompt: "Summarize tickets", kind: "daily", time: "09:00", timezone: "Asia/Taipei", weekdays: ["MO"] }
  const current: ScheduleDraft = { ...base, prompt: "Summarize urgent tickets" }
  const latest: ScheduleDraft = { ...base, prompt: "Remote prompt", time: "16:30", timezone: "Asia/Tokyo", weekdays: ["TU", "TH"] }

  expect(rebaseScheduleDraft(base, current, latest)).toEqual({
    ...latest,
    prompt: "Summarize urgent tickets",
  })
})


test("keeps the local timing group when schedule kinds diverge", () => {
  const base: ScheduleDraft = { ...blankScheduleDraft(), prompt: "Summarize tickets", kind: "daily", time: "09:00", timezone: "Asia/Taipei", weekdays: ["MO"] }
  const current: ScheduleDraft = { ...base, time: "10:00" }
  const latest: ScheduleDraft = { ...base, kind: "once", onceAt: "2030-01-02T09:00", time: "08:00", timezone: "Europe/London", weekdays: ["FR"] }

  expect(rebaseScheduleDraft(base, current, latest)).toEqual(current)
})
