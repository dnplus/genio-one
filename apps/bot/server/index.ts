import { createBotApp } from "./app"


const app = await createBotApp(undefined, { logger: true })
const host = process.env.GENIO_BOT_HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1")
const port = Number.parseInt(process.env.GENIO_BOT_PORT || "5181", 10)
await app.listen({ host, port })

let stopping = false
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    process.stderr.write(`${JSON.stringify({ event: "bot-server.shutdown-signal", signal })}\n`)
    void app.close().then(() => process.exit(0)).catch(() => process.exit(1))
  })
}
