import { DISTILLATION_TRIAGE_REQUEST_BYTE_LIMIT } from "@genioone/protocol/distillation-triage"

import { handleDistillationTriageRequest } from "../shared/distillation-triage"
import {
  createProcessorAdapterRuntime,
  loadProcessorAdapterRegistryFromEnvironment,
  type ProcessorAdapterRuntime,
} from "../shared/processor-adapters"
import { appendSafetyBuffer } from "./safety-buffer"

async function readLimitedBody(request: Request, maximumBytes: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    try {
      total = appendSafetyBuffer(chunks, total, value, maximumBytes)
    } catch {
      await reader.cancel()
      return null
    }
  }
  return Buffer.concat(chunks)
}

export function createLocalDistillationTriageApp(input: {
  token: string
  runtime: ProcessorAdapterRuntime
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ status: "ok", component: "local-distillation-triage" })
    }
    if (request.method !== "POST" || !url.pathname.endsWith("/v1/distillation-triage")) {
      return new Response(null, { status: 404 })
    }
    const body = await readLimitedBody(request, DISTILLATION_TRIAGE_REQUEST_BYTE_LIMIT)
    if (!body) return Response.json({ code: "DISTILLATION_EXCERPT_TOO_LARGE" }, { status: 413 })
    return handleDistillationTriageRequest({
      authorization: request.headers.get("authorization"),
      body,
      token: input.token,
      runtime: input.runtime,
    })
  }
}

if (import.meta.main) {
  const token = process.env.GENIO_ONE_DISTILLATION_TRIAGE_TOKEN?.trim()
  if (!token) throw new Error("GENIO_ONE_DISTILLATION_TRIAGE_TOKEN is required")
  const listen = process.env.GENIO_ONE_AI_PROCESSOR_HTTP_LISTEN ?? "127.0.0.1:8182"
  const separator = listen.lastIndexOf(":")
  const hostname = listen.slice(0, separator)
  const port = Number.parseInt(listen.slice(separator + 1), 10)
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("GENIO_ONE_AI_PROCESSOR_HTTP_LISTEN must be host:port")
  }
  const runtime = createProcessorAdapterRuntime(
    loadProcessorAdapterRegistryFromEnvironment(process.env),
    process.env,
  )
  Bun.serve({
    hostname,
    port,
    fetch: createLocalDistillationTriageApp({ token, runtime }),
  })
}
