import type { ResourceRegistration } from "@/domain/contracts"

export type VersioningPathStrategy = "REPLACE" | "COEXIST"

export function parseResourceVersion(version: string) {
  const trimmed = version.trim()
  const prefixed = /^v(\d+)$/i.exec(trimmed)
  if (prefixed) return Number(prefixed[1])
  const dotted = /^(\d+)(?:\.\d+)*$/.exec(trimmed)
  return dotted ? Number(dotted[1]) : null
}

export function bumpResourceVersion(version: string) {
  const parsed = parseResourceVersion(version)
  return parsed === null ? "v2" : `v${parsed + 1}`
}

export function resourceVersionLineageKey(resource: Pick<ResourceRegistration, "display_name" | "kind" | "owner_organization_id">) {
  return `${resource.owner_organization_id}::${resource.kind}::${resource.display_name.trim().toLowerCase()}`
}

export function versionLineage(resources: ResourceRegistration[], resource: ResourceRegistration) {
  const key = resourceVersionLineageKey(resource)
  return resources.filter((candidate) => resourceVersionLineageKey(candidate) === key)
}

export function nextVersionInLineage(resources: ResourceRegistration[], resource: ResourceRegistration) {
  const numbers = versionLineage(resources, resource)
    .map((candidate) => parseResourceVersion(candidate.version))
    .filter((value): value is number => value !== null)
  return `v${Math.max(0, ...numbers, parseResourceVersion(resource.version) ?? 0) + 1}`
}

export function publicationBasePathForVersion(
  resource: ResourceRegistration,
  strategy: VersioningPathStrategy,
  currentPath: string,
) {
  if (resource.kind === "LLM") return "/"
  const trimmed = currentPath.trim() || "/"
  if (strategy === "REPLACE") return trimmed
  const suffix = `/${resource.version}`
  const withoutSlash = trimmed.replace(/\/+$/, "") || ""
  if (withoutSlash.endsWith(suffix) || withoutSlash.toLowerCase().endsWith(`/${resource.version.toLowerCase()}`)) {
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  }
  return `${withoutSlash}${suffix}` || suffix
}
