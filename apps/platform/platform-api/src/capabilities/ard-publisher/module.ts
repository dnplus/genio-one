import { createHash } from "node:crypto"
import { isIP } from "node:net"

import { canonicalJson, compareUtf8 } from "@genioone/protocol/canonical"

import { isPlatformApiError } from "../errors"
import type { GatewayProjectionSnapshot } from "../gateway-projection/contract"
import type { AiResourcePublicationWorkflow } from "../publications/module"
import type { ResourceCatalog } from "../resources/module"

const ARD_MANIFEST_CONTENT_TYPE = "application/json; charset=utf-8"
const MCP_SERVER_CARD_CONTENT_TYPE = "application/mcp-server-card+json; charset=utf-8"
const MCP_SERVER_CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json"
const MCP_SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json"
const CONFIG_KEYS = new Set(["tenant_id", "public_origin", "namespace", "resource_ids"])
const NAMESPACE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const DESCRIPTOR_PATH_KEY = /^([a-f0-9]{64})\.([a-f0-9]{64})$/

export interface ArdPublisherConfig {
  tenantId: string
  publicOrigin: string
  publisherDomain: string
  namespace: string
  resourceIds: ReadonlySet<string>
}

export interface ArdManifestEntry {
  identifier: string
  displayName: string
  type: typeof MCP_SERVER_CARD_MEDIA_TYPE
  url: string
}

export interface ArdManifest {
  entries: ArdManifestEntry[]
}

export interface McpServerCard {
  $schema: typeof MCP_SERVER_CARD_SCHEMA
  name: string
  version: string
  description: string
  remotes: Array<{
    type: "streamable-http"
    url: string
  }>
}

export interface ArdDocument {
  body: ArdManifest | McpServerCard
  contentType: string
}

export interface ArdPublisher {
  manifest(): Promise<ArdDocument>
  descriptor(input: { descriptorKey: string }): Promise<ArdDocument | null>
}

interface PublishedMcpResource {
  descriptorPathKey: string
  entry: ArdManifestEntry
  card: McpServerCard
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`${name} must be a non-empty trimmed string`)
  }
  return value
}

function configuredOrigin(value: unknown): { publicOrigin: string; publisherDomain: string } {
  const raw = requiredString(value, "GENIO_ONE_ARD_PUBLISHER_JSON.public_origin")
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error("GENIO_ONE_ARD_PUBLISHER_JSON.public_origin must be an absolute HTTPS origin")
  }
  const publisherDomain = parsed.hostname.toLowerCase()
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    isIP(publisherDomain) !== 0 ||
    !DOMAIN.test(publisherDomain)
  ) {
    throw new Error("GENIO_ONE_ARD_PUBLISHER_JSON.public_origin must be an HTTPS FQDN origin without credentials or a path")
  }
  return { publicOrigin: parsed.origin, publisherDomain }
}

export function ardPublisherConfigFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ArdPublisherConfig | undefined {
  const raw = environment.GENIO_ONE_ARD_PUBLISHER_JSON
  if (raw === undefined || !raw.trim()) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("GENIO_ONE_ARD_PUBLISHER_JSON must be valid JSON")
  }
  if (!isRecord(parsed)) {
    throw new Error("GENIO_ONE_ARD_PUBLISHER_JSON must be an object")
  }
  if (Object.keys(parsed).some((key) => !CONFIG_KEYS.has(key))) {
    throw new Error("GENIO_ONE_ARD_PUBLISHER_JSON has an unsupported field")
  }
  const tenantId = requiredString(parsed.tenant_id, "GENIO_ONE_ARD_PUBLISHER_JSON.tenant_id")
  const { publicOrigin, publisherDomain } = configuredOrigin(parsed.public_origin)
  const namespace = requiredString(parsed.namespace, "GENIO_ONE_ARD_PUBLISHER_JSON.namespace")
  if (!NAMESPACE.test(namespace)) {
    throw new Error("GENIO_ONE_ARD_PUBLISHER_JSON.namespace must be a lowercase DNS label")
  }
  if (publisherDomain.length + namespace.length + 66 > 200) {
    throw new Error("GENIO_ONE_ARD_PUBLISHER_JSON.public_origin and namespace exceed the MCP Server Card name limit")
  }
  if (!Array.isArray(parsed.resource_ids)) {
    throw new Error("GENIO_ONE_ARD_PUBLISHER_JSON.resource_ids must be an array")
  }
  const resourceIds = new Set<string>()
  for (const value of parsed.resource_ids) {
    const resourceId = requiredString(value, "GENIO_ONE_ARD_PUBLISHER_JSON.resource_ids entry")
    if (resourceIds.has(resourceId)) {
      throw new Error("GENIO_ONE_ARD_PUBLISHER_JSON.resource_ids must be unique")
    }
    resourceIds.add(resourceId)
  }
  return { tenantId, publicOrigin, publisherDomain, namespace, resourceIds }
}

function resourceKey(config: ArdPublisherConfig, resourceId: string): string {
  return createHash("sha256")
    .update(config.tenantId)
    .update("\u0000")
    .update(resourceId)
    .digest("hex")
}

function descriptorKey(card: McpServerCard): string {
  return createHash("sha256").update(canonicalJson(card)).digest("hex")
}

function descriptorPathKey(config: ArdPublisherConfig, resourceId: string, card: McpServerCard): string {
  return `${resourceKey(config, resourceId)}.${descriptorKey(card)}`
}

function descriptorUrl(config: ArdPublisherConfig, key: string): string {
  const [resourceKey, contentKey] = key.split(".")
  return new URL(
    `/.well-known/ard/mcp/${resourceKey}/${contentKey}`,
    config.publicOrigin,
  ).toString()
}

function ardIdentifier(config: ArdPublisherConfig, resourceId: string): string {
  return `urn:air:${config.publisherDomain}:${config.namespace}:resource-${resourceKey(config, resourceId)}`
}

function cardName(config: ArdPublisherConfig, resourceId: string): string {
  return `${config.publisherDomain.split(".").reverse().join(".")}/${config.namespace}-${resourceKey(config, resourceId)}`
}

function publicMcpUrl(snapshot: GatewayProjectionSnapshot): string | null {
  const endpoint = snapshot.publication_endpoint
  if (
    endpoint.visibility !== "PUBLIC" ||
    endpoint.dns_verification !== "VERIFIED" ||
    typeof endpoint.hostname !== "string" ||
    typeof endpoint.base_path !== "string"
  ) {
    return null
  }
  const hostname = endpoint.hostname.toLowerCase()
  const basePath = endpoint.base_path
  if (
    isIP(hostname) !== 0 ||
    !DOMAIN.test(hostname) ||
    !basePath.startsWith("/") ||
    basePath.startsWith("//") ||
    /[\\\u0000-\u001f\u007f\s?#]/.test(basePath) ||
    /%(?:2e|2f|5c)/i.test(basePath)
  ) {
    return null
  }
  const origin = `https://${hostname}`
  let url: URL
  try {
    url = new URL(basePath, origin)
  } catch {
    return null
  }
  if (
    url.origin !== origin ||
    url.pathname !== basePath ||
    url.search ||
    url.hash
  ) {
    return null
  }
  return url.toString()
}

function publishedMcpResource(
  config: ArdPublisherConfig,
  current: { tenant_id: string; resource_id: string; kind: string; lifecycle: string },
  snapshot: GatewayProjectionSnapshot,
): PublishedMcpResource | null {
  if (
    current.tenant_id !== config.tenantId ||
    current.kind !== "MCP" ||
    current.lifecycle !== "PUBLISHED" ||
    snapshot.tenant_id !== config.tenantId ||
    snapshot.resource_id !== current.resource_id ||
    snapshot.resource.tenant_id !== config.tenantId ||
    snapshot.resource.resource_id !== current.resource_id ||
    snapshot.resource.kind !== "MCP" ||
    typeof snapshot.resource.display_name !== "string" ||
    !snapshot.resource.display_name.trim() ||
    typeof snapshot.resource.version !== "string" ||
    !snapshot.resource.version.trim() ||
    snapshot.resource.version.length > 255
  ) {
    return null
  }
  const mcpUrl = publicMcpUrl(snapshot)
  if (!mcpUrl) return null
  const card: McpServerCard = {
    $schema: MCP_SERVER_CARD_SCHEMA,
    name: cardName(config, current.resource_id),
    version: snapshot.resource.version,
    description: "GenioOne MCP server",
    remotes: [{ type: "streamable-http", url: mcpUrl }],
  }
  const key = descriptorPathKey(config, current.resource_id, card)
  return {
    descriptorPathKey: key,
    entry: {
      identifier: ardIdentifier(config, current.resource_id),
      displayName: snapshot.resource.display_name,
      type: MCP_SERVER_CARD_MEDIA_TYPE,
      url: descriptorUrl(config, key),
    },
    card,
  }
}

export function createArdPublisher(input: {
  config: ArdPublisherConfig
  resources: Pick<ResourceCatalog, "getResource">
  publications: Pick<AiResourcePublicationWorkflow, "getPublishedSnapshot">
}): ArdPublisher {
  const resourceIdsByKey = new Map<string, string>()
  const resourceIds = [...input.config.resourceIds].sort(compareUtf8)
  for (const resourceId of resourceIds) {
    const key = resourceKey(input.config, resourceId)
    if (resourceIdsByKey.has(key)) {
      throw new Error("ARD publisher resource key collision")
    }
    resourceIdsByKey.set(key, resourceId)
  }

  const readPublishedResource = async (resourceId: string): Promise<PublishedMcpResource | null> => {
    let current
    try {
      current = await input.resources.getResource({
        tenantId: input.config.tenantId,
        resourceId,
      })
    } catch (error) {
      if (isPlatformApiError(error) && error.code === "RESOURCE_NOT_FOUND") return null
      throw error
    }
    if (current.kind !== "MCP" || current.lifecycle !== "PUBLISHED") return null
    const snapshot = await input.publications.getPublishedSnapshot({
      tenantId: input.config.tenantId,
      resourceId,
    })
    return snapshot ? publishedMcpResource(input.config, current, snapshot) : null
  }

  const publishedResources = async (): Promise<PublishedMcpResource[]> => {
    const values = await Promise.all(resourceIds.map(readPublishedResource))
    return values
      .filter((value): value is PublishedMcpResource => value !== null)
      .sort((left, right) => compareUtf8(left.entry.identifier, right.entry.identifier))
  }

  return {
    async manifest() {
      const entries = (await publishedResources()).map((resource) => resource.entry)
      return { body: { entries }, contentType: ARD_MANIFEST_CONTENT_TYPE }
    },

    async descriptor({ descriptorKey: requestedDescriptorKey }) {
      const parsed = DESCRIPTOR_PATH_KEY.exec(requestedDescriptorKey)
      if (!parsed) return null
      const resourceId = resourceIdsByKey.get(parsed[1]!)
      if (!resourceId) return null
      const resource = await readPublishedResource(resourceId)
      if (!resource || resource.descriptorPathKey !== requestedDescriptorKey) return null
      return { body: resource.card, contentType: MCP_SERVER_CARD_CONTENT_TYPE }
    },
  }
}
