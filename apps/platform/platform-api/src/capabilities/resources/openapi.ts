import { PlatformApiError } from "../errors"
import type { ApiMetadata, OpenApiImportInput, ResourceCreateInput } from "./contract"

const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"])

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function operationId(method: string, path: string, operation: Record<string, unknown>): string {
  const declared = text(operation.operationId)
  const fallback = `${method.toUpperCase()} ${path}`
  const value = declared ?? fallback
  if (value.length > 256 || /[\u0000\r\n]/.test(value)) {
    throw new PlatformApiError("OPENAPI_OPERATION_ID_INVALID", 422)
  }
  return value
}

export function resourceCreateFromOpenApi(input: OpenApiImportInput): ResourceCreateInput {
  const document = object(input.document)
  const info = object(document?.info)
  const paths = object(document?.paths)
  const openapiVersion = text(document?.openapi) ?? text(document?.swagger)
  const title = text(info?.title)
  const documentVersion = text(info?.version)
  if (!document || !paths || !openapiVersion || !title || !documentVersion) {
    throw new PlatformApiError("OPENAPI_DOCUMENT_INVALID", 422)
  }
  if (!input.public_path.startsWith("/") || /[?#\u0000\r\n]/.test(input.public_path)) {
    throw new PlatformApiError("API_PUBLIC_PATH_INVALID", 422)
  }
  const operations: ApiMetadata["operations"] = []
  const ids = new Set<string>()
  for (const [path, pathItemValue] of Object.entries(paths)) {
    if (!path.startsWith("/") || /[?#\u0000\r\n]/.test(path)) {
      throw new PlatformApiError("OPENAPI_PATH_INVALID", 422)
    }
    const pathItem = object(pathItemValue)
    if (!pathItem) continue
    for (const [method, operationValue] of Object.entries(pathItem)) {
      if (!methods.has(method.toLowerCase())) continue
      const operation = object(operationValue)
      if (!operation) throw new PlatformApiError("OPENAPI_OPERATION_INVALID", 422)
      const id = operationId(method, path, operation)
      if (ids.has(id)) throw new PlatformApiError("OPENAPI_OPERATION_ID_DUPLICATE", 422)
      ids.add(id)
      const parameters = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])]
        .flatMap((parameter): Array<{ location: "HEADER" | "QUERY"; name: string }> => {
          const parsed = object(parameter)
          const name = text(parsed?.name)
          const location = parsed?.in === "header" ? "HEADER" : parsed?.in === "query" ? "QUERY" : null
          if (!name || !location) return []
          if (name.length > 256 || /[\u0000\r\n]/.test(name)) {
            throw new PlatformApiError("OPENAPI_PARAMETER_INVALID", 422)
          }
          return [{ location, name }]
        })
      operations.push({
        operation_id: id,
        method: method.toUpperCase(),
        path,
        parameters: [...new Map(parameters.map((parameter) => [
          `${parameter.location}\u0000${parameter.name.toLowerCase()}`,
          parameter,
        ])).values()],
      })
    }
  }
  if (!operations.length) throw new PlatformApiError("OPENAPI_OPERATION_REQUIRED", 422)
  operations.sort((left, right) => left.operation_id.localeCompare(right.operation_id))
  return {
    display_name: title,
    kind: "API",
    owner_organization_id: input.owner_organization_id,
    authentication_strategy: input.authentication_strategy,
    environment_id: input.environment_id,
    version: input.version,
    capabilities: operations.map((operation) => ({
      capability_id: operation.operation_id,
      display_name: `${operation.method} ${operation.path}`,
    })),
    api: {
      api_product_id: `api-product-${crypto.randomUUID()}`,
      openapi_version: openapiVersion,
      document_title: title,
      document_version: documentVersion,
      public_path: input.public_path,
      inbound_security: input.inbound_security,
      request_schema_validation: input.request_schema_validation,
      operations,
      ...(input.a2a ? { a2a: input.a2a } : {}),
    },
    enforcement_point_id: input.enforcement_point_id,
  }
}
