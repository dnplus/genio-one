import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createObservationOutbox, type ObservationRecord } from "./observation-outbox"
import { startObservationRelay } from "./server"

const limit = 262_144

async function relayFixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), "gateway-relay-test-"))
  const outbox = await createObservationOutbox({ stateRoot, send: async () => 202 })
  const accepted: ObservationRecord[] = []
  const server = startObservationRelay(
    { observationPort: 0 } as Parameters<typeof startObservationRelay>[0],
    { headers: async () => ({}) },
    outbox,
    async (path, body, correlationId) => {
      const record = { path, body, correlation_id: correlationId ?? null }
      accepted.push(record)
      return record
    },
  )
  return {
    server,
    accepted,
    async close() {
      await server.stop(true)
      await outbox.stop()
      await rm(stateRoot, { recursive: true, force: true })
    },
  }
}

describe("觀測轉送請求大小限制", () => {
  for (const path of ["/activities", "/audit-events", "/accounting"] as const) {
    test(`${path} 超界時取消串流且不讀取剩餘內容`, async () => {
      const fixture = await relayFixture()
      let reads = 0
      let cancelled = false
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          reads += 1
          controller.enqueue(new Uint8Array(65_536))
          if (reads === 64) controller.close()
        },
        cancel() { cancelled = true },
      }, { highWaterMark: 0 })
      try {
        const request = new Request(`http://127.0.0.1${path}`, { method: "POST", body: stream })
        expect(request.headers.has("content-length")).toBe(false)
        const response = await fixture.server.fetch(request)
        expect(response.status).toBe(413)
        await request.body?.cancel()
        expect(cancelled).toBe(true)
        expect(reads).toBeLessThanOrEqual(6)
        expect(fixture.accepted).toHaveLength(0)
      } finally {
        await fixture.close()
      }
    })

    for (const size of [32, limit]) {
      test(`${path} 透過 loopback HTTP 接受 ${size} bytes`, async () => {
        const fixture = await relayFixture()
        const value = "界".repeat(Math.floor((size - 2) / 3))
        const payload = JSON.stringify(value) + " ".repeat((size - 2) % 3)
        try {
          const encoded = new TextEncoder().encode(payload)
          expect(encoded.byteLength).toBe(size)
          const response = await fetch(new URL(path, fixture.server.url), {
            method: "POST",
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoded.subarray(0, 13))
                controller.enqueue(encoded.subarray(13))
                controller.close()
              },
            }),
          })
          expect(response.status).toBe(202)
          expect(fixture.accepted).toEqual([{ path, body: JSON.parse(payload), correlation_id: null }])
        } finally {
          await fixture.close()
        }
      })
    }
  }
})
import { fetchRelease, pollCommand } from "./server"

const tokens = { headers: async () => ({}) } as Parameters<typeof pollCommand>[1]
const command = {
  command_id: "command-1",
  desired_release: { release_id: "release-1" },
} as Parameters<typeof fetchRelease>[2]

async function expectCancelled(pending: Promise<unknown>) {
  expect(await Promise.race([
    pending.then(() => "completed", () => "aborted"),
    Bun.sleep(500).then(() => "waiting"),
  ])).toBe("aborted")
}

function fixture(status = 200) {
  let chunks = 0
  let polls = 0
  const intervals = new Set<ReturnType<typeof setInterval>>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      polls += 1
      if (new URL(request.url).pathname.endsWith("/next") && polls > 1) {
        return Response.json(null)
      }
      let interval: ReturnType<typeof setInterval>
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("["))
          interval = setInterval(() => {
            chunks += 1
            controller.enqueue(new TextEncoder().encode(" "))
          }, 5)
          intervals.add(interval)
        },
        cancel() {
          clearInterval(interval)
          intervals.delete(interval)
        },
      }), { status })
    },
  })
  return {
    config: {
      platformOrigin: server.url.origin,
      tenantId: "tenant-1",
      runtimeId: "runtime-1",
      controlPlaneTimeoutMs: 100,
    } as Parameters<typeof pollCommand>[0],
    chunks: () => chunks,
    async close() {
      for (const interval of intervals) clearInterval(interval)
      await server.stop(true)
    },
  }
}

describe("控制平面請求總期限", () => {
  for (const status of [200, 503]) {
    test(`command 持續傳輸的 ${status} body 逾時後可繼續輪詢`, async () => {
      const context = fixture(status)
      try {
        await expectCancelled(pollCommand(context.config, tokens))
        expect(context.chunks()).toBeGreaterThan(1)
        expect(await pollCommand(context.config, tokens)).toBeNull()
      } finally {
        await context.close()
      }
    }, 2_000)
  }

  test("release 持續傳輸的 body 仍會逾時", async () => {
    const context = fixture()
    try {
      await expectCancelled(fetchRelease(context.config, tokens, command))
      expect(context.chunks()).toBeGreaterThan(1)
      expect(await pollCommand(context.config, tokens)).toBeNull()
    } finally {
      await context.close()
    }
  }, 2_000)

  for (const operation of [pollCommand, (config: Parameters<typeof pollCommand>[0], source: typeof tokens) => fetchRelease(config, source, command)]) {
    test("shutdown 取消尚未讀完的控制平面 body", async () => {
      const context = fixture()
      const shutdown = new AbortController()
      context.config.shutdownSignal = shutdown.signal
      context.config.controlPlaneTimeoutMs = 10_000
      const pending = operation(context.config, tokens)
      const abort = setTimeout(() => shutdown.abort(), 50)
      try {
        await expectCancelled(pending)
        expect(context.chunks()).toBeGreaterThan(1)
      } finally {
        clearTimeout(abort)
        await context.close()
      }
    }, 2_000)
  }
})
import { connectionHealthHostAllowed } from "./server"

describe("connectionHealthHostAllowed", () => {
  const originalEnv = process.env.GENIO_ONE_CONNECTION_HEALTH_ALLOWED_HOSTS

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GENIO_ONE_CONNECTION_HEALTH_ALLOWED_HOSTS
    } else {
      process.env.GENIO_ONE_CONNECTION_HEALTH_ALLOWED_HOSTS = originalEnv
    }
  })

  test("allows default loopback endpoints", () => {
    expect(connectionHealthHostAllowed("http://127.0.0.1:8080/health")).toBe(true)
    expect(connectionHealthHostAllowed("https://localhost/healthz")).toBe(true)
    expect(connectionHealthHostAllowed("http://[::1]:9090/status")).toBe(true)
  })

  test("allows explicitly configured allowed hosts", () => {
    process.env.GENIO_ONE_CONNECTION_HEALTH_ALLOWED_HOSTS = "internal-service.local, api.example.com"
    expect(connectionHealthHostAllowed("http://internal-service.local/health")).toBe(true)
    expect(connectionHealthHostAllowed("https://api.example.com/health")).toBe(true)
  })

  test("rejects disallowed hosts", () => {
    process.env.GENIO_ONE_CONNECTION_HEALTH_ALLOWED_HOSTS = "internal-service.local"
    expect(connectionHealthHostAllowed("http://attacker.com/health")).toBe(false)
    expect(connectionHealthHostAllowed("http://162.242.211.1/health")).toBe(false)
  })

  test("rejects URLs with userinfo credentials", () => {
    expect(connectionHealthHostAllowed("http://user:pass@127.0.0.1/health")).toBe(false)
    expect(connectionHealthHostAllowed("http://admin@localhost/health")).toBe(false)
  })

  test("rejects URLs with search query parameters or fragments", () => {
    expect(connectionHealthHostAllowed("http://127.0.0.1/health?query=1")).toBe(false)
    expect(connectionHealthHostAllowed("http://127.0.0.1/health#fragment")).toBe(false)
  })

  test("rejects non-http/https protocols and malformed URLs", () => {
    expect(connectionHealthHostAllowed("file:///etc/passwd")).toBe(false)
    expect(connectionHealthHostAllowed("ftp://127.0.0.1/health")).toBe(false)
    expect(connectionHealthHostAllowed("not a url")).toBe(false)
  })
})

for (const allowedHost of ["[::1]", "::1", "[fd00::1]", "fd00::1"]) {
  test(`connection health accepts IPv6 allowlist hostname ${allowedHost}`, () => {
    const original = process.env.GENIO_ONE_CONNECTION_HEALTH_ALLOWED_HOSTS
    try {
      process.env.GENIO_ONE_CONNECTION_HEALTH_ALLOWED_HOSTS = ` ${allowedHost} `
      expect(connectionHealthHostAllowed("http://[::1]:8080/health")).toBe(true)
      expect(connectionHealthHostAllowed("http://[fd00::1]:8080/health")).toBe(allowedHost.includes("fd00"))
      expect(connectionHealthHostAllowed("http://[fd00::2]:8080/health")).toBe(false)
      expect(connectionHealthHostAllowed("http://user:pass@[fd00::1]:8080/health")).toBe(false)
      expect(connectionHealthHostAllowed("ftp://[fd00::1]/health")).toBe(false)
    } finally {
      if (original === undefined) delete process.env.GENIO_ONE_CONNECTION_HEALTH_ALLOWED_HOSTS
      else process.env.GENIO_ONE_CONNECTION_HEALTH_ALLOWED_HOSTS = original
    }
  })
}
