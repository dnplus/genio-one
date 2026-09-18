import { createHash } from "node:crypto"

import { Check } from "typebox/value"

import { PlatformApiError } from "../errors"
import { CompiledEnforcementChainSchema } from "./contract"
import type {
  CompileEnforcementChainInput,
  CompiledEnforcementChain,
  EnforcementStep,
  NativeJwtAuthenticationConfig,
  ObserveStep,
  ProcessAction,
  ProcessStep,
} from "./contract"
import type { EnforcementChainCompiler, EnforcementChainScope } from "./module"

const NATIVE_JWT_CONFIG_KEYS = [
  "schema_version",
  "provider",
  "issuer",
  "audiences",
  "remote_jwks_uri",
  "subject_claim",
  "client_claim",
] as const

const JWT_PROVIDER_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const JWT_CLAIM_NAME = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nativeJwtConfigError(
  code: "NATIVE_JWT_CONFIG_REQUIRED" | "NATIVE_JWT_CONFIG_INVALID",
  path = "config",
): PlatformApiError {
  return new PlatformApiError(code, 422, `Invalid native JWT authentication ${path}`)
}

function secureIssuerUri(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw nativeJwtConfigError("NATIVE_JWT_CONFIG_INVALID", path)
  }
  let uri: URL
  try {
    uri = new URL(value)
  } catch {
    throw nativeJwtConfigError("NATIVE_JWT_CONFIG_INVALID", path)
  }
  const isLoopbackHttp = uri.protocol === "http:" &&
    (uri.hostname === "127.0.0.1" || uri.hostname === "localhost" || uri.hostname === "[::1]")
  if (
    (uri.protocol !== "https:" && !isLoopbackHttp) ||
    !uri.hostname ||
    uri.username ||
    uri.password
  ) {
    throw nativeJwtConfigError("NATIVE_JWT_CONFIG_INVALID", path)
  }
  return value
}

/**
 * Validate the canonical JWT config before either compiling or projecting it.
 * Envoy Gateway permits issuer/audience checks to be omitted, but an inbound
 * GenioOne authenticator must not silently become an unsigned or unscoped
 * route, so these fields are intentionally required here.
 */
export function validateNativeJwtAuthenticationConfig(
  value: unknown,
): NativeJwtAuthenticationConfig {
  if (value === undefined || value === null) {
    throw nativeJwtConfigError("NATIVE_JWT_CONFIG_REQUIRED")
  }
  if (!isRecord(value)) {
    throw nativeJwtConfigError("NATIVE_JWT_CONFIG_INVALID")
  }
  for (const key of Object.keys(value)) {
    if (!(NATIVE_JWT_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw nativeJwtConfigError("NATIVE_JWT_CONFIG_INVALID", key)
    }
  }
  if (value.schema_version !== "genio.one.auth.jwt.v1") {
    throw nativeJwtConfigError("NATIVE_JWT_CONFIG_INVALID", "schema_version")
  }
  if (
    typeof value.provider !== "string" ||
    !JWT_PROVIDER_NAME.test(value.provider) ||
    value.provider.length > 63
  ) {
    throw nativeJwtConfigError("NATIVE_JWT_CONFIG_INVALID", "provider")
  }

  if (typeof value.issuer !== "string" || value.issuer.length === 0) {
    throw nativeJwtConfigError("NATIVE_JWT_CONFIG_INVALID", "issuer")
  }
  const issuer = secureIssuerUri(value.issuer, "issuer")

  if (
    !Array.isArray(value.audiences) ||
    value.audiences.length === 0 ||
    value.audiences.some(
      (audience) =>
        typeof audience !== "string" ||
        audience.length === 0 ||
        audience.length > 512 ||
        /\s/.test(audience),
    ) ||
    new Set(value.audiences).size !== value.audiences.length
  ) {
    throw nativeJwtConfigError("NATIVE_JWT_CONFIG_INVALID", "audiences")
  }

  const remoteJwksUri = secureIssuerUri(value.remote_jwks_uri, "remote_jwks_uri")
  if (
    typeof value.subject_claim !== "string" ||
    !JWT_CLAIM_NAME.test(value.subject_claim) ||
    value.subject_claim.length > 256
  ) {
    throw nativeJwtConfigError("NATIVE_JWT_CONFIG_INVALID", "subject_claim")
  }
  if (
    typeof value.client_claim !== "string" ||
    !JWT_CLAIM_NAME.test(value.client_claim) ||
    value.client_claim.length > 256 ||
    value.client_claim === value.subject_claim
  ) {
    throw nativeJwtConfigError("NATIVE_JWT_CONFIG_INVALID", "client_claim")
  }

  return {
    schema_version: "genio.one.auth.jwt.v1",
    provider: value.provider,
    issuer,
    audiences: [...value.audiences] as string[],
    remote_jwks_uri: remoteJwksUri,
    subject_claim: value.subject_claim,
    client_claim: value.client_claim,
  }
}

function actionName(action: ProcessAction | undefined): string | undefined {
  return action?.action.trim().toUpperCase()
}

const DATA_PROTECTION_ACTIONS = new Set(["BLOCK", "REDACT", "TOKENIZE", "RESTORE"])
const DATA_PROTECTION_SEMANTIC_TYPE = /^[A-Z][A-Z0-9_]{0,31}$/
const DATA_PROTECTION_FLAGS = /^[dgimsuvy]*$/

function assertDataProtectionConfig(action: ProcessAction | undefined): void {
  const name = actionName(action)
  if (!name || !DATA_PROTECTION_ACTIONS.has(name) || action?.config === undefined) return
  if (!isRecord(action.config) || !Array.isArray(action.config.patterns)) {
    throw new PlatformApiError("DATA_PROTECTION_PATTERN_INVALID", 422)
  }
  for (const pattern of action.config.patterns) {
    if (!isRecord(pattern)) {
      throw new PlatformApiError("DATA_PROTECTION_PATTERN_INVALID", 422)
    }
    if (
      typeof pattern.name !== "string" ||
      !DATA_PROTECTION_SEMANTIC_TYPE.test(pattern.name)
    ) {
      throw new PlatformApiError("DATA_PROTECTION_SEMANTIC_TYPE_INVALID", 422)
    }
    if (
      typeof pattern.expression !== "string" ||
      pattern.expression.length === 0 ||
      pattern.expression.length > 2_048 ||
      (pattern.flags !== undefined && (
        typeof pattern.flags !== "string" ||
        !DATA_PROTECTION_FLAGS.test(pattern.flags)
      ))
    ) {
      throw new PlatformApiError("DATA_PROTECTION_PATTERN_INVALID", 422)
    }
    try {
      new RegExp(pattern.expression, pattern.flags)
    } catch {
      throw new PlatformApiError("DATA_PROTECTION_PATTERN_INVALID", 422)
    }
  }
}

function chainId(
  tenantId: string,
  resourceId: string,
  capabilityId: string,
  revision: number,
): string {
  const identity = createHash("sha256")
    .update(tenantId)
    .update("\0")
    .update(resourceId)
    .update("\0")
    .update(capabilityId)
    .update("\0")
    .update(String(revision))
    .digest("hex")
    .slice(0, 32)
  return `chain-${identity}`
}

function changesEntitlementCandidates(action: ProcessAction | undefined): boolean {
  return action?.effect !== undefined
}

function isRouteLease(action: ProcessAction | undefined): boolean {
  const name = actionName(action)
  return name === "SESSION_ROUTE_LEASE" || name === "MODEL_ROUTE_LEASE"
}

function isProcessStep(step: EnforcementStep): step is ProcessStep {
  return step.kind === "PROCESS"
}

function isObserveStep(step: EnforcementStep): step is ObserveStep {
  return step.kind === "OBSERVE"
}

function assertProcessStep(step: ProcessStep): void {
  const request = step.hooks.request
  const response = step.hooks.response
  if (!request && !response) {
    throw new PlatformApiError("PROCESS_HOOK_REQUIRED", 422)
  }

  const requestName = actionName(request)
  const responseName = actionName(response)
  if (requestName === "RESTORE" || responseName === "TOKENIZE") {
    throw new PlatformApiError("TOKEN_VAULT_HOOK_DIRECTION_INVALID", 422)
  }
  const tokenVault = requestName === "TOKENIZE" || responseName === "RESTORE"
  if (tokenVault && (requestName !== "TOKENIZE" || responseName !== "RESTORE")) {
    throw new PlatformApiError(
      "TOKEN_VAULT_HOOK_PAIR_REQUIRED",
      422,
      "Reversible tokenization is one PROCESS step with request TOKENIZE and response RESTORE",
    )
  }

  if (changesEntitlementCandidates(response)) {
    throw new PlatformApiError("CANDIDATE_EFFECT_REQUEST_HOOK_REQUIRED", 422)
  }
  if (responseName?.includes("CLASSIFIER")) {
    throw new PlatformApiError("CLASSIFIER_REQUEST_HOOK_REQUIRED", 422)
  }
  if (actionName(request)?.includes("CLASSIFIER") && !changesEntitlementCandidates(request)) {
    throw new PlatformApiError(
      "CLASSIFIER_EFFECT_REQUIRED",
      422,
      "A classifier may only narrow or sort entitlement candidates",
    )
  }

  if (isRouteLease(response)) {
    throw new PlatformApiError("ROUTE_LEASE_REQUEST_HOOK_REQUIRED", 422)
  }
}

function assertDraftDataProtectionConfigs(steps: readonly EnforcementStep[]): void {
  for (const step of steps) {
    if (!isProcessStep(step)) continue
    assertDataProtectionConfig(step.hooks.request)
    assertDataProtectionConfig(step.hooks.response)
  }
}

type ObserveHook = "request" | "attempt" | "response"

function observeOccurrences(steps: ObserveStep[]) {
  return steps.flatMap((step, index) =>
    (Object.entries(step.hooks) as Array<
      [ObserveHook, ObserveStep["hooks"][ObserveHook]]
    >)
      .filter((entry): entry is [ObserveHook, NonNullable<typeof entry[1]>] =>
        Boolean(entry[1]),
      )
      .map(([hook, action]) => ({
        action: action.action.trim().toUpperCase(),
        hook,
        index,
      })),
  )
}

function executesBefore(
  left: { hook: ObserveHook; index: number },
  right: { hook: ObserveHook; index: number },
): boolean {
  const hookRank: Record<ObserveHook, number> = { request: 0, attempt: 1, response: 2 }
  if (hookRank[left.hook] !== hookRank[right.hook]) {
    return hookRank[left.hook] < hookRank[right.hook]
  }
  // Envoy response filters run in the reverse of request/filter insertion order.
  return left.hook === "response" ? left.index > right.index : left.index < right.index
}

function assertDependencies(steps: EnforcementStep[]): void {
  const byId = new Map(steps.map((step) => [step.step_id, step]))
  const positionById = new Map(steps.map((step, index) => [step.step_id, index]))
  for (const [stepIndex, step] of steps.entries()) {
    for (const dependencyId of step.depends_on ?? []) {
      const dependency = byId.get(dependencyId)
      if (!dependency) {
        throw new PlatformApiError("ENFORCEMENT_DEPENDENCY_NOT_FOUND", 422, dependencyId)
      }
      if ((positionById.get(dependencyId) ?? stepIndex) >= stepIndex) {
        throw new PlatformApiError(
          "ENFORCEMENT_DEPENDENCY_SEQUENCE_INVALID",
          422,
          `${dependencyId} must execute before ${step.step_id}`,
        )
      }
    }
  }
}

function externalFilterOrders(steps: EnforcementStep[]): {
  request: string[]
  response: string[]
} {
  const externalFilters = steps.filter(
    (step) => step.kind === "AUTHORIZE" || isProcessStep(step),
  )
  return {
    request: externalFilters.map((step) => step.step_id),
    response: externalFilters
      .filter((step): step is ProcessStep => isProcessStep(step) && Boolean(step.hooks.response))
      .map((step) => step.step_id)
      .reverse(),
  }
}

function sameOrder(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
}

function assertChainSemantics(steps: EnforcementStep[]): void {
  const positionById = new Map(steps.map((step, index) => [step.step_id, index]))
  const positionOf = (step: EnforcementStep): number =>
    positionById.get(step.step_id) ?? Number.MAX_SAFE_INTEGER
  const authentication = steps.filter((step) => step.kind === "AUTHENTICATE")
  const authorization = steps.filter((step) => step.kind === "AUTHORIZE")
  const routes = steps.filter((step) => step.kind === "ROUTE")
  if (authentication.length > 1 || authorization.length > 1) {
    throw new PlatformApiError("AUTHENTICATION_AUTHORIZATION_DUPLICATE", 422)
  }
  if (authentication.length !== authorization.length) {
    throw new PlatformApiError(
      "AUTHENTICATION_AUTHORIZATION_PAIR_REQUIRED",
      422,
      "Authentication and authorization must be configured together",
    )
  }
  if (authentication[0]) {
    validateNativeJwtAuthenticationConfig(authentication[0].config)
  }
  if (routes.length !== 1) {
    throw new PlatformApiError("ROUTE_ANCHOR_REQUIRED", 422)
  }
  if (authentication[0] && authorization[0] &&
      positionOf(authentication[0]) >= positionOf(authorization[0])) {
    throw new PlatformApiError("AUTHENTICATION_MUST_PRECEDE_AUTHORIZATION", 422)
  }

  const route = routes[0]
  if (authorization[0] && positionOf(authorization[0]) >= positionOf(route)) {
    throw new PlatformApiError("AUTHORIZATION_MUST_PRECEDE_ROUTE", 422)
  }
  for (const step of steps) {
    if (!isProcessStep(step)) continue
    assertProcessStep(step)
    if (positionOf(step) >= positionOf(route)) {
      throw new PlatformApiError(
        "PROCESS_MUST_PRECEDE_ROUTE_FILTER",
        422,
        "External processors are inserted before Envoy's fixed router filter",
      )
    }
    if (changesEntitlementCandidates(step.hooks.request) && positionOf(step) >= positionOf(route)) {
      throw new PlatformApiError("CANDIDATE_EFFECT_MUST_PRECEDE_ROUTE", 422)
    }
    if (isRouteLease(step.hooks.request) && positionOf(step) >= positionOf(route)) {
      throw new PlatformApiError("ROUTE_LEASE_MUST_PRECEDE_MODEL_SELECTION", 422)
    }
    if (actionName(step.hooks.request) === "TOKENIZE" && positionOf(step) >= positionOf(route)) {
      throw new PlatformApiError("TOKENIZATION_MUST_PRECEDE_PROVIDER", 422)
    }
  }

  const observationActions = observeOccurrences(
    steps.filter(isObserveStep),
  )
  const usage = observationActions.find((item) => item.action === "USAGE_EXTRACTION")
  const accounting = observationActions.find((item) => item.action === "ACCOUNTING")
  if (accounting && (!usage || !executesBefore(usage, accounting))) {
    throw new PlatformApiError("USAGE_EXTRACTION_MUST_PRECEDE_ACCOUNTING", 422)
  }
}

/**
 * Revalidate a persisted compiled chain before a release signs it. This keeps
 * old or malformed stored data from bypassing the current execution-order
 * invariants merely because it still matches the structural TypeBox schema.
 */
export function validateCompiledEnforcementChainSemantics(
  chain: CompiledEnforcementChain,
): void {
  if (!Check(CompiledEnforcementChainSchema, chain)) {
    throw new PlatformApiError("ENFORCEMENT_CHAIN_CONTRACT_INVALID", 422)
  }
  const ids = new Set<string>()
  for (const step of chain.steps) {
    if (ids.has(step.step_id)) {
      throw new PlatformApiError("DUPLICATE_ENFORCEMENT_STEP", 422)
    }
    ids.add(step.step_id)
  }
  assertDependencies(chain.steps)
  assertChainSemantics(chain.steps)
  const expected = externalFilterOrders(chain.steps)
  if (!sameOrder(chain.request_filter_order, expected.request)) {
    throw new PlatformApiError("ENFORCEMENT_REQUEST_FILTER_ORDER_INVALID", 422)
  }
  if (!sameOrder(chain.response_filter_order, expected.response)) {
    throw new PlatformApiError("ENFORCEMENT_RESPONSE_FILTER_ORDER_INVALID", 422)
  }
}

async function assertScope(
  scope: EnforcementChainScope,
  input: { tenantId: string; value: CompileEnforcementChainInput },
): Promise<void> {
  const resource = await scope.resources.getResource({
    tenantId: input.tenantId,
    resourceId: input.value.resource_id,
  })
  if (resource.tenant_id !== input.tenantId) {
    throw new PlatformApiError("ENFORCEMENT_TENANT_MISMATCH", 422)
  }
  if (resource.resource_id !== input.value.resource_id) {
    throw new PlatformApiError("ENFORCEMENT_RESOURCE_MISMATCH", 422)
  }

  const capability = resource.capabilities.find(
    (candidate) => candidate.capability_id === input.value.capability_id,
  )
  if (!capability) {
    throw new PlatformApiError(
      "ENFORCEMENT_CAPABILITY_NOT_FOUND",
      422,
      `Capability ${input.value.capability_id} is not owned by Resource ${input.value.resource_id}`,
    )
  }

  if (
    !Array.isArray(input.value.eligible_connection_ids) ||
    input.value.eligible_connection_ids.length === 0
  ) {
    throw new PlatformApiError("ENFORCEMENT_CONNECTION_CANDIDATES_REQUIRED", 422)
  }
  const uniqueConnectionIds = new Set(input.value.eligible_connection_ids)
  if (uniqueConnectionIds.size !== input.value.eligible_connection_ids.length) {
    throw new PlatformApiError("DUPLICATE_ENFORCEMENT_CONNECTION_CANDIDATE", 422)
  }

  for (const connectionId of input.value.eligible_connection_ids) {
    const connection = await scope.connections.get({
      tenantId: input.tenantId,
      resourceId: input.value.resource_id,
      connectionId,
    })
    if (connection.tenant_id !== input.tenantId) {
      throw new PlatformApiError("ENFORCEMENT_TENANT_MISMATCH", 422)
    }
    if (
      connection.resource_id !== input.value.resource_id ||
      connection.connection_id !== connectionId
    ) {
      throw new PlatformApiError("ENFORCEMENT_CONNECTION_MISMATCH", 422)
    }
    const certificateStatus = connection.certificate?.status
    const certificateUsable = certificateStatus === undefined ||
      ["NOT_CONFIGURED", "VALID", "EXPIRING"].includes(certificateStatus)
    if (
      connection.status !== "READY" ||
      connection.lifecycle !== "ENABLED" ||
      connection.verification_state !== "VERIFIED" ||
      connection.health_state !== "HEALTHY" ||
      !certificateUsable
    ) {
      throw new PlatformApiError(
        "ENFORCEMENT_CONNECTION_NOT_READY",
        409,
        `Connection ${connectionId} is not ready for an admitted route candidate set`,
      )
    }
  }
}

export function createEnforcementChainCompiler(
  scope: EnforcementChainScope,
): EnforcementChainCompiler {
  return {
    async listEligibleConnectionIds({ tenantId, resourceId }): Promise<string[]> {
      const connections = await scope.connections.list({ tenantId, resourceId })
      const readyConnectionIds = connections
        .filter((connection) => {
          const certificateStatus = connection.certificate?.status
          const certificateUsable = certificateStatus === undefined ||
            ["NOT_CONFIGURED", "VALID", "EXPIRING"].includes(certificateStatus)
          return connection.status === "READY" &&
            connection.lifecycle === "ENABLED" &&
            connection.verification_state === "VERIFIED" &&
            connection.health_state === "HEALTHY" &&
            certificateUsable
        })
        .map((connection) => connection.connection_id)
      if (readyConnectionIds.length === 0) {
        throw new PlatformApiError(
          "ENFORCEMENT_CONNECTION_CANDIDATES_REQUIRED",
          422,
          "An Enforcement Chain requires at least one READY Resource-owned Connection",
        )
      }
      return readyConnectionIds
    },

    async compile(input: {
      tenantId: string
      value: CompileEnforcementChainInput
    }): Promise<CompiledEnforcementChain> {
      const value = input.value
      // Resolve ownership before validating or emitting the chain.  Resource
      // and Connection registries are tenant-scoped, and the returned records
      // are checked as defense in depth against an adapter that accidentally
      // returns an out-of-scope row.
      await assertScope(scope, input)
      const ids = new Set<string>()
      for (const step of value.steps) {
        if (ids.has(step.step_id)) throw new PlatformApiError("DUPLICATE_ENFORCEMENT_STEP", 422)
        ids.add(step.step_id)
      }
      // The array is the sole sequence authority. Keeping a second numeric
      // order on every step makes drag/drop edits ambiguous and can disagree
      // with the serialized chain.
      const steps = [...value.steps]
      assertDraftDataProtectionConfigs(steps)
      assertDependencies(steps)
      assertChainSemantics(steps)

      const filterOrders = externalFilterOrders(steps)
      return {
        chain_id: chainId(
          input.tenantId,
          value.resource_id,
          value.capability_id,
          value.one_policy_revision,
        ),
        tenant_id: input.tenantId,
        resource_id: value.resource_id,
        capability_id: value.capability_id,
        eligible_connection_ids: [...value.eligible_connection_ids],
        one_policy_revision: value.one_policy_revision,
        steps,
        request_filter_order: filterOrders.request,
        response_filter_order: filterOrders.response,
      }
    },
  }
}
