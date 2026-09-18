import type { ConnectionVerifier } from "./capabilities/connections/module"
import type { PublicationDnsVerifier } from "./capabilities/resources/module"
import type { ConnectionCertificate } from "./capabilities/connections/contract"

type HttpFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type TlsRequestInit = RequestInit & { tls?: { ca?: string } }

function certificateFetchInit(certificate: ConnectionCertificate | undefined): RequestInit {
  if (certificate?.mode !== "CUSTOM_CA" || !certificate.certificate_pem) return {}
  return { tls: { ca: certificate.certificate_pem } } as TlsRequestInit
}

function modelsUrl(endpoint: string): URL {
  const url = new URL(endpoint)
  url.pathname = `${url.pathname.replace(/\/$/, "")}/models`
  url.search = ""
  url.hash = ""
  return url
}

async function mcpRequest(
  endpoint: string,
  body: Record<string, unknown>,
  sessionId?: string,
  authorization?: string,
  fetcher: HttpFetcher = fetch,
  certificate?: ConnectionCertificate,
): Promise<{ response: Response; json: Record<string, any> | null }> {
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
    ...certificateFetchInit(certificate),
  } as TlsRequestInit)
  const text = await response.text()
  let json: Record<string, any> | null = null
  if (text.trim()) {
    try {
      const payload = response.headers.get("content-type")?.includes("text/event-stream")
        ? text.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? ""
        : text
      const parsed: unknown = JSON.parse(payload)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        json = parsed as Record<string, any>
      }
    } catch {
      return { response, json: null }
    }
  }
  return { response, json }
}

/** Real network probes used only by the explicit local AI Gateway slice. */
export function createLocalSliceConnectionVerifier(options: {
  credentials?: Readonly<Record<string, string>>
  allowedHosts?: readonly string[]
} = {}): ConnectionVerifier {
  return createHttpConnectionVerifier({
    ...options,
    allowHttp: true,
    allowedHosts: ["127.0.0.1", "localhost", "::1", ...(options.allowedHosts ?? [])],
  })
}

export function createHttpConnectionVerifier(options: {
  credentials?: Readonly<Record<string, string>>
  allowHttp?: boolean
  allowedHosts?: readonly string[]
  fetcher?: HttpFetcher
} = {}): ConnectionVerifier {
  const allowedHosts = new Set(options.allowedHosts ?? [])
  const fetcher = options.fetcher ?? fetch
  return {
    async diagnose(input) {
      let attempts = 0
      let status: number | null = null
      let networkFailure = false
      const diagnosticFetcher: HttpFetcher = async (url, init) => {
        attempts++
        try { const response = await fetcher(url, init); status = response.status; return response }
        catch (caught) { networkFailure = true; throw caught }
      }
      const result = await createHttpConnectionVerifier({ ...options, fetcher: diagnosticFetcher }).verify(input)
      const endpoint = new URL(input.connection.endpoint)
      const reason = endpoint.protocol === "http:" && !options.allowHttp ? "CONNECTION_HTTP_DISABLED"
        : attempts === 0 ? "CONNECTION_LIVE_TEST_UNAVAILABLE"
        : networkFailure ? "CONNECTION_NETWORK_FAILED"
        : result ? "CONNECTION_TEST_PASSED"
        : status === 401 || status === 403 ? "CONNECTION_AUTHENTICATION_FAILED"
        : "CONNECTION_TEST_FAILED"
      return { passed: attempts > 0 && result, reason_code: reason, http_status: status }
    },
    async verify({ connection, providerCredentialProfile }) {
      try {
        const endpoint = new URL(connection.endpoint)
        if (endpoint.protocol !== "https:" && !(options.allowHttp && endpoint.protocol === "http:")) {
          return false
        }
        const gcpRegion = providerCredentialProfile?.strategy.kind === "RUNTIME_IDENTITY"
          ? providerCredentialProfile.strategy.parameters.region
          : providerCredentialProfile?.strategy.kind === "OIDC_FEDERATION"
            ? providerCredentialProfile.strategy.exchange.region
            : connection.region ?? undefined
        const trustedGcpVertexHost = connection.provider_type === "GCP_VERTEX_AI"
          && gcpRegion !== undefined
          && endpoint.hostname === `${gcpRegion}-aiplatform.googleapis.com`
        if (allowedHosts.size > 0 && !allowedHosts.has(endpoint.hostname) && !trustedGcpVertexHost) return false
        if (connection.connection_kind === "MCP") {
        if (
          !connection.connector_configuration && (connection.downstream_identity.mode === "USER_PASSTHROUGH" ||
          connection.downstream_identity.mode === "USER_OAUTH")
        ) {
          const protectedProbe = await mcpRequest(connection.endpoint, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "genio-one-gateway-runtime", version: "0.1.0" },
            },
          }, undefined, undefined, fetcher, connection.certificate)
          // A user credential is intentionally unavailable to the Control Plane.
          // A 401 proves that the configured endpoint is reachable and protected;
          // the real credential is validated only on an invocation through Envoy.
          return protectedProbe.response.status === 401
        }
        const authorization = connection.downstream_identity.mode === "SERVICE"
          ? connection.credential_ref && options.credentials?.[connection.credential_ref]
            ? `Bearer ${options.credentials[connection.credential_ref]}`
            : null
          : undefined
        if (authorization === null) return false
        const initialized = await mcpRequest(connection.endpoint, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "genio-one-gateway-runtime", version: "0.1.0" },
          },
        }, undefined, authorization, fetcher, connection.certificate)
        if (!initialized.response.ok || initialized.json?.result?.protocolVersion !== "2025-06-18") {
          return false
        }
        const sessionId = initialized.response.headers.get("mcp-session-id") ?? undefined
        const notified = await mcpRequest(
          connection.endpoint,
          { jsonrpc: "2.0", method: "notifications/initialized" },
          sessionId,
          authorization,
          fetcher,
          connection.certificate,
        )
        if (![200, 202, 204].includes(notified.response.status)) return false
        const listed = await mcpRequest(
          connection.endpoint,
          { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
          sessionId,
          authorization,
          fetcher,
          connection.certificate,
        )
        return listed.response.ok && Array.isArray(listed.json?.result?.tools)
      }
        if (connection.connection_kind === "API") {
          const response = await fetcher(connection.endpoint, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(5_000),
            ...certificateFetchInit(connection.certificate),
          } as TlsRequestInit)
          return response.status < 500
        }
        if (!connection.provider_type) return false
        if (connection.provider_type === "GCP_VERTEX_AI") {
          return endpoint.protocol === "https:"
            && trustedGcpVertexHost
            && connection.downstream_identity.mode === "SERVICE"
            && connection.downstream_identity.authentication === "PROVIDER_CREDENTIAL_PROFILE"
            && connection.provider_credential_profile !== null
            && connection.provider_credential_profile !== undefined
        }
        const credentialRef = providerCredentialProfile?.strategy.kind === "STATIC_SECRET_REFERENCE"
          ? providerCredentialProfile.strategy.secret_ref
          : connection.credential_ref ?? undefined
        const secret = credentialRef ? options.credentials?.[credentialRef] : undefined
        if (providerCredentialProfile?.strategy.kind === "STATIC_SECRET_REFERENCE" && !secret) return false
        const response = await fetcher(modelsUrl(connection.endpoint), {
          headers: {
            accept: "application/json",
            ...(secret ? { authorization: `Bearer ${secret}` } : {}),
          },
          signal: AbortSignal.timeout(5_000),
          ...certificateFetchInit(connection.certificate),
        } as TlsRequestInit)
        if (!response.ok) return false
        const body: unknown = await response.json()
        return typeof body === "object" && body !== null && "data" in body
      } catch {
        return false
      }
    },
  }
}

export function createLocalSliceDnsVerifier(): PublicationDnsVerifier {
  return {
    async verify({ hostname, dnsTarget }) {
      if (hostname !== "localhost" && !hostname.endsWith(".localhost")) return false
      if (dnsTarget !== null && dnsTarget !== "127.0.0.1" && dnsTarget !== "::1") return false
      return true
    },
  }
}
