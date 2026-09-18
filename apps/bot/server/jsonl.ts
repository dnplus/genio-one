export function createJsonLineCollector(onLine: (line: string) => void) {
  let pending = ""
  return (chunk: string) => {
    pending += chunk
    for (;;) {
      const newline = pending.indexOf("\n")
      if (newline < 0) return
      const line = pending.slice(0, newline).trim()
      pending = pending.slice(newline + 1)
      if (line) onLine(line)
    }
  }
}
