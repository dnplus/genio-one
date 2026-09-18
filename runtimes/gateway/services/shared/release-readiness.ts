import { createServer, type RequestListener, type Server } from "node:http"

import {
  isGatewayReleaseReference,
  type PolicyReleaseObservation,
} from "./policy-release"

const GATEWAY_SIDECAR_READINESS_SCHEMA_VERSION =
  "genio.one.gateway-sidecar-readiness.v1" as const

export type GatewayPolicySidecarComponent = "AUTHORIZER" | "PROCESSOR"

export interface PolicyReleaseObservationSource {
  releaseObservation(): Promise<PolicyReleaseObservation>
}

export interface GatewaySidecarReadinessServer {
  address: string
  close(): Promise<void>
}

interface LoopbackListenAddress {
  host: "127.0.0.1" | "::1"
  port: number
}

function json(response: Parameters<RequestListener>[1], status: number, body: unknown): void {
  const encoded = JSON.stringify(body)
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(encoded),
    "content-type": "application/json; charset=utf-8",
  })
  response.end(encoded)
}

function parseLoopbackListenAddress(value: string): LoopbackListenAddress {
  let parsed: URL
  try {
    parsed = new URL(`http://${value}`)
  } catch {
    throw new Error("readiness listen address must be loopback host:port")
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "")
  const port = Number.parseInt(parsed.port, 10)
  if (
    (host !== "127.0.0.1" && host !== "::1") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("readiness listen address must be loopback host:port")
  }
  return { host, port }
}

export function createGatewaySidecarReadinessHandler(
  component: GatewayPolicySidecarComponent,
  source: PolicyReleaseObservationSource,
): RequestListener {
  return (request, response) => {
    void (async () => {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET")
        return json(response, 405, { code: "METHOD_NOT_ALLOWED" })
      }
      if (request.url !== "/readyz") {
        return json(response, 404, { code: "NOT_FOUND" })
      }
      try {
        const observation = await source.releaseObservation()
        if (
          (observation.source !== "CURRENT" && observation.source !== "LKG") ||
          !isGatewayReleaseReference(observation.releaseReference)
        ) {
          throw new Error("policy release observation is invalid")
        }
        return json(response, 200, {
          schema_version: GATEWAY_SIDECAR_READINESS_SCHEMA_VERSION,
          component,
          state: "READY",
          source: observation.source,
          release: observation.releaseReference,
        })
      } catch {
        return json(response, 503, {
          schema_version: GATEWAY_SIDECAR_READINESS_SCHEMA_VERSION,
          component,
          state: "UNKNOWN",
          source: "NONE",
          error: {
            code: "POLICY_RELEASE_UNAVAILABLE",
            message: "Policy release is unavailable",
          },
        })
      }
    })()
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

export async function startGatewaySidecarReadinessServer(
  listen: string,
  component: GatewayPolicySidecarComponent,
  source: PolicyReleaseObservationSource,
): Promise<GatewaySidecarReadinessServer> {
  const address = parseLoopbackListenAddress(listen)
  const server = createServer(createGatewaySidecarReadinessHandler(component, source))
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(address.port, address.host)
  })
  return {
    address: listen,
    close: () => closeServer(server),
  }
}
