import { afterEach, expect, test } from "bun:test"

import type { Turn } from "./generated/v2/Turn"
import { BotRegistry } from "./bot-registry"
import { createBotApp } from "./app"
import { backfillDistillationTurn } from "./distillation/backfill"
import { SQLiteDistillationBackfillProgressStore } from "./distillation/backfill-progress"
import { contentDigest, markerContentDigest, sourceRevision } from "./distillation/history"
import { attachDistillation, createDistillationWorker } from "./distillation/worker"
import { createHttpDistillationPlatform } from "./distillation/platform"
import { distillationDecisionAttributes } from "./distillation/span"
import { DISTILLATION_QUESTIONS } from "@genioone/protocol/distillation-triage"
import type { DistillationTriage } from "@genioone/protocol/distillation-triage"

const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
const canary = "客戶合約的部署步驟"
let registry: BotRegistry | undefined
afterEach(() => registry?.close())

function classified(relevant: boolean): DistillationTriage {
  return {
    status: "CLASSIFIED",
    relevant,
    scope: relevant ? "process" : "unrelated",
    sensitivity: "standard",
    knowledge_type: relevant ? "PROCEDURE" : "FACT",
    representation: relevant ? "BOTH" : "HUMAN",
    classifier_version: "jev-distillation-1",
    evidence: DISTILLATION_QUESTIONS.map((question) => ({
      check_id: question.id,
      score: relevant && (question.id === "relevant" || question.id === "scope_process" || question.id === "type_procedure") ? 0.9 : 0.1,
      threshold: question.threshold,
      matched: relevant && (question.id === "relevant" || question.id === "scope_process" || question.id === "type_procedure"),
    })),
  }
}

function completeTurn(text = canary) {
  registry!.rememberThread(registry!.create(principal, { name: "A", description: "工作" }).id, "thread")
  const botId = registry!.list(principal)[0]!.id
  registry!.recordRuntimeEvent(principal, JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "thread",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [
          { type: "userMessage", id: "user", content: [{ type: "text", text }] },
          { type: "agentMessage", id: "agent", text: "先核對 manifest。" },
        ],
      },
    },
  }))
  return botId
}

function historicalTurn(id: string, text: string): Turn {
  return {
    id,
    status: "completed",
    itemsView: "full",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [{ type: "userMessage", id: `${id}-user`, content: [{ type: "text", text }] }],
  } as unknown as Turn
}

test("a relevant turn submits ids and a digest, never the excerpt", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn()
  registry.update(botId, principal, { teamWorkspaceId: "workspace-1" })
  const drafts: unknown[] = []
  let classifiedText = ""
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify(_tenant, text) { classifiedText = text; return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) {
        drafts.push(draft)
        return { marker_id: "marker-1" }
      },
      async claim() {
        const draft = drafts[0] as { content_digest: string; turn_ids: string[]; thread_id: string }
        return { marker_id: "marker-1", content_digest: draft.content_digest, lease_token: "lease-1", turn_ids: draft.turn_ids, thread_id: draft.thread_id }
      },
      async complete(_token, _tenant, _marker, body) {
        expect(body.outcome).toBe("CANDIDATE_CREATED")
        expect(JSON.stringify(body).includes(canary)).toBe(false)
      },
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick()
  expect(classifiedText).toContain(canary)
  expect(drafts).toHaveLength(1)
  expect(JSON.stringify(drafts[0]).includes(canary)).toBe(false)
  expect((drafts[0] as { bot_id: string; workspace_id: string }).bot_id).toBe(botId)
  expect((drafts[0] as { workspace_id: string }).workspace_id).toBe("workspace-1")
  await worker.tick()
  expect(drafts).toHaveLength(1)
})

test("a terminal turn classifier only receives the evidence visible to reviewers", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  registry.timeline.putTurn(bot.id, "thread", {
    id: "turn-1",
    status: "failed",
    itemsView: "full",
    error: { message: "internal-error-secret" },
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [
      { type: "userMessage", id: "user", content: [{ type: "text", text: "使用者可見請求" }] },
      { type: "agentMessage", id: "agent", text: "助手可見答案" },
    ],
  } as unknown as Turn)
  let classifierText = ""
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify(_tenant, text) { classifierText = text; return classified(false) } },
    platform: { async submit() { throw new Error("unrelated") }, async claim() { return null }, async complete() {} },
  })

  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick(1_000)

  expect(classifierText).toBe("使用者可見請求\n助手可見答案")
  expect(classifierText).not.toContain("internal-error-secret")
})

test("a queued turn stays in the workspace bound when it was noted", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn()
  registry.update(botId, principal, { teamWorkspaceId: "workspace-a" })
  const workspaces: Array<string | null> = []
  let submits = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) {
        submits += 1
        workspaces.push(draft.workspace_id)
        if (submits === 1) throw new Error("temporary")
        return { marker_id: "marker-1" }
      },
      async claim() { return null },
      async complete() {},
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  registry.update(botId, principal, { teamWorkspaceId: "workspace-b" })
  await worker.tick(1_000)
  await worker.tick(1_030)
  expect(submits).toBe(2)
  expect(workspaces).toEqual(["workspace-a", "workspace-a"])
})

test("an unrelated classification does not create a platform marker", async () => {
  registry = new BotRegistry(":memory:")
  completeTurn("早安")
  let submitted = false
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { return classified(false) } },
    platform: {
      async submit() { submitted = true; return { marker_id: "marker" } },
      async claim() { return null },
      async complete() {},
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick()
  expect(submitted).toBe(false)
})

test("a revised unrelated turn is enqueued once after history import", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn("早安")
  registry.update(botId, principal, { teamWorkspaceId: "workspace-a" })
  const drafts: unknown[] = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify(_tenant, text) { return classified(text.includes("客戶合約")) } },
    platform: {
      async submit(_token, _tenant, draft) { drafts.push(draft); return { marker_id: "marker-1" } },
      async claim() { return null },
      async complete() {},
    },
  })
  const stopHistoryImportObserving = registry.observeHistoryImport((event) => {
    worker.historyImported(event.botId, event.threadId, event.turnIds)
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick(1_000)
  expect(drafts).toEqual([])
  registry.update(botId, principal, { teamWorkspaceId: "workspace-b" })
  const restored = {
    id: "turn-1",
    status: "completed",
    itemsView: "full",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [{ type: "userMessage", id: "user", content: [{ type: "text", text: canary }] }],
  } as unknown as Turn
  registry.importRuntimeHistory(botId, "thread", [restored], registry.timeline.revision())
  await worker.tick(1_000)
  expect(drafts).toHaveLength(1)
  expect((drafts[0] as { workspace_id: string }).workspace_id).toBe("workspace-a")
  registry.importRuntimeHistory(botId, "thread", [restored], registry.timeline.revision())
  await worker.tick(1_000)
  expect(drafts).toHaveLength(1)
  stopHistoryImportObserving()
})

test("a revised candidate turn submits a new marker while retaining its original candidate", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn(canary)
  const original = registry.timeline.storedTurn(botId, "thread", "turn-1")!
  let submissions = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit() { submissions += 1; return { marker_id: `marker-${submissions + 1}` } },
      async claim() { return null },
      async complete() {},
    },
  })
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error)
    values (?, ?, ?, ?, ?, ?, ?, 'CANDIDATE', 0, ?, 'marker-1', null)`).run(
    botId,
    "thread",
    "turn-1",
    sourceRevision("turn-1", original.revision),
    principal.tenant_id,
    principal.subject_id,
    principal.acting_client_id,
    1_000,
  )
  const stopHistoryImportObserving = registry.observeHistoryImport((event) => {
    worker.historyImported(event.botId, event.threadId, event.turnIds)
  })
  const restored = {
    id: "turn-1",
    status: "completed",
    itemsView: "full",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [{ type: "userMessage", id: "user", content: [{ type: "text", text: "新版客戶合約部署步驟" }] }],
  } as unknown as Turn
  registry.importRuntimeHistory(botId, "thread", [restored], registry.timeline.revision())
  await worker.tick(1_000)
  expect(submissions).toBe(1)
  expect(registry.db.query("select state, marker_id from bot_distillation_inbox order by rowid").all()).toEqual([
    { state: "CANDIDATE", marker_id: "marker-1" },
    { state: "SUBMITTED", marker_id: "marker-2" },
  ])
  registry.importRuntimeHistory(botId, "thread", [restored], registry.timeline.revision())
  await worker.tick(1_000)
  expect(submissions).toBe(1)
  stopHistoryImportObserving()
})

test("a missing-history failure requeues after a later full history import", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  registry.recordRuntimeEvent(principal, JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn-1", status: "completed", itemsView: "summary", items: [] } },
  }))
  let scans = 0
  let submissions = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      async backfill() {
        scans += 1
        return { status: "EXHAUSTED" as const, exhaustedScans: scans }
      },
    },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit() { submissions += 1; return { marker_id: "marker-1" } },
      async claim() { return null },
      async complete() {},
    },
  })
  const stopHistoryImportObserving = registry.observeHistoryImport((event) => {
    worker.historyImported(event.botId, event.threadId, event.turnIds)
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick(1_000)
  await worker.tick(1_030)
  await worker.tick(1_060)
  expect(registry.db.query("select state, last_error from bot_distillation_inbox").all()).toEqual([
    { state: "FAILED", last_error: "DISTILLATION_HISTORY_NOT_FOUND" },
  ])
  registry.importRuntimeHistory(bot.id, "thread", [{
    id: "turn-1",
    status: "completed",
    itemsView: "full",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [{ type: "userMessage", id: "user", content: [{ type: "text", text: "補回的客戶合約步驟" }] }],
  } as unknown as Turn], registry.timeline.revision())
  await worker.tick(1_090)
  expect(scans).toBe(3)
  expect(submissions).toBe(1)
  expect(registry.db.query("select state from bot_distillation_inbox order by rowid").all()).toEqual([
    { state: "FAILED" },
    { state: "SUBMITTED" },
  ])
  stopHistoryImportObserving()
})

test("a validation failure remains terminal after a later history import", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn(canary)
  const original = registry.timeline.storedTurn(botId, "thread", "turn-1")!
  let submissions = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit() { submissions += 1; return { marker_id: "unexpected" } },
      async claim() { return null },
      async complete() {},
    },
  })
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error)
    values (?, ?, ?, ?, ?, ?, ?, 'FAILED', 5, ?, null, 'DISTILLATION_PLATFORM_422')`).run(
    botId,
    "thread",
    "turn-1",
    sourceRevision("turn-1", original.revision),
    principal.tenant_id,
    principal.subject_id,
    principal.acting_client_id,
    1_000,
  )
  const stopHistoryImportObserving = registry.observeHistoryImport((event) => {
    worker.historyImported(event.botId, event.threadId, event.turnIds)
  })
  registry.importRuntimeHistory(botId, "thread", [{
    id: "turn-1",
    status: "completed",
    itemsView: "full",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [{ type: "userMessage", id: "user", content: [{ type: "text", text: "更新後的客戶合約步驟" }] }],
  } as unknown as Turn], registry.timeline.revision())
  await worker.tick(1_000)
  expect(submissions).toBe(0)
  expect(registry.db.query("select state, last_error from bot_distillation_inbox").all()).toEqual([
    { state: "FAILED", last_error: "DISTILLATION_PLATFORM_422" },
  ])
  stopHistoryImportObserving()
})

test("attached distillation observes revised unrelated history", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn("早安")
  let submissions = 0
  const worker = attachDistillation({
    registry,
    sessions: { tokenFor: () => "owner-token" },
    env: {
      GENIO_ONE_PLATFORM_ORIGIN: "http://platform.test",
      GENIO_ONE_DISTILLATION_TRIAGE_URL: "http://triage.test/v1/distillation",
      GENIO_ONE_DISTILLATION_TRIAGE_TOKEN: "triage-token",
      GENIO_ONE_DISTILLATION_ADAPTER_ID: "adapter",
    },
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const bodyText = String(init?.body)
      const body = JSON.parse(bodyText) as Record<string, unknown>
      if (typeof body.adapter_id === "string") {
        const text = String(body.text ?? "")
        return Response.json({ classifier_version: "jev-distillation-1", triage: classified(text.includes("客戶合約")) })
      }
      if (typeof body.lease_owner === "string") return Response.json(null)
      if (typeof body.bot_id === "string") {
        submissions += 1
        return Response.json({ marker_id: "marker-1" })
      }
      throw new Error("unexpected distillation request")
    }) as typeof fetch,
  })
  try {
    const at = Math.floor(Date.now() / 1_000) + 1
    worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
    await worker.tick(at)
    expect(submissions).toBe(0)
    expect(registry.db.query("select state, classifier_attempts, last_error from bot_distillation_inbox").all()).toEqual([
      { state: "UNRELATED", classifier_attempts: 0, last_error: null },
    ])
    registry.importRuntimeHistory(botId, "thread", [{
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      items: [{ type: "userMessage", id: "user", content: [{ type: "text", text: canary }] }],
    } as unknown as Turn], registry.timeline.revision())
    expect(registry.db.query("select state from bot_distillation_inbox order by rowid").all()).toEqual([
      { state: "UNRELATED" },
      { state: "PENDING" },
    ])
    await worker.tick(at)
    expect(submissions).toBe(1)
  } finally {
    worker.stop()
  }
})

test("an active owner catches up bound ready history after reattach", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "bound-thread")
  const readyTurn = {
    id: "ready-turn",
    status: "completed",
    itemsView: "full",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [{ type: "userMessage", id: "ready-user", content: [{ type: "text", text: "已匯入的客戶合約步驟" }] }],
  } as unknown as Turn
  const summaryTurn = {
    id: "summary-turn",
    status: "completed",
    itemsView: "summary",
    error: null,
    startedAt: 2,
    completedAt: 3,
    durationMs: 1,
    items: [],
  } as unknown as Turn
  const unboundTurn = {
    id: "unbound-turn",
    status: "completed",
    itemsView: "full",
    error: null,
    startedAt: 3,
    completedAt: 4,
    durationMs: 1,
    items: [{ type: "userMessage", id: "unbound-user", content: [{ type: "text", text: "不可處理" }] }],
  } as unknown as Turn
  registry.importRuntimeHistory(bot.id, "bound-thread", [readyTurn, summaryTurn], registry.timeline.revision())
  registry.importRuntimeHistory(bot.id, "unbound-thread", [unboundTurn], registry.timeline.revision())
  let online = false
  const drafts: Array<{ turn_ids: string[] }> = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => online ? "owner-token" : null,
      claimTargets: () => online ? [{ principal, botId: bot.id }] : [],
    },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) { drafts.push(draft); return { marker_id: `marker-${drafts.length}` } },
      async claim() { return null },
      async complete() {},
    },
  })
  await worker.tick(1_000)
  expect(drafts).toEqual([])
  online = true
  await worker.tick(1_000)
  expect(drafts.map((draft) => draft.turn_ids)).toEqual([["ready-turn"]])
  registry.importRuntimeHistory(bot.id, "bound-thread", [{
    ...summaryTurn,
    itemsView: "full",
    items: [{ type: "userMessage", id: "summary-user", clientId: null, content: [{ type: "text", text: "補齊的部署步驟", text_elements: [] }] }],
  }], registry.timeline.revision())
  await worker.tick(1_000)
  expect(drafts.map((draft) => draft.turn_ids)).toEqual([["ready-turn"], ["summary-turn"]])
  await worker.tick(1_000)
  expect(drafts).toHaveLength(2)
})

test("an active owner catches up a bound failed full turn", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  registry.importRuntimeHistory(bot.id, "thread", [{
    id: "failed-turn",
    status: "failed",
    itemsView: "full",
    error: { message: "runtime failed" },
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [{ type: "userMessage", id: "user", content: [{ type: "text", text: "失敗前的部署步驟" }] }],
  } as unknown as Turn], registry.timeline.revision())
  const drafts: Array<{ turn_ids: string[] }> = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      claimTargets: () => [{ principal, botId: bot.id }],
    },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) { drafts.push(draft); return { marker_id: "marker-1" } },
      async claim() { return null },
      async complete() {},
    },
  })
  await worker.tick(1_000)
  expect(drafts.map((draft) => draft.turn_ids)).toEqual([["failed-turn"]])
})

test("active recovery keeps history imported before a workspace binding unbound", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  registry.importRuntimeHistory(bot.id, "thread", [historicalTurn("history-turn", "歷史部署步驟")], registry.timeline.revision())
  registry.update(bot.id, principal, { teamWorkspaceId: "workspace-new" })
  const drafts: Array<{ workspace_id: string | null }> = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token", claimTargets: () => [{ principal, botId: bot.id }] },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) {
        drafts.push({ workspace_id: draft.workspace_id })
        return { marker_id: "history-marker", processing_state: "CANDIDATE_CREATED" }
      },
      async claim() { return null },
      async complete() {},
    },
  })

  await worker.tick(1_000)

  expect(drafts).toEqual([{ workspace_id: null }])
  expect(registry.db.query("select state, marker_id, workspace_id from bot_distillation_inbox").all()).toEqual([
    { state: "CANDIDATE", marker_id: "history-marker", workspace_id: null },
  ])
})

test("active recovery does not bind imported history to a later workspace rebind", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.update(bot.id, principal, { teamWorkspaceId: "workspace-before" })
  registry.rememberThread(bot.id, "thread")
  registry.importRuntimeHistory(bot.id, "thread", [historicalTurn("history-turn", "重新綁定前的歷史步驟")], registry.timeline.revision())
  registry.update(bot.id, principal, { teamWorkspaceId: "workspace-after" })
  const drafts: Array<{ workspace_id: string | null }> = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token", claimTargets: () => [{ principal, botId: bot.id }] },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) {
        drafts.push({ workspace_id: draft.workspace_id })
        return { marker_id: "rebound-marker", processing_state: "CANDIDATE_CREATED" }
      },
      async claim() { return null },
      async complete() {},
    },
  })

  await worker.tick(1_000)

  expect(drafts).toEqual([{ workspace_id: null }])
  expect(registry.db.query("select state, marker_id, workspace_id from bot_distillation_inbox").all()).toEqual([
    { state: "CANDIDATE", marker_id: "rebound-marker", workspace_id: null },
  ])
})

test("a noted turn preserves its workspace through a rebind and imported revision", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.update(bot.id, principal, { teamWorkspaceId: "workspace-original" })
  registry.rememberThread(bot.id, "thread")
  registry.recordRuntimeEvent(principal, JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread", turn: historicalTurn("turn-1", "原始部署步驟") },
  }))
  const drafts: Array<{ workspace_id: string | null }> = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) {
        drafts.push({ workspace_id: draft.workspace_id })
        return { marker_id: `marker-${drafts.length}`, processing_state: "CANDIDATE_CREATED" }
      },
      async claim() { return null },
      async complete() {},
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick(1_000)

  registry.update(bot.id, principal, { teamWorkspaceId: "workspace-rebound" })
  registry.importRuntimeHistory(bot.id, "thread", [historicalTurn("turn-1", "修訂後的部署步驟")], registry.timeline.revision())
  worker.historyImported(bot.id, "thread", ["turn-1"])
  await worker.tick(1_000)

  expect(drafts).toEqual([{ workspace_id: "workspace-original" }, { workspace_id: "workspace-original" }])
  expect(registry.db.query("select state, marker_id, workspace_id from bot_distillation_inbox order by rowid").all()).toEqual([
    { state: "CANDIDATE", marker_id: "marker-1", workspace_id: "workspace-original" },
    { state: "CANDIDATE", marker_id: "marker-2", workspace_id: "workspace-original" },
  ])
})

test("classifier failure stays retryable and is not stored as unrelated", async () => {
  registry = new BotRegistry(":memory:")
  completeTurn()
  let calls = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { calls += 1; return { status: "UNAVAILABLE", classifier_version: "jev-distillation-1" } } },
    platform: {
      async submit() { throw new Error("should not submit") },
      async claim() { return null },
      async complete() {},
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick(1_000)
  await worker.tick(1_000)
  expect(calls).toBe(1)
  await worker.tick(1_030)
  expect(calls).toBe(2)
})

test("classifier unavailability stays queued after the attempt cap", async () => {
  registry = new BotRegistry(":memory:")
  completeTurn()
  let calls = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { calls += 1; return { status: "UNAVAILABLE", classifier_version: "jev-distillation-1" } } },
    platform: {
      async submit() { throw new Error("should not submit") },
      async claim() { return null },
      async complete() {},
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  let at = 1_000
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await worker.tick(at)
    at += 300
  }
  expect(calls).toBe(6)
})

test("an offline owner is not classified until the session can submit", async () => {
  registry = new BotRegistry(":memory:")
  completeTurn()
  let calls = 0
  let online = false
  const drafts: unknown[] = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => online ? "owner-token" : null },
    classifier: { async classify() { calls += 1; return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) { drafts.push(draft); return { marker_id: "marker-1" } },
      async claim() { return null },
      async complete() {},
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick(1_000)
  expect(calls).toBe(0)
  expect(drafts).toHaveLength(0)
  online = true
  await worker.tick(1_030)
  expect(calls).toBe(1)
  expect(drafts).toHaveLength(1)
})

test("classifier outages do not spend the submission retry budget", async () => {
  registry = new BotRegistry(":memory:")
  completeTurn()
  let calls = 0
  let submits = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: {
      async classify() {
        calls += 1
        if (calls <= 4) return { status: "UNAVAILABLE", classifier_version: "jev-distillation-1" }
        return classified(true)
      },
    },
    platform: {
      async submit() {
        submits += 1
        if (submits === 1) throw new Error("temporary")
        return { marker_id: "marker-1" }
      },
      async claim() { return null },
      async complete() {},
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  let at = 1_000
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await worker.tick(at)
    at += 300
  }
  await worker.tick(at)
  await worker.tick(at + 30)
  expect(calls).toBe(5)
  expect(submits).toBe(2)
})

test("a transient marker submit reuses persisted triage after a worker restart", async () => {
  registry = new BotRegistry(":memory:")
  completeTurn()
  let classifierCalls = 0
  let submits = 0
  const platform = {
    async submit() {
      submits += 1
      if (submits === 1) throw new Error("temporary")
      return { marker_id: "marker-1" }
    },
    async claim() { return null },
    async complete() {},
  }
  const createWorker = () => createDistillationWorker({
    registry: registry!,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { classifierCalls += 1; return classified(true) } },
    platform,
  })
  const first = createWorker()
  first.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await first.tick(1_000)
  const restarted = createWorker()
  await restarted.tick(1_030)
  expect(classifierCalls).toBe(1)
  expect(submits).toBe(2)
})

test("a legacy cached decision is retriaged after the visible excerpt changes", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn("可見的使用者文字")
  const stored = registry.timeline.storedTurn(botId, "thread", "turn-1")!
  registry.timeline.putTurn(botId, "thread", {
    ...stored.turn,
    status: "failed",
    error: { message: "internal-error-secret" },
  } as Turn)
  const seen: string[] = []
  let submissions = 0
  let relevant = true
  const createWorker = () => createDistillationWorker({
    registry: registry!,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: {
      async classify(_tenant, text) {
        seen.push(text)
        return classified(relevant)
      },
    },
    platform: {
      async submit() {
        submissions += 1
        throw new Error("DISTILLATION_PLATFORM_503")
      },
      async claim() { return null },
      async complete() {},
    },
  })
  const first = createWorker()
  first.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await first.tick(1_000)
  expect(submissions).toBe(1)
  registry.db.query("update bot_distillation_inbox set classifier_version = 'jev-distillation-1'").run()
  relevant = false
  await createWorker().tick(1_030)
  expect(seen).toHaveLength(2)
  expect(seen.every((text) => !text.includes("internal-error-secret"))).toBe(true)
  expect(submissions).toBe(1)
  expect(registry.db.query("select state from bot_distillation_inbox").all()).toEqual([{ state: "UNRELATED" }])
})

test("a body change invalidates cached triage before a marker retry", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn()
  let classifierCalls = 0
  let submits = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: {
      async classify(_tenant, text) {
        classifierCalls += 1
        return classified(text.includes(canary))
      },
    },
    platform: {
      async submit() {
        submits += 1
        throw new Error("temporary")
      },
      async claim() { return null },
      async complete() {},
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick(1_000)
  const stored = registry.timeline.storedTurn(botId, "thread", "turn-1")!
  const changed = JSON.parse(stored.bodyJson) as Turn
  changed.items = changed.items.map((item) => item.type === "userMessage"
    ? { ...item, content: [{ type: "text", text: "早安", text_elements: [] }] }
    : item)
  registry.db.query("update bot_timeline_turns set body_json = ? where bot_id = ? and thread_id = ? and turn_id = ?")
    .run(JSON.stringify(changed), botId, "thread", "turn-1")
  await worker.tick(1_030)
  expect(classifierCalls).toBe(2)
  expect(submits).toBe(1)
})

test("a long first message is classified from a bounded prefix", async () => {
  registry = new BotRegistry(":memory:")
  const text = "部署步驟".repeat(20_000)
  completeTurn(text)
  let seen = ""
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify(_tenant, excerpt) { seen = excerpt; return classified(false) } },
    platform: { async submit() { throw new Error("unrelated") }, async claim() { return null }, async complete() {} },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick()
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.length).toBeLessThan(text.length)
})

test("history backfill updates the source revision before a submit is retried", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  registry.recordRuntimeEvent(principal, JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn-1", status: "completed", items: [] } },
  }))
  const revisions: string[] = []
  let submits = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      async backfill({ botId, threadId, turnId }) {
        registry!.importRuntimeHistory(botId, threadId, [{
          id: turnId,
          status: "completed",
          itemsView: "full",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          items: [
            { type: "userMessage", id: "user", content: [{ type: "text", text: "補齊後的步驟" }] },
            { type: "agentMessage", id: "agent", text: "完成" },
          ],
        } as unknown as Turn], registry!.timeline.revision())
        return { status: "READY" as const, exhaustedScans: 0 }
      },
    },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) {
        submits += 1
        revisions.push(draft.source_revision)
        if (submits === 1) throw new Error("temporary")
        return { marker_id: "marker-1" }
      },
      async claim() { return null },
      async complete() {},
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick(1_000)
  await worker.tick(1_030)
  expect(submits).toBe(2)
  expect(revisions[0]).toBe(revisions[1])
})

test("a history update during classification is retriaged before marker submission", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn()
  let releaseClassifier = () => {}
  const classifierGate = new Promise<void>((resolve) => { releaseClassifier = resolve })
  let classifierStarted = false
  const classifierInputs: string[] = []
  const drafts: Array<{ source_revision: string; content_digest: string }> = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: {
      async classify(_tenant, text) {
        classifierInputs.push(text)
        if (classifierInputs.length === 1) {
          classifierStarted = true
          await classifierGate
        }
        return classified(text.includes("客戶合約"))
      },
    },
    platform: {
      async submit(_token, _tenant, draft) {
        drafts.push(draft)
        return { marker_id: "marker-1" }
      },
      async claim() { return null },
      async complete() {},
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  const tick = worker.tick(1_000)
  for (let attempt = 0; attempt < 20 && !classifierStarted; attempt += 1) await Promise.resolve()
  expect(classifierStarted).toBe(true)
  registry.importRuntimeHistory(botId, "thread", [{
    id: "turn-1",
    status: "completed",
    itemsView: "full",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [{ type: "userMessage", id: "user", content: [{ type: "text", text: "早安" }] }],
  } as unknown as Turn], registry.timeline.revision())
  const refreshed = registry.timeline.storedTurn(botId, "thread", "turn-1")!
  releaseClassifier()
  await tick
  expect(drafts).toEqual([])
  await worker.tick(1_000)
  expect(classifierInputs[0]).toContain(canary)
  expect(classifierInputs[1]).toContain("早安")
  expect(classifierInputs[1]).not.toContain(canary)
  expect(drafts).toEqual([])
  expect(refreshed.bodyJson).toContain("早安")
})

test("a history update during terminal marker submission preserves the candidate and queues the new revision", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn()
  let releaseSubmit = () => {}
  const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve })
  let submitStarted = false
  const drafts: Array<{ source_revision: string; content_digest: string }> = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) {
        drafts.push(draft)
        if (drafts.length === 1) {
          submitStarted = true
          await submitGate
          return { marker_id: "marker-1", processing_state: "CANDIDATE_CREATED" as const }
        }
        return { marker_id: "marker-2" }
      },
      async claim() { return null },
      async complete() {},
    },
  })
  const stopHistoryImportObserving = registry.observeHistoryImport((event) => {
    worker.historyImported(event.botId, event.threadId, event.turnIds)
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  const tick = worker.tick(1_000)
  for (let attempt = 0; attempt < 20 && !submitStarted; attempt += 1) await Promise.resolve()
  expect(submitStarted).toBe(true)
  registry.importRuntimeHistory(botId, "thread", [{
    id: "turn-1",
    status: "completed",
    itemsView: "full",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [{ type: "userMessage", id: "user", content: [{ type: "text", text: "更新後的客戶合約部署步驟" }] }],
  } as unknown as Turn], registry.timeline.revision())
  releaseSubmit()
  await tick
  expect(registry.db.query("select state, marker_id from bot_distillation_inbox order by rowid").all()).toEqual([
    { state: "CANDIDATE", marker_id: "marker-1" },
    { state: "PENDING", marker_id: null },
  ])
  await worker.tick(1_000)
  expect(drafts).toHaveLength(2)
  expect(drafts[1]!.source_revision).not.toBe(drafts[0]!.source_revision)
  expect(drafts[1]!.content_digest).not.toBe(drafts[0]!.content_digest)
  stopHistoryImportObserving()
})

test("a history update during a failed marker submission queues the new revision", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn()
  let releaseSubmit = () => {}
  const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve })
  let submitStarted = false
  const drafts: Array<{ source_revision: string; content_digest: string }> = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) {
        drafts.push(draft)
        if (drafts.length === 1) {
          submitStarted = true
          await submitGate
          return { marker_id: "marker-1", processing_state: "FAILED" as const, last_error: "DISTILLATION_PLATFORM_FAILED" }
        }
        return { marker_id: "marker-2" }
      },
      async claim() { return null },
      async complete() {},
    },
  })
  const stopHistoryImportObserving = registry.observeHistoryImport((event) => {
    worker.historyImported(event.botId, event.threadId, event.turnIds)
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  const tick = worker.tick(1_000)
  for (let attempt = 0; attempt < 20 && !submitStarted; attempt += 1) await Promise.resolve()
  expect(submitStarted).toBe(true)
  registry.importRuntimeHistory(botId, "thread", [{
    id: "turn-1",
    status: "completed",
    itemsView: "full",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [{ type: "userMessage", id: "user", content: [{ type: "text", text: "修訂後的客戶合約部署步驟" }] }],
  } as unknown as Turn], registry.timeline.revision())
  releaseSubmit()
  await tick
  expect(registry.db.query("select state, marker_id from bot_distillation_inbox order by rowid").all()).toEqual([
    { state: "FAILED", marker_id: "marker-1" },
    { state: "PENDING", marker_id: null },
  ])
  await worker.tick(1_000)
  expect(drafts).toHaveLength(2)
  expect(drafts[1]!.source_revision).not.toBe(drafts[0]!.source_revision)
  expect(drafts[1]!.content_digest).not.toBe(drafts[0]!.content_digest)
  stopHistoryImportObserving()
})

test("a history update during a terminal rejected marker submission queues the new revision", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn()
  let releaseSubmit = () => {}
  const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve })
  let submitStarted = false
  const drafts: Array<{ source_revision: string; content_digest: string }> = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) {
        drafts.push(draft)
        if (drafts.length === 1) {
          submitStarted = true
          await submitGate
          throw new Error("DISTILLATION_PLATFORM_422")
        }
        return { marker_id: "marker-2" }
      },
      async claim() { return null },
      async complete() {},
    },
  })
  const stopHistoryImportObserving = registry.observeHistoryImport((event) => {
    worker.historyImported(event.botId, event.threadId, event.turnIds)
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  registry.db.query("update bot_distillation_inbox set attempts = 4 where bot_id = ? and thread_id = ? and turn_id = ?")
    .run(botId, "thread", "turn-1")
  const tick = worker.tick(1_000)
  for (let attempt = 0; attempt < 20 && !submitStarted; attempt += 1) await Promise.resolve()
  expect(submitStarted).toBe(true)
  registry.importRuntimeHistory(botId, "thread", [{
    id: "turn-1",
    status: "completed",
    itemsView: "full",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [{ type: "userMessage", id: "user", content: [{ type: "text", text: "拒絕後更新的客戶合約部署步驟" }] }],
  } as unknown as Turn], registry.timeline.revision())
  releaseSubmit()
  await tick
  expect(registry.db.query("select state, attempts, marker_id, last_error from bot_distillation_inbox order by rowid").all()).toEqual([
    { state: "FAILED", attempts: 5, marker_id: null, last_error: "DISTILLATION_PLATFORM_422" },
    { state: "PENDING", attempts: 0, marker_id: null, last_error: null },
  ])
  await worker.tick(1_000)
  expect(drafts).toHaveLength(2)
  expect(drafts[1]!.source_revision).not.toBe(drafts[0]!.source_revision)
  expect(drafts[1]!.content_digest).not.toBe(drafts[0]!.content_digest)
  stopHistoryImportObserving()
})

test("a history import during a history-not-found completion queues the new revision", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  registry.recordRuntimeEvent(principal, JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn-1", status: "completed", itemsView: "summary", items: [] } },
  }))
  const initial = registry.timeline.storedTurn(bot.id, "thread", "turn-1")!
  let releaseComplete = () => {}
  const completeGate = new Promise<void>((resolve) => { releaseComplete = resolve })
  let completeStarted = false
  let claims = 0
  const submissions: unknown[] = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) {
        submissions.push(draft)
        return { marker_id: "marker-2" }
      },
      async claim() {
        claims += 1
        if (claims > 1) return null
        return {
          marker_id: "marker-1",
          content_digest: contentDigest(initial.bodyJson),
          lease_token: "lease-1",
          turn_ids: ["turn-1"],
          thread_id: "thread",
        }
      },
      async complete(_token, _tenant, markerId, body) {
        expect(markerId).toBe("marker-1")
        expect(body).toEqual({
          lease_token: "lease-1",
          outcome: "FAILED",
          error: "DISTILLATION_HISTORY_NOT_FOUND",
        })
        completeStarted = true
        await completeGate
      },
    },
  })
  const stopHistoryImportObserving = registry.observeHistoryImport((event) => {
    worker.historyImported(event.botId, event.threadId, event.turnIds)
  })
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error, history_exhausted_scans)
    values (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, ?, 'marker-1', null, 3)`).run(
    bot.id,
    "thread",
    "turn-1",
    sourceRevision("turn-1", initial.revision),
    principal.tenant_id,
    principal.subject_id,
    principal.acting_client_id,
    1_000,
  )
  const tick = worker.tick(1_000)
  for (let attempt = 0; attempt < 20 && !completeStarted; attempt += 1) await Promise.resolve()
  expect(completeStarted).toBe(true)
  registry.importRuntimeHistory(bot.id, "thread", [{
    id: "turn-1",
    status: "completed",
    itemsView: "full",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [{ type: "userMessage", id: "user", content: [{ type: "text", text: "恢復後的客戶合約部署步驟" }] }],
  } as unknown as Turn], registry.timeline.revision())
  releaseComplete()
  await tick
  expect(registry.db.query("select state, marker_id from bot_distillation_inbox order by rowid").all()).toEqual([
    { state: "FAILED", marker_id: "marker-1" },
    { state: "PENDING", marker_id: null },
  ])
  await worker.tick(1_000)
  expect(submissions).toHaveLength(1)
  stopHistoryImportObserving()
})

test("a lost candidate completion response is retried before another claim", async () => {
  registry = new BotRegistry(":memory:")
  completeTurn()
  let markerDigest = ""
  let claims = 0
  let completionAttempts = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) {
        markerDigest = draft.content_digest
        return { marker_id: "marker-1" }
      },
      async claim() {
        claims += 1
        return { marker_id: "marker-1", content_digest: markerDigest, lease_token: "lease-1", turn_ids: ["turn-1"], thread_id: "thread" }
      },
      async complete(_token, _tenant, markerId, body) {
        expect(markerId).toBe("marker-1")
        expect(body).toEqual({ lease_token: "lease-1", outcome: "CANDIDATE_CREATED", content_digest: markerDigest })
        completionAttempts += 1
        if (completionAttempts === 1) throw new Error("response lost after remote acceptance")
      },
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick(1_000)
  await worker.tick(1_000)
  expect(completionAttempts).toBe(2)
  expect(claims).toBe(1)
  expect(registry.db.query("select state from bot_distillation_inbox").all()).toEqual([{ state: "CANDIDATE" }])
})

test("an empty claim reconciles a marker the Platform exhausted so the Bot stops polling it", async () => {
  // Five abandoned leases make the Platform mark the marker FAILED and return
  // null from claim. Without a status lookup the local SUBMITTED row stays a
  // claim target and the Bot polls this marker forever.
  registry = new BotRegistry(":memory:")
  completeTurn()
  let claims = 0
  const lookups: string[] = []
  let remoteState: "PENDING" | "FAILED" = "PENDING"
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit() { return { marker_id: "marker-1", processing_state: "PENDING" } },
      async claim() { claims += 1; return null },
      async complete() { throw new Error("nothing was claimed") },
      async marker(_token, _tenant, markerId) {
        lookups.push(markerId)
        return remoteState === "FAILED"
          ? { marker_id: markerId, processing_state: "FAILED", last_error: "DISTILLATION_ATTEMPTS_EXHAUSTED" }
          : { marker_id: markerId, processing_state: "PENDING", last_error: null }
      },
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick(1_000)
  expect(registry.db.query("select state, marker_id from bot_distillation_inbox").all()).toEqual([
    { state: "SUBMITTED", marker_id: "marker-1" },
  ])
  expect(lookups).toEqual(["marker-1"])
  remoteState = "FAILED"
  await worker.tick(1_000)
  expect(registry.db.query("select state, marker_id, last_error from bot_distillation_inbox").all()).toEqual([
    { state: "FAILED", marker_id: "marker-1", last_error: "DISTILLATION_ATTEMPTS_EXHAUSTED" },
  ])
  const claimsAfterReconcile = claims
  await worker.tick(1_000)
  expect(claims).toBe(claimsAfterReconcile)
  expect(lookups).toEqual(["marker-1", "marker-1"])
})

test("the HTTP platform client reads a marker's terminal status", async () => {
  const requests: Array<{ url: string; method: string }> = []
  const platform = createHttpDistillationPlatform("http://platform.test/", (async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method ?? "GET" })
    return Response.json({ marker_id: "marker/1", processing_state: "FAILED", last_error: "DISTILLATION_ATTEMPTS_EXHAUSTED" })
  }) as unknown as typeof fetch)
  expect(await platform.marker!("token", "tenant", "marker/1")).toEqual({
    marker_id: "marker/1",
    processing_state: "FAILED",
    last_error: "DISTILLATION_ATTEMPTS_EXHAUSTED",
  })
  expect(requests).toEqual([{ url: "http://platform.test/v1/tenants/tenant/distillation-markers/marker%2F1", method: "GET" }])
})

test("a replayed linked multi-turn candidate completion records every claimed turn", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  for (const turnId of ["turn-1", "turn-2"]) {
    registry.recordRuntimeEvent(principal, JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          id: turnId,
          status: "completed",
          items: [{ type: "userMessage", id: `${turnId}-user`, content: [{ type: "text", text: `客戶合約 ${turnId}` }] }],
        },
      },
    }))
  }
  const bodies = ["turn-1", "turn-2"].map((turnId) => registry!.timeline.storedTurn(bot.id, "thread", turnId)!.bodyJson)
  const first = registry.timeline.storedTurn(bot.id, "thread", "turn-1")!
  let scanEnabled = false
  let claims = 0
  let completions = 0
  let submissions = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      claimTargets: () => scanEnabled ? [{ principal, botId: bot.id }] : [],
    },
    classifier: { async classify() { throw new Error("replayed marker must suppress first-seen submission") } },
    platform: {
      async submit() { submissions += 1; return { marker_id: "unexpected" } },
      async claim() {
        claims += 1
        if (claims > 1) return null
        return {
          marker_id: "marker-1",
          content_digest: markerContentDigest(bodies),
          lease_token: "lease-1",
          turn_ids: ["turn-1", "turn-2"],
          thread_id: "thread",
        }
      },
      async complete(_token, _tenant, markerId, body) {
        expect(markerId).toBe("marker-1")
        expect(body).toEqual({
          lease_token: "lease-1",
          outcome: "CANDIDATE_CREATED",
          content_digest: markerContentDigest(bodies),
        })
        completions += 1
        if (completions === 1) throw new Error("response lost after remote acceptance")
      },
    },
  })
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error)
    values (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, ?, 'marker-1', null)`).run(
    bot.id,
    "thread",
    "turn-1",
    sourceRevision("turn-1", first.revision),
    principal.tenant_id,
    principal.subject_id,
    principal.acting_client_id,
    1_000,
  )
  await worker.tick(1_000)
  expect(completions).toBe(1)
  expect(registry.db.query("select state from bot_distillation_inbox").all()).toEqual([{ state: "SUBMITTED" }])
  await worker.tick(1_000)
  expect(claims).toBe(1)
  expect(completions).toBe(2)
  expect(registry.db.query("select turn_id, state, marker_id from bot_distillation_inbox order by turn_id").all()).toEqual([
    { turn_id: "turn-1", state: "CANDIDATE", marker_id: "marker-1" },
    { turn_id: "turn-2", state: "CANDIDATE", marker_id: "marker-1" },
  ])
  scanEnabled = true
  await worker.tick(1_000)
  expect(submissions).toBe(0)
})

test("a definitive completion conflict clears stale payload before a fresh claim", async () => {
  registry = new BotRegistry(":memory:")
  completeTurn()
  let markerDigest = ""
  let claims = 0
  let completionAttempts = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) {
        markerDigest = draft.content_digest
        return { marker_id: "marker-1" }
      },
      async claim() {
        claims += 1
        return {
          marker_id: "marker-1",
          content_digest: markerDigest,
          lease_token: claims === 1 ? "stale-lease" : "fresh-lease",
          turn_ids: ["turn-1"],
          thread_id: "thread",
        }
      },
      async complete(_token, _tenant, _markerId, body) {
        completionAttempts += 1
        if (completionAttempts === 1) {
          expect(body.lease_token).toBe("stale-lease")
          throw new Error("DISTILLATION_PLATFORM_RESPONSE_INVALID")
        }
        if (completionAttempts === 2) {
          expect(body.lease_token).toBe("stale-lease")
          throw new Error("DISTILLATION_PLATFORM_409")
        }
        expect(body.lease_token).toBe("fresh-lease")
      },
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick(1_000)
  await worker.tick(1_000)
  expect(registry.db.query("select state, completion_lease_token from bot_distillation_inbox").all()).toEqual([
    { state: "SUBMITTED", completion_lease_token: null },
  ])
  await worker.tick(1_000)
  expect(completionAttempts).toBe(3)
  expect(claims).toBe(2)
  expect(registry.db.query("select state from bot_distillation_inbox").all()).toEqual([{ state: "CANDIDATE" }])
})

test("a replayed candidate completion enqueues a newer timeline revision", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn()
  let markerDigest = ""
  let claims = 0
  let classifierCalls = 0
  let submits = 0
  let completionAttempts = 0
  let releaseCompletion = () => {}
  const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve })
  let completionStarted = false
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { classifierCalls += 1; return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) {
        submits += 1
        markerDigest = draft.content_digest
        return { marker_id: `marker-${submits}` }
      },
      async claim() {
        claims += 1
        return claims === 1
          ? { marker_id: "marker-1", content_digest: markerDigest, lease_token: "lease-1", turn_ids: ["turn-1"], thread_id: "thread" }
          : null
      },
      async complete(_token, _tenant, _markerId, body) {
        expect(body.outcome).toBe("CANDIDATE_CREATED")
        completionAttempts += 1
        if (completionAttempts === 1) throw new Error("response lost after remote acceptance")
        completionStarted = true
        await completionGate
      },
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick(1_000)
  const replay = worker.tick(1_000)
  for (let attempt = 0; attempt < 20 && !completionStarted; attempt += 1) await Promise.resolve()
  expect(completionStarted).toBe(true)
  registry.importRuntimeHistory(botId, "thread", [{
    id: "turn-1",
    status: "completed",
    itemsView: "full",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [{ type: "userMessage", id: "user", content: [{ type: "text", text: "更新後的部署步驟" }] }],
  } as unknown as Turn], registry.timeline.revision())
  releaseCompletion()
  await replay
  expect(registry.db.query("select state from bot_distillation_inbox order by rowid").all()).toEqual([
    { state: "CANDIDATE" },
    { state: "PENDING" },
  ])
  await worker.tick(1_000)
  expect(classifierCalls).toBe(2)
  expect(submits).toBe(2)
})

test("a linked waiting marker completes before a changed turn is submitted again", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn()
  const initial = registry.timeline.storedTurn(botId, "thread", "turn-1")!
  let classifierCalls = 0
  let submits = 0
  let completeAttempts = 0
  let claims = 0
  let remotelyFailed = false
  let claimOldMarker = true
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { classifierCalls += 1; return classified(true) } },
    platform: {
      async submit() {
        submits += 1
        return { marker_id: `marker-${submits}` }
      },
      async claim() {
        claims += 1
        return claimOldMarker
          ? {
              marker_id: "marker-1",
              content_digest: contentDigest(initial.bodyJson),
              lease_token: "lease-1",
              turn_ids: ["turn-1"],
              thread_id: "thread",
            }
          : null
      },
      async complete(_token, _tenant, markerId, body) {
        expect(markerId).toBe("marker-1")
        expect(body.outcome).toBe("FAILED")
        completeAttempts += 1
        if (completeAttempts === 1) {
          remotelyFailed = true
          throw new Error("response lost after remote acceptance")
        }
        expect(remotelyFailed).toBe(true)
        claimOldMarker = false
      },
    },
  })
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error)
    values (?, ?, ?, ?, ?, ?, ?, 'WAITING_HISTORY', 0, ?, 'marker-1', null)`).run(
    botId,
    "thread",
    "turn-1",
    sourceRevision("turn-1", initial.revision),
    principal.tenant_id,
    principal.subject_id,
    principal.acting_client_id,
    1_000,
  )
  const changed = JSON.parse(initial.bodyJson) as Turn
  changed.items = changed.items.map((item) => item.type === "userMessage"
    ? { ...item, content: [{ type: "text", text: "新版客戶合約部署步驟", text_elements: [] }] }
    : item)
  registry.db.query("update bot_timeline_turns set body_json = ?, revision = revision + 1 where bot_id = ? and thread_id = ? and turn_id = ?")
    .run(JSON.stringify(changed), botId, "thread", "turn-1")
  await worker.tick(1_000)
  expect(completeAttempts).toBe(1)
  expect(classifierCalls).toBe(0)
  expect(submits).toBe(0)
  expect(registry.db.query("select state from bot_distillation_inbox").all()).toEqual([{ state: "WAITING_HISTORY" }])
  await worker.tick(1_000)
  expect(completeAttempts).toBe(2)
  expect(claims).toBe(1)
  expect(registry.db.query("select state from bot_distillation_inbox order by rowid").all()).toEqual([
    { state: "FAILED" },
    { state: "PENDING" },
  ])
  await worker.tick(1_000)
  expect(classifierCalls).toBe(1)
  expect(submits).toBe(1)
})

test("history backfill keeps the revision captured before the list request", async () => {
  let revision = 1
  const imported: number[] = []
  const ready = await backfillDistillationTurn({
    async request() {
      revision = 5
      return { data: [{ id: "turn-1" } as Turn], nextCursor: null }
    },
    importTurns(_turns, captured) { imported.push(captured) },
    readRevision: () => revision,
    threadId: "thread",
    turnId: "turn-1",
    ready: () => true,
  })
  expect(ready.status).toBe("READY")
  expect(imported).toEqual([1])
})

test("completing a marker checks every claimed turn", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  for (const [id, text] of [["turn-1", "第一段"], ["turn-2", "第二段"]] as const) {
    registry.recordRuntimeEvent(principal, JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          id,
          status: "completed",
          items: [{ type: "userMessage", id: `${id}-user`, content: [{ type: "text", text }] }],
        },
      },
    }))
  }
  const bodies = ["turn-1", "turn-2"].map((id) => registry!.timeline.storedTurn(bot.id, "thread", id)!.bodyJson)
  let outcome = ""
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit() { return { marker_id: "marker-1" } },
      async claim() {
        return {
          marker_id: "marker-1",
          content_digest: markerContentDigest(bodies),
          lease_token: "lease-1",
          turn_ids: ["turn-1", "turn-2"],
          thread_id: "thread",
        }
      },
      async complete(_token, _tenant, _marker, body) { outcome = body.outcome },
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick(1_000)
  await worker.tick(1_000)
  expect(outcome).toBe("CANDIDATE_CREATED")
})

test("a slow claimed history backfill releases the lease and restores every unready turn", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  const fullTurns = [
    {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      items: [{ type: "userMessage", id: "user-1", content: [{ type: "text", text: "第一段完整步驟" }] }],
    },
    {
      id: "turn-2",
      status: "completed",
      itemsView: "full",
      error: null,
      startedAt: 3,
      completedAt: 4,
      durationMs: 1,
      items: [{ type: "userMessage", id: "user-2", content: [{ type: "text", text: "第二段完整步驟" }] }],
    },
  ] as unknown as Turn[]
  registry.importRuntimeHistory(bot.id, "thread", fullTurns, registry.timeline.revision())
  const bodies = fullTurns.map((turn) => registry!.timeline.storedTurn(bot.id, "thread", turn.id)!.bodyJson)
  const summary = { ...fullTurns[1]!, itemsView: "summary", items: [] }
  registry.db.query("update bot_timeline_turns set body_json = ? where bot_id = ? and thread_id = ? and turn_id = ?")
    .run(JSON.stringify(summary), bot.id, "thread", "turn-2")
  const summaryRevision = registry.timeline.storedTurn(bot.id, "thread", "turn-2")!.revision
  let backfillStarted = false
  let releaseBackfill = () => {}
  const backfillGate = new Promise<void>((resolve) => { releaseBackfill = resolve })
  const backfilledTurnIds: string[] = []
  const completions: Array<Record<string, unknown>> = []
  let claims = 0
  let leaseReleased = false
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      async backfill(input) {
        expect(leaseReleased).toBe(true)
        backfilledTurnIds.push(input.turnId)
        backfillStarted = true
        await backfillGate
        registry!.importRuntimeHistory(bot.id, "thread", [fullTurns[1]!], registry!.timeline.revision())
        return { status: "READY" as const, exhaustedScans: 0 }
      },
    },
    classifier: { async classify() { throw new Error("linked marker must not classify") } },
    platform: {
      async submit() { throw new Error("linked marker must not submit") },
      async claim(token) {
        expect(token).toBe("owner-token")
        claims += 1
        return {
          marker_id: "marker-1",
          content_digest: markerContentDigest(bodies),
          lease_token: `lease-${claims}`,
          turn_ids: ["turn-1", "turn-2"],
          thread_id: "thread",
        }
      },
      async complete(token, _tenant, _markerId, body) {
        expect(token).toBe("owner-token")
        completions.push(body)
        if (body.outcome === "WAITING_FOR_HISTORY") leaseReleased = true
      },
    },
  })
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error)
    values (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, ?, 'marker-1', null)`).run(
    bot.id,
    "thread",
    "turn-2",
    sourceRevision("turn-2", summaryRevision),
    principal.tenant_id,
    principal.subject_id,
    principal.acting_client_id,
    1_000,
  )
  const firstTick = worker.tick(1_000)
  for (let attempt = 0; attempt < 20 && !backfillStarted; attempt += 1) await Promise.resolve()
  expect(backfillStarted).toBe(true)
  expect(completions).toEqual([{
    lease_token: "lease-1",
    outcome: "WAITING_FOR_HISTORY",
    error: "DISTILLATION_HISTORY_INCOMPLETE",
  }])
  await worker.tick(1_061)
  expect(claims).toBe(1)
  releaseBackfill()
  await firstTick
  await worker.tick(1_061)
  expect(backfilledTurnIds).toEqual(["turn-2"])
  expect(completions).toEqual([
    {
      lease_token: "lease-1",
      outcome: "WAITING_FOR_HISTORY",
      error: "DISTILLATION_HISTORY_INCOMPLETE",
    },
    {
      lease_token: "lease-2",
      outcome: "CANDIDATE_CREATED",
      content_digest: markerContentDigest(bodies),
    },
  ])
  expect(claims).toBe(2)
  expect(registry.db.query("select state from bot_distillation_inbox order by turn_id").all()).toEqual([
    { state: "CANDIDATE" },
    { state: "CANDIDATE" },
  ])
})

test("a replayed waiting completion shares one history scan across claimed turns", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  const fullTurns = [
    {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      items: [{ type: "userMessage", id: "user-1", content: [{ type: "text", text: "第一段完整步驟" }] }],
    },
    {
      id: "turn-2",
      status: "completed",
      itemsView: "full",
      error: null,
      startedAt: 3,
      completedAt: 4,
      durationMs: 1,
      items: [{ type: "userMessage", id: "user-2", content: [{ type: "text", text: "第二段完整步驟" }] }],
    },
  ] as unknown as Turn[]
  registry.importRuntimeHistory(bot.id, "thread", fullTurns, registry.timeline.revision())
  const bodies = fullTurns.map((turn) => registry!.timeline.storedTurn(bot.id, "thread", turn.id)!.bodyJson)
  const firstRevision = registry.timeline.storedTurn(bot.id, "thread", "turn-1")!.revision
  for (const turn of fullTurns) {
    registry.db.query("update bot_timeline_turns set body_json = ? where bot_id = ? and thread_id = ? and turn_id = ?")
      .run(JSON.stringify({ ...turn, itemsView: "summary", items: [] }), bot.id, "thread", turn.id)
  }
  let claims = 0
  let completions = 0
  const backfillRequests: string[][] = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      async backfill(input) {
        backfillRequests.push([...(input.turnIds ?? [input.turnId])])
        registry!.importRuntimeHistory(bot.id, "thread", fullTurns, registry!.timeline.revision())
        return { status: "READY" as const, exhaustedScans: 0 }
      },
    },
    classifier: { async classify() { throw new Error("linked marker must not classify") } },
    platform: {
      async submit() { throw new Error("linked marker must not submit") },
      async claim() {
        claims += 1
        return {
          marker_id: "marker-1",
          content_digest: markerContentDigest(bodies),
          lease_token: "lease-1",
          turn_ids: ["turn-1", "turn-2"],
          thread_id: "thread",
        }
      },
      async complete(_token, _tenant, _markerId, body) {
        expect(body).toEqual({ lease_token: "lease-1", outcome: "WAITING_FOR_HISTORY", error: "DISTILLATION_HISTORY_INCOMPLETE" })
        completions += 1
        if (completions === 1) throw new Error("response lost after remote acceptance")
      },
    },
  })
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error)
    values (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, ?, 'marker-1', null)`).run(
    bot.id,
    "thread",
    "turn-1",
    sourceRevision("turn-1", firstRevision),
    principal.tenant_id,
    principal.subject_id,
    principal.acting_client_id,
    1_000,
  )
  await worker.tick(1_000)
  expect(backfillRequests).toEqual([])
  await worker.tick(1_000)
  expect(claims).toBe(1)
  expect(backfillRequests).toEqual([["turn-1", "turn-2"]])
  expect(registry.db.query("select state from bot_distillation_inbox").all()).toEqual([{ state: "WAITING_HISTORY" }])
})

test("a missing pre-submit turn fails after bounded complete history scans", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  registry.recordRuntimeEvent(principal, JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn-1", status: "completed", itemsView: "summary", items: [] } },
  }))
  let scans = 0
  let submits = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      async backfill() {
        scans += 1
        return { status: "EXHAUSTED" as const, exhaustedScans: scans }
      },
    },
    classifier: { async classify() { throw new Error("missing history must not classify") } },
    platform: { async submit() { submits += 1; return { marker_id: "marker" } }, async claim() { return null }, async complete() {} },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick(1_000)
  await worker.tick(1_030)
  await worker.tick(1_060)
  expect(scans).toBe(3)
  expect(submits).toBe(0)
  expect(registry.db.query("select state, last_error from bot_distillation_inbox").all()).toEqual([
    { state: "FAILED", last_error: "DISTILLATION_HISTORY_NOT_FOUND" },
  ])
})

test("late history recovery before the scan bound resumes marker submission", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  registry.recordRuntimeEvent(principal, JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn-1", status: "completed", itemsView: "summary", items: [] } },
  }))
  let scans = 0
  let submits = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      async backfill() {
        scans += 1
        if (scans < 3) return { status: "EXHAUSTED" as const, exhaustedScans: scans }
        registry!.importRuntimeHistory(bot.id, "thread", [{
          id: "turn-1",
          status: "completed",
          itemsView: "full",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          items: [{ type: "userMessage", id: "user", content: [{ type: "text", text: "晚到的完整部署步驟" }] }],
        } as unknown as Turn], registry!.timeline.revision())
        return { status: "READY" as const, exhaustedScans: 0 }
      },
    },
    classifier: { async classify() { return classified(true) } },
    platform: { async submit() { submits += 1; return { marker_id: "marker" } }, async claim() { return null }, async complete() {} },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick(1_000)
  await worker.tick(1_030)
  await worker.tick(1_060)
  expect(scans).toBe(3)
  expect(submits).toBe(1)
  expect(registry.db.query("select state, history_exhausted_scans from bot_distillation_inbox").all()).toEqual([
    { state: "SUBMITTED", history_exhausted_scans: 0 },
  ])
})

test("partial and transient history scans do not consume the missing-history bound", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  registry.recordRuntimeEvent(principal, JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn-1", status: "completed", itemsView: "summary", items: [] } },
  }))
  const statuses = [
    { status: "MORE_PAGES" as const, exhaustedScans: 0 },
    { status: "TRANSIENT_FAILURE" as const, exhaustedScans: 0 },
    { status: "EXHAUSTED" as const, exhaustedScans: 1 },
  ]
  let index = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      async backfill() { return statuses[index++]! },
    },
    classifier: { async classify() { throw new Error("missing history must not classify") } },
    platform: { async submit() { throw new Error("missing history must not submit") }, async claim() { return null }, async complete() {} },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  await worker.tick(1_000)
  await worker.tick(1_030)
  await worker.tick(1_060)
  expect(registry.db.query("select state, history_exhausted_scans from bot_distillation_inbox").all()).toEqual([
    { state: "WAITING_HISTORY", history_exhausted_scans: 1 },
  ])
})

test("a multi-turn marker shares one bounded history scan", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  for (const turnId of ["turn-1", "turn-2"]) {
    registry.recordRuntimeEvent(principal, JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: turnId, status: "completed", itemsView: "summary", items: [] } },
    }))
  }
  const stored = registry.timeline.storedTurn(bot.id, "thread", "turn-1")!
  let scans = 0
  const backfillRequests: string[][] = []
  const outcomes: string[] = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      async backfill(input) {
        scans += 1
        backfillRequests.push([...(input.turnIds ?? [input.turnId])])
        return { status: "EXHAUSTED" as const, exhaustedScans: scans }
      },
    },
    classifier: { async classify() { throw new Error("linked marker must not classify") } },
    platform: {
      async submit() { throw new Error("linked marker must not submit") },
      async claim() {
        return {
          marker_id: "marker-1",
          content_digest: contentDigest(stored.bodyJson),
          lease_token: `lease-${scans + 1}`,
          turn_ids: ["turn-1", "turn-2"],
          thread_id: "thread",
        }
      },
      async complete(_token, _tenant, _markerId, body) { outcomes.push(String(body.error ?? body.outcome)) },
    },
  })
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error)
    values (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, ?, 'marker-1', null)`).run(
    bot.id,
    "thread",
    "turn-1",
    sourceRevision("turn-1", stored.revision),
    principal.tenant_id,
    principal.subject_id,
    principal.acting_client_id,
    1_000,
  )
  await worker.tick(1_000)
  expect(registry.db.query("select state, history_exhausted_scans from bot_distillation_inbox").all()).toEqual([
    { state: "WAITING_HISTORY", history_exhausted_scans: 1 },
  ])
  await worker.tick(1_030)
  await worker.tick(1_060)
  await worker.tick(1_090)
  expect(backfillRequests).toEqual([
    ["turn-1", "turn-2"],
    ["turn-1", "turn-2"],
    ["turn-1", "turn-2"],
  ])
  expect(outcomes).toEqual([
    "DISTILLATION_HISTORY_INCOMPLETE",
    "DISTILLATION_HISTORY_INCOMPLETE",
    "DISTILLATION_HISTORY_INCOMPLETE",
    "DISTILLATION_HISTORY_NOT_FOUND",
  ])
})

test("a 32-turn marker uses one twenty-page history scan", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  const turnIds = Array.from({ length: 32 }, (_, index) => `turn-${index + 1}`)
  for (const turnId of turnIds) {
    registry.recordRuntimeEvent(principal, JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: turnId, status: "completed", itemsView: "summary", items: [] } },
    }))
  }
  const first = registry.timeline.storedTurn(bot.id, "thread", turnIds[0]!)!
  let scans = 0
  let pageRequests = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      async backfill(input) {
        scans += 1
        expect(input.turnIds).toEqual(turnIds)
        return backfillDistillationTurn({
          async request() {
            pageRequests += 1
            return { data: [], nextCursor: `cursor-${pageRequests}` }
          },
          importTurns() {},
          readRevision: () => registry!.timeline.revision(),
          threadId: input.threadId,
          turnId: input.turnId,
          ready: () => false,
        })
      },
    },
    classifier: { async classify() { throw new Error("incomplete marker must not classify") } },
    platform: {
      async submit() { throw new Error("incomplete marker must not submit") },
      async claim() {
        return {
          marker_id: "marker-1",
          content_digest: "marker-digest",
          lease_token: "lease-1",
          turn_ids: turnIds,
          thread_id: "thread",
        }
      },
      async complete(_token, _tenant, _markerId, body) {
        expect(body).toEqual({
          lease_token: "lease-1",
          outcome: "WAITING_FOR_HISTORY",
          error: "DISTILLATION_HISTORY_INCOMPLETE",
        })
      },
    },
  })
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error)
    values (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, ?, 'marker-1', null)`).run(
    bot.id,
    "thread",
    turnIds[0],
    sourceRevision(turnIds[0]!, first.revision),
    principal.tenant_id,
    principal.subject_id,
    principal.acting_client_id,
    1_000,
  )
  await worker.tick(1_000)
  expect(scans).toBe(1)
  expect(pageRequests).toBe(20)
})

test("multi-turn markers with the same first turn keep history progress separate", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  for (const turnId of ["turn-1", "turn-2", "turn-3"]) {
    registry.recordRuntimeEvent(principal, JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: turnId, status: "completed", itemsView: "summary", items: [] } },
    }))
  }
  const progress = new SQLiteDistillationBackfillProgressStore(registry.db)
  const completions: Array<{ markerId: string; body: Record<string, unknown> }> = []
  let claims = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      claimTargets: () => [{ principal, botId: bot.id }],
      async backfill(input) {
        return {
          status: "EXHAUSTED" as const,
          exhaustedScans: progress.forTurn(input.botId, input.threadId, input.progressKey ?? input.turnId).recordExhaustedScan(),
        }
      },
    },
    classifier: { async classify() { throw new Error("incomplete marker must not classify") } },
    platform: {
      async submit() { throw new Error("incomplete marker must not submit") },
      async claim() {
        claims += 1
        if (claims <= 3) {
          return {
            marker_id: "marker-a",
            content_digest: "marker-a-digest",
            lease_token: `lease-${claims}`,
            turn_ids: ["turn-1", "turn-2"],
            thread_id: "thread",
          }
        }
        if (claims === 4) {
          return {
            marker_id: "marker-b",
            content_digest: "marker-b-digest",
            lease_token: "lease-4",
            turn_ids: ["turn-1", "turn-3"],
            thread_id: "thread",
          }
        }
        return null
      },
      async complete(_token, _tenant, markerId, body) {
        completions.push({ markerId, body })
      },
    },
  })
  await worker.tick(1_000)
  await worker.tick(1_030)
  await worker.tick(1_060)
  await worker.tick(1_090)
  expect(completions).toEqual([
    { markerId: "marker-a", body: { lease_token: "lease-1", outcome: "WAITING_FOR_HISTORY", error: "DISTILLATION_HISTORY_INCOMPLETE" } },
    { markerId: "marker-a", body: { lease_token: "lease-2", outcome: "WAITING_FOR_HISTORY", error: "DISTILLATION_HISTORY_INCOMPLETE" } },
    { markerId: "marker-a", body: { lease_token: "lease-3", outcome: "WAITING_FOR_HISTORY", error: "DISTILLATION_HISTORY_INCOMPLETE" } },
    { markerId: "marker-b", body: { lease_token: "lease-4", outcome: "WAITING_FOR_HISTORY", error: "DISTILLATION_HISTORY_INCOMPLETE" } },
  ])
  expect(progress.forTurn(bot.id, "thread", "marker-a").exhaustedScans()).toBe(3)
  expect(progress.forTurn(bot.id, "thread", "marker-b").exhaustedScans()).toBe(1)
})

test("a claimed marker fails remotely after bounded missing-history scans", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  registry.recordRuntimeEvent(principal, JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn-1", status: "completed", itemsView: "summary", items: [] } },
  }))
  const stored = registry.timeline.storedTurn(bot.id, "thread", "turn-1")!
  let scans = 0
  const outcomes: string[] = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      async backfill() {
        scans += 1
        return { status: "EXHAUSTED" as const, exhaustedScans: scans }
      },
    },
    classifier: { async classify() { throw new Error("linked marker must not classify") } },
    platform: {
      async submit() { throw new Error("linked marker must not submit") },
      async claim() {
        return {
          marker_id: "marker-1",
          content_digest: contentDigest(stored.bodyJson),
          lease_token: `lease-${scans + 1}`,
          turn_ids: ["turn-1"],
          thread_id: "thread",
        }
      },
      async complete(_token, _tenant, _markerId, body) { outcomes.push(String(body.error ?? body.outcome)) },
    },
  })
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error)
    values (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, ?, 'marker-1', null)`).run(
    bot.id,
    "thread",
    "turn-1",
    sourceRevision("turn-1", stored.revision),
    principal.tenant_id,
    principal.subject_id,
    principal.acting_client_id,
    1_000,
  )
  await worker.tick(1_000)
  await worker.tick(1_030)
  await worker.tick(1_060)
  await worker.tick(1_090)
  expect(scans).toBe(3)
  expect(outcomes).toEqual([
    "DISTILLATION_HISTORY_INCOMPLETE",
    "DISTILLATION_HISTORY_INCOMPLETE",
    "DISTILLATION_HISTORY_INCOMPLETE",
    "DISTILLATION_HISTORY_NOT_FOUND",
  ])
  expect(registry.db.query("select state, last_error from bot_distillation_inbox").all()).toEqual([
    { state: "FAILED", last_error: "DISTILLATION_HISTORY_NOT_FOUND" },
  ])
})

test("an unlinked claimed marker fails after persisted missing-history scans", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  const progress = new SQLiteDistillationBackfillProgressStore(registry.db)
  const outcomes: string[] = []
  let scans = 0
  const createWorker = () => createDistillationWorker({
    registry: registry!,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      claimTargets() { return [{ principal, botId: bot.id }] },
      async backfill({ botId, threadId, turnId, progressKey }) {
        scans += 1
        return {
          status: "EXHAUSTED" as const,
          exhaustedScans: progress.forTurn(botId, threadId, progressKey ?? turnId).recordExhaustedScan(),
        }
      },
    },
    classifier: { async classify() { throw new Error("unlinked marker must not classify") } },
    platform: {
      async submit() { throw new Error("unlinked marker must not submit") },
      async claim() {
        return {
          marker_id: "unlinked-marker",
          content_digest: "unlinked-digest",
          lease_token: `lease-${scans + 1}`,
          turn_ids: ["missing-turn"],
          thread_id: "thread",
        }
      },
      async complete(_token, _tenant, _markerId, body) { outcomes.push(String(body.error ?? body.outcome)) },
    },
  })
  let worker = createWorker()
  await worker.tick(1_000)
  await worker.tick(1_030)
  await worker.tick(1_060)
  worker = createWorker()
  await worker.tick(1_090)
  expect(scans).toBe(3)
  expect(outcomes).toEqual([
    "DISTILLATION_HISTORY_INCOMPLETE",
    "DISTILLATION_HISTORY_INCOMPLETE",
    "DISTILLATION_HISTORY_INCOMPLETE",
    "DISTILLATION_HISTORY_NOT_FOUND",
  ])
  expect(registry.db.query("select count(*) as count from bot_distillation_inbox").get()).toEqual({ count: 0 })
})

test("an active owner target converges an idempotent remote candidate without an initial inbox row", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn()
  let claims = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor(candidate, candidateBotId) {
        expect(candidate.tenant_id).toBe(principal.tenant_id)
        expect(candidate.subject_id).toBe(principal.subject_id)
        expect(candidate.acting_client_id).toBe(principal.acting_client_id)
        expect(candidateBotId).toBe(botId)
        return "owner-token"
      },
      claimTargets() {
        return [{ principal, botId }]
      },
    },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit() { return { marker_id: "remote-marker", processing_state: "CANDIDATE_CREATED" as const } },
      async claim(token, tenantId, candidateBotId) {
        claims += 1
        expect(token).toBe("owner-token")
        expect(tenantId).toBe(principal.tenant_id)
        expect(candidateBotId).toBe(botId)
        return null
      },
      async complete() { throw new Error("candidate marker must not complete") },
    },
  })
  expect(registry.db.query("select count(*) as count from bot_distillation_inbox").get()).toEqual({ count: 0 })
  await worker.tick(1_000)
  expect(claims).toBe(1)
  expect(registry.db.query("select state, marker_id from bot_distillation_inbox").all()).toEqual([
    { state: "CANDIDATE", marker_id: "remote-marker" },
  ])
})

test("terminal idempotent submissions converge the local inbox", async () => {
  for (const [processingState, expectedState, lastError] of [
    ["CANDIDATE_CREATED", "CANDIDATE", null],
    ["FILTERED_OUT", "UNRELATED", null],
    ["FAILED", "FAILED", "REMOTE_FAILED"],
  ] as const) {
    registry?.close()
    registry = new BotRegistry(":memory:")
    completeTurn()
    const worker = createDistillationWorker({
      registry,
      now: () => 1_000,
      sessions: { tokenFor: () => "owner-token" },
      classifier: { async classify() { return classified(true) } },
      platform: {
        async submit() {
          return { marker_id: `marker-${processingState}`, processing_state: processingState, ...(lastError ? { last_error: lastError } : {}) }
        },
        async claim() { return null },
        async complete() {},
      },
    })
    worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
    await worker.tick(1_000)
    expect(registry.db.query("select state, marker_id, last_error from bot_distillation_inbox").all()).toEqual([
      { state: expectedState, marker_id: `marker-${processingState}`, last_error: lastError },
    ])
  }
})

test("a remote multi-turn candidate records every claimed turn", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.update(bot.id, principal, { teamWorkspaceId: "workspace-current" })
  registry.rememberThread(bot.id, "thread")
  for (const turnId of ["turn-1", "turn-2"]) {
    registry.recordRuntimeEvent(principal, JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          id: turnId,
          status: "completed",
          items: [{ type: "userMessage", id: `${turnId}-user`, content: [{ type: "text", text: turnId }] }],
        },
      },
    }))
  }
  const bodies = ["turn-1", "turn-2"].map((turnId) => registry!.timeline.storedTurn(bot.id, "thread", turnId)!.bodyJson)
  let claims = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      claimTargets: () => [{ principal, botId: bot.id }],
    },
    classifier: { async classify() { throw new Error("remote candidate must not submit") } },
    platform: {
      async submit() { throw new Error("remote candidate must not submit") },
      async claim() {
        claims += 1
        return claims === 1
          ? {
              marker_id: "remote-marker",
              content_digest: markerContentDigest(bodies),
              lease_token: "remote-lease",
              turn_ids: ["turn-1", "turn-2"],
              thread_id: "thread",
              workspace_id: "workspace-original",
            }
          : null
      },
      async complete(_token, _tenant, markerId, body) {
        expect(markerId).toBe("remote-marker")
        expect(body).toEqual({ lease_token: "remote-lease", outcome: "CANDIDATE_CREATED", content_digest: markerContentDigest(bodies) })
      },
    },
  })
  await worker.tick(1_000)
  expect(registry.db.query("select turn_id, state, marker_id, workspace_id from bot_distillation_inbox order by turn_id").all()).toEqual([
    { turn_id: "turn-1", state: "CANDIDATE", marker_id: "remote-marker", workspace_id: "workspace-original" },
    { turn_id: "turn-2", state: "CANDIDATE", marker_id: "remote-marker", workspace_id: "workspace-original" },
  ])
  await worker.tick(1_000)
  expect(claims).toBe(2)
  expect(registry.db.query("select count(*) as count from bot_distillation_inbox").get()).toEqual({ count: 2 })
})

test("a linked multi-turn completion preserves old candidates and requeues revisions imported during completion", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.update(bot.id, principal, { teamWorkspaceId: "workspace-current" })
  registry.rememberThread(bot.id, "thread")
  for (const turnId of ["turn-1", "turn-2"]) {
    registry.recordRuntimeEvent(principal, JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          id: turnId,
          status: "completed",
          items: [{ type: "userMessage", id: `${turnId}-user`, content: [{ type: "text", text: `舊版 ${turnId}` }] }],
        },
      },
    }))
  }
  const initialTurns = ["turn-1", "turn-2"].map((turnId) => registry!.timeline.storedTurn(bot.id, "thread", turnId)!)
  const initialDigest = markerContentDigest(initialTurns.map((stored) => stored.bodyJson))
  const oldRevisions = initialTurns.map((stored, index) => sourceRevision(`turn-${index + 1}`, stored.revision))
  let releaseComplete = () => {}
  const completeGate = new Promise<void>((resolve) => { releaseComplete = resolve })
  let completeStarted = false
  let scanEnabled = false
  let claims = 0
  const drafts: Array<{ turn_ids: string[] }> = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      claimTargets: () => scanEnabled ? [{ principal, botId: bot.id }] : [],
    },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) {
        drafts.push(draft)
        return { marker_id: `new-marker-${drafts.length}` }
      },
      async claim() {
        claims += 1
        if (claims > 1) return null
        return {
          marker_id: "linked-marker",
          content_digest: initialDigest,
          lease_token: "linked-lease",
          turn_ids: ["turn-1", "turn-2"],
          thread_id: "thread",
          workspace_id: "workspace-original",
        }
      },
      async complete(_token, _tenant, markerId, body) {
        expect(markerId).toBe("linked-marker")
        expect(body).toEqual({
          lease_token: "linked-lease",
          outcome: "CANDIDATE_CREATED",
          content_digest: initialDigest,
        })
        completeStarted = true
        await completeGate
      },
    },
  })
  const stopHistoryImportObserving = registry.observeHistoryImport((event) => {
    worker.historyImported(event.botId, event.threadId, event.turnIds)
  })
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error, workspace_id)
    values (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, ?, 'linked-marker', null, ?)`).run(
    bot.id,
    "thread",
    "turn-1",
    oldRevisions[0],
    principal.tenant_id,
    principal.subject_id,
    principal.acting_client_id,
    1_000,
    "workspace-original",
  )
  const tick = worker.tick(1_000)
  for (let attempt = 0; attempt < 20 && !completeStarted; attempt += 1) await Promise.resolve()
  expect(completeStarted).toBe(true)
  registry.importRuntimeHistory(bot.id, "thread", [
    {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      items: [{ type: "userMessage", id: "turn-1-user", content: [{ type: "text", text: "新版客戶合約步驟一" }] }],
    },
    {
      id: "turn-2",
      status: "completed",
      itemsView: "full",
      error: null,
      startedAt: 3,
      completedAt: 4,
      durationMs: 1,
      items: [{ type: "userMessage", id: "turn-2-user", content: [{ type: "text", text: "新版客戶合約步驟二" }] }],
    },
  ] as unknown as Turn[], registry.timeline.revision())
  scanEnabled = true
  releaseComplete()
  await tick
  const currentRevisions = ["turn-1", "turn-2"].map((turnId) => {
    const stored = registry!.timeline.storedTurn(bot.id, "thread", turnId)!
    return sourceRevision(turnId, stored.revision)
  })
  expect(registry.db.query(`select turn_id, source_revision, state, marker_id, workspace_id from bot_distillation_inbox
    where thread_id = 'thread' order by turn_id, rowid`).all()).toEqual([
    { turn_id: "turn-1", source_revision: oldRevisions[0], state: "CANDIDATE", marker_id: "linked-marker", workspace_id: "workspace-original" },
    { turn_id: "turn-1", source_revision: currentRevisions[0], state: "PENDING", marker_id: null, workspace_id: "workspace-original" },
    { turn_id: "turn-2", source_revision: oldRevisions[1], state: "CANDIDATE", marker_id: "linked-marker", workspace_id: "workspace-original" },
    { turn_id: "turn-2", source_revision: currentRevisions[1], state: "PENDING", marker_id: null, workspace_id: "workspace-original" },
  ])
  await worker.tick(1_000)
  expect(drafts.map((draft) => draft.turn_ids)).toEqual([["turn-1"], ["turn-2"]])
  stopHistoryImportObserving()
})

test("an unlinked completion requeues every claimed turn changed during the completion response", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.update(bot.id, principal, { teamWorkspaceId: "workspace-current" })
  registry.rememberThread(bot.id, "thread")
  for (const turnId of ["turn-1", "turn-2"]) {
    registry.recordRuntimeEvent(principal, JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          id: turnId,
          status: "completed",
          items: [{ type: "userMessage", id: `${turnId}-user`, content: [{ type: "text", text: `舊版 ${turnId}` }] }],
        },
      },
    }))
  }
  const initialBodies = ["turn-1", "turn-2"].map((turnId) => registry!.timeline.storedTurn(bot.id, "thread", turnId)!.bodyJson)
  let releaseComplete = () => {}
  const completeGate = new Promise<void>((resolve) => { releaseComplete = resolve })
  let completeStarted = false
  let claims = 0
  const drafts: Array<{ turn_ids: string[] }> = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit(_token, _tenant, draft) {
        drafts.push(draft)
        return { marker_id: `new-marker-${drafts.length}` }
      },
      async claim() {
        claims += 1
        if (claims > 1) return null
        return {
          marker_id: "remote-marker",
          content_digest: markerContentDigest(initialBodies),
          lease_token: "remote-lease",
          turn_ids: ["turn-1", "turn-2"],
          thread_id: "thread",
          workspace_id: "workspace-original",
        }
      },
      async complete(_token, _tenant, markerId, body) {
        expect(markerId).toBe("remote-marker")
        expect(body).toEqual({
          lease_token: "remote-lease",
          outcome: "CANDIDATE_CREATED",
          content_digest: markerContentDigest(initialBodies),
        })
        completeStarted = true
        await completeGate
      },
    },
  })
  const stopHistoryImportObserving = registry.observeHistoryImport((event) => {
    worker.historyImported(event.botId, event.threadId, event.turnIds)
  })
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error)
    values (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, ?, 'anchor-marker', null)`).run(
    bot.id,
    "anchor-thread",
    "anchor-turn",
    "anchor-source",
    principal.tenant_id,
    principal.subject_id,
    principal.acting_client_id,
    1_000,
  )
  const tick = worker.tick(1_000)
  for (let attempt = 0; attempt < 20 && !completeStarted; attempt += 1) await Promise.resolve()
  expect(completeStarted).toBe(true)
  registry.importRuntimeHistory(bot.id, "thread", [
    {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      items: [{ type: "userMessage", id: "turn-1-user", content: [{ type: "text", text: "新版客戶合約步驟一" }] }],
    },
    {
      id: "turn-2",
      status: "completed",
      itemsView: "full",
      error: null,
      startedAt: 3,
      completedAt: 4,
      durationMs: 1,
      items: [{ type: "userMessage", id: "turn-2-user", content: [{ type: "text", text: "新版客戶合約步驟二" }] }],
    },
  ] as unknown as Turn[], registry.timeline.revision())
  releaseComplete()
  await tick
  expect(registry.db.query(`select turn_id, state, marker_id, workspace_id from bot_distillation_inbox
    where thread_id = 'thread' order by turn_id, rowid`).all()).toEqual([
    { turn_id: "turn-1", state: "CANDIDATE", marker_id: "remote-marker", workspace_id: "workspace-original" },
    { turn_id: "turn-1", state: "PENDING", marker_id: null, workspace_id: "workspace-original" },
    { turn_id: "turn-2", state: "CANDIDATE", marker_id: "remote-marker", workspace_id: "workspace-original" },
    { turn_id: "turn-2", state: "PENDING", marker_id: null, workspace_id: "workspace-original" },
  ])
  await worker.tick(1_000)
  expect(drafts.map((draft) => draft.turn_ids)).toEqual([["turn-1"], ["turn-2"]])
  stopHistoryImportObserving()
})

test("an unlinked marker fails before reading a thread owned by another Bot", async () => {
  registry = new BotRegistry(":memory:")
  const source = registry.create(principal, { name: "Source", description: "工作" })
  const other = registry.create(principal, { name: "Other", description: "工作" })
  registry.rememberThread(other.id, "other-thread")
  registry.recordRuntimeEvent(principal, JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "other-thread",
      turn: {
        id: "other-turn",
        status: "completed",
        items: [{ type: "userMessage", id: "other-user", content: [{ type: "text", text: "不可跨 Bot 取用" }] }],
      },
    },
  }))
  let backfills = 0
  const completions: Array<Record<string, unknown>> = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      claimTargets: () => [{ principal, botId: source.id }],
      async backfill() {
        backfills += 1
        return { status: "READY" as const, exhaustedScans: 0 }
      },
    },
    classifier: { async classify() { throw new Error("foreign thread must not classify") } },
    platform: {
      async submit() { throw new Error("foreign thread must not submit") },
      async claim() {
        return {
          marker_id: "foreign-marker",
          content_digest: "foreign-digest",
          lease_token: "foreign-lease",
          turn_ids: ["other-turn"],
          thread_id: "other-thread",
        }
      },
      async complete(_token, _tenant, markerId, body) {
        expect(markerId).toBe("foreign-marker")
        completions.push(body)
      },
    },
  })
  await worker.tick(1_000)
  expect(backfills).toBe(0)
  expect(completions).toEqual([{
    lease_token: "foreign-lease",
    outcome: "FAILED",
    error: "DISTILLATION_THREAD_NOT_OWNED",
  }])
  expect(registry.db.query("select count(*) as count from bot_distillation_inbox where bot_id = ?").get(source.id)).toEqual({ count: 0 })
})

test("deleting a Bot during an unlinked marker claim prevents remote completion", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn()
  const stored = registry.timeline.storedTurn(botId, "thread", "turn-1")!
  let claimStarted = false
  let releaseClaim = () => {}
  const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve })
  let completions = 0
  let backfills = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      claimTargets() { return [{ principal, botId }] },
      async backfill() {
        backfills += 1
        return { status: "TRANSIENT_FAILURE" as const, exhaustedScans: 0 }
      },
    },
    classifier: { async classify() { throw new Error("unlinked marker must not classify") } },
    platform: {
      async submit() { throw new Error("unlinked marker must not submit") },
      async claim() {
        claimStarted = true
        await claimGate
        return {
          marker_id: "remote-marker",
          content_digest: markerContentDigest([stored.bodyJson]),
          lease_token: "remote-lease",
          turn_ids: ["turn-1"],
          thread_id: "thread",
        }
      },
      async complete() { completions += 1 },
    },
  })
  const tick = worker.tick(1_000)
  for (let attempt = 0; attempt < 20 && !claimStarted; attempt += 1) await Promise.resolve()
  expect(claimStarted).toBe(true)
  registry.delete(botId, principal)
  releaseClaim()
  await tick
  expect(completions).toBe(0)
  expect(backfills).toBe(0)
})

test("a claim target cannot poll another owner's Bot", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  const otherPrincipal = { ...principal, subject_id: "other-owner" }
  let tokenRequests = 0
  let claims = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor() {
        tokenRequests += 1
        return "other-token"
      },
      claimTargets() { return [{ principal: otherPrincipal, botId: bot.id }] },
    },
    classifier: { async classify() { throw new Error("foreign Bot must not classify") } },
    platform: {
      async submit() { throw new Error("foreign Bot must not submit") },
      async claim() { claims += 1; return null },
      async complete() { throw new Error("foreign Bot must not complete") },
    },
  })
  await worker.tick(1_000)
  expect(tokenRequests).toBe(0)
  expect(claims).toBe(0)
})

test("a submitted marker waits for its original client before another active client can claim", async () => {
  registry = new BotRegistry(":memory:")
  const clientA = { ...principal, acting_client_id: "client-a" }
  const clientB = { ...principal, acting_client_id: "client-b" }
  const bot = registry.create(clientA, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  registry.recordRuntimeEvent(clientA, JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "thread",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ type: "userMessage", id: "user", content: [{ type: "text", text: canary }] }],
      },
    },
  }))
  const stored = registry.timeline.storedTurn(bot.id, "thread", "turn-1")!
  let originalClientOnline = false
  const tokenClients: string[] = []
  const claimTokens: string[] = []
  let completions = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor(candidate) {
        tokenClients.push(candidate.acting_client_id)
        if (candidate.acting_client_id === clientA.acting_client_id) return originalClientOnline ? "token-a" : null
        if (candidate.acting_client_id === clientB.acting_client_id) return "token-b"
        return null
      },
      claimTargets: () => [{ principal: clientB, botId: bot.id }],
    },
    classifier: { async classify() { throw new Error("submitted marker must not classify") } },
    platform: {
      async submit() { throw new Error("submitted marker must not submit") },
      async claim(token, _tenant, claimedBotId) {
        claimTokens.push(token)
        expect(claimedBotId).toBe(bot.id)
        return {
          marker_id: "marker-a",
          content_digest: contentDigest(stored.bodyJson),
          lease_token: "lease-a",
          turn_ids: ["turn-1"],
          thread_id: "thread",
        }
      },
      async complete(token, _tenant, markerId, body) {
        expect(token).toBe("token-a")
        expect(markerId).toBe("marker-a")
        expect(body).toEqual({
          lease_token: "lease-a",
          outcome: "CANDIDATE_CREATED",
          content_digest: contentDigest(stored.bodyJson),
        })
        completions += 1
      },
    },
  })
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error)
    values (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, ?, 'marker-a', null)`).run(
    bot.id,
    "thread",
    "turn-1",
    sourceRevision("turn-1", stored.revision),
    clientA.tenant_id,
    clientA.subject_id,
    clientA.acting_client_id,
    1_000,
  )
  await worker.tick(1_000)
  expect(claimTokens).toEqual([])
  expect(tokenClients).toEqual(["client-a"])
  expect(registry.db.query("select state, acting_client_id from bot_distillation_inbox").all()).toEqual([
    { state: "SUBMITTED", acting_client_id: "client-a" },
  ])
  originalClientOnline = true
  await worker.tick(1_000)
  expect(claimTokens).toEqual(["token-a"])
  expect(completions).toBe(1)
  expect(registry.db.query("select state, acting_client_id from bot_distillation_inbox").all()).toEqual([
    { state: "CANDIDATE", acting_client_id: "client-a" },
  ])
})

test("active claim targets rotate a bounded batch across a worker restart", async () => {
  registry = new BotRegistry(":memory:")
  const bots = Array.from({ length: 9 }, (_, index) => registry!.create(principal, { name: `Bot ${index}` }))
  const claims: string[] = []
  const createWorker = () => createDistillationWorker({
    registry: registry!,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      claimTargets: () => bots.map((bot) => ({ principal, botId: bot.id })).reverse(),
    },
    classifier: { async classify() { throw new Error("remote claims must not classify") } },
    platform: {
      async submit() { throw new Error("remote claims must not submit") },
      async claim(_token, _tenant, botId) { claims.push(botId); return null },
      async complete() { throw new Error("remote claims must not complete") },
    },
  })
  const first = createWorker()
  await first.tick(1_000)
  expect(claims).toHaveLength(8)
  const firstClaimed = new Set(claims)
  expect(firstClaimed).toHaveLength(8)
  const restarted = createWorker()
  await restarted.tick(1_000)
  expect(claims).toHaveLength(16)
  expect(firstClaimed.has(claims[8]!)).toBe(false)
  expect(new Set(claims.slice(8))).toHaveLength(8)
  expect(new Set(claims)).toEqual(new Set(bots.map((bot) => bot.id)))
})

test("local submitted targets rotate a bounded batch across a worker restart", async () => {
  registry = new BotRegistry(":memory:")
  const bots = Array.from({ length: 9 }, (_, index) => registry!.create(principal, { name: `Bot ${index}` }))
  const claims: string[] = []
  const createWorker = () => createDistillationWorker({
    registry: registry!,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { throw new Error("local claims must not classify") } },
    platform: {
      async submit() { throw new Error("local claims must not submit") },
      async claim(_token, _tenant, botId) { claims.push(botId); return null },
      async complete() { throw new Error("local claims must not complete") },
    },
  })
  const worker = createWorker()
  for (const bot of bots) {
    registry.db.query(`insert into bot_distillation_inbox
      (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error)
      values (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, ?, ?, null)`).run(
      bot.id,
      `thread-${bot.id}`,
      `turn-${bot.id}`,
      `source-${bot.id}`,
      principal.tenant_id,
      principal.subject_id,
      principal.acting_client_id,
      1_000,
      `marker-${bot.id}`,
    )
  }
  await worker.tick(1_000)
  expect(claims).toHaveLength(8)
  const firstClaimed = new Set(claims)
  expect(firstClaimed).toHaveLength(8)
  const restarted = createWorker()
  await restarted.tick(1_000)
  expect(claims).toHaveLength(16)
  expect(firstClaimed.has(claims[8]!)).toBe(false)
  expect(new Set(claims)).toEqual(new Set(bots.map((bot) => bot.id)))
})

test("a saved local completion precedes a normal local claim", async () => {
  registry = new BotRegistry(":memory:")
  const normal = registry.create(principal, { name: "Normal" })
  const completion = registry.create(principal, { name: "Completion" })
  const events: string[] = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { throw new Error("local rows must not classify") } },
    platform: {
      async submit() { throw new Error("local rows must not submit") },
      async claim(_token, _tenant, botId) { events.push(`claim:${botId}`); return null },
      async complete(_token, _tenant, markerId) { events.push(`complete:${markerId}`) },
    },
  })
  const insert = registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error,
      completion_lease_token, completion_outcome, completion_error)
    values (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, ?, ?, null, ?, ?, ?)`)
  insert.run(normal.id, "normal-thread", "normal-turn", "normal-source", principal.tenant_id, principal.subject_id, principal.acting_client_id, 1_000, "normal-marker", null, null, null)
  insert.run(completion.id, "completion-thread", "completion-turn", "completion-source", principal.tenant_id, principal.subject_id, principal.acting_client_id, 1_000, "completion-marker", "completion-lease", "FAILED", "DISTILLATION_HISTORY_NOT_FOUND")
  await worker.tick(1_000)
  expect(events).toEqual([`complete:completion-marker`, `claim:${normal.id}`])
})

test("local submitted completion runs before the bounded active claim batch", async () => {
  registry = new BotRegistry(":memory:")
  const bots = Array.from({ length: 9 }, (_, index) => registry!.create(principal, { name: `Bot ${index}` }))
  const local = [...bots].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0).at(-1)!
  const events: string[] = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      claimTargets: () => bots.map((bot) => ({ principal, botId: bot.id })).reverse(),
    },
    classifier: { async classify() { throw new Error("claim batch must not classify") } },
    platform: {
      async submit() { throw new Error("claim batch must not submit") },
      async claim(_token, _tenant, botId) { events.push(`claim:${botId}`); return null },
      async complete(_token, _tenant, markerId) { events.push(`complete:${markerId}`) },
    },
  })
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error,
      completion_lease_token, completion_outcome, completion_error)
    values (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, ?, 'local-marker', null, 'local-lease', 'FAILED', 'DISTILLATION_HISTORY_NOT_FOUND')`).run(
    local.id,
    "thread",
    "turn",
    "source",
    principal.tenant_id,
    principal.subject_id,
    principal.acting_client_id,
    1_000,
  )
  await worker.tick(1_000)
  expect(events[0]).toBe("complete:local-marker")
  expect(events.filter((event) => event.startsWith("claim:"))).toHaveLength(8)
  expect(events).not.toContain(`claim:${local.id}`)
})

test("a due backlog leaves room for submitted marker completion", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  let classifierCalls = 0
  let completionAfter = -1
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: {
      async classify() {
        classifierCalls += 1
        return { status: "UNAVAILABLE" as const, classifier_version: "jev-distillation-1" }
      },
    },
    platform: {
      async submit() { throw new Error("backlog rows must not submit") },
      async claim() { throw new Error("completion must run before another claim") },
      async complete(_token, _tenant, _markerId, body) {
        completionAfter = classifierCalls
        expect(body).toEqual({
          lease_token: "lease-1",
          outcome: "FAILED",
          error: "DISTILLATION_HISTORY_NOT_FOUND",
        })
      },
    },
  })
  for (let index = 0; index < 9; index += 1) {
    const turnId = `backlog-${index}`
    registry.recordRuntimeEvent(principal, JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          id: turnId,
          status: "completed",
          items: [{ type: "userMessage", id: `user-${index}`, content: [{ type: "text", text: `待處理步驟 ${index}` }] }],
        },
      },
    }))
    worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: turnId } } }))
  }
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error,
      completion_lease_token, completion_outcome, completion_error)
    values (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, ?, 'submitted-marker', null, 'lease-1', 'FAILED', 'DISTILLATION_HISTORY_NOT_FOUND')`).run(
    bot.id,
    "thread",
    "submitted-turn",
    "submitted-source",
    principal.tenant_id,
    principal.subject_id,
    principal.acting_client_id,
    1_000,
  )
  await worker.tick(1_000)
  expect(classifierCalls).toBe(8)
  expect(completionAfter).toBe(8)
  await worker.tick(1_000)
  expect(classifierCalls).toBe(9)
})

test("deleting a bot during classification prevents a new marker submission", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn()
  let classifierStarted = false
  let releaseClassifier = () => {}
  const classifierGate = new Promise<void>((resolve) => { releaseClassifier = resolve })
  let submits = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: {
      async classify() {
        classifierStarted = true
        await classifierGate
        return classified(true)
      },
    },
    platform: {
      async submit() { submits += 1; return { marker_id: "marker-1" } },
      async claim() { return null },
      async complete() {},
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  const tick = worker.tick(1_000)
  for (let attempt = 0; attempt < 20 && !classifierStarted; attempt += 1) await Promise.resolve()
  expect(classifierStarted).toBe(true)
  registry.delete(botId, principal)
  releaseClassifier()
  await tick
  expect(submits).toBe(0)
  expect(registry.db.query("select count(*) as count from bot_distillation_inbox where bot_id = ?").get(botId)).toEqual({ count: 0 })
})

test("deleting a bot during backfill prevents classifier execution", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  registry.rememberThread(bot.id, "thread")
  registry.recordRuntimeEvent(principal, JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn-1", status: "completed", itemsView: "summary", items: [] } },
  }))
  let backfillStarted = false
  let releaseBackfill = () => {}
  const backfillGate = new Promise<void>((resolve) => { releaseBackfill = resolve })
  let classifierCalls = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: {
      tokenFor: () => "owner-token",
      async backfill() {
        backfillStarted = true
        await backfillGate
        return { status: "EXHAUSTED" as const, exhaustedScans: 1 }
      },
    },
    classifier: { async classify() { classifierCalls += 1; return classified(true) } },
    platform: { async submit() { throw new Error("deleted bot must not submit") }, async claim() { return null }, async complete() {} },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  const tick = worker.tick(1_000)
  for (let attempt = 0; attempt < 20 && !backfillStarted; attempt += 1) await Promise.resolve()
  expect(backfillStarted).toBe(true)
  registry.delete(bot.id, principal)
  releaseBackfill()
  await tick
  expect(classifierCalls).toBe(0)
})

test("deleting a bot during a claimed marker flow prevents remote completion", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn()
  const stored = registry.timeline.storedTurn(botId, "thread", "turn-1")!
  let claimStarted = false
  let releaseClaim = () => {}
  const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve })
  let completions = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { throw new Error("submitted marker must not classify") } },
    platform: {
      async submit() { throw new Error("submitted marker must not submit") },
      async claim() {
        claimStarted = true
        await claimGate
        return {
          marker_id: "marker-1",
          content_digest: contentDigest(stored.bodyJson),
          lease_token: "lease-1",
          turn_ids: ["turn-1"],
          thread_id: "thread",
        }
      },
      async complete() { completions += 1 },
    },
  })
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error)
    values (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, ?, 'marker-1', null)`).run(
    botId,
    "thread",
    "turn-1",
    sourceRevision("turn-1", stored.revision),
    principal.tenant_id,
    principal.subject_id,
    principal.acting_client_id,
    1_000,
  )
  const tick = worker.tick(1_000)
  for (let attempt = 0; attempt < 20 && !claimStarted; attempt += 1) await Promise.resolve()
  expect(claimStarted).toBe(true)
  registry.delete(botId, principal)
  releaseClaim()
  await tick
  expect(completions).toBe(0)
  expect(registry.db.query("select count(*) as count from bot_distillation_inbox where bot_id = ?").get(botId)).toEqual({ count: 0 })
})

test("an in-flight tick is not reentered by the next scheduled tick", async () => {
  registry = new BotRegistry(":memory:")
  completeTurn()
  let calls = 0
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: {
      async classify() {
        calls += 1
        if (calls === 1) await gate
        return classified(true)
      },
    },
    platform: {
      async submit() { return { marker_id: "marker-1" } },
      async claim() { return null },
      async complete() {},
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  const first = worker.tick(1_000)
  for (let attempt = 0; attempt < 20 && calls === 0; attempt += 1) await Promise.resolve()
  const second = worker.tick(1_000)
  await second
  expect(calls).toBe(1)
  release()
  await first
  expect(calls).toBe(1)
})

test("a lost marker response stays retryable and a rejected one does not", async () => {
  registry = new BotRegistry(":memory:")
  completeTurn()
  let submits = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit() {
        submits += 1
        if (submits <= 5) throw new Error("DISTILLATION_PLATFORM_RESPONSE_INVALID")
        return { marker_id: "marker-1" }
      },
      async claim() { return null },
      async complete() {},
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  let at = 1_000
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await worker.tick(at)
    at += 30
  }
  expect(submits).toBe(6)

  registry.close()
  registry = new BotRegistry(":memory:")
  completeTurn()
  submits = 0
  const rejected = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => "owner-token" },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit() {
        submits += 1
        throw new Error("DISTILLATION_PLATFORM_422")
      },
      async claim() { return null },
      async complete() {},
    },
  })
  rejected.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  at = 1_000
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await rejected.tick(at)
    at += 300
  }
  expect(submits).toBe(5)
})

test("the bot profile patch persists and returns the team workspace binding", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("/team-workspaces/workspace-se")) return Response.json({ workspace_id: "workspace-se" })
    if (url.includes("/team-workspaces/")) return Response.json({ code: "TEAM_WORKSPACE_CONTRIBUTOR_REQUIRED" }, { status: 403 })
    return Response.json(principal)
  }) as unknown as typeof fetch
  const app = await createBotApp({ botRegistry: registry })
  try {
    const headers = { authorization: "Bearer token", "content-type": "application/json" }
    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}`,
      headers,
      payload: { expectedRevision: bot.revision, teamWorkspaceId: "workspace-other" },
    })
    expect(rejected.statusCode).toBe(403)
    expect(rejected.json().error).toBe("TEAM_WORKSPACE_CONTRIBUTOR_REQUIRED")
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}`,
      headers,
      payload: { expectedRevision: bot.revision, teamWorkspaceId: "workspace-se" },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().teamWorkspaceId).toBe("workspace-se")
    const profile = await app.inject({ method: "GET", url: `/api/bots/${bot.id}`, headers })
    expect(profile.json().teamWorkspaceId).toBe("workspace-se")
  } finally {
    await app.close()
    globalThis.fetch = originalFetch
  }
})

test("a workspace binding preserves Platform authorization errors and retryable outages", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作" })
  const originalFetch = globalThis.fetch
  let workspaceResponse: () => Promise<Response> = async () => Response.json({ workspace_id: "workspace-se" })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("/v1/identity/session")) return Response.json(principal)
    if (url.includes("/team-workspaces/")) return workspaceResponse()
    return new Response("not found", { status: 404 })
  }) as unknown as typeof fetch
  const app = await createBotApp({ botRegistry: registry })
  const headers = { authorization: "Bearer token", "content-type": "application/json" }
  const patch = () => app.inject({
    method: "PATCH",
    url: `/api/bots/${bot.id}`,
    headers,
    payload: { expectedRevision: bot.revision, teamWorkspaceId: "workspace-se" },
  })
  try {
    workspaceResponse = async () => Response.json({ code: "UNAUTHENTICATED" }, { status: 401 })
    const unauthenticated = await patch()
    expect(unauthenticated.statusCode).toBe(401)
    expect(unauthenticated.json().error).toBe("TEAM_WORKSPACE_UNAUTHENTICATED")

    workspaceResponse = async () => Response.json({ code: "TEAM_WORKSPACE_NOT_FOUND" }, { status: 404 })
    const missing = await patch()
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toBe("TEAM_WORKSPACE_NOT_FOUND")

    workspaceResponse = async () => new Response("unavailable", { status: 503 })
    const unavailable = await patch()
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json().error).toBe("TEAM_WORKSPACE_UNAVAILABLE")

    workspaceResponse = async () => { throw new TypeError("fetch failed") }
    const transportFailure = await patch()
    expect(transportFailure.statusCode).toBe(503)
    expect(transportFailure.json().error).toBe("TEAM_WORKSPACE_UNAVAILABLE")
  } finally {
    await app.close()
    globalThis.fetch = originalFetch
  }
})

test("duplicating a bot keeps its team workspace binding", () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "工作", teamWorkspaceId: "workspace-se" })
  const copy = registry.duplicate(bot.id, principal, "agent-copy")
  expect(copy.teamWorkspaceId).toBe("workspace-se")
  expect(registry.teamWorkspaceId(copy.id)).toBe("workspace-se")
})

test("an expired owner token waits for refreshed authorization without consuming submission attempts", async () => {
  registry = new BotRegistry(":memory:")
  completeTurn()
  let accessToken = "expired-token"
  let submits = 0
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => accessToken },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit(token) {
        submits += 1
        if (token === "expired-token") throw new Error("DISTILLATION_PLATFORM_401")
        expect(token).toBe("refreshed-token")
        return { marker_id: "marker-1" }
      },
      async claim() { return null },
      async complete() {},
    },
  })
  worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
  let at = 1_000
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await worker.tick(at)
    at += 30
  }
  expect(submits).toBe(6)
  expect(registry.db.query("select state, attempts, last_error from bot_distillation_inbox").all()).toEqual([
    { state: "PENDING", attempts: 0, last_error: "DISTILLATION_PLATFORM_401" },
  ])
  accessToken = "refreshed-token"
  await worker.tick(at)
  expect(submits).toBe(7)
  expect(registry.db.query("select state, attempts, marker_id from bot_distillation_inbox").all()).toEqual([
    { state: "SUBMITTED", attempts: 0, marker_id: "marker-1" },
  ])
})

test("forbidden and validation Platform responses remain terminal submission failures", async () => {
  for (const status of [403, 422]) {
    registry?.close()
    registry = new BotRegistry(":memory:")
    completeTurn()
    let submits = 0
    const worker = createDistillationWorker({
      registry,
      now: () => 1_000,
      sessions: { tokenFor: () => "owner-token" },
      classifier: { async classify() { return classified(true) } },
      platform: {
        async submit() {
          submits += 1
          throw new Error(`DISTILLATION_PLATFORM_${status}`)
        },
        async claim() { return null },
        async complete() {},
      },
    })
    worker.note(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-1" } } }))
    let at = 1_000
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await worker.tick(at)
      at += 300
    }
    expect(submits).toBe(5)
    expect(registry.db.query("select state, attempts, last_error from bot_distillation_inbox").all()).toEqual([
      { state: "FAILED", attempts: 5, last_error: `DISTILLATION_PLATFORM_${status}` },
    ])
  }
})

test("an expired owner token retains a pending completion until authorization refreshes", async () => {
  registry = new BotRegistry(":memory:")
  const botId = completeTurn()
  const stored = registry.timeline.storedTurn(botId, "thread", "turn-1")!
  let accessToken = "expired-token"
  const completionTokens: string[] = []
  const worker = createDistillationWorker({
    registry,
    now: () => 1_000,
    sessions: { tokenFor: () => accessToken },
    classifier: { async classify() { return classified(true) } },
    platform: {
      async submit() { throw new Error("should not submit") },
      async claim() { return null },
      async complete(token, _tenant, _markerId, body) {
        completionTokens.push(token)
        expect(body.outcome).toBe("CANDIDATE_CREATED")
        if (token === "expired-token") throw new Error("DISTILLATION_PLATFORM_401")
        expect(token).toBe("refreshed-token")
      },
    },
  })
  registry.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error,
      completion_lease_token, completion_outcome, completion_content_digest)
    values (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, ?, 'marker-1', null, 'lease-1', 'CANDIDATE_CREATED', ?)`).run(
    botId,
    "thread",
    "turn-1",
    sourceRevision("turn-1", stored.revision),
    principal.tenant_id,
    principal.subject_id,
    principal.acting_client_id,
    1_000,
    contentDigest(stored.bodyJson),
  )
  await worker.tick(1_000)
  expect(registry.db.query("select state, completion_lease_token from bot_distillation_inbox").all()).toEqual([
    { state: "SUBMITTED", completion_lease_token: "lease-1" },
  ])
  accessToken = "refreshed-token"
  await worker.tick(1_030)
  expect(completionTokens).toEqual(["expired-token", "refreshed-token"])
  expect(registry.db.query("select state from bot_distillation_inbox").all()).toEqual([{ state: "CANDIDATE" }])
})

test("the decision span carries identifiers and the classifier result, not the excerpt", () => {
  const attributes = distillationDecisionAttributes({
    tenantId: "tenant",
    botId: "bot",
    threadId: "thread",
    turnId: "turn",
    relevant: true,
    scope: "process",
    sensitivity: "standard",
    classifierVersion: "jev-distillation-1",
    outcome: "marker",
  }).map(([key, value]) => `${key}=${value}`).join(" ")
  expect(attributes).toContain("genio.distillation.outcome=marker")
  expect(attributes.includes(canary)).toBe(false)
})
