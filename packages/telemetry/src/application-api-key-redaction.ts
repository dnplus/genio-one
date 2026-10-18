const APPLICATION_API_KEY_PATTERN = /(?<![A-Za-z0-9_-])genio_app_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g

export function redactApplicationApiKeys(value: string): string {
  return value.replace(APPLICATION_API_KEY_PATTERN, "[REDACTED_APPLICATION_API_KEY]")
}
