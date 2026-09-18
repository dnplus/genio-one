type NativeResource = Record<string, any>

const ENVOY_GATEWAY_API_VERSION = "gateway.envoyproxy.io/v1alpha1"
const GATEWAY_API_GROUP = "gateway.networking.k8s.io"
const PROCESSOR_BACKEND = "genio-one-detail-capture"

function backend(namespace: string): NativeResource {
  return {
    apiVersion: ENVOY_GATEWAY_API_VERSION,
    kind: "Backend",
    metadata: {
      name: PROCESSOR_BACKEND,
      namespace,
      labels: { "genio.one/shared-component": PROCESSOR_BACKEND },
    },
    spec: {
      endpoints: [{
        fqdn: {
          hostname: `${PROCESSOR_BACKEND}.${namespace}.svc.cluster.local`,
          port: 8083,
        },
      }],
    },
  }
}

function targetNames(resources: readonly NativeResource[]): Array<{
  name: string
  namespace: string
}> {
  const result = new Map<string, { name: string; namespace: string }>()
  const hasAiRoute = resources.some((resource) => resource.kind === "AIGatewayRoute")
  for (const route of resources.filter((resource) => resource.kind === "HTTPRoute")) {
    const name = route.metadata?.name
    const namespace = route.metadata?.namespace ?? "default"
    if (typeof name !== "string" || !name) continue
    const hostnames = Array.isArray(route.spec?.hostnames) ? route.spec.hostnames : []
    if (hostnames.some((hostname: unknown) =>
      typeof hostname === "string" && hostname.endsWith(".internal.invalid")
    )) continue
    if (hasAiRoute) {
      const publicRoute = route.spec?.rules?.some((rule: any) =>
        rule?.backendRefs?.some((reference: any) => reference?.name === "genio-one-aigw-internal")
      )
      if (!publicRoute) continue
    }
    result.set(`${namespace}/${name}`, { name, namespace })
  }
  return [...result.values()]
}

function captureExtProc(namespace: string) {
  return {
    backendRefs: [{
      group: "gateway.envoyproxy.io",
      kind: "Backend",
      name: PROCESSOR_BACKEND,
      namespace,
      port: 8083,
    }],
    processingMode: {
      request: { body: "Streamed" },
      response: { body: "Streamed" },
    },
    failOpen: false,
  }
}

export function withGatewayDetailCapture(
  resources: readonly NativeResource[],
  enabled: boolean,
  gatewayId: string,
): NativeResource[] {
  const configured = resources.map((resource) => structuredClone(resource))
  if (!enabled) return configured
  const targets = targetNames(configured)
  const routeNamespaces = resources.flatMap((resource) =>
    resource.kind === "HTTPRoute" || resource.kind === "MCPRoute" || resource.kind === "AIGatewayRoute"
      ? [resource.metadata?.namespace ?? "default"]
      : []
  )
  const namespaces = [...new Set([...targets.map((target) => target.namespace), ...routeNamespaces])]
  if (namespaces.length === 0) return configured
  for (const namespace of namespaces) {
    const exists = configured.some((resource) =>
      resource.kind === "Backend" &&
      resource.metadata?.name === PROCESSOR_BACKEND &&
      (resource.metadata?.namespace ?? "default") === namespace
    )
    if (!exists) configured.push(backend(namespace))
  }

  for (const target of targets) {
    const policy = configured.find((resource) =>
      resource.kind === "EnvoyExtensionPolicy" &&
      (resource.metadata?.namespace ?? "default") === target.namespace &&
      resource.spec?.targetRefs?.some((reference: any) =>
        reference?.kind === "HTTPRoute" && reference?.name === target.name
      )
    )
    if (policy) {
      policy.spec.extProc = [
        captureExtProc(target.namespace),
        ...(Array.isArray(policy.spec.extProc) ? policy.spec.extProc : []),
      ]
      continue
    }
    configured.push({
      apiVersion: ENVOY_GATEWAY_API_VERSION,
      kind: "EnvoyExtensionPolicy",
      metadata: {
        name: `${target.name}-detail-capture`,
        namespace: target.namespace,
      },
      spec: {
        targetRefs: [{
          group: GATEWAY_API_GROUP,
          kind: "HTTPRoute",
          name: target.name,
        }],
        extProc: [captureExtProc(target.namespace)],
      },
    })
  }
  for (const namespace of namespaces) {
    configured.push({
      apiVersion: ENVOY_GATEWAY_API_VERSION,
      kind: "EnvoyExtensionPolicy",
      metadata: {
        name: `${gatewayId}-detail-capture`,
        namespace,
      },
      spec: {
        targetRefs: [{
          group: GATEWAY_API_GROUP,
          kind: "Gateway",
          name: gatewayId,
        }],
        extProc: [captureExtProc(namespace)],
      },
    })
  }
  return configured
}
