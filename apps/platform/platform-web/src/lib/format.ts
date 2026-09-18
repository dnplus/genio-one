import i18n from "@/i18n"

export function relativeTime(timestamp: number) {
  const relative = new Intl.RelativeTimeFormat(i18n.resolvedLanguage ?? "en", { numeric: "auto" })
  const seconds = timestamp > 10_000_000_000 ? Math.floor(timestamp / 1_000) : timestamp
  const delta = seconds - Math.floor(Date.now() / 1_000)
  if (Math.abs(delta) < 60) return relative.format(delta, "second")
  if (Math.abs(delta) < 3_600) return relative.format(Math.round(delta / 60), "minute")
  if (Math.abs(delta) < 86_400) return relative.format(Math.round(delta / 3_600), "hour")
  return relative.format(Math.round(delta / 86_400), "day")
}

export function actingClientLabel(client: { status: string; acting_client_id?: string }) {
  return client.status === "VERIFIED" && client.acting_client_id
    ? client.acting_client_id
    : i18n.t("Unknown")
}
