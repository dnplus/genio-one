import { expect, test } from "bun:test"

import { BotConnectionInteractions } from "./bot-connection-interactions"
import { botToolText } from "./bot-tool-contract"

const principal = { tenant_id: "tenant", subject_id: "person", acting_client_id: "genio-one-bot", scopes: [] }

test("delivers a personal connection request only to its source runtime and resumes after platform confirmation", async () => {
  const interactions = new BotConnectionInteractions()
  const delivered: unknown[] = []
  interactions.subscribe({ principal, botId: "source", runtimeSessionId: "runtime-source", send: (request) => delivered.push(request) })
  interactions.subscribe({ principal, botId: "source", runtimeSessionId: "runtime-other", send: (request) => delivered.push({ other: request }) })
  let retries = 0
  const pending = interactions.begin({
    principal,
    runtimeSessionId: "runtime-source",
    botId: "source",
    targetBotId: "target",
    threadId: "thread",
    resourceId: "notion",
    resourceName: "Notion",
    capabilityId: "notion.write",
    reason: "connection_required",
    resume: { tool: "add_enterprise_resource", arguments: { botId: "target", resourceId: "notion", capabilityId: "notion.write" } },
    retry: async () => {
      retries += 1
      return botToolText({ addState: "INSTALLED" })
    },
  })
  expect(delivered).toHaveLength(1)
  const request = delivered[0] as { requestToken: string; botId: string; targetBotId: string; threadId: string }
  expect(request).toMatchObject({ botId: "source", targetBotId: "target", threadId: "thread" })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json([{ connection_id: "connection", status: "CONNECTED" }])) as unknown as typeof fetch
  try {
    const completed = await interactions.complete({
      principal,
      runtimeSessionId: "runtime-source",
      requestToken: request.requestToken,
      botId: "source",
      threadId: "thread",
      resourceId: "notion",
      connectionId: "connection",
      status: "CONNECTED",
      accessToken: "access-token",
    })
    expect(completed).toEqual(botToolText({ addState: "INSTALLED" }))
    expect(await pending.wait).toEqual(completed)
    expect(retries).toBe(1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("rejects a completion from another runtime or an unconnected account", async () => {
  const interactions = new BotConnectionInteractions()
  const pending = interactions.begin({
    principal,
    runtimeSessionId: "runtime-source",
    botId: "source",
    targetBotId: "target",
    threadId: "thread",
    resourceId: "mail",
    resourceName: "Mail",
    capabilityId: "mail.read",
    reason: "connection_required",
    resume: { tool: "add_enterprise_resource", arguments: { botId: "target", resourceId: "mail", capabilityId: "mail.read" } },
    retry: async () => botToolText({ addState: "INSTALLED" }),
  })
  await expect(interactions.complete({
    principal,
    runtimeSessionId: "runtime-other",
    requestToken: pending.request.requestToken,
    botId: "source",
    threadId: "thread",
    resourceId: "mail",
    connectionId: "connection",
    status: "CONNECTED",
    accessToken: "access-token",
  })).rejects.toThrow("BOT_CONNECTION_REQUEST_FORBIDDEN")
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json([{ connection_id: "connection", status: "NEEDS_CONNECTION" }])) as unknown as typeof fetch
  try {
    await expect(interactions.complete({
      principal,
      runtimeSessionId: "runtime-source",
      requestToken: pending.request.requestToken,
      botId: "source",
      threadId: "thread",
      resourceId: "mail",
      connectionId: "connection",
      status: "CONNECTED",
      accessToken: "access-token",
    })).rejects.toThrow("BOT_CONNECTION_NOT_CONNECTED")
  } finally {
    globalThis.fetch = originalFetch
  }
  interactions.cancel({ principal, runtimeSessionId: "runtime-source", requestToken: pending.request.requestToken, botId: "source", threadId: "thread" })
  await expect(pending.wait).rejects.toThrow("BOT_CONNECTION_REQUEST_CANCELLED")
})

test("accepts a saved password credential but never accepts a saved OAuth credential", async () => {
  const interactions = new BotConnectionInteractions()
  const password = interactions.begin({
    principal,
    runtimeSessionId: "runtime-source",
    botId: "source",
    targetBotId: "target",
    threadId: "thread-password",
    resourceId: "mail",
    resourceName: "Mail",
    capabilityId: "mail.read",
    reason: "connection_required",
    resume: { tool: "add_enterprise_resource", arguments: { botId: "target", resourceId: "mail", capabilityId: "mail.read" } },
    retry: async () => botToolText({ addState: "INSTALLED" }),
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json([{ connection_id: "password", authentication: "PASSWORD", status: "SAVED" }])) as unknown as typeof fetch
  try {
    const completed = await interactions.complete({
      principal,
      runtimeSessionId: "runtime-source",
      requestToken: password.request.requestToken,
      botId: "source",
      threadId: "thread-password",
      resourceId: "mail",
      connectionId: "password",
      status: "SAVED",
      accessToken: "access-token",
    })
    expect(completed).toEqual(botToolText({ addState: "INSTALLED", connectionState: "SAVED", credentialSavedUnverified: true }))
    expect(await password.wait).toEqual(completed)
  } finally {
    globalThis.fetch = originalFetch
  }

  const oauth = interactions.begin({
    principal,
    runtimeSessionId: "runtime-source",
    botId: "source",
    targetBotId: "target",
    threadId: "thread-oauth",
    resourceId: "mail",
    resourceName: "Mail",
    capabilityId: "mail.read",
    reason: "connection_required",
    resume: { tool: "add_enterprise_resource", arguments: { botId: "target", resourceId: "mail", capabilityId: "mail.read" } },
    retry: async () => botToolText({ addState: "INSTALLED" }),
  })
  globalThis.fetch = (async () => Response.json([{ connection_id: "oauth", authentication: "OAUTH", status: "SAVED" }])) as unknown as typeof fetch
  try {
    await expect(interactions.complete({
      principal,
      runtimeSessionId: "runtime-source",
      requestToken: oauth.request.requestToken,
      botId: "source",
      threadId: "thread-oauth",
      resourceId: "mail",
      connectionId: "oauth",
      status: "SAVED",
      accessToken: "access-token",
    })).rejects.toThrow("BOT_CONNECTION_NOT_CONNECTED")
  } finally {
    globalThis.fetch = originalFetch
  }
  interactions.cancel({ principal, runtimeSessionId: "runtime-source", requestToken: oauth.request.requestToken, botId: "source", threadId: "thread-oauth" })
  await expect(oauth.wait).rejects.toThrow("BOT_CONNECTION_REQUEST_CANCELLED")
})

test("does not retry after the request is cancelled while connection verification is in flight", async () => {
  const interactions = new BotConnectionInteractions()
  let retries = 0
  const pending = interactions.begin({
    principal,
    runtimeSessionId: "runtime-source",
    botId: "source",
    targetBotId: "target",
    threadId: "thread",
    resourceId: "mail",
    resourceName: "Mail",
    capabilityId: "mail.read",
    reason: "connection_required",
    resume: { tool: "add_enterprise_resource", arguments: { botId: "target", resourceId: "mail", capabilityId: "mail.read" } },
    retry: async () => {
      retries += 1
      return botToolText({ addState: "INSTALLED" })
    },
  })
  let startVerification!: () => void
  const verificationStarted = new Promise<void>((resolve) => { startVerification = resolve })
  let resolveFetch!: (response: Response) => void
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() => new Promise<Response>((resolve) => {
    resolveFetch = resolve
    startVerification()
  })) as unknown as typeof fetch
  const completion = interactions.complete({
    principal,
    runtimeSessionId: "runtime-source",
    requestToken: pending.request.requestToken,
    botId: "source",
    threadId: "thread",
    resourceId: "mail",
    connectionId: "connection",
    status: "CONNECTED",
    accessToken: "access-token",
  })
  await verificationStarted
  const wait = pending.wait.catch((error) => error)
  interactions.cancel({ principal, runtimeSessionId: "runtime-source", requestToken: pending.request.requestToken, botId: "source", threadId: "thread" })
  resolveFetch(Response.json([{ connection_id: "connection", status: "CONNECTED" }]))
  try {
    await expect(completion).rejects.toThrow("BOT_CONNECTION_REQUEST_CANCELLED")
    expect(await wait).toEqual(expect.objectContaining({ message: "BOT_CONNECTION_REQUEST_CANCELLED" }))
    expect(retries).toBe(0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("claims a verified request before retry so parallel completions cannot execute it twice", async () => {
  const interactions = new BotConnectionInteractions()
  let retries = 0
  let startRetry!: () => void
  const retryStarted = new Promise<void>((resolve) => { startRetry = resolve })
  let resolveRetry!: (response: ReturnType<typeof botToolText>) => void
  const retryResult = new Promise<ReturnType<typeof botToolText>>((resolve) => { resolveRetry = resolve })
  const pending = interactions.begin({
    principal,
    runtimeSessionId: "runtime-source",
    botId: "source",
    targetBotId: "target",
    threadId: "thread",
    resourceId: "mail",
    resourceName: "Mail",
    capabilityId: "mail.read",
    reason: "connection_required",
    resume: { tool: "add_enterprise_resource", arguments: { botId: "target", resourceId: "mail", capabilityId: "mail.read" } },
    retry: async () => {
      retries += 1
      startRetry()
      return retryResult
    },
  })
  const verifications: Array<(response: Response) => void> = []
  let startVerifications!: () => void
  const verificationsStarted = new Promise<void>((resolve) => { startVerifications = resolve })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() => new Promise<Response>((resolve) => {
    verifications.push(resolve)
    if (verifications.length === 2) startVerifications()
  })) as unknown as typeof fetch
  const input = {
    principal,
    runtimeSessionId: "runtime-source",
    requestToken: pending.request.requestToken,
    botId: "source",
    threadId: "thread",
    resourceId: "mail",
    connectionId: "connection",
    status: "CONNECTED",
    accessToken: "access-token",
  }
  const first = interactions.complete(input)
  const second = interactions.complete(input)
  await verificationsStarted
  verifications[0]!(Response.json([{ connection_id: "connection", status: "CONNECTED" }]))
  await retryStarted
  verifications[1]!(Response.json([{ connection_id: "connection", status: "CONNECTED" }]))
  try {
    await expect(second).rejects.toThrow("BOT_CONNECTION_REQUEST_BUSY")
    resolveRetry(botToolText({ addState: "INSTALLED" }))
    await expect(first).resolves.toEqual(botToolText({ addState: "INSTALLED" }))
    await expect(pending.wait).resolves.toEqual(botToolText({ addState: "INSTALLED" }))
    expect(retries).toBe(1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

function beginMail(interactions: BotConnectionInteractions, threadId = "thread") {
  return interactions.begin({
    principal,
    runtimeSessionId: "runtime-source",
    botId: "source",
    targetBotId: "target",
    threadId,
    resourceId: "mail",
    resourceName: "Mail",
    capabilityId: "mail.read",
    reason: "connection_required",
    resume: { tool: "add_enterprise_resource", arguments: { botId: "target", resourceId: "mail", capabilityId: "mail.read" } },
    retry: async () => botToolText({ addState: "INSTALLED" }),
  })
}

test("tells the source browser when a slow OAuth setup outlives the wait window so the card does not stay stuck", async () => {
  const interactions = new BotConnectionInteractions(5)
  const expired: unknown[] = []
  interactions.subscribe({ principal, botId: "source", runtimeSessionId: "runtime-source", send: () => {}, expire: (request) => expired.push(request) })
  interactions.subscribe({ principal, botId: "source", runtimeSessionId: "runtime-other", send: () => {}, expire: (request) => expired.push({ other: request }) })
  const pending = beginMail(interactions)
  await expect(pending.wait).rejects.toThrow("BOT_CONNECTION_REQUEST_EXPIRED")
  expect(expired).toEqual([expect.objectContaining({ requestToken: pending.request.requestToken, botId: "source", threadId: "thread" })])
  expect(() => interactions.cancel({ principal, runtimeSessionId: "runtime-source", requestToken: pending.request.requestToken, botId: "source", threadId: "thread" })).toThrow("BOT_CONNECTION_REQUEST_EXPIRED")
})

test("lists waiting connection requests per thread so pending reloads can recreate the card", async () => {
  const interactions = new BotConnectionInteractions()
  const current = beginMail(interactions, "thread")
  const otherThread = beginMail(interactions, "thread-other")
  expect(interactions.pendingRequests({ principal, botId: "source", runtimeSessionId: "runtime-source", threadId: "thread" }).map((request) => request.requestToken)).toEqual([current.request.requestToken])
  expect(interactions.pendingRequests({ principal, botId: "source", runtimeSessionId: "runtime-other", threadId: "thread" })).toEqual([])
  expect(interactions.pendingRequests({ principal: { ...principal, subject_id: "someone-else" }, botId: "source", runtimeSessionId: "runtime-source", threadId: "thread" })).toEqual([])
  interactions.cancel({ principal, runtimeSessionId: "runtime-source", requestToken: current.request.requestToken, botId: "source", threadId: "thread" })
  interactions.cancel({ principal, runtimeSessionId: "runtime-source", requestToken: otherThread.request.requestToken, botId: "source", threadId: "thread-other" })
  await expect(current.wait).rejects.toThrow("BOT_CONNECTION_REQUEST_CANCELLED")
  await expect(otherThread.wait).rejects.toThrow("BOT_CONNECTION_REQUEST_CANCELLED")
  expect(interactions.pendingRequests({ principal, botId: "source", runtimeSessionId: "runtime-source", threadId: "thread" })).toEqual([])
})
