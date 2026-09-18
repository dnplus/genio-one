export function isTemporarySessionFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true
  if (!(error instanceof Error)) return false
  const status = "status" in error ? Number(error.status) : Number(error.message.match(/PRODUCT_API_REQUEST_FAILED_(\d+)/)?.[1])
  return status === 429 || status >= 500
}
