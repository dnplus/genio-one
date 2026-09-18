import grpc from "@grpc/grpc-js"
import { createClient } from "redis"

import { createExternalProcessorServer } from "./grpc"
import { FileProcessorPolicyStore } from "./policy-store"
import { EncryptedValkeyTokenVault } from "./token-vault"
import { ValkeyGatewayModelRouteResolver } from "./model-route-lease"
import { policyReleaseLoaderOptionsFromEnvironment } from "../shared/policy-release"
import { startGatewaySidecarReadinessServer } from "../shared/release-readiness"
import { startProcessorHttpBridge } from "./http"
import { createOtlpGatewayDetailCapture } from "../../../../packages/telemetry/src/otlp-detail-capture"
import { createValkeyUsageCounterStore } from "../shared/usage-governance-valkey"

const listen = process.env.GENIO_ONE_AI_PROCESSOR_LISTEN ?? "0.0.0.0:8082"
const readinessListen =
  process.env.GENIO_ONE_AI_PROCESSOR_READINESS_LISTEN ?? "127.0.0.1:9082"
const httpListen =
  process.env.GENIO_ONE_AI_PROCESSOR_HTTP_LISTEN ?? "0.0.0.0:8182"
const detailCaptureListen =
  process.env.GENIO_ONE_DETAIL_CAPTURE_LISTEN ?? "0.0.0.0:8083"
const valkeyOrigin = process.env.GENIO_ONE_VALKEY_ORIGIN
const encodedEncryptionKey = process.env.GENIO_ONE_TOKEN_VAULT_KEY
const observationOrigin = process.env.GENIO_ONE_GATEWAY_OBSERVATION_ORIGIN?.replace(/\/$/, "")
const detailOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
const detailCapture = detailOtlpEndpoint
  ? createOtlpGatewayDetailCapture({ endpoint: detailOtlpEndpoint })
  : undefined

async function deliverActivity(event: Parameters<NonNullable<
  Parameters<typeof createExternalProcessorServer>[0]["onActivity"]
>>[0]): Promise<void> {
  if (!observationOrigin) return
  const response = await fetch(`${observationOrigin}/activities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  })
  if (!response.ok) throw new Error(`activity delivery failed (${response.status})`)
}

async function deliverAccounting(event: Parameters<NonNullable<
  Parameters<typeof createExternalProcessorServer>[0]["onAccounting"]
>>[0]): Promise<void> {
  if (!observationOrigin) return
  const response = await fetch(`${observationOrigin}/accounting`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  })
  if (!response.ok) throw new Error(`accounting delivery failed (${response.status})`)
}

if (!valkeyOrigin || !encodedEncryptionKey) {
  throw new Error("GENIO_ONE_VALKEY_ORIGIN and GENIO_ONE_TOKEN_VAULT_KEY are required")
}

const policyStore = new FileProcessorPolicyStore(
  policyReleaseLoaderOptionsFromEnvironment(),
)
const vault = new EncryptedValkeyTokenVault(
  valkeyOrigin,
  Buffer.from(encodedEncryptionKey, "base64"),
)
const modelRouter = new ValkeyGatewayModelRouteResolver(valkeyOrigin)
const usageValkey = createClient({ url: valkeyOrigin })
await usageValkey.connect()
const usageCounterStore = createValkeyUsageCounterStore(usageValkey)
// The process may start before the first empty release exists. Readiness is
// UNKNOWN and each ext_proc stream fails closed until it can pin CURRENT/LKG.
const readiness = await startGatewaySidecarReadinessServer(
  readinessListen,
  "PROCESSOR",
  policyStore,
)
const server = createExternalProcessorServer({
  policySource: policyStore,
  tokenVault: vault,
  modelRouter,
  usageCounterStore,
  ...(detailCapture ? { detailCapture } : {}),
  ...(observationOrigin
    ? {
        onActivity: deliverActivity,
        onAccounting: deliverAccounting,
      }
    : {}),
})
const detailCaptureServer = createExternalProcessorServer({
  policySource: policyStore,
  tokenVault: vault,
  modelRouter,
  captureOnly: true,
  ...(detailCapture ? { detailCapture } : {}),
})
const httpBridge = startProcessorHttpBridge({
  listen: httpListen,
  policySource: policyStore,
  tokenVault: vault,
  modelRouter,
  ...(observationOrigin ? { onActivity: deliverActivity } : {}),
})

function bind(server: grpc.Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

try {
  await Promise.all([
    bind(server, listen),
    bind(detailCaptureServer, detailCaptureListen),
  ])
} catch (error) {
  await readiness.close()
  httpBridge.closeAllConnections()
  httpBridge.close()
  await vault.close()
  await modelRouter.close()
  if (usageValkey.isOpen) await usageValkey.quit()
  throw error
}

let stopping = false
const shutdown = async () => {
  if (stopping) return
  stopping = true
  await readiness.close()
  httpBridge.closeAllConnections()
  httpBridge.close()
  await vault.close()
  await modelRouter.close()
  if (usageValkey.isOpen) await usageValkey.quit()
  await Promise.all([
    new Promise<void>((resolve) => server.tryShutdown(() => resolve())),
    new Promise<void>((resolve) => detailCaptureServer.tryShutdown(() => resolve())),
  ])
}
process.once("SIGTERM", () => void shutdown().catch(() => process.exitCode = 1))
process.once("SIGINT", () => void shutdown().catch(() => process.exitCode = 1))
