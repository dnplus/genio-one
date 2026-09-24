import { afterEach, expect, test } from "bun:test"

import {
  DISTILLATION_EXTRACTOR_VERSION,
  LEGACY_DISTILLATION_EXTRACTOR_VERSION,
} from "@genioone/protocol/distillation-triage"

import { createBotApp } from "../app"
import { BotRegistry, type BotRecord } from "../bot-registry"
import { markerContentDigest } from "../distillation/history"
import { createDistillationWorker } from "../distillation/worker"
import type { Turn } from "../generated/v2/Turn"

const owner = { tenant_id: "tenant-a", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
const maintainer = { tenant_id: "tenant-a", subject_id: "workspace-maintainer", acting_client_id: "genio-one-bot", scopes: [] }
const reader = { tenant_id: "tenant-a", subject_id: "workspace-reader", acting_client_id: "genio-one-bot", scopes: [] }
const revoked = { tenant_id: "tenant-a", subject_id: "revoked-maintainer", acting_client_id: "genio-one-bot", scopes: [] }

type Candidate = {
  knowledge_id: string
  tenant_id: string
  marker_id: string
  owner_subject_id: string
  workspace_id: string | null
  scope: string
  knowledge_type: string
  representation: string
  sensitivity: string
  review_state: string
  content_digest: string
  provenance: {
    bot_id: string
    thread_id: string
    turn_ids: string[]
    source_revision: string
    classifier_version: string
    extractor_version: string
    evidence: unknown[]
    excerpt_truncated: boolean
  }
  reviewed_by: string | null
  reviewed_at: number | null
  created_at: number
  updated_at: number
}

let app: Awaited<ReturnType<typeof createBotApp>> | undefined
let registry: BotRegistry | undefined
const originalFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = originalFetch
  await app?.close()
  app = undefined
  registry?.close()
  registry = undefined
})

function turn(id: string, userText: string, assistantText: string, errorMessage?: string): Turn {
  return {
    id,
    itemsView: "full",
    status: "completed",
    error: errorMessage ? { message: errorMessage } : null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    items: [
      { type: "userMessage", id: `${id}-user`, content: [{ type: "text", text: userText }] },
      { type: "agentMessage", id: `${id}-assistant`, text: assistantText },
      {
        type: "mcpToolCall",
        id: `${id}-tool`,
        server: "private-server",
        tool: "read-secret",
        status: "completed",
        arguments: { credential: "tool-input-secret" },
        appContext: null,
        mcpAppResourceUri: undefined,
        pluginId: null,
        readOnlyHint: true,
        result: { content: [{ type: "text", text: "tool-output-secret" }], structuredContent: { secret: "tool-structured-secret" }, _meta: { artifact: "tool-artifact-secret" } },
        error: null,
        durationMs: 1,
      },
    ],
  } as unknown as Turn
}

function candidateFor(bot: BotRecord, turnIds = ["turn-1", "turn-2"]): Candidate {
  const stored = turnIds.map((turnId) => registry!.timeline.storedTurn(bot.id, "thread-1", turnId)!)
  return {
    knowledge_id: "knowledge-1",
    tenant_id: owner.tenant_id,
    marker_id: "marker-1",
    owner_subject_id: owner.subject_id,
    workspace_id: "workspace-1",
    scope: "process",
    knowledge_type: "PROCEDURE",
    representation: "BOTH",
    sensitivity: "standard",
    review_state: "PENDING_REVIEW",
    content_digest: markerContentDigest(stored.map((item) => item.bodyJson)),
    provenance: {
      bot_id: bot.id,
      thread_id: "thread-1",
      turn_ids: turnIds,
      source_revision: "a".repeat(64),
      classifier_version: "jev-distillation-1",
      extractor_version: DISTILLATION_EXTRACTOR_VERSION,
      evidence: [],
      excerpt_truncated: false,
    },
    reviewed_by: null,
    reviewed_at: null,
    created_at: 1,
    updated_at: 1,
  }
}

async function harness() {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(owner, { name: "Evidence Bot", description: "Evidence source" })
  registry.rememberThread(bot.id, "thread-1")
  registry.timeline.putTurn(bot.id, "thread-1", turn("turn-1", "使用者可見請求", "助手可見答案"))
  registry.timeline.putTurn(bot.id, "thread-1", turn("turn-2", "第二個請求", "第二個答案", "turn-error-secret"))
  let candidate = candidateFor(bot)
  const identities = new Map([
    ["owner-token", owner],
    ["maintainer-token", maintainer],
    ["reader-token", reader],
    ["revoked-token", revoked],
  ])
  const reviewCalls: Array<{ token: string; body: BodyInit | null | undefined }> = []
  let reviewContext: (token: string) => Response | Promise<Response> = (_token) => Response.json(candidate)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const authorization = new Headers(init?.headers).get("authorization") ?? ""
    const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : ""
    if (url.includes("/v1/identity/session")) {
      const principal = identities.get(token)
      return principal ? Response.json(principal) : new Response("unauthorized", { status: 401 })
    }
    if (url.includes("/review-context")) {
      reviewCalls.push({ token, body: init?.body })
      return reviewContext(token)
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch
  app = await createBotApp({ botRegistry: registry })
  return {
    bot,
    candidate: () => candidate,
    reviewCalls,
    setCandidate(next: Candidate) { candidate = next },
    setReviewContext(next: (token: string) => Response | Promise<Response>) { reviewContext = next },
  }
}

test("a current workspace Maintainer reads bounded evidence without gaining the owner timeline", async () => {
  const fixture = await harness()
  const response = await app!.inject({
    method: "GET",
    url: "/api/knowledge-candidates/knowledge-1/evidence",
    headers: { authorization: "Bearer maintainer-token" },
  })

  expect(response.statusCode).toBe(200)
  expect(response.headers["cache-control"]).toBe("private, no-store")
  expect(fixture.reviewCalls).toEqual([
    { token: "maintainer-token", body: undefined },
    { token: "maintainer-token", body: undefined },
  ])
  expect(response.json() as unknown).toEqual({
    knowledge_id: "knowledge-1",
    tenant_id: "tenant-a",
    workspace_id: "workspace-1",
    content_digest: fixture.candidate().content_digest,
    turns: [
      { turn_id: "turn-1", text: "使用者可見請求\n助手可見答案", truncated: false },
      { turn_id: "turn-2", text: "第二個請求\n第二個答案", truncated: false },
    ],
  })
  expect(response.body).not.toContain("tool-input-secret")
  expect(response.body).not.toContain("tool-output-secret")
  expect(response.body).not.toContain("tool-structured-secret")
  expect(response.body).not.toContain("tool-artifact-secret")
  expect(response.body).not.toContain("turn-error-secret")

  const timeline = await app!.inject({
    method: "GET",
    url: `/api/bots/${fixture.bot.id}/timeline`,
    headers: { authorization: "Bearer maintainer-token" },
  })
  expect(timeline.statusCode).toBe(404)
})

test("a legacy extractor with an omitted error cannot return review evidence", async () => {
  const fixture = await harness()
  const candidate = fixture.candidate()
  fixture.setCandidate({
    ...candidate,
    provenance: { ...candidate.provenance, extractor_version: LEGACY_DISTILLATION_EXTRACTOR_VERSION },
  })

  const response = await app!.inject({
    method: "GET",
    url: "/api/knowledge-candidates/knowledge-1/evidence",
    headers: { authorization: "Bearer maintainer-token" },
  })

  expect(response.statusCode).toBe(409)
  expect(response.json() as unknown).toEqual({ error: "KNOWLEDGE_EVIDENCE_EXCERPT_CHANGED" })
  expect(response.body).not.toContain("turn-error-secret")
  expect(response.body).not.toContain("使用者可見請求")
})

test("a legacy deleted Bot without an owner locator does not expose retained history", async () => {
  const fixture = await harness()
  createDistillationWorker({
    registry: registry!,
    sessions: { tokenFor: () => null },
    classifier: {
      async classify() {
        return { status: "UNAVAILABLE", classifier_version: "jev-distillation-1" }
      },
    },
    platform: { async submit() { return { marker_id: "marker-1" } }, async claim() { return null }, async complete() {} },
  })
  registry!.db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(fixture.bot.id, "thread-1", "turn-1", "a".repeat(64), owner.tenant_id, owner.subject_id, owner.acting_client_id, "CANDIDATE", 0, 0)
  registry!.db.query("delete from bot_distillation_inbox where bot_id = ?").run(fixture.bot.id)
  registry!.db.query("delete from bots where id = ?").run(fixture.bot.id)
  expect(registry!.db.query("select 1 from bot_evidence_source_tombstones where bot_id = ?").get(fixture.bot.id)).toBeNull()
  expect(registry!.db.query("select 1 from bot_distillation_inbox where bot_id = ?").get(fixture.bot.id)).toBeNull()

  const response = await app!.inject({
    method: "GET",
    url: "/api/knowledge-candidates/knowledge-1/evidence",
    headers: { authorization: "Bearer maintainer-token" },
  })

  expect(response.statusCode).toBe(404)
  expect(response.json() as unknown).toEqual({ error: "KNOWLEDGE_CANDIDATE_NOT_FOUND" })
  expect(response.body).not.toContain("使用者可見請求")
  expect(response.body).not.toContain("turn-error-secret")
})

test("evidence responses are marked sensitive for HTTP telemetry", async () => {
  await harness()
  let sensitiveResponse: boolean | undefined
  app!.addHook("onSend", async (request, _reply, payload) => {
    if (request.routeOptions.url === "/api/knowledge-candidates/:knowledgeId/evidence") {
      sensitiveResponse = (request.routeOptions.config as { sensitiveResponse?: boolean }).sensitiveResponse
    }
    return payload
  })

  const response = await app!.inject({
    method: "GET",
    url: "/api/knowledge-candidates/knowledge-1/evidence",
    headers: { authorization: "Bearer maintainer-token" },
  })

  expect(response.statusCode).toBe(200)
  expect(sensitiveResponse).toBe(true)
})

test("a Platform-denied reader or revoked Maintainer cannot read evidence", async () => {
  const fixture = await harness()
  fixture.setReviewContext(() => Response.json({ code: "KNOWLEDGE_CANDIDATE_MAINTAINER_REQUIRED" }, { status: 403 }))

  for (const token of ["reader-token", "revoked-token"]) {
    const response = await app!.inject({
      method: "GET",
      url: "/api/knowledge-candidates/knowledge-1/evidence",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json() as unknown).toEqual({ error: "KNOWLEDGE_EVIDENCE_FORBIDDEN" })
  }
})

test("a final review-context check rejects candidate movement and revoked workspace access before returning excerpts", async () => {
  const fixture = await harness()
  const initial = fixture.candidate()
  let calls = 0
  fixture.setReviewContext(() => {
    calls += 1
    return calls === 1
      ? Response.json(initial)
      : Response.json({ ...initial, workspace_id: "workspace-moved" })
  })

  const moved = await app!.inject({
    method: "GET",
    url: "/api/knowledge-candidates/knowledge-1/evidence",
    headers: { authorization: "Bearer maintainer-token" },
  })
  expect(calls).toBe(2)
  expect(moved.statusCode).toBe(409)
  expect(moved.json() as unknown).toEqual({ error: "KNOWLEDGE_EVIDENCE_CHANGED" })
  expect(moved.body).not.toContain("使用者可見請求")
  expect(moved.body).not.toContain("助手可見答案")

  calls = 0
  fixture.setReviewContext(() => {
    calls += 1
    return calls === 1
      ? Response.json(initial)
      : Response.json({ code: "KNOWLEDGE_CANDIDATE_MAINTAINER_REQUIRED" }, { status: 403 })
  })

  const revoked = await app!.inject({
    method: "GET",
    url: "/api/knowledge-candidates/knowledge-1/evidence",
    headers: { authorization: "Bearer maintainer-token" },
  })
  expect(calls).toBe(2)
  expect(revoked.statusCode).toBe(403)
  expect(revoked.json() as unknown).toEqual({ error: "KNOWLEDGE_EVIDENCE_FORBIDDEN" })
  expect(revoked.body).not.toContain("使用者可見請求")
  expect(revoked.body).not.toContain("助手可見答案")
})

test("a delayed first review-context exhausts the shared evidence budget before final authorization", async () => {
  const fixture = await harness()
  const originalTimeout = AbortSignal.timeout
  const deadline = new AbortController()
  let calls = 0
  try {
    AbortSignal.timeout = ((timeout) => {
      expect(timeout).toBe(8_000)
      return deadline.signal
    }) as typeof AbortSignal.timeout
    fixture.setReviewContext(async () => {
      calls += 1
      await Promise.resolve()
      deadline.abort()
      return Response.json(fixture.candidate())
    })

    const response = await app!.inject({
      method: "GET",
      url: "/api/knowledge-candidates/knowledge-1/evidence",
      headers: { authorization: "Bearer maintainer-token" },
    })
    expect(calls).toBe(1)
    expect(response.statusCode).toBe(503)
    expect(response.json() as unknown).toEqual({ error: "KNOWLEDGE_EVIDENCE_PLATFORM_UNAVAILABLE" })
    expect(response.body).not.toContain("使用者可見請求")
    expect(response.body).not.toContain("助手可見答案")
  } finally {
    AbortSignal.timeout = originalTimeout
  }
})

test("a stalled session verification uses the shared evidence deadline", async () => {
  const fixture = await harness()
  const originalTimeout = AbortSignal.timeout
  const harnessFetch = globalThis.fetch
  const deadline = new AbortController()
  let timeouts: number[] = []
  try {
    AbortSignal.timeout = ((timeout) => {
      timeouts.push(timeout)
      return deadline.signal
    }) as typeof AbortSignal.timeout
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("/v1/identity/session")) return harnessFetch(input, init)
      expect(init?.signal).toBe(deadline.signal)
      return new Promise<Response>((_resolve, reject) => {
        deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), { once: true })
        queueMicrotask(() => deadline.abort())
      })
    }) as typeof fetch

    const response = await app!.inject({
      method: "GET",
      url: "/api/knowledge-candidates/knowledge-1/evidence",
      headers: { authorization: "Bearer maintainer-token" },
    })
    expect(timeouts).toEqual([8_000])
    expect(fixture.reviewCalls).toEqual([])
    expect(response.statusCode).toBe(503)
    expect(response.json() as unknown).toEqual({ error: "KNOWLEDGE_EVIDENCE_PLATFORM_UNAVAILABLE" })
    expect(response.body).not.toContain("使用者可見請求")
    expect(response.body).not.toContain("助手可見答案")
  } finally {
    globalThis.fetch = harnessFetch
    AbortSignal.timeout = originalTimeout
  }
})

test("Platform authentication races and outages do not expose evidence", async () => {
  const fixture = await harness()
  fixture.setReviewContext(() => Response.json({ code: "UNAUTHENTICATED" }, { status: 401 }))
  const expired = await app!.inject({ method: "GET", url: "/api/knowledge-candidates/knowledge-1/evidence", headers: { authorization: "Bearer maintainer-token" } })
  expect(expired.statusCode).toBe(401)
  expect(expired.json() as unknown).toEqual({ error: "KNOWLEDGE_EVIDENCE_AUTH_REQUIRED" })

  fixture.setReviewContext(async () => { throw new TypeError("fetch failed") })
  const unavailable = await app!.inject({ method: "GET", url: "/api/knowledge-candidates/knowledge-1/evidence", headers: { authorization: "Bearer maintainer-token" } })
  expect(unavailable.statusCode).toBe(503)
  expect(unavailable.json() as unknown).toEqual({ error: "KNOWLEDGE_EVIDENCE_PLATFORM_UNAVAILABLE" })
})

test("a session-service outage is reported as retryable instead of logging the Maintainer out", async () => {
  const fixture = await harness()
  const harnessFetch = globalThis.fetch
  try {
    for (const status of [500, 503, 408, 429]) {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => String(input).includes("/v1/identity/session")
        ? new Response("unavailable", { status })
        : harnessFetch(input, init)) as typeof fetch
      const response = await app!.inject({ method: "GET", url: "/api/knowledge-candidates/knowledge-1/evidence", headers: { authorization: "Bearer maintainer-token" } })
      expect(response.statusCode).toBe(503)
      expect(response.json() as unknown).toEqual({ error: "KNOWLEDGE_EVIDENCE_PLATFORM_UNAVAILABLE" })
    }
    // A scope rejection is a real authentication failure, unlike throttling or timeouts above.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => String(input).includes("/v1/identity/session")
      ? new Response("forbidden", { status: 403 })
      : harnessFetch(input, init)) as typeof fetch
    const forbidden = await app!.inject({ method: "GET", url: "/api/knowledge-candidates/knowledge-1/evidence", headers: { authorization: "Bearer maintainer-token" } })
    expect(forbidden.statusCode).toBe(401)
    expect(forbidden.json() as unknown).toEqual({ error: "KNOWLEDGE_EVIDENCE_AUTH_REQUIRED" })
    expect(fixture.reviewCalls).toEqual([])
  } finally {
    globalThis.fetch = harnessFetch
  }
  const rejected = await app!.inject({ method: "GET", url: "/api/knowledge-candidates/knowledge-1/evidence", headers: { authorization: "Bearer unknown-token" } })
  expect(rejected.statusCode).toBe(401)
  expect(rejected.json() as unknown).toEqual({ error: "KNOWLEDGE_EVIDENCE_AUTH_REQUIRED" })
})

test("candidate identity must match the local Bot tenant, owner, and provenance Bot", async () => {
  const fixture = await harness()
  const current = fixture.candidate()
  const variants = [
    { ...current, tenant_id: "tenant-b" },
    { ...current, owner_subject_id: "other-owner" },
    { ...current, provenance: { ...current.provenance, bot_id: "bot-other" } },
  ]

  for (const candidate of variants) {
    fixture.setCandidate(candidate)
    const response = await app!.inject({
      method: "GET",
      url: "/api/knowledge-candidates/knowledge-1/evidence",
      headers: { authorization: "Bearer maintainer-token" },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json() as unknown).toEqual({ error: "KNOWLEDGE_CANDIDATE_NOT_FOUND" })
  }
})

test("missing turns, incomplete summaries, and changed digests fail without returning evidence", async () => {
  const fixture = await harness()
  const current = fixture.candidate()
  fixture.setCandidate({ ...current, provenance: { ...current.provenance, turn_ids: ["missing-turn"] } })
  const missing = await app!.inject({ method: "GET", url: "/api/knowledge-candidates/knowledge-1/evidence", headers: { authorization: "Bearer maintainer-token" } })
  expect(missing.statusCode).toBe(404)

  const stored = registry!.timeline.storedTurn(fixture.bot.id, "thread-1", "turn-1")!
  registry!.timeline.putTurn(fixture.bot.id, "thread-1", { ...stored.turn, itemsView: "summary", items: [] })
  fixture.setCandidate(candidateFor(fixture.bot, ["turn-1"]))
  const summary = await app!.inject({ method: "GET", url: "/api/knowledge-candidates/knowledge-1/evidence", headers: { authorization: "Bearer maintainer-token" } })
  expect(summary.statusCode).toBe(503)
  expect(summary.json() as unknown).toEqual({ error: "KNOWLEDGE_EVIDENCE_HISTORY_INCOMPLETE" })

  registry!.timeline.putTurn(fixture.bot.id, "thread-1", turn("turn-1", "使用者可見請求", "助手可見答案"))
  fixture.setCandidate({ ...candidateFor(fixture.bot, ["turn-1"]), content_digest: "f".repeat(64) })
  const changed = await app!.inject({ method: "GET", url: "/api/knowledge-candidates/knowledge-1/evidence", headers: { authorization: "Bearer maintainer-token" } })
  expect(changed.statusCode).toBe(409)
  expect(changed.json() as unknown).toEqual({ error: "KNOWLEDGE_EVIDENCE_DIGEST_CHANGED" })
})

test("archiving a Bot does not hide evidence retained for a current workspace Maintainer", async () => {
  const fixture = await harness()
  registry!.db.query("update bots set archived = 1 where id = ?").run(fixture.bot.id)

  const response = await app!.inject({
    method: "GET",
    url: "/api/knowledge-candidates/knowledge-1/evidence",
    headers: { authorization: "Bearer maintainer-token" },
  })
  expect(response.statusCode).toBe(200)
})

test("hard deletion retains only a verified candidate evidence source", async () => {
  const fixture = await harness()
  const onlyFirstTurn = candidateFor(fixture.bot, ["turn-1"])
  fixture.setCandidate(onlyFirstTurn)

  expect(registry!.delete(fixture.bot.id, owner)).toBeTrue()
  expect(registry!.getOwned(fixture.bot.id, owner)).toBeNull()
  const tombstone = registry!.db.query("select * from bot_evidence_source_tombstones where bot_id = ?").get(fixture.bot.id) as Record<string, unknown>
  expect(Object.keys(tombstone).sort()).toEqual(["bot_id", "deleted_at", "owner_subject_id", "tenant_id"])
  expect(tombstone).toMatchObject({ bot_id: fixture.bot.id, tenant_id: owner.tenant_id, owner_subject_id: owner.subject_id, deleted_at: expect.any(Number) })

  const retained = await app!.inject({
    method: "GET",
    url: "/api/knowledge-candidates/knowledge-1/evidence",
    headers: { authorization: "Bearer maintainer-token" },
  })
  expect(retained.statusCode).toBe(200)
  expect(retained.json() as unknown).toEqual({
    knowledge_id: "knowledge-1",
    tenant_id: "tenant-a",
    workspace_id: "workspace-1",
    content_digest: onlyFirstTurn.content_digest,
    turns: [{ turn_id: "turn-1", text: "使用者可見請求\n助手可見答案", truncated: false }],
  })

  const rejected = [
    { ...onlyFirstTurn, tenant_id: "tenant-b" },
    { ...onlyFirstTurn, owner_subject_id: "other-owner" },
    { ...onlyFirstTurn, content_digest: "f".repeat(64) },
  ]
  for (const candidate of rejected) {
    fixture.setCandidate(candidate)
    const response = await app!.inject({
      method: "GET",
      url: "/api/knowledge-candidates/knowledge-1/evidence",
      headers: { authorization: "Bearer maintainer-token" },
    })
    expect(response.statusCode).toBe(candidate.content_digest === onlyFirstTurn.content_digest ? 404 : 409)
  }
})

test("a legacy extractor can expose evidence when visible text already exhausts its excerpt", async () => {
  const fixture = await harness()
  const longText = "可見內容".repeat(20_000)
  registry!.timeline.putTurn(fixture.bot.id, "thread-1", turn("long-turn", longText, "完成", "legacy-error-secret"))
  const candidate = candidateFor(fixture.bot, ["long-turn"])
  fixture.setCandidate({
    ...candidate,
    provenance: { ...candidate.provenance, extractor_version: LEGACY_DISTILLATION_EXTRACTOR_VERSION },
  })

  const response = await app!.inject({
    method: "GET",
    url: "/api/knowledge-candidates/knowledge-1/evidence",
    headers: { authorization: "Bearer maintainer-token" },
  })
  expect(response.statusCode).toBe(200)
  const body = response.json() as unknown as { turns: Array<{ text: string; truncated: boolean }> }
  expect(body.turns).toHaveLength(1)
  expect(body.turns[0]!.truncated).toBe(true)
  expect(body.turns[0]!.text.length).toBeLessThan(longText.length)
  expect(response.body).not.toContain("legacy-error-secret")
})
