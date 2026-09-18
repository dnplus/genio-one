const supportedTimeZones = [
  "Asia/Taipei",
  "Asia/Tokyo",
  "America/Los_Angeles",
  "Europe/London",
] as const

export type ConsoleTimeZone = typeof supportedTimeZones[number]

export interface PersonalPreferences {
  timezone: ConsoleTimeZone
  accessNotifications: boolean
  securityNotifications: boolean
  productNotifications: boolean
}

const defaultPersonalPreferences: PersonalPreferences = {
  timezone: "Asia/Taipei",
  accessNotifications: true,
  securityNotifications: true,
  productNotifications: false,
}

const activeTimeZoneKey = "genio-one:active-time-zone"

function isTimeZone(value: unknown): value is ConsoleTimeZone {
  return supportedTimeZones.includes(value as ConsoleTimeZone)
}

export function loadPersonalPreferences(subjectId: string): PersonalPreferences {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(`genio-one:personal-preferences:${subjectId}`) ?? "null",
    ) as Partial<PersonalPreferences> | null
    return {
      ...defaultPersonalPreferences,
      ...stored,
      timezone: isTimeZone(stored?.timezone)
        ? stored.timezone
        : defaultPersonalPreferences.timezone,
    }
  } catch {
    return defaultPersonalPreferences
  }
}

export function savePersonalPreferences(
  subjectId: string,
  preferences: PersonalPreferences,
): void {
  window.localStorage.setItem(
    `genio-one:personal-preferences:${subjectId}`,
    JSON.stringify(preferences),
  )
  window.localStorage.setItem(activeTimeZoneKey, preferences.timezone)
}

export function activatePersonalPreferences(subjectId: string): PersonalPreferences {
  const preferences = loadPersonalPreferences(subjectId)
  window.localStorage.setItem(activeTimeZoneKey, preferences.timezone)
  return preferences
}

export function currentTimeZone(): ConsoleTimeZone {
  try {
    const value = window.localStorage.getItem(activeTimeZoneKey)
    return isTimeZone(value) ? value : defaultPersonalPreferences.timezone
  } catch {
    return defaultPersonalPreferences.timezone
  }
}

function currentLanguage(): string {
  if (typeof document !== "undefined" && document.documentElement.lang) return document.documentElement.lang
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language
  return "en"
}

export function formatEpochSeconds(timestamp: number, language = currentLanguage()): string {
  const seconds = timestamp > 10_000_000_000 ? Math.floor(timestamp / 1_000) : timestamp
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: currentTimeZone(),
  }).format(new Date(seconds * 1_000))
}

export function dateKeyInTimeZone(timestamp: number, timeZone: string = currentTimeZone()): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp * 1_000))
  const part = (type: string) => parts.find((value) => value.type === type)?.value ?? ""
  return `${part("year")}-${part("month")}-${part("day")}`
}

export function calendarDayStartEpochSeconds(
  year: number,
  monthIndex: number,
  day: number,
  timeZone: string = currentTimeZone(),
): number {
  const target = Date.UTC(year, monthIndex, day)
  let instant = target
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant))
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0)
    const represented = Date.UTC(
      value("year"),
      value("month") - 1,
      value("day"),
      value("hour"),
      value("minute"),
      value("second"),
    )
    instant += target - represented
  }
  return Math.floor(instant / 1_000)
}
