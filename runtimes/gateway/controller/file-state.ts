import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { GatewayRuntimeStateStore } from "./runtime"

export function createGatewayRuntimeFileState(path: string): GatewayRuntimeStateStore {
  const candidatePath = `${path}.candidate`
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, "utf8")) as unknown
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        throw error
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(candidatePath, `${JSON.stringify(state)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      })
      await rename(candidatePath, path)
    },
  }
}
