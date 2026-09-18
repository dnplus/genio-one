import { createConnectorHost } from "../host"
import { createServiceNowHandler } from "./server"

const server = Bun.serve({
  hostname: process.env.CONNECTOR_HOST ?? "127.0.0.1",
  port: Number(process.env.CONNECTOR_PORT ?? 58110),
  fetch: createConnectorHost({
    kind: "servicenow-csm",
    configurationKey: process.env.GENIO_CONNECTOR_CONFIGURATION_KEY ?? "",
    discoveryHandler: createServiceNowHandler(),
    configuredHandler(configuration) {
      if (configuration.kind !== "servicenow-csm") throw new Error("CONNECTOR_KIND_MISMATCH")
      return createServiceNowHandler({ instanceUrl: configuration.instance_url })
    },
  }),
})
console.info(JSON.stringify({ event: "connector.started", service: "servicenow-csm", port: server.port }))
