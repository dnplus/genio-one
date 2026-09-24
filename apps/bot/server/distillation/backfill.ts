import type { Turn } from "../generated/v2/Turn"

export interface DistillationBackfillProgress {
  cursor(): string | null
  seen(): string[]
  exhaustedScans(): number
  save(cursor: string, seen: readonly string[]): void
  resetCursor(): void
  recordExhaustedScan(): number
  clear(): void
}

export type DistillationBackfillStatus = "READY" | "MORE_PAGES" | "EXHAUSTED" | "TRANSIENT_FAILURE"

export interface DistillationBackfillResult {
  status: DistillationBackfillStatus
  exhaustedScans: number
}

function invalidCursorError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\binvalid_cursor\b|\b(?:invalid|expired|malformed|unknown)\s+cursor\b|\bcursor\s+(?:is\s+)?(?:invalid|expired|malformed|unknown)\b/i.test(message)
}

export async function backfillDistillationTurn(input: {
  request: (method: string, params: Record<string, unknown>) => Promise<{ data?: Turn[]; nextCursor?: string | null }>
  importTurns: (turns: Turn[], revision: number) => void
  readRevision: () => number
  threadId: string
  turnId: string
  ready: () => boolean
  progress?: DistillationBackfillProgress
}): Promise<DistillationBackfillResult> {
  let cursor = input.progress?.cursor() ?? undefined
  let exhaustedScans = input.progress?.exhaustedScans() ?? 0
  const seen = new Set(input.progress?.seen() ?? [])
  if (cursor) seen.add(cursor)
  for (let page = 0; page < 20; page += 1) {
    const revision = input.readRevision()
    let result: { data?: Turn[]; nextCursor?: string | null }
    try {
      result = await input.request("thread/turns/list", {
        threadId: input.threadId,
        ...(cursor ? { cursor } : {}),
        limit: 50,
        sortDirection: "desc",
        itemsView: "full",
      })
    } catch (error) {
      if (invalidCursorError(error)) {
        input.progress?.resetCursor()
        exhaustedScans = 0
      }
      return { status: "TRANSIENT_FAILURE", exhaustedScans }
    }
    const turns = Array.isArray(result.data) ? result.data : []
    if (turns.length > 0) input.importTurns(turns, revision)
    if (input.ready()) {
      input.progress?.clear()
      return { status: "READY", exhaustedScans: 0 }
    }
    if (!result.nextCursor || seen.has(result.nextCursor)) {
      exhaustedScans = input.progress?.recordExhaustedScan() ?? exhaustedScans + 1
      return { status: "EXHAUSTED", exhaustedScans }
    }
    seen.add(result.nextCursor)
    cursor = result.nextCursor
    input.progress?.save(cursor, [...seen])
  }
  return { status: "MORE_PAGES", exhaustedScans }
}
