import { createServer } from "vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"

let mailSaved = false
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../..", import.meta.url)),
  server: { host: "127.0.0.1", port: 5188, strictPort: true },
  plugins: [react(), {
    name: "connection-card-test-api",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const base = "/v1/tenants/component-test/me/resource-connections/servicenow-csm"
        if (request.url === "/test-authorization") {
          response.setHeader("content-type", "text/html; charset=utf-8")
          response.end("<!doctype html><html lang='zh-Hant'><title>測試授權頁</title><h1>已到達授權頁</h1><p>這是分段測試；未建立外部登入或儲存任何憑證。</p></html>")
          return
        }
        const mailBase = "/v1/tenants/component-test/me/resource-connections/mail2000"
        if (request.url?.startsWith(mailBase)) {
          response.setHeader("content-type", "application/json")
          if (request.headers.authorization !== "Bearer component-test") { response.statusCode = 401; response.end("{}"); return }
          if (request.url === mailBase && request.method === "GET") response.end(JSON.stringify([{ connection_id: "mail-connection", display_name: "Mail2000", authentication: "PASSWORD", status: mailSaved ? "SAVED" : "NEEDS_CONNECTION" }]))
          else if (request.url === `${mailBase}/mail-connection/password` && request.method === "POST") { request.resume(); mailSaved = true; response.end(JSON.stringify({ status: "SAVED" })) }
          else { response.statusCode = 404; response.end("{}") }
          return
        }
        if (!request.url?.startsWith(base)) return next()
        response.setHeader("content-type", "application/json")
        response.setHeader("cache-control", "no-store")
        if (request.headers.authorization !== "Bearer component-test") {
          response.statusCode = 401
          response.end(JSON.stringify({ code: "UNAUTHENTICATED" }))
        } else if (request.url === base && request.method === "GET") {
          response.end(JSON.stringify([{ connection_id: "sn-connection", display_name: "ServiceNow CSM", authentication: "OAUTH", status: "NEEDS_CONNECTION" }]))
        } else if (request.url === `${base}/sn-connection/authorize` && request.method === "POST") {
          response.end(JSON.stringify({ authorization_url: "http://127.0.0.1:5188/test-authorization", expires_at: Math.floor(Date.now() / 1000) + 600 }))
        } else {
          response.statusCode = 404
          response.end(JSON.stringify({ code: "NOT_FOUND" }))
        }
      })
    },
  }],
})
await server.listen()
console.info("Connection card component test: http://127.0.0.1:5188/tests/connection-card/")
