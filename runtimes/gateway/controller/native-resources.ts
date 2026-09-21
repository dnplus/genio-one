import { canonicalJson } from "@genioone/protocol/canonical"

function identity(resource: Record<string, any>): string {
  const apiVersion = resource.apiVersion
  const kind = resource.kind
  const namespace = resource.metadata?.namespace ?? ""
  const name = resource.metadata?.name
  if (![apiVersion, kind, name].every((value) => typeof value === "string" && value)) {
    throw new Error("GATEWAY_NATIVE_RESOURCE_IDENTITY_INVALID")
  }
  return `${apiVersion}\u0000${kind}\u0000${namespace}\u0000${name}`
}

function displayIdentity(resource: Record<string, any>): string {
  return identity(resource).replaceAll("\u0000", "/")
}

function accessLogSettings(resource: Record<string, any>): Array<Record<string, any>> {
  const value = resource.spec?.telemetry?.accessLog?.settings
  return Array.isArray(value) ? value : []
}

function withoutComposableTelemetry(resource: Record<string, any>): Record<string, any> {
  const clone = structuredClone(resource)
  if (clone.spec?.telemetry?.accessLog) delete clone.spec.telemetry.accessLog
  if (clone.spec?.telemetry?.tracing) delete clone.spec.telemetry.tracing
  if (clone.spec?.telemetry?.metrics) delete clone.spec.telemetry.metrics
  // Filter ordering is process-wide too. Older immutable projections may
  // contain only a subset of the current order, so it is merged explicitly
  // below instead of making every historical projection byte-identical.
  if (clone.spec?.filterOrder) delete clone.spec.filterOrder
  if (clone.spec?.telemetry && Object.keys(clone.spec.telemetry).length === 0) {
    delete clone.spec.telemetry
  }
  return clone
}

function mergeConflict(resource: Record<string, any>): Error {
  return new Error(`GATEWAY_NATIVE_RESOURCE_CONFLICT:${displayIdentity(resource)}`)
}

/**
 * Merge fields that are opinions about the same Gateway-level object.
 * Missing fields are treated as no opinion (which lets a newer projection
 * provide a default for an older one); two explicit, different values still
 * fail closed. Arrays remain atomic because their ordering is semantic.
 */
function mergeCompatible(
  left: unknown,
  right: unknown,
  resource: Record<string, any>,
): unknown {
  if (left === undefined) return structuredClone(right)
  if (right === undefined) return structuredClone(left)
  if (Array.isArray(left) || Array.isArray(right)) {
    if (canonicalJson(left) !== canonicalJson(right)) throw mergeConflict(resource)
    return structuredClone(left)
  }
  if (
    left && typeof left === "object" &&
    right && typeof right === "object"
  ) {
    const merged: Record<string, unknown> = {}
    const keys = new Set([
      ...Object.keys(left as Record<string, unknown>),
      ...Object.keys(right as Record<string, unknown>),
    ])
    for (const key of keys) {
      merged[key] = mergeCompatible(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        resource,
      )
    }
    return merged
  }
  if (canonicalJson(left) !== canonicalJson(right)) throw mergeConflict(resource)
  return structuredClone(left)
}

function mergeFilterOrder(
  resources: readonly Record<string, any>[],
  resource: Record<string, any>,
): Array<Record<string, unknown>> | undefined {
  const byName = new Map<string, Record<string, unknown>>()
  for (const candidate of resources) {
    const filterOrder = candidate.spec?.filterOrder
    if (filterOrder === undefined) continue
    if (!Array.isArray(filterOrder)) throw mergeConflict(resource)
    for (const entry of filterOrder) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw mergeConflict(resource)
      }
      const name = (entry as Record<string, unknown>).name
      if (typeof name !== "string" || !name) throw mergeConflict(resource)
      const value = structuredClone(entry) as Record<string, unknown>
      const existing = byName.get(name)
      if (existing && canonicalJson(existing) !== canonicalJson(value)) throw mergeConflict(resource)
      byName.set(name, value)
    }
  }
  if (byName.size === 0) return undefined
  return [...byName.values()].sort((left, right) =>
    String(left.name).localeCompare(String(right.name)),
  )
}

function mergeMetrics(resources: readonly Record<string, any>[]): Record<string, any> | undefined {
  const values = resources
    .map((resource) => resource.spec?.telemetry?.metrics)
    .filter((value): value is Record<string, any> => value !== undefined)
  if (values.length === 0) return undefined
  const canonical = canonicalJson(values[0])
  if (values.some((value) => canonicalJson(value) !== canonical)) {
    throw new Error(`GATEWAY_NATIVE_RESOURCE_CONFLICT:${displayIdentity(resources[0]!)}`)
  }
  return structuredClone(values[0])
}

function mergeTracing(resources: readonly Record<string, any>[]): Record<string, any> | undefined {
  const values = resources
    .map((resource) => resource.spec?.telemetry?.tracing)
    .filter((value): value is Record<string, any> => value !== undefined)
  if (values.length === 0) return undefined
  const withoutTags = (value: Record<string, any>) => {
    const clone = structuredClone(value)
    delete clone.customTags
    return clone
  }
  const canonical = canonicalJson(withoutTags(values[0]!))
  if (values.some((value) => canonicalJson(withoutTags(value)) !== canonical)) {
    throw new Error(`GATEWAY_NATIVE_RESOURCE_CONFLICT:${displayIdentity(resources[0]!)}`)
  }
  const merged = structuredClone(values[0]!)
  const customTags: Record<string, unknown> = {}
  for (const value of values) {
    for (const [name, tag] of Object.entries(value.customTags ?? {})) {
      const previous = customTags[name]
      if (previous !== undefined && canonicalJson(previous) !== canonicalJson(tag)) {
        throw new Error(`GATEWAY_NATIVE_RESOURCE_CONFLICT:${displayIdentity(resources[0]!)}`)
      }
      customTags[name] = structuredClone(tag)
    }
  }
  if (Object.keys(customTags).length > 0) merged.customTags = customTags
  return merged
}

function mergeAccessLogSettings(
  resources: readonly Record<string, any>[],
): Array<Record<string, any>> {
  const anchor = resources[0]!
  const byOptions = new Map<string, {
    options: Record<string, any>
    format?: unknown
    sinks: Map<string, unknown>
  }>()
  for (const resource of resources) {
    for (const original of accessLogSettings(resource)) {
      const setting = structuredClone(original)
      const json = setting.format?.json
      if (json && typeof json === "object") {
        if (
          typeof json["genio.subject.id"] === "string" &&
          /^%DYNAMIC_METADATA\(envoy\.filters\.http\.jwt_authn:[^:)]+:sub\)%$/.test(
            json["genio.subject.id"],
          )
        ) {
          json["genio.subject.id"] =
            "%DYNAMIC_METADATA(genio.one.processor:x-genio-trusted-subject-id)%"
        }
        if (
          typeof json["genio.client.id"] === "string" &&
          /^%DYNAMIC_METADATA\(envoy\.filters\.http\.jwt_authn:[^:)]+:azp\)%$/.test(
            json["genio.client.id"],
          )
        ) {
          json["genio.client.id"] =
            "%DYNAMIC_METADATA(genio.one.processor:x-genio-trusted-client-id)%"
        }
      }
      const options = structuredClone(setting)
      delete options.format
      delete options.sinks
      const key = canonicalJson(options)
      const current = byOptions.get(key) ?? {
        options,
        sinks: new Map<string, unknown>(),
      }
      current.format = mergeCompatible(current.format, setting.format, anchor)
      const sinks = Array.isArray(setting.sinks) ? setting.sinks : []
      for (const sink of sinks) {
        const type = sink?.type
        if (typeof type !== "string" || !type) throw mergeConflict(anchor)
        current.sinks.set(
          type,
          mergeCompatible(current.sinks.get(type), sink, anchor),
        )
      }
      byOptions.set(key, current)
    }
  }
  return [...byOptions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, setting]) => ({
      ...setting.options,
      ...(setting.format === undefined ? {} : { format: setting.format }),
      sinks: [...setting.sinks.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, sink]) => sink),
    }))
}

function mergeEnvoyProxy(resources: readonly Record<string, any>[]): Record<string, any> {
  const first = structuredClone(resources[0]!)
  const base = resources
    .slice(1)
    .reduce<unknown>(
      (merged, resource) => mergeCompatible(
        merged,
        withoutComposableTelemetry(resource),
        first,
      ),
      withoutComposableTelemetry(first),
    ) as Record<string, any>
  const filterOrder = mergeFilterOrder(resources, first)
  Object.assign(first, base)
  if (filterOrder) {
    first.spec ??= {}
    first.spec.filterOrder = filterOrder
  }
  const settings = mergeAccessLogSettings(resources)
  const tracing = mergeTracing(resources)
  const metrics = mergeMetrics(resources)
  if (tracing) {
    first.spec ??= {}
    first.spec.telemetry ??= {}
    first.spec.telemetry.tracing = tracing
  }
  if (metrics) {
    first.spec ??= {}
    first.spec.telemetry ??= {}
    first.spec.telemetry.metrics = metrics
  }
  if (settings.length > 0) {
    first.spec ??= {}
    first.spec.telemetry ??= {}
    first.spec.telemetry.accessLog ??= {}
    first.spec.telemetry.accessLog.settings = settings
  }
  return first
}

function globalContractRevision(resource: Record<string, any>): number {
  const value = resource.metadata?.annotations?.["genio.one/global-contract-revision"]
  if (value === undefined) return 0
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw mergeConflict(resource)
  }
  const revision = Number(value)
  if (!Number.isSafeInteger(revision)) throw mergeConflict(resource)
  return revision
}

function mergeGlobalContract(resources: readonly Record<string, any>[]): Record<string, any> {
  const revisions = resources.map(globalContractRevision)
  const highest = Math.max(...revisions)
  if (highest === 0) {
    const canonical = canonicalJson(resources[0])
    if (resources.some((resource) => canonicalJson(resource) !== canonical)) {
      throw mergeConflict(resources[0]!)
    }
    return resources[0]!
  }
  const current = resources.filter((_, index) => revisions[index] === highest)
  const canonical = canonicalJson(current[0])
  if (current.some((resource) => canonicalJson(resource) !== canonical)) {
    throw mergeConflict(current[0]!)
  }
  return current[0]!
}

/**
 * Aggregate releases may contain the same Gateway-level native resource in
 * several immutable Publication projections. Identical resources collapse;
 * EnvoyProxy access-log sinks compose; every other conflict fails closed.
 */
export function mergeGatewayNativeResources(
  resources: readonly Record<string, any>[],
): Record<string, any>[] {
  const grouped = new Map<string, Record<string, any>[]>()
  for (const resource of resources) {
    const key = identity(resource)
    grouped.set(key, [...(grouped.get(key) ?? []), resource])
  }
  return [...grouped.values()].map((duplicates) => {
    if (duplicates.length === 1) return duplicates[0]!
    if (duplicates[0]!.kind === "EnvoyProxy") return mergeEnvoyProxy(duplicates)
    if (duplicates[0]!.kind === "GatewayConfig" || duplicates[0]!.kind === "ClientTrafficPolicy") return mergeGlobalContract(duplicates)
    const canonical = canonicalJson(duplicates[0])
    if (duplicates.some((resource) => canonicalJson(resource) !== canonical)) {
      throw new Error(`GATEWAY_NATIVE_RESOURCE_CONFLICT:${displayIdentity(duplicates[0]!)}`)
    }
    return duplicates[0]!
  })
}
