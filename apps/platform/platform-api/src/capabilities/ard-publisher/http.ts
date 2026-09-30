import { createHash } from "node:crypto"

import type { FastifyPluginAsync } from "fastify"

import { canonicalJson } from "@genioone/protocol/canonical"

import type { ArdDocument, ArdPublisher } from "./module"

function etag(body: unknown): string {
  return `\"${createHash("sha256").update(canonicalJson(body)).digest("hex")}\"`
}

function matchesIfNoneMatch(value: string | undefined, current: string): boolean {
  if (!value) return false
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim()
    return normalized === "*" || normalized.replace(/^W\//, "") === current
  })
}

function publicHeaders(reply: {
  header(name: string, value: string): unknown
}) {
  reply.header("cache-control", "no-store")
  reply.header("access-control-allow-origin", "*")
  reply.header("access-control-expose-headers", "ETag")
  reply.header("x-content-type-options", "nosniff")
  reply.header("referrer-policy", "no-referrer")
}

function sendPreflight(reply: {
  code(statusCode: number): { send(value?: string): unknown }
  header(name: string, value: string): unknown
}) {
  reply.header("access-control-allow-methods", "GET, HEAD, OPTIONS")
  reply.header("access-control-allow-headers", "If-None-Match, Content-Type")
  return reply.code(204).send()
}

function sendDocument(
  request: { headers: { [key: string]: string | string[] | undefined } },
  reply: {
    code(statusCode: number): { send(value?: string): unknown }
    header(name: string, value: string): unknown
  },
  document: ArdDocument,
) {
  const body = canonicalJson(document.body)
  const currentEtag = etag(document.body)
  reply.header("content-type", document.contentType)
  reply.header("etag", currentEtag)
  const ifNoneMatch = request.headers["if-none-match"]
  if (typeof ifNoneMatch === "string" && matchesIfNoneMatch(ifNoneMatch, currentEtag)) {
    return reply.code(304).send()
  }
  return reply.code(200).send(body)
}

export const ardPublisherHttp: FastifyPluginAsync<{ publisher: ArdPublisher }> = async (
  app,
  options,
) => {
  app.addHook("onRequest", async (_request, reply) => {
    publicHeaders(reply)
  })
  app.options("/.well-known/ard.json", { schema: { hide: true } }, async (_request, reply) =>
    sendPreflight(reply),
  )
  app.get("/.well-known/ard.json", { schema: { hide: true } }, async (request, reply) =>
    sendDocument(request, reply, await options.publisher.manifest()),
  )
  app.options("/.well-known/ard/mcp/:resource_key/:content_key", { schema: { hide: true } }, async (_request, reply) =>
    sendPreflight(reply),
  )
  app.get("/.well-known/ard/mcp/:resource_key/:content_key", { schema: { hide: true } }, async (request, reply) => {
    const params = request.params as { resource_key: string; content_key: string }
    const descriptor = await options.publisher.descriptor({
      descriptorKey: `${params.resource_key}.${params.content_key}`,
    })
    if (!descriptor) {
      return reply.code(404).send()
    }
    return sendDocument(request, reply, descriptor)
  })
}
