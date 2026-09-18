import { readdir, stat, lstat, unlink, rmdir } from "node:fs/promises"
import { join } from "node:path"

export async function cleanupInactiveOtelSpools(root: string, active: ReadonlySet<string>, now = Date.now()) {
  let removed = 0
  let bytes = 0
  const directories = await readdir(root).catch(() => [])
  for (const name of directories) {
    if (!/^[a-f0-9]{16}$/.test(name) || active.has(name)) continue
    const directory = join(root, name)
    if (!(await lstat(directory).catch(() => null))?.isDirectory()) continue
    const lease = await stat(join(directory, ".lock")).catch(() => null)
    if (lease && now - lease.mtimeMs < 30000) continue
    for (const filename of await readdir(directory).catch(() => [])) {
      const match = /^(\d+)-[a-f0-9-]+\.(json|tmp)$/.exec(filename)
      if (!match || now - Number(match[1]) <= 7200000) continue
      const path = join(directory, filename)
      const metadata = await stat(path).catch(() => null)
      if (metadata && await unlink(path).then(() => true, () => false)) { removed++; bytes += metadata.size }
    }
    await rmdir(directory).catch(() => {})
  }
  return { removed, bytes }
}
