export function isMissingCodexThread(error: unknown) {
  if (!(error instanceof Error)) return false
  try {
    const detail = JSON.parse(error.message)
    return detail.code === -32600 && typeof detail.message === "string" && /^no rollout found for thread id [a-zA-Z0-9-]+$/.test(detail.message)
  } catch {
    return false
  }
}
