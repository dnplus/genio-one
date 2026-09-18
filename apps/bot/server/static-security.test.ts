import { expect, test } from "bun:test"
import Fastify from "fastify"
import fastifyStatic from "@fastify/static"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("SPA static serving preserves fallback without exposing files outside web root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "genio-static-security-"))
  const root = join(directory, "web")
  const app = Fastify()
  try {
    await mkdir(root)
    await writeFile(join(root, "index.html"), "<main>Genio Bot</main>")
    await writeFile(join(root, "asset.js"), "export const ready = true")
    await writeFile(join(directory, "secret.txt"), "outside-root-secret")
    await app.register(fastifyStatic, { root })
    app.setNotFoundHandler((_request, reply) => reply.sendFile("index.html"))
    expect((await app.inject("/asset.js")).body).toBe("export const ready = true")
    expect((await app.inject("/bots/example")).body).toBe("<main>Genio Bot</main>")
    for (const url of ["/../secret.txt", "/%2e%2e/secret.txt", "/%2e%2e%2fsecret.txt", "/..%5csecret.txt"]) {
      const response = await app.inject({ method: "GET", url })
      expect(response.body).not.toContain("outside-root-secret")
      expect(response.statusCode).toBeLessThan(500)
    }
  } finally {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
})
