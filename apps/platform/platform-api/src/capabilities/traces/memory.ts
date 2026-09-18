import type { TraceStore } from "./module"

export function createInMemoryTraceStore(): TraceStore {
  return { spans: async () => ({ spans: [], next_cursor: null }), logs: async () => ({ records: [], next_cursor: null }), list: async () => [] }
}
