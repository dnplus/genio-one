import { createArchifyHandler } from "./server"

const bearerToken = process.env.ARCHIFY_CONNECTOR_BEARER_TOKEN ?? ""
if (!bearerToken) throw new Error("ARCHIFY_CONNECTOR_BEARER_TOKEN_REQUIRED")

const server = Bun.serve({
  hostname: process.env.CONNECTOR_HOST ?? "127.0.0.1",
  port: Number(process.env.CONNECTOR_PORT ?? 5193),
  fetch: createArchifyHandler({ bearerToken }),
})

console.info(JSON.stringify({ event: "connector.started", service: "archify", port: server.port }))
