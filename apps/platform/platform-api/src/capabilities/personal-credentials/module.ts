import type { SqlAdapter } from "../../persistence/sql-adapter"
import type { ResourceConnectionRegistry } from "../connections/module"
import type { McpOAuthSecretCodec } from "../mcp-oauth/crypto"
import type { IdentityDirectory } from "../identity/module"
import { mcpOAuthHeaderName } from "../../../../../../runtimes/gateway/services/shared/mcp-oauth-handoff"
import { PlatformApiError } from "../errors"

export interface CredentialOwner {
  tenantId: string
  resourceId: string
  connectionId: string
  subjectId: string
}
export interface PasswordCredentialStore {
  get(owner: CredentialOwner): Promise<string | null>
  put(owner: CredentialOwner, sealed: string): Promise<void>
  remove(owner: CredentialOwner): Promise<void>
}
export function createMemoryPasswordCredentialStore(): PasswordCredentialStore {
  const values = new Map<string, string>()
  const key = (owner: CredentialOwner) => JSON.stringify([owner.tenantId, owner.connectionId, owner.subjectId, owner.resourceId])
  return {
    async get(owner) { return values.get(key(owner)) ?? null },
    async put(owner, value) { values.set(key(owner), value) },
    async remove(owner) { values.delete(key(owner)) },
  }
}
export function createPostgresPasswordCredentialStore(sql: SqlAdapter): PasswordCredentialStore {
  const params = (owner: CredentialOwner) => [owner.tenantId, owner.connectionId, owner.subjectId, owner.resourceId]
  return {
    async get(owner) {
      const result = await sql.query<{ sealed_value: string }>("select sealed_value from genio_one_personal_password_credentials where tenant_id=$1 and connection_id=$2 and subject_id=$3 and resource_id=$4", params(owner))
      return result.rows[0]?.sealed_value ?? null
    },
    async put(owner, value) {
      await sql.query("insert into genio_one_personal_password_credentials (tenant_id, connection_id, subject_id, resource_id, sealed_value) values ($1,$2,$3,$4,$5) on conflict (tenant_id, resource_id, connection_id, subject_id) do update set sealed_value=excluded.sealed_value, updated_at=now()", [...params(owner), value])
    },
    async remove(owner) {
      await sql.query("delete from genio_one_personal_password_credentials where tenant_id=$1 and connection_id=$2 and subject_id=$3 and resource_id=$4", params(owner))
    },
  }
}
export function createPersonalCredentials(options: {
  store: PasswordCredentialStore
  codec: McpOAuthSecretCodec
  connections: Pick<ResourceConnectionRegistry, "get" | "list">
  identity: Pick<IdentityDirectory, "canonicalSubjectId">
}) {
  async function enabled(owner: CredentialOwner & { resourceId: string }) {
    const connection = await options.connections.get(owner)
    if (connection.connection_kind !== "MCP" || connection.downstream_identity.mode !== "USER_PASSWORD" || connection.lifecycle !== "ENABLED") throw new PlatformApiError("PASSWORD_CONNECTION_NOT_ENABLED", 409)
    return connection
  }
  async function resolve(owner: CredentialOwner & { resourceId: string }) {
      const connection = await enabled(owner)
      const sealed = await options.store.get(owner)
      if (!sealed) throw new PlatformApiError("PASSWORD_CONNECTION_REQUIRED", 412)
      const value = options.codec.open<CredentialOwner & { resourceId: string; username: string; password: string; endpoint?: string }>(sealed)
      if (value.tenantId !== owner.tenantId || value.connectionId !== owner.connectionId || value.subjectId !== owner.subjectId || value.resourceId !== owner.resourceId) throw new PlatformApiError("PASSWORD_CREDENTIAL_BINDING_INVALID", 500)
      if (connection.connector_configuration && value.endpoint !== connection.endpoint) throw new PlatformApiError("PASSWORD_CONNECTION_REQUIRED", 412)
      return { username: value.username, password: value.password }
  }
  return {
    async save(owner: CredentialOwner & { resourceId: string }, value: { username: string; password: string }) {
      const connection = await enabled(owner)
      if (!value.username.trim() || value.username.includes(":") || /[\u0000\r\n]/.test(value.username) || !value.password || value.username.length > 512 || value.password.length > 4096) throw new PlatformApiError("PASSWORD_CREDENTIAL_INVALID", 422)
      await options.store.put(owner, options.codec.seal({ ...owner, endpoint: connection.endpoint, username: value.username.trim(), password: value.password }))
      return { status: "SAVED" as const }
    },
    async status(owner: CredentialOwner & { resourceId: string }) {
      try { await resolve(owner); return { status: "SAVED" as const } }
      catch (error) {
        if (error instanceof PlatformApiError && error.code === "PASSWORD_CONNECTION_REQUIRED") return { status: "NEEDS_CONNECTION" as const }
        throw error
      }
    },
    async remove(owner: CredentialOwner) { await options.store.remove(owner) },
    resolve,
    async resolveRequestHeaders(input: { tenantId: string; resourceId: string; subjectId: string; credentialsOptional?: boolean }) {
      const connections = (await options.connections.list(input)).filter((connection) => connection.connection_kind === "MCP" && connection.downstream_identity.mode === "USER_PASSWORD" && connection.lifecycle === "ENABLED" && connection.status === "READY")
      if (!connections.length) return []
      const subjectId = await options.identity.canonicalSubjectId(input)
      if (!subjectId) {
        if (input.credentialsOptional) return []
        throw new PlatformApiError("PASSWORD_SUBJECT_NOT_FOUND", 412)
      }
      const headers = await Promise.all(connections.map(async (connection) => {
        let value
        try { value = await resolve({ ...input, connectionId: connection.connection_id, subjectId }) }
        catch (error) {
          if (input.credentialsOptional && error instanceof PlatformApiError && error.code === "PASSWORD_CONNECTION_REQUIRED") return null
          throw error
        }
        return { name: mcpOAuthHeaderName(connection.connection_id), value: `Basic ${Buffer.from(`${value.username}:${value.password}`, "utf8").toString("base64")}` }
      }))
      return headers.filter((header): header is { name: string; value: string } => header !== null)
    },
  }
}
export type PersonalCredentials = ReturnType<typeof createPersonalCredentials>
