import type { ConnectionRegistration } from "../connections/contract"
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client"
import {
  auth,
  refreshAuthorization,
} from "@modelcontextprotocol/client"
import { createHash, randomBytes, randomUUID } from "node:crypto"

import type { ResourceConnectionRegistry } from "../connections/module"
import type { IdentityDirectory } from "../identity/module"
import { PlatformApiError } from "../errors"
import { mcpOAuthHeaderName } from "../../../../../../runtimes/gateway/services/shared/mcp-oauth-handoff"
import type { McpOAuthAuthorization, McpOAuthBinding } from "./contract"
import type { McpOAuthSecretCodec } from "./crypto"
import { configuredAuthorization, exchangeConfiguredCode, type ConfiguredOAuthClient } from "./configured-client"

export interface McpOAuthSessionRecord {
  tenant_id: string
  session_id: string
  state_hash: string
  resource_id: string
  connection_id: string
  subject_id: string
  return_url: string
  sealed_state: string
  expires_at: number
  created_at: number
}

export interface McpOAuthBindingRecord {
  tenant_id: string
  resource_id: string
  connection_id: string
  subject_id: string
  issuer: string
  resource_url: string
  sealed_state: string
  updated_at: number
}

export interface McpOAuthStore {
  createSession(value: McpOAuthSessionRecord): Promise<void>
  getSessionById(input: { tenantId: string; sessionId: string }): Promise<McpOAuthSessionRecord | null>
  getSessionByStateHash(stateHash: string): Promise<McpOAuthSessionRecord | null>
  updateSession(value: McpOAuthSessionRecord): Promise<void>
  deleteSession(input: { tenantId: string; sessionId: string }): Promise<void>
  putBinding(value: McpOAuthBindingRecord): Promise<void>
  updateBindingIfCurrent(previous: McpOAuthBindingRecord, value: McpOAuthBindingRecord): Promise<boolean>
  getBinding(input: { tenantId: string; connectionId: string; subjectId: string }): Promise<McpOAuthBindingRecord | null>
  deleteBinding(input: { tenantId: string; connectionId: string; subjectId: string }): Promise<void>
  listBindings(input: { tenantId: string; resourceId: string; subjectId: string }): Promise<McpOAuthBindingRecord[]>
}

interface ProviderState {
  state: string
  configured_client?: ConfiguredOAuthClient
  code_verifier?: string
  client_information?: StoredOAuthClientInformation
  tokens?: StoredOAuthTokens
  tokens_saved_at?: number
  discovery_state?: OAuthDiscoveryState
}

class StoredMcpOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null

  constructor(
    private readonly session: McpOAuthSessionRecord,
    private readonly store: McpOAuthStore,
    private readonly codec: McpOAuthSecretCodec,
    private readonly redirect: URL,
    private readonly now: () => number,
  ) {}

  get redirectUrl(): URL {
    return this.redirect
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "GenioOne MCP OAuth",
      client_uri: this.redirect.origin,
      redirect_uris: [this.redirect.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "default",
    }
  }

  async state(): Promise<string> {
    return (await this.load()).state
  }

  async clientInformation(_context?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    return (await this.load()).client_information
  }

  async saveClientInformation(value: StoredOAuthClientInformation): Promise<void> {
    await this.merge({ client_information: value })
  }

  async tokens(_context?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    return (await this.load()).tokens
  }

  async saveTokens(value: StoredOAuthTokens): Promise<void> {
    await this.merge({ tokens: value, tokens_saved_at: this.now() })
  }

  async redirectToAuthorization(value: URL): Promise<void> {
    this.authorizationUrl = value
  }

  async saveCodeVerifier(value: string): Promise<void> {
    await this.merge({ code_verifier: value })
  }

  async codeVerifier(): Promise<string> {
    const value = (await this.load()).code_verifier
    if (!value) throw new PlatformApiError("MCP_OAUTH_SESSION_INVALID", 400)
    return value
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.load()).discovery_state
  }

  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    await this.merge({ discovery_state: value })
  }

  private async load(): Promise<ProviderState> {
    const current = await this.store.getSessionById({
      tenantId: this.session.tenant_id,
      sessionId: this.session.session_id,
    })
    if (!current) throw new PlatformApiError("MCP_OAUTH_SESSION_EXPIRED", 410)
    return this.codec.open<ProviderState>(current.sealed_state)
  }

  private async merge(value: Partial<ProviderState>): Promise<void> {
    const current = await this.store.getSessionById({
      tenantId: this.session.tenant_id,
      sessionId: this.session.session_id,
    })
    if (!current) throw new PlatformApiError("MCP_OAUTH_SESSION_EXPIRED", 410)
    const state = this.codec.open<ProviderState>(current.sealed_state)
    await this.store.updateSession({
      ...current,
      sealed_state: this.codec.seal({ ...state, ...value }),
    })
  }
}

function stateHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

function normalizedOrigin(value: string, code: string): URL {
  const result = new URL(value)
  if (!result.origin || result.username || result.password) throw new Error(code)
  return result
}

export function mcpOAuthReturnUrl(origin: URL, resourceId: string): string {
  const result = new URL("/management", origin)
  result.searchParams.set("view", "connections")
  result.searchParams.set("resource", resourceId)
  return result.toString()
}

function bindingFromRecord(
  record: McpOAuthBindingRecord,
  codec: McpOAuthSecretCodec,
): McpOAuthBinding {
  const state = codec.open<ProviderState>(record.sealed_state)
  const tokens = state.tokens
  const expiresAt = tokens?.expires_in && state.tokens_saved_at
    ? state.tokens_saved_at + tokens.expires_in
    : null
  return {
    tenant_id: record.tenant_id,
    resource_id: record.resource_id,
    connection_id: record.connection_id,
    subject_id: record.subject_id,
    state: "CONNECTED",
    issuer: record.issuer,
    resource_url: record.resource_url,
    scopes: tokens?.scope?.split(/\s+/).filter(Boolean) ?? [],
    expires_at: expiresAt,
    updated_at: record.updated_at,
  }
}

export interface McpOAuthService {
  start(input: { tenantId: string; resourceId: string; connectionId: string; subjectId: string }): Promise<McpOAuthAuthorization>
  complete(input: { state: string; code?: string; iss?: string; error?: string }): Promise<string>
  status(input: { tenantId: string; resourceId: string; connectionId: string; subjectId: string }): Promise<McpOAuthBinding | null>
  disconnect(input: { tenantId: string; connectionId: string; subjectId: string }): Promise<void>
  resolveAccessToken(input: { tenantId: string; connectionId: string; subjectId: string }): Promise<{ accessToken: string; expiresAt: number | null }>
  resolveRequestHeaders(input: { tenantId: string; resourceId: string; subjectId: string; credentialsOptional?: boolean }): Promise<Array<{ name: string; value: string }>>
}

export function createMcpOAuthService(options: {
  store: McpOAuthStore
  connections: ResourceConnectionRegistry
  identity: Pick<IdentityDirectory, "canonicalSubjectId">
  codec: McpOAuthSecretCodec
  publicOrigin: string
  managementUiOrigin: string
  now?: () => number
  idFactory?: () => string
  stateFactory?: () => string
  refreshAuthorization?: typeof refreshAuthorization
  exchangeConfiguredCode?: typeof exchangeConfiguredCode
}): McpOAuthService {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const publicOrigin = normalizedOrigin(options.publicOrigin, "MCP OAuth public origin is invalid")
  const managementUiOrigin = normalizedOrigin(options.managementUiOrigin, "MCP OAuth UI origin is invalid")
  const redirectUrl = new URL("/v1/mcp-oauth/callback", publicOrigin)
  const idFactory = options.idFactory ?? (() => `mcp-oauth-${randomUUID()}`)
  const stateFactory = options.stateFactory ?? (() => randomBytes(32).toString("base64url"))
  const refresh = options.refreshAuthorization ?? refreshAuthorization

  async function usableAccessToken(
    binding: McpOAuthBindingRecord,
    connection: ConnectionRegistration,
  ): Promise<{ accessToken: string; expiresAt: number | null }> {
    if (connection.connector_configuration && binding.resource_url !== connection.endpoint) throw new PlatformApiError("MCP_OAUTH_REAUTHORIZATION_REQUIRED", 412)
    const state = options.codec.open<ProviderState>(binding.sealed_state)
    if (!state.tokens?.access_token) {
      throw new PlatformApiError("MCP_OAUTH_BINDING_INVALID", 500)
    }
    const expiresAt = state.tokens.expires_in && state.tokens_saved_at
      ? state.tokens_saved_at + state.tokens.expires_in
      : null
    if (expiresAt === null || expiresAt > now() + 30) {
      return { accessToken: state.tokens.access_token, expiresAt }
    }
    const discovery = state.discovery_state
    if (!state.tokens.refresh_token || !state.client_information || !discovery) {
      throw new PlatformApiError("MCP_OAUTH_REAUTHORIZATION_REQUIRED", 412)
    }
    let refreshed: StoredOAuthTokens
    try {
      refreshed = await refresh(discovery.authorizationServerUrl, {
        metadata: discovery.authorizationServerMetadata,
        clientInformation: state.client_information,
        refreshToken: state.tokens.refresh_token,
      })
    } catch {
      throw new PlatformApiError("MCP_OAUTH_REAUTHORIZATION_REQUIRED", 412)
    }
    const savedAt = now()
    const tokens = {
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? state.tokens.refresh_token,
      issuer: refreshed.issuer ?? state.tokens.issuer ?? binding.issuer,
    }
    const saved = await options.store.updateBindingIfCurrent(binding, {
      ...binding,
      sealed_state: options.codec.seal({
        ...state,
        tokens,
        tokens_saved_at: savedAt,
      } satisfies ProviderState),
      updated_at: savedAt,
    })
    if (!saved) throw new PlatformApiError("MCP_OAUTH_BINDING_CHANGED", 409)
    const refreshedExpiresAt = tokens.expires_in
      ? savedAt + tokens.expires_in
      : null
    if (!tokens.access_token) throw new PlatformApiError("MCP_OAUTH_BINDING_INVALID", 500)
    return { accessToken: tokens.access_token, expiresAt: refreshedExpiresAt }
  }

  return {
    async start(input) {
      const connection = await options.connections.get({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
        connectionId: input.connectionId,
      })
      if (connection.connection_kind !== "MCP" || connection.downstream_identity.mode !== "USER_OAUTH") {
        throw new PlatformApiError("MCP_OAUTH_CONNECTION_REQUIRED", 422)
      }
      const state = stateFactory()
      const createdAt = now()
      const session: McpOAuthSessionRecord = {
        tenant_id: input.tenantId,
        session_id: idFactory(),
        state_hash: stateHash(state),
        resource_id: input.resourceId,
        connection_id: input.connectionId,
        subject_id: input.subjectId,
        return_url: mcpOAuthReturnUrl(managementUiOrigin, input.resourceId),
        sealed_state: options.codec.seal({ state } satisfies ProviderState),
        expires_at: createdAt + 600,
        created_at: createdAt,
      }
      const configured = connection.downstream_identity.oauth_client
      if (configured) {
        const authorization = configuredAuthorization(configured, state, redirectUrl.toString())
        session.sealed_state = options.codec.seal({
          state,
          configured_client: configured,
          code_verifier: authorization.verifier,
          client_information: { client_id: configured.client_id },
          discovery_state: {
            authorizationServerUrl: configured.issuer,
            authorizationServerMetadata: {
              issuer: configured.issuer,
              authorization_endpoint: configured.authorization_endpoint,
              token_endpoint: configured.token_endpoint,
              response_types_supported: ["code"],
              token_endpoint_auth_methods_supported: ["none"],
            },
          },
        } satisfies ProviderState)
        await options.store.createSession(session)
        return { authorization_url: authorization.url, expires_at: session.expires_at }
      }
      await options.store.createSession(session)
      const provider = new StoredMcpOAuthProvider(
        session,
        options.store,
        options.codec,
        redirectUrl,
        now,
      )
      let result: Awaited<ReturnType<typeof auth>>
      try {
        result = await auth(provider, { serverUrl: connection.endpoint, scope: "default" })
      } catch {
        await options.store.deleteSession({ tenantId: session.tenant_id, sessionId: session.session_id })
        throw new PlatformApiError("MCP_OAUTH_DISCOVERY_FAILED", 422)
      }
      if (result !== "REDIRECT" || !provider.authorizationUrl) {
        await options.store.deleteSession({ tenantId: session.tenant_id, sessionId: session.session_id })
        throw new PlatformApiError("MCP_OAUTH_AUTHORIZATION_UNAVAILABLE", 422)
      }
      return {
        authorization_url: provider.authorizationUrl.toString(),
        expires_at: session.expires_at,
      }
    },

    async complete(input) {
      const session = await options.store.getSessionByStateHash(stateHash(input.state))
      if (!session || session.expires_at <= now()) {
        throw new PlatformApiError("MCP_OAUTH_SESSION_EXPIRED", 410)
      }
      if (input.error || !input.code) {
        await options.store.deleteSession({ tenantId: session.tenant_id, sessionId: session.session_id })
        const result = new URL(session.return_url)
        result.searchParams.set("mcp_oauth", "failed")
        return result.toString()
      }
      const connection = await options.connections.get({
        tenantId: session.tenant_id,
        resourceId: session.resource_id,
        connectionId: session.connection_id,
      })
      const provider = new StoredMcpOAuthProvider(
        session,
        options.store,
        options.codec,
        redirectUrl,
        now,
      )
      try {
        const stored = options.codec.open<ProviderState>(session.sealed_state)
        if (stored.configured_client) {
          if (!stored.code_verifier || (input.iss && input.iss !== stored.configured_client.issuer) || JSON.stringify(connection.downstream_identity.oauth_client) !== JSON.stringify(stored.configured_client)) {
            throw new PlatformApiError("MCP_OAUTH_CALLBACK_INVALID", 400)
          }
          const tokens = await (options.exchangeConfiguredCode ?? exchangeConfiguredCode)({
            client: stored.configured_client,
            code: input.code,
            verifier: stored.code_verifier,
            redirectUri: redirectUrl.toString(),
          })
          await provider.saveTokens(tokens)
        } else {
          const result = await auth(provider, {
            serverUrl: connection.endpoint,
            authorizationCode: input.code,
            ...(input.iss ? { iss: input.iss } : {}),
            scope: "default",
          })
          if (result !== "AUTHORIZED") throw new PlatformApiError("MCP_OAUTH_CALLBACK_INVALID", 400)
        }
      } catch (error) {
        if (error instanceof PlatformApiError) throw error
        throw new PlatformApiError("MCP_OAUTH_TOKEN_EXCHANGE_FAILED", 422)
      }
      const updated = await options.store.getSessionById({
        tenantId: session.tenant_id,
        sessionId: session.session_id,
      })
      if (!updated) throw new PlatformApiError("MCP_OAUTH_SESSION_EXPIRED", 410)
      const state = options.codec.open<ProviderState>(updated.sealed_state)
      const issuer = state.tokens?.issuer ?? state.discovery_state?.authorizationServerMetadata?.issuer
      const resourceUrl = state.discovery_state?.resourceMetadata?.resource ?? connection.endpoint
      if (!issuer || !state.tokens?.access_token) {
        throw new PlatformApiError("MCP_OAUTH_TOKEN_EXCHANGE_FAILED", 422)
      }
      await options.store.putBinding({
        tenant_id: session.tenant_id,
        resource_id: session.resource_id,
        connection_id: session.connection_id,
        subject_id: session.subject_id,
        issuer,
        resource_url: resourceUrl,
        sealed_state: updated.sealed_state,
        updated_at: now(),
      })
      await options.store.deleteSession({ tenantId: session.tenant_id, sessionId: session.session_id })
      const result = new URL(session.return_url)
      result.searchParams.set("mcp_oauth", "connected")
      return result.toString()
    },

    async status(input) {
      const connection = await options.connections.get({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
        connectionId: input.connectionId,
      })
      if (connection.connection_kind !== "MCP") throw new PlatformApiError("MCP_CONNECTION_NOT_FOUND", 404)
      const binding = await options.store.getBinding({
        tenantId: input.tenantId,
        connectionId: input.connectionId,
        subjectId: input.subjectId,
      })
      if (binding && connection.connector_configuration && binding.resource_url !== connection.endpoint) return null
      return binding ? bindingFromRecord(binding, options.codec) : null
    },

    async disconnect(input) {
      await options.store.deleteBinding(input)
    },

    async resolveAccessToken(input) {
      const binding = await options.store.getBinding(input)
      if (!binding) throw new PlatformApiError("MCP_OAUTH_AUTHORIZATION_REQUIRED", 412)
      const connection = await options.connections.get({ tenantId: binding.tenant_id, resourceId: binding.resource_id, connectionId: binding.connection_id })
      return usableAccessToken(binding, connection)
    },

    async resolveRequestHeaders(input) {
      const connections = await options.connections.list({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
      })
      const required = connections.filter((connection) =>
        connection.connection_kind === "MCP" &&
        connection.status === "READY" &&
        connection.downstream_identity.mode === "USER_OAUTH")
      if (required.length === 0) return []
      const canonicalSubjectId = await options.identity.canonicalSubjectId({
        tenantId: input.tenantId,
        subjectId: input.subjectId,
      })
      if (!canonicalSubjectId) {
        if (input.credentialsOptional) return []
        throw new PlatformApiError("MCP_OAUTH_SUBJECT_NOT_FOUND", 412)
      }
      const bindings = await options.store.listBindings({
        ...input,
        subjectId: canonicalSubjectId,
      })
      const byConnection = new Map(bindings.map((binding) => [binding.connection_id, binding]))
      const headers = await Promise.all(required.map(async (connection) => {
        const binding = byConnection.get(connection.connection_id)
        if (!binding) {
          if (input.credentialsOptional) return null
          throw new PlatformApiError("MCP_OAUTH_AUTHORIZATION_REQUIRED", 412)
        }
        let token
        try { token = await usableAccessToken(binding, connection) }
        catch (error) {
          if (input.credentialsOptional && error instanceof PlatformApiError && error.code === "MCP_OAUTH_REAUTHORIZATION_REQUIRED") return null
          throw error
        }
        return {
          name: mcpOAuthHeaderName(connection.connection_id),
          value: `Bearer ${token.accessToken}`,
        }
      }))
      return headers.filter((header): header is { name: string; value: string } => header !== null)
    },
  }
}
