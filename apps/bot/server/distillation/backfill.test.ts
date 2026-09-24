import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Database } from "bun:sqlite"

import type { Turn } from "../generated/v2/Turn"
import { backfillDistillationTurn } from "./backfill"
import { SQLiteDistillationBackfillProgressStore } from "./backfill-progress"
import { BotRegistry } from "../bot-registry"

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryDatabasePath() {
  const directory = mkdtempSync(join(tmpdir(), "genio-distillation-backfill-"))
  temporaryDirectories.push(directory)
  return join(directory, "backfill.sqlite")
}

function turn(id: string): Turn {
  return { id } as Turn
}

test("backfill resumes its persisted cursor after twenty pages and a database reopen", async () => {
  const path = temporaryDatabasePath()
  let database = new Database(path)
  let ready = false
  const imported: string[] = []
  const cursors: Array<string | undefined> = []
  const request = async (_method: string, params: Record<string, unknown>) => {
    const cursor = typeof params.cursor === "string" ? params.cursor : undefined
    cursors.push(cursor)
    const page = cursor ? Number(cursor.slice("cursor-".length)) : 0
    const id = page === 20 ? "target" : `turn-${page}`
    return {
      data: [turn(id)],
      nextCursor: page < 20 ? `cursor-${page + 1}` : null,
    }
  }
  try {
    const firstProgress = new SQLiteDistillationBackfillProgressStore(database).forTurn("bot", "thread", "target")
    const first = await backfillDistillationTurn({
      request,
      importTurns: (turns) => {
        imported.push(...turns.map((item) => item.id))
        ready = turns.some((item) => item.id === "target")
      },
      readRevision: () => 1,
      threadId: "thread",
      turnId: "target",
      ready: () => ready,
      progress: firstProgress,
    })
    expect(first.status).toBe("MORE_PAGES")
    expect(cursors).toHaveLength(20)
    expect(cursors[0]).toBeUndefined()
    expect(firstProgress.cursor()).toBe("cursor-20")
    database.close()
    database = new Database(path)

    const resumedProgress = new SQLiteDistillationBackfillProgressStore(database).forTurn("bot", "thread", "target")
    const resumed = await backfillDistillationTurn({
      request,
      importTurns: (turns) => {
        imported.push(...turns.map((item) => item.id))
        ready = turns.some((item) => item.id === "target")
      },
      readRevision: () => 2,
      threadId: "thread",
      turnId: "target",
      ready: () => ready,
      progress: resumedProgress,
    })
    expect(resumed.status).toBe("READY")
    expect(cursors.at(-1)).toBe("cursor-20")
    expect(imported.at(-1)).toBe("target")
    expect(resumedProgress.cursor()).toBeNull()
    expect(resumedProgress.seen()).toEqual([])
  } finally {
    database.close()
  }
})

test("backfill clears cyclic and invalid persistent cursors without clearing a timeout", async () => {
  const path = temporaryDatabasePath()
  let database = new Database(path)
  const cursors: Array<string | undefined> = []
  const cycleRequest = async (_method: string, params: Record<string, unknown>) => {
    const cursor = typeof params.cursor === "string" ? params.cursor : undefined
    cursors.push(cursor)
    const page = cursor ? Number(cursor.slice(1)) : 0
    return {
      data: [turn(`turn-${page}`)],
      nextCursor: page < 20 ? `c${page + 1}` : page === 20 ? "c0" : "c1",
    }
  }
  const input = (progress: ReturnType<SQLiteDistillationBackfillProgressStore["forTurn"]>, request: typeof cycleRequest) => ({
    request,
    importTurns: () => {},
    readRevision: () => 1,
    threadId: "thread",
    turnId: "target",
    ready: () => false,
    progress,
  })
  try {
    const firstProgress = new SQLiteDistillationBackfillProgressStore(database).forTurn("bot", "thread", "target")
    expect((await backfillDistillationTurn(input(firstProgress, cycleRequest))).status).toBe("MORE_PAGES")
    expect(firstProgress.cursor()).toBe("c20")
    database.close()
    database = new Database(path)

    const resumedProgress = new SQLiteDistillationBackfillProgressStore(database).forTurn("bot", "thread", "target")
    const exhausted = await backfillDistillationTurn(input(resumedProgress, cycleRequest))
    expect(exhausted.status).toBe("EXHAUSTED")
    expect(exhausted.exhaustedScans).toBe(1)
    expect(cursors.slice(-2)).toEqual(["c20", "c0"])
    expect(resumedProgress.cursor()).toBeNull()
    database.close()
    database = new Database(path)
    const afterExhaustion = new SQLiteDistillationBackfillProgressStore(database).forTurn("bot", "thread", "target")
    expect(afterExhaustion.exhaustedScans()).toBe(1)

    afterExhaustion.save("invalid", ["invalid"])
    expect((await backfillDistillationTurn(input(afterExhaustion, async () => {
      throw new Error('{"code":"INVALID_CURSOR","message":"invalid cursor"}')
    }))).status).toBe("TRANSIENT_FAILURE")
    expect(afterExhaustion.cursor()).toBeNull()
    expect(afterExhaustion.exhaustedScans()).toBe(0)

    afterExhaustion.save("timeout", ["timeout"])
    expect((await backfillDistillationTurn(input(afterExhaustion, async () => {
      throw new Error("BOT_RUNTIME_REQUEST_TIMEOUT")
    }))).status).toBe("TRANSIENT_FAILURE")
    expect(afterExhaustion.cursor()).toBe("timeout")
  } finally {
    database.close()
  }
})

test("a deleted bot cannot recreate progress after an in-flight page request", async () => {
  const registry = new BotRegistry(":memory:")
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "client", scopes: [] }
  const bot = registry.create(principal, { name: "A" })
  const progress = new SQLiteDistillationBackfillProgressStore(registry.db).forTurn(bot.id, "thread", "turn")
  let requestStarted = false
  let releaseRequest = () => {}
  const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve })
  try {
    const backfill = backfillDistillationTurn({
      async request() {
        requestStarted = true
        await requestGate
        return { data: [turn("other")], nextCursor: "cursor-1" }
      },
      importTurns: (turns) => registry.importRuntimeHistory(bot.id, "thread", turns, registry.timeline.revision()),
      readRevision: () => registry.timeline.revision(),
      threadId: "thread",
      turnId: "turn",
      ready: () => false,
      progress,
    })
    for (let attempt = 0; attempt < 20 && !requestStarted; attempt += 1) await Promise.resolve()
    expect(requestStarted).toBe(true)
    registry.delete(bot.id, principal)
    releaseRequest()
    expect((await backfill).status).toBe("EXHAUSTED")
    expect(progress.cursor()).toBeNull()
    expect(registry.db.query("select count(*) as count from bot_distillation_backfill_progress where bot_id = ?").get(bot.id)).toEqual({ count: 0 })
  } finally {
    registry.close()
  }
})
