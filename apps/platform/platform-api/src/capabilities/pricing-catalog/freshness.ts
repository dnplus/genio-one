const DEFAULT_MAX_AGE_HOURS = 24

export function priceCatalogIsFresh(
  fetchedAt: number | null,
  nowSeconds: number,
  maxAgeSeconds: number,
): boolean {
  return fetchedAt !== null && nowSeconds - fetchedAt < maxAgeSeconds
}

/**
 * Returns the freshness window in seconds when the sync was started with `--if-stale[=hours]`,
 * or null when the catalog must always be fetched.
 */
export function ifStaleMaxAgeSeconds(argv: readonly string[]): number | null {
  const flag = argv.find((argument) => argument === "--if-stale" || argument.startsWith("--if-stale="))
  if (!flag) return null
  if (flag === "--if-stale") return DEFAULT_MAX_AGE_HOURS * 3_600
  const hours = Number(flag.slice("--if-stale=".length))
  if (!Number.isFinite(hours) || hours <= 0) throw new Error("--if-stale expects a positive number of hours")
  return Math.round(hours * 3_600)
}
