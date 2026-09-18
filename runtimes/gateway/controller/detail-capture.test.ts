import assert from "node:assert/strict"
import test from "node:test"

import { withGatewayDetailCapture } from "./detail-capture"

const resources = [{
  apiVersion: "gateway.networking.k8s.io/v1",
  kind: "HTTPRoute",
  metadata: { name: "public-api", namespace: "genio-one" },
  spec: { rules: [{ backendRefs: [{ name: "upstream" }] }] },
}, {
  apiVersion: "aigateway.envoyproxy.io/v1beta1",
  kind: "MCPRoute",
  metadata: { name: "mcp-tools", namespace: "genio-one" },
  spec: {},
}, {
  apiVersion: "gateway.envoyproxy.io/v1alpha1",
  kind: "EnvoyExtensionPolicy",
  metadata: { name: "public-api-processing", namespace: "genio-one" },
  spec: {
    targetRefs: [{
      group: "gateway.networking.k8s.io",
      kind: "HTTPRoute",
      name: "public-api",
    }],
    lua: [{ type: "Inline", inline: "function envoy_on_request(handle) end" }],
    extProc: [{ backendRefs: [{ name: "genio-one-processor" }] }],
  },
}]

test("enabled detail capture uses one shared service for direct and generated routes", () => {
  const configured = withGatewayDetailCapture(resources, true, "ai-gateway")
  const backend = configured.find((resource) =>
    resource.kind === "Backend" && resource.metadata.name === "genio-one-detail-capture"
  )
  assert.equal(backend?.spec.endpoints[0].fqdn.port, 8083)

  const direct = configured.find((resource) =>
    resource.kind === "EnvoyExtensionPolicy" && resource.metadata.name === "public-api-processing"
  )
  assert.equal(direct?.spec.extProc.length, 2)
  assert.equal(direct?.spec.extProc[0].backendRefs[0].name, "genio-one-detail-capture")
  assert.equal(direct?.spec.extProc[1].backendRefs[0].name, "genio-one-processor")
  assert.deepEqual(direct?.spec.extProc[0].processingMode, {
    request: { body: "Streamed" },
    response: { body: "Streamed" },
  })
  assert.equal(direct?.spec.extProc[0].failOpen, false)

  const gateway = configured.find((resource) =>
    resource.kind === "EnvoyExtensionPolicy" &&
    resource.metadata.name === "ai-gateway-detail-capture"
  )
  assert.equal(gateway?.spec.targetRefs[0].kind, "Gateway")
  assert.equal(gateway?.spec.extProc[0].backendRefs[0].name, "genio-one-detail-capture")
  assert.equal(gateway?.spec.extProc[0].failOpen, false)
})

test("disabled detail capture leaves the signed projection unchanged", () => {
  assert.deepEqual(withGatewayDetailCapture(resources, false, "ai-gateway"), resources)
})
