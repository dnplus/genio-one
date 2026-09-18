import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OtlpOutbox } from "./otlp-outbox"

test("outbox survives offline restart, replays every signal and removes acknowledged records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otel-outbox-"))
  let clock = 10000
  const events: any[] = []
  let online = false
  const received: any[] = []
  const send = (async (url: string, init: RequestInit) => { if (!online) throw new Error("offline"); received.push({ url, body: JSON.parse(String(init?.body)) }); return new Response("{}") })
  let box = new OtlpOutbox({ directory, origin: "http://collector.test", send, now: () => clock, report: value => events.push(value) })
  try {
    for (const signal of ["traces", "logs", "metrics"] as const) box.enqueue(signal, { evidence: signal })
    await box.flush()
    assert.equal((await readdir(directory)).filter(name => name.endsWith(".json")).length, 3)
    assert.ok(events.some(event => event.event === "otel.outbox.retry"))
    await box.close()
    clock += 2000
    online = true
    box = new OtlpOutbox({ directory, origin: "http://collector.test", send, now: () => clock })
    await box.flush()
    assert.equal(received.length, 3)
    assert.deepEqual(new Set(received.map(value => value.body.evidence)), new Set(["traces", "logs", "metrics"]))
    assert.equal((await readdir(directory)).length, 0)
  } finally { await box.close(); await rm(directory, { recursive: true, force: true }) }
})

test("outbox cleans expired, capacity and corrupt records and reports losses without blocking producers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otel-outbox-"))
  const events: any[] = []
  await writeFile(join(directory, "1000-aaaa.json"), JSON.stringify({ signal: "logs", body: {} }))
  await writeFile(join(directory, "9999-bbbb.json"), "broken")
  const box = new OtlpOutbox({ directory, origin: "http://collector.test", now: () => 10000, maxAgeMs: 1000, maxFiles: 1, maxPendingBytes: 1000, send: (async () => { throw new Error("offline") }), report: event => events.push(event) })
  try {
    await box.flush()
    box.enqueue("logs", { oversized: "x".repeat(1001) })
    box.enqueue("logs", { item: 1 })
    box.enqueue("logs", { item: 2 })
    await box.flush()
    assert.equal((await readdir(directory)).length, 1)
    for (const reason of ["expired", "corrupt_record", "disk_capacity", "memory_capacity"]) assert.ok(events.some(event => event.reason === reason), reason)
  } finally { await box.close(); await rm(directory, { recursive: true, force: true }) }
})

test("OTLP partial success is terminal, reports rejected data and does not duplicate the accepted subset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otel-outbox-"))
  const events: any[] = []
  let attempts = 0
  const box = new OtlpOutbox({ directory, origin: "http://collector.test", send: (async () => { attempts++; return Response.json({ partialSuccess: { rejectedSpans: "1" } }) }), report: event => events.push(event) })
  try {
    box.enqueue("traces", { resourceSpans: [] })
    await box.flush()
    await box.flush()
    assert.equal(attempts, 1)
    assert.equal((await readdir(directory)).length, 0)
    assert.ok(events.some(event => event.reason === "collector_partial_rejection"))
  } finally { await box.close(); await rm(directory, { recursive: true, force: true }) }
})

test("slow delivery does not block persistence and concurrent consumers do not duplicate a batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otel-outbox-"))
  let release!: () => void
  let started!: () => void
  const sending = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let attempts = 0
  const send = async () => { attempts++; started(); await gate; return Response.json({}) }
  const first = new OtlpOutbox({ directory, origin: "http://collector.test", send })
  const second = new OtlpOutbox({ directory, origin: "http://collector.test", send })
  try {
    assert.equal(await first.enqueue("logs", { item: 1 }), true)
    const drain = first.flush()
    await sending
    assert.equal(await Promise.race([first.enqueue("metrics", { item: 2 }), new Promise(resolve => setTimeout(() => resolve("blocked"), 250))]), true)
    await second.flush()
    assert.equal(attempts, 1)
    release()
    await drain
    await first.flush()
    assert.equal(attempts, 2)
  } finally { release(); await first.close(); await second.close(); await rm(directory, { recursive: true, force: true }) }
})

test("storage failure is reported without throwing into a producer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otel-outbox-"))
  const file = join(directory, "not-a-directory")
  await writeFile(file, "occupied")
  const events: any[] = []
  const box = new OtlpOutbox({ directory: file, origin: "http://collector.test", report: event => events.push(event) })
  try {
    assert.equal(await box.enqueue("logs", { item: 1 }), false)
    assert.ok(events.some(event => event.reason === "storage_write"))
  } finally { await box.close(); await rm(directory, { recursive: true, force: true }) }
})

test("full telemetry bursts are batched without losing individual records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otel-outbox-"))
  const received: number[] = []
  let requests = 0
  const box = new OtlpOutbox({ directory, origin: "http://collector.test", send: async (_url, init) => {
    requests++
    received.push(...JSON.parse(String(init.body)).resourceSpans.map((value: { id: number }) => value.id))
    return Response.json({})
  } })
  try {
    await Promise.all(Array.from({ length: 2000 }, (_, id) => box.enqueue("traces", { resourceSpans: [{ id }] })))
    await box.flush()
    assert.equal(new Set(received).size, 2000)
    assert.equal(received.length, 2000)
    assert.ok(requests < 25, `requests=${requests}`)
  } finally { await box.close(); await rm(directory, { recursive: true, force: true }) }
})

test("stale delivery leases recover even when a watcher reuses the same process ID", async () => {
  const { utimes } = await import("node:fs/promises")
  const { hostname } = await import("node:os")
  const directory = await mkdtemp(join(tmpdir(), "otel-outbox-"))
  const lock = join(directory, ".lock")
  await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname() }))
  await utimes(lock, new Date(0), new Date(0))
  let received = 0
  const box = new OtlpOutbox({ directory, origin: "http://collector.test", send: async () => { received++; return Response.json({}) } })
  try {
    await box.enqueue("logs", { resourceLogs: [{ id: 1 }] })
    await box.flush()
    await box.flush()
    assert.equal(received, 1)
  } finally { await box.close(); await rm(directory, { recursive: true, force: true }) }
})
