import { createHash, timingSafeEqual } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"

const archifyTypes = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"] as const
const archifyTypeSchema = z.enum(archifyTypes)
const maxRequestBytes = 192 * 1024
const maxSpecBytes = 128 * 1024
const maxArtifactBytes = 2 * 1024 * 1024
const maxSpecDepth = 24
const maxSpecValues = 1_200
const maxStringBytes = 16 * 1024
const renderTimeoutMs = 20_000
const maxConcurrentRenders = 2
const vendorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "vendor", "archify")
const archifyCli = path.join(vendorRoot, "bin", "archify.mjs")

let activeRenders = 0

type ArchifyType = (typeof archifyTypes)[number]

interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

interface DeliveryReceipt {
  artifact?: { sha256?: string; bytes?: number }
  validation?: { checksPassed?: number; checkCount?: number; compositionStatus?: string; errors?: number; warnings?: number }
}

export interface ArchifyHandlerOptions {
  bearerToken?: string
  executable?: string
}

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex")
}

function serviceTokenMatches(header: string | null, expected: string) {
  const token = /^Bearer ([A-Za-z0-9._~+/-]+={0,2})$/.exec(header ?? "")?.[1]
  if (!token || !expected) return false
  return timingSafeEqual(Buffer.from(digest(token), "hex"), Buffer.from(digest(expected), "hex"))
}

function hasBoundedJson(value: unknown, state = { values: 0, depth: 0 }): boolean {
  state.values += 1
  if (state.values > maxSpecValues || state.depth > maxSpecDepth) return false
  if (value === null || typeof value === "boolean" || typeof value === "number") return Number.isFinite(value) || typeof value !== "number"
  if (typeof value === "string") return Buffer.byteLength(value) <= maxStringBytes
  if (Array.isArray(value)) {
    if (value.length > 200) return false
    state.depth += 1
    const valid = value.every((item) => hasBoundedJson(item, state))
    state.depth -= 1
    return valid
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false
  const entries = Object.entries(value)
  if (entries.length > 200 || entries.some(([key]) => Buffer.byteLength(key) > 256)) return false
  state.depth += 1
  const valid = entries.every(([, item]) => hasBoundedJson(item, state))
  state.depth -= 1
  return valid
}

function safeSpec(spec: Record<string, unknown>) {
  const bytes = Buffer.byteLength(JSON.stringify(spec))
  if (bytes > maxSpecBytes || !hasBoundedJson(spec)) return null
  const meta = spec.meta
  if (meta && typeof meta === "object" && !Array.isArray(meta) && Object.hasOwn(meta, "output")) return null
  return bytes
}

async function runCli(executable: string, args: string[], cwd: string): Promise<CliResult> {
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([executable, archifyCli, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  } catch {
    return { exitCode: 1, stdout: "", stderr: "", timedOut: false }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, renderTimeoutMs)
  const outputText = (stream: typeof child.stdout) => stream instanceof ReadableStream ? new Response(stream).text() : Promise.resolve("")
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, outputText(child.stdout), outputText(child.stderr)])
  clearTimeout(timer)
  return { exitCode, stdout: stdout.slice(0, 64 * 1024), stderr: stderr.slice(0, 64 * 1024), timedOut }
}

function receiptFrom(output: string): DeliveryReceipt | null {
  try {
    const value = JSON.parse(output) as DeliveryReceipt
    return value && typeof value === "object" ? value : null
  } catch {
    return null
  }
}

function errorCode(result: CliResult) {
  if (result.timedOut) return "ARCHIFY_RENDER_TIMEOUT"
  try {
    const value = JSON.parse(result.stdout) as { diagnostics?: Array<{ code?: unknown }> }
    const code = value.diagnostics?.[0]?.code
    if (typeof code === "string" && /^[a-z0-9/_-]{1,96}$/i.test(code)) return `ARCHIFY_${code.toUpperCase().replaceAll(/[/-]/g, "_")}`
  } catch {}
  return "ARCHIFY_RENDER_FAILED"
}

function resultError(code: string) {
  return { isError: true, content: [{ type: "text" as const, text: code }], structuredContent: { error: { code } } }
}

function acquireRenderSlot() {
  if (activeRenders >= maxConcurrentRenders) return false
  activeRenders += 1
  return true
}

function releaseRenderSlot() {
  activeRenders -= 1
}

async function render(type: ArchifyType, spec: Record<string, unknown>, executable: string) {
  const specBytes = safeSpec(spec)
  if (specBytes === null) return { ok: false as const, code: "ARCHIFY_SPEC_REJECTED" }
  const directory = await mkdtemp(path.join(os.tmpdir(), "genio-archify-"))
  const input = path.join(directory, "diagram.json")
  const output = path.join(directory, "diagram.html")
  try {
    await writeFile(input, JSON.stringify(spec), { encoding: "utf8", flag: "wx", mode: 0o600 })
    const validation = await runCli(executable, ["validate", type, input, "--quality", "showcase", "--json"], directory)
    if (validation.exitCode !== 0) return { ok: false as const, code: errorCode(validation) }
    const delivery = await runCli(executable, ["deliver", type, input, output, "--quality", "showcase", "--json"], directory)
    if (delivery.exitCode !== 0) return { ok: false as const, code: errorCode(delivery) }
    const html = await readFile(output)
    if (html.byteLength === 0 || html.byteLength > maxArtifactBytes) return { ok: false as const, code: "ARCHIFY_ARTIFACT_SIZE_REJECTED" }
    const receipt = receiptFrom(delivery.stdout)
    const sha256 = digest(html)
    if (receipt?.artifact?.sha256 !== sha256 || receipt.artifact.bytes !== html.byteLength) return { ok: false as const, code: "ARCHIFY_ARTIFACT_RECEIPT_INVALID" }
    return {
      ok: true as const,
      html: html.toString("utf8"),
      artifact: { name: `${type}.html`, sha256, bytes: html.byteLength },
      specBytes,
      validation: {
        checksPassed: receipt.validation?.checksPassed ?? 0,
        checkCount: receipt.validation?.checkCount ?? 0,
        compositionStatus: receipt.validation?.compositionStatus ?? "unknown",
        errors: receipt.validation?.errors ?? 0,
        warnings: receipt.validation?.warnings ?? 0,
      },
    }
  } catch {
    return { ok: false as const, code: "ARCHIFY_RENDER_FAILED" }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function schemaGuide(type?: ArchifyType, includeExample = true) {
  if (!type) return { types: archifyTypes, limits: { maxSpecBytes, maxArtifactBytes, maxConcurrentRenders } }
  const schema = await readFile(path.join(vendorRoot, "schemas", `${type}.schema.json`), "utf8")
  const names: Record<ArchifyType, string> = {
    architecture: "web-app.architecture.json",
    workflow: "agent-tool-call.workflow.json",
    sequence: "cache-miss-request.sequence.json",
    dataflow: "product-analytics.dataflow.json",
    lifecycle: "agent-run.lifecycle.json",
  }
  const example = includeExample ? await readFile(path.join(vendorRoot, "examples", names[type]), "utf8") : undefined
  const guideDigest = digest(`${schema}\u0000${example ?? ""}`)
  return { type, schema: JSON.parse(schema), ...(example ? { example: JSON.parse(example) } : {}), limits: { maxSpecBytes, maxArtifactBytes }, sha256: guideDigest }
}

export function createArchifyHandler(options: ArchifyHandlerOptions = {}) {
  const bearerToken = options.bearerToken ?? process.env.ARCHIFY_CONNECTOR_BEARER_TOKEN ?? ""
  const executable = options.executable ?? process.env.ARCHIFY_NODE_EXECUTABLE ?? "node"
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname === "/health") return Response.json({ service: "genio-connector-archify", status: bearerToken ? "ready" : "misconfigured" }, { status: bearerToken ? 200 : 503 })
    if (url.pathname !== "/mcp") return new Response(null, { status: 404 })
    const contentLength = request.headers.get("content-length")
    if (contentLength && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > maxRequestBytes)) return Response.json({ error: "ARCHIFY_REQUEST_TOO_LARGE" }, { status: 413 })
    if (!bearerToken) return Response.json({ error: "ARCHIFY_SERVICE_TOKEN_REQUIRED" }, { status: 503 })
    if (!serviceTokenMatches(request.headers.get("authorization"), bearerToken)) return Response.json({ error: "ARCHIFY_AUTHORIZATION_REQUIRED" }, { status: 401, headers: { "www-authenticate": "Bearer" } })
    const server = new McpServer({ name: "genio-archify", version: "0.1.0" })
    server.registerTool("archify_schema", {
      title: "取得 Archify 圖表規格",
      description: "取得受支援圖類的 JSON Schema 與範例；先依這個規格產生 archify_render 的 spec。",
      inputSchema: { type: archifyTypeSchema.optional(), include_example: z.boolean().default(true) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (args) => {
      try {
        const guide = await schemaGuide(args.type, args.include_example)
        const sha256 = "sha256" in guide ? guide.sha256 : digest(JSON.stringify(guide))
        return { content: [{ type: "text" as const, text: `ARCHIFY_SCHEMA sha256=${sha256}` }], structuredContent: guide }
      } catch {
        return resultError("ARCHIFY_SCHEMA_UNAVAILABLE")
      }
    })
    server.registerTool("archify_render", {
      title: "產生 Archify 互動式 HTML 圖表",
      description: "驗證並交付受限 JSON spec 為互動式單檔 HTML；不接受路徑、命令或任意執行參數。",
      inputSchema: { type: archifyTypeSchema, spec: z.record(z.string(), z.unknown()) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (args) => {
      if (!acquireRenderSlot()) return resultError("ARCHIFY_BUSY")
      try {
        const outcome = await render(args.type, args.spec, executable)
        if (!outcome.ok) return resultError(outcome.code)
        return {
          content: [{ type: "text" as const, text: `ARCHIFY_RENDERED type=${args.type} sha256=${outcome.artifact.sha256} bytes=${outcome.artifact.bytes}` }],
          structuredContent: { type: args.type, specBytes: outcome.specBytes, artifact: outcome.artifact, validation: outcome.validation },
          _meta: { "genio/artifacts": [{ name: outcome.artifact.name, mimeType: "text/html", text: outcome.html, sha256: outcome.artifact.sha256 }] },
        }
      } finally {
        releaseRenderSlot()
      }
    })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    try {
      return await transport.handleRequest(request)
    } finally {
      await server.close()
    }
  }
}
