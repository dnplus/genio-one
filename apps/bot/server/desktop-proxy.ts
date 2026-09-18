export function proxiedDesktopUrl(runtimeSessionId: string, upstreamDesktopUrl: string | null) {
  if (!upstreamDesktopUrl) return null
  const upstream = new URL(upstreamDesktopUrl)
  const session = encodeURIComponent(runtimeSessionId)
  const query = new URLSearchParams(upstream.search)
  query.set("path", `/api/desktop/${session}/websockify`)
  return `/api/desktop/${session}/vnc.html?${query}`
}
