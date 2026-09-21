import { readFileSync } from "node:fs"

import { Type, type Static } from "typebox"
import { Value } from "typebox/value"

export const PROCESSOR_ADAPTERS_SCHEMA_VERSION = 1 as const
export const JEV_SYSTEM_ONE_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
export const JEV_DEFAULT_MODEL = "jev-latest"
export const MAX_PROCESSOR_ADAPTER_IDENTIFIER_CHARACTERS = 256
export const MAX_PROCESSOR_ADAPTER_REQUEST_BYTES = 131_072
export const MAX_PROCESSOR_ADAPTER_RESPONSE_BYTES = 65_536
export const MAX_SAFETY_STATE_BYTES = 96_000
export const PRESIDIO_PAYLOAD_TIMEOUT_MS = 5_000
export const MAX_PRESIDIO_INSPECTED_STRINGS = 64
export const MAX_PRESIDIO_INSPECTED_BYTES = 65_536
export const PROCESSOR_ADAPTER_CREDENTIAL_ENV_NAMES =
  "GENIO_ONE_PROCESSOR_ADAPTER_CREDENTIAL_ENV_NAMES"

const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: MAX_PROCESSOR_ADAPTER_IDENTIFIER_CHARACTERS,
  pattern: "^(?!\\s)(?!.*\\s$)[^\\u0000\\r\\n]+$",
})

const CredentialEnvironmentKeySchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Z][A-Z0-9_]*_(API_KEY|TOKEN)$",
})

const RESERVED_CREDENTIAL_ENVIRONMENT_PREFIXES = [
  "GENIO_ONE_",
  "OTEL_",
  "NODE_",
  "BUN_",
  "KUBERNETES_",
] as const

const ProcessorAdapterKindSchema = Type.Union([
  Type.Literal("JEV"),
  Type.Literal("HTTP"),
  Type.Literal("PRESIDIO"),
])

export type ProcessorAdapterKind = Static<typeof ProcessorAdapterKindSchema>

const ProcessorAdapterDefinitionSchema = Type.Object(
  {
    id: IdentifierSchema,
    tenant_id: IdentifierSchema,
    kind: ProcessorAdapterKindSchema,
    endpoint: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
    credential_env: Type.Optional(CredentialEnvironmentKeySchema),
    model: Type.Optional(IdentifierSchema),
  },
  { additionalProperties: false },
)

export type ProcessorAdapterDefinition = Static<typeof ProcessorAdapterDefinitionSchema>

const ProcessorAdapterRegistrySchema = Type.Object(
  {
    schema_version: Type.Literal(PROCESSOR_ADAPTERS_SCHEMA_VERSION),
    adapters: Type.Array(ProcessorAdapterDefinitionSchema, { maxItems: 4_096 }),
  },
  { additionalProperties: false },
)

export type ProcessorAdapterRegistry = Static<typeof ProcessorAdapterRegistrySchema>

export interface SanitizedProcessorAdapterCatalogEntry {
  id: string
  tenant_id: string
  kind: ProcessorAdapterKind
  endpoint: string
  model?: string
}

export interface SystemOneQuestion {
  type: "noul"
  instructions: string
}

export interface SystemOneCheckInput {
  id: string
  instructions: string
}

export interface SystemOneRequest {
  state: unknown
  model: string
  questions: Record<string, SystemOneQuestion>
}

export interface SystemOneNoulAnswer {
  type: "noul"
  noul: number
}

export interface SystemOneResponse {
  model: string
  answers: Record<string, SystemOneNoulAnswer>
}

const WORST_CASE_SYSTEM_ONE_REQUEST_MODEL = "\u0001".repeat(
  MAX_PROCESSOR_ADAPTER_IDENTIFIER_CHARACTERS,
)

function jsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error("processor adapter request is invalid")
  return Buffer.byteLength(serialized, "utf8")
}

export function systemOneQuestionsForChecks(
  checks: readonly SystemOneCheckInput[],
): Record<string, SystemOneQuestion> {
  const questions = Object.create(null) as Record<string, SystemOneQuestion>
  for (const check of checks) {
    questions[check.id] = { type: "noul", instructions: check.instructions }
  }
  return questions
}

export function systemOneQuestionsWithinRequestBudget(
  checks: readonly SystemOneCheckInput[],
): boolean {
  const reserved = jsonByteLength({
    state: null,
    model: WORST_CASE_SYSTEM_ONE_REQUEST_MODEL,
    questions: systemOneQuestionsForChecks(checks),
  }) - jsonByteLength(null) + MAX_SAFETY_STATE_BYTES
  return reserved <= MAX_PROCESSOR_ADAPTER_REQUEST_BYTES
}

export interface SafetyAdapterClient {
  readonly adapterId: string
  readonly provider: "JEV" | "HTTP"
  readonly endpoint: string
  readonly model: string
  evaluate(input: Omit<SystemOneRequest, "model">, timeoutMs: number): Promise<SystemOneResponse>
}

export interface PresidioSpan {
  start: number
  end: number
  score: number
  entity_type: string
}

export interface PresidioAdapterClient {
  readonly adapterId: string
  readonly endpoint: string
  analyze(input: {
    text: string
    language: string
    entities: readonly string[]
    scoreThreshold: number
    timeoutMs: number
  }): Promise<readonly PresidioSpan[]>
}

export interface ProcessorAdapterRuntime {
  resolveSafetyAdapter(tenantId: string, adapterId: string): SafetyAdapterClient
  resolvePresidioAdapter(tenantId: string, adapterId: string): PresidioAdapterClient
}

function invalidRegistry(): Error {
  return new Error("processor adapter registry is invalid")
}

function invalidConfiguration(): Error {
  return new Error("processor adapter configuration is invalid")
}

function validCredentialEnvironmentName(value: string): boolean {
  return Value.Check(CredentialEnvironmentKeySchema, value) &&
    !RESERVED_CREDENTIAL_ENVIRONMENT_PREFIXES.some((prefix) => value.startsWith(prefix))
}

function normalizeEndpoint(definition: ProcessorAdapterDefinition): string {
  const source = definition.endpoint?.trim() ||
    (definition.kind === "JEV" ? JEV_SYSTEM_ONE_ENDPOINT : "")
  if (!source) throw invalidRegistry()
  let parsed: URL
  try {
    parsed = new URL(source)
  } catch {
    throw invalidRegistry()
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw invalidRegistry()
  }
  if (definition.kind === "JEV" && parsed.protocol !== "https:") throw invalidRegistry()
  if (definition.kind === "HTTP" && !definition.endpoint?.trim()) throw invalidRegistry()
  if (definition.kind === "PRESIDIO" && !parsed.pathname.endsWith("/analyze")) {
    throw invalidRegistry()
  }
  return parsed.toString()
}

function normalizedDefinition(definition: ProcessorAdapterDefinition): ProcessorAdapterDefinition {
  if (definition.kind === "HTTP" && !definition.model?.trim()) throw invalidRegistry()
  if (definition.credential_env && !validCredentialEnvironmentName(definition.credential_env)) {
    throw invalidRegistry()
  }
  return {
    ...definition,
    endpoint: normalizeEndpoint(definition),
    ...(definition.kind === "JEV" && !definition.model ? { model: JEV_DEFAULT_MODEL } : {}),
  }
}

export function loadProcessorAdapterRegistry(input: unknown): ProcessorAdapterRegistry {
  if (!Value.Check(ProcessorAdapterRegistrySchema, input)) throw invalidRegistry()
  const registry = input as ProcessorAdapterRegistry
  const seen = new Set<string>()
  const adapters = registry.adapters.map((adapter) => {
    const normalized = normalizedDefinition(adapter)
    const key = `${normalized.tenant_id}\u0000${normalized.id}`
    if (seen.has(key)) throw invalidRegistry()
    seen.add(key)
    return normalized
  })
  return { schema_version: PROCESSOR_ADAPTERS_SCHEMA_VERSION, adapters }
}

export function loadProcessorAdapterRegistryFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ProcessorAdapterRegistry {
  const location = environment.GENIO_ONE_PROCESSOR_ADAPTERS_FILE?.trim()
  if (!location) return { schema_version: PROCESSOR_ADAPTERS_SCHEMA_VERSION, adapters: [] }
  let serialized: string
  try {
    serialized = readFileSync(location, "utf8")
  } catch {
    throw new Error("processor adapter registry is unavailable")
  }
  try {
    return loadProcessorAdapterRegistry(JSON.parse(serialized) as unknown)
  } catch (error) {
    if (error instanceof Error && error.message === "processor adapter registry is invalid") {
      throw error
    }
    throw invalidRegistry()
  }
}

export function sanitizeProcessorAdapterCatalog(
  registry: ProcessorAdapterRegistry,
  tenantId?: string,
): SanitizedProcessorAdapterCatalogEntry[] {
  const normalized = loadProcessorAdapterRegistry(registry)
  return normalized.adapters
    .filter((adapter) => tenantId === undefined || adapter.tenant_id === tenantId)
    .map((adapter) => ({
      id: adapter.id,
      tenant_id: adapter.tenant_id,
      kind: adapter.kind,
      endpoint: adapter.endpoint!,
      ...(adapter.model ? { model: adapter.model } : {}),
    }))
}

function adapterFor(
  registry: ProcessorAdapterRegistry,
  tenantId: string,
  adapterId: string,
): ProcessorAdapterDefinition {
  if (!tenantId.trim() || !adapterId.trim()) throw invalidConfiguration()
  const adapter = registry.adapters.find((candidate) =>
    candidate.tenant_id === tenantId && candidate.id === adapterId
  )
  if (!adapter) throw invalidConfiguration()
  return adapter
}

function credentialNamesFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ReadonlySet<string> {
  const serialized = environment[PROCESSOR_ADAPTER_CREDENTIAL_ENV_NAMES]
  if (serialized === undefined) return new Set()
  if (!serialized || serialized !== serialized.trim()) throw invalidConfiguration()
  const names = serialized.split(",")
  const allowed = new Set<string>()
  for (const name of names) {
    if (!validCredentialEnvironmentName(name) || allowed.has(name)) {
      throw invalidConfiguration()
    }
    allowed.add(name)
  }
  return allowed
}

function credentialsFor(
  registry: ProcessorAdapterRegistry,
  environment: NodeJS.ProcessEnv,
): ReadonlyMap<string, string> {
  const allowed = credentialNamesFromEnvironment(environment)
  const credentials = new Map<string, string>()
  for (const adapter of registry.adapters) {
    const name = adapter.credential_env
    if (!name) continue
    if (!allowed.has(name)) throw invalidConfiguration()
    const credential = environment[name]
    if (!credential?.trim()) throw invalidConfiguration()
    credentials.set(name, credential)
  }
  return credentials
}

function credentialFor(
  adapter: ProcessorAdapterDefinition,
  credentials: ReadonlyMap<string, string>,
): string | undefined {
  if (!adapter.credential_env) return undefined
  const credential = credentials.get(adapter.credential_env)
  if (!credential) throw invalidConfiguration()
  return credential
}

function requestSignal(timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw invalidConfiguration()
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) throw new Error("processor adapter response is invalid")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_PROCESSOR_ADAPTER_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error("processor adapter response is invalid")
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseSystemOneResponse(value: unknown): SystemOneResponse {
  const payload = object(value)
  if (
    !payload ||
    typeof payload.model !== "string" ||
    !payload.model.trim() ||
    payload.model !== payload.model.trim() ||
    payload.model.length > 512 ||
    /[\u0000\r\n]/.test(payload.model)
  ) {
    throw new Error("processor adapter response is invalid")
  }
  const answers = object(payload.answers)
  if (!answers) throw new Error("processor adapter response is invalid")
  const parsedAnswers = Object.create(null) as Record<string, SystemOneNoulAnswer>
  for (const [id, answer] of Object.entries(answers)) {
    const candidate = object(answer)
    if (
      !candidate ||
      candidate.type !== "noul" ||
      typeof candidate.noul !== "number" ||
      !Number.isFinite(candidate.noul) ||
      candidate.noul < 0 ||
      candidate.noul > 1
    ) {
      throw new Error("processor adapter response is invalid")
    }
    parsedAnswers[id] = { type: "noul", noul: candidate.noul }
  }
  return { model: payload.model, answers: parsedAnswers }
}

function parsePresidioSpans(value: unknown): readonly PresidioSpan[] {
  if (!Array.isArray(value)) throw new Error("processor adapter response is invalid")
  return value.map((span) => {
    const candidate = object(span)
    if (
      !candidate ||
      !Number.isInteger(candidate.start) ||
      !Number.isInteger(candidate.end) ||
      !Number.isFinite(candidate.score) ||
      typeof candidate.entity_type !== "string" ||
      !candidate.entity_type.trim()
    ) {
      throw new Error("processor adapter response is invalid")
    }
    return {
      start: candidate.start as number,
      end: candidate.end as number,
      score: candidate.score as number,
      entity_type: candidate.entity_type,
    }
  })
}

async function postJson(
  endpoint: string,
  credential: string | undefined,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const serialized = JSON.stringify(body)
  if (Buffer.byteLength(serialized, "utf8") > MAX_PROCESSOR_ADAPTER_REQUEST_BYTES) {
    throw new Error("processor adapter request is invalid")
  }
  const signal = requestSignal(timeoutMs)
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: signal.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      body: serialized,
    })
    if (!response.ok || response.redirected) {
      await response.body?.cancel()
      throw new Error("processor adapter response is rejected")
    }
    const text = await readBoundedResponse(response)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error("processor adapter response is invalid")
    }
  } catch {
    throw new Error("processor adapter request failed")
  } finally {
    signal.dispose()
  }
}

class Runtime implements ProcessorAdapterRuntime {
  constructor(
    private readonly registry: ProcessorAdapterRegistry,
    private readonly credentials: ReadonlyMap<string, string>,
  ) {}

  resolveSafetyAdapter(tenantId: string, adapterId: string): SafetyAdapterClient {
    const adapter = adapterFor(this.registry, tenantId, adapterId)
    if (adapter.kind !== "JEV" && adapter.kind !== "HTTP") throw invalidConfiguration()
    const credential = credentialFor(adapter, this.credentials)
    const provider = adapter.kind
    const endpoint = adapter.endpoint!
    const model = adapter.model || (provider === "JEV" ? JEV_DEFAULT_MODEL : undefined)
    if (!model) throw invalidConfiguration()
    return {
      adapterId: adapter.id,
      provider,
      endpoint,
      model,
      evaluate: async (input, timeoutMs) => {
        const response = await postJson(endpoint, credential, { ...input, model }, timeoutMs)
        return parseSystemOneResponse(response)
      },
    }
  }

  resolvePresidioAdapter(tenantId: string, adapterId: string): PresidioAdapterClient {
    const adapter = adapterFor(this.registry, tenantId, adapterId)
    if (adapter.kind !== "PRESIDIO") throw invalidConfiguration()
    const credential = credentialFor(adapter, this.credentials)
    const endpoint = adapter.endpoint!
    return {
      adapterId: adapter.id,
      endpoint,
      analyze: async (input) => {
        const response = await postJson(endpoint, credential, {
          text: input.text,
          language: input.language,
          entities: input.entities,
          score_threshold: input.scoreThreshold,
        }, input.timeoutMs)
        return parsePresidioSpans(response)
      },
    }
  }
}

export function createProcessorAdapterRuntime(
  registry: ProcessorAdapterRegistry,
  environment: NodeJS.ProcessEnv = process.env,
): ProcessorAdapterRuntime {
  const normalized = loadProcessorAdapterRegistry(registry)
  return new Runtime(normalized, credentialsFor(normalized, environment))
}
