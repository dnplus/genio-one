import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const stateFileName = ".genioone-ce-sync-state.json"
const stateSchema = 2
const reservedTopLevelPaths = new Set([".git", "node_modules", stateFileName])

function sha256(content) {
  return createHash("sha256").update(content).digest("hex")
}

function pathExists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

function globToRegExp(glob) {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*")
  return new RegExp(`^${source}$`)
}

function compileGlobs(globs) {
  return globs.map((glob) => {
    const negated = glob.startsWith("!")
    return { negated, regex: globToRegExp(negated ? glob.slice(1) : glob) }
  })
}

function isSafeRelativePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\") || isAbsolute(path)) return false
  if (posix.normalize(path) !== path) return false
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
}

function assertSafeRelativePath(path, label = "path") {
  if (!isSafeRelativePath(path)) throw new Error(`${label} must be a safe repository-relative path: ${path}`)
  if (reservedTopLevelPaths.has(path.split("/")[0])) {
    throw new Error(`${label} targets a reserved destination path: ${path}`)
  }
}

function assertManagedPath(path, label = "path") {
  assertSafeRelativePath(path, label)
  const parts = path.split("/")
  const basename = parts.at(-1)
  if (parts.some((part) => [".git", "node_modules", ".local", "data", "runtime-data"].includes(part)) || (basename.startsWith(".env") && basename !== ".env.example")) {
    throw new Error(`${label} targets a protected CE path: ${path}`)
  }
}

function pathIsInside(child, parent) {
  const path = relative(parent, child)
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function isExplicitMapping(path, manifest) {
  return (manifest.fileMappings || []).some(({ source }) => path === source || path.startsWith(`${source}/`))
}

function assertNoTrackedSecretPaths(gitFiles) {
  for (const path of gitFiles) {
    assertSafeRelativePath(path, "source path")
    const basename = path.split("/").at(-1)
    if (basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example")) {
      throw new Error(`refusing tracked source secret file: ${path}`)
    }
  }
}

export function isDenied(path, deniedGlobs) {
  const compiled = compileGlobs(deniedGlobs)
  const denied = compiled.filter((entry) => !entry.negated && entry.regex.test(path))
  if (denied.length === 0) return false
  return !compiled.some((entry) => entry.negated && entry.regex.test(path))
}

export function isAllowed(path, manifest) {
  const prefixes = [...manifest.candidatePaths, ...manifest.closurePaths]
  if (manifest.rootFiles.includes(path) || manifest.toolingFiles.includes(path)) return true
  if (isExplicitMapping(path, manifest)) return true
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

export function listedSourceFiles(gitFiles, manifest) {
  assertNoTrackedSecretPaths(gitFiles)
  return gitFiles.filter((path) => {
    assertManagedPath(path, "source path")
    return isAllowed(path, manifest) && (!isDenied(path, manifest.deniedGlobs) || isExplicitMapping(path, manifest))
  })
}

export function destinationPath(sourcePath, manifest) {
  assertManagedPath(sourcePath, "source path")
  const mappings = (manifest.fileMappings || []).filter(({ source }) => sourcePath === source || sourcePath.startsWith(`${source}/`))
  if (mappings.length > 1) throw new Error(`multiple file mappings match ${sourcePath}`)
  if (mappings.length === 0) return sourcePath
  const mapping = mappings[0]
  assertManagedPath(mapping.source, "mapping source")
  assertManagedPath(mapping.destination, "mapping destination")
  const suffix = sourcePath.slice(mapping.source.length).replace(/^\//, "")
  return suffix ? `${mapping.destination}/${suffix}` : mapping.destination
}

function runGit(cwd, args, encoding = "utf8") {
  const result = spawnSync("git", args, { cwd, encoding, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.error?.message || result.stderr?.toString().trim() || result.status}`)
  }
  return result.stdout
}

function gitSnapshot(sourceRoot, sourceRef) {
  const commit = runGit(sourceRoot, ["rev-parse", "--verify", "--end-of-options", `${sourceRef}^{commit}`]).trim()
  const treeDigest = runGit(sourceRoot, ["rev-parse", `${commit}^{tree}`]).trim()
  const tree = runGit(sourceRoot, ["ls-tree", "-r", "-z", commit], "buffer")
  const files = []
  const entries = new Map()
  for (const record of tree.toString("utf8").split("\0")) {
    if (!record) continue
    const match = /^(\d+) (blob|commit) [0-9a-f]+\t(.+)$/.exec(record)
    if (!match) throw new Error(`unable to parse git tree entry: ${record}`)
    files.push(match[3])
    entries.set(match[3], { mode: Number.parseInt(match[1], 8), type: match[2] })
  }
  return {
    files,
    read(path) {
      const entry = entries.get(path)
      if (entry?.type !== "blob" || entry.mode === 0o120000) throw new Error(`refusing non-regular selected source path: ${path}`)
      return runGit(sourceRoot, ["show", `${commit}:${path}`], "buffer")
    },
    mode(path) {
      const mode = entries.get(path)?.mode
      if (mode !== 0o100644 && mode !== 0o100755) throw new Error(`refusing unsupported selected source mode: ${path}`)
      return mode & 0o777
    },
    provenance: { requestedRef: sourceRef, revision: commit, treeDigest },
  }
}

function workingTreeSource(sourceRoot) {
  const listing = runGit(sourceRoot, ["ls-files", "-z"], "buffer")
  const files = listing.toString("utf8").split("\0").filter(Boolean)
  return {
    files,
    read(path) {
      const absolute = resolve(sourceRoot, path)
      const stat = lstatSync(absolute)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`refusing non-regular source file: ${path}`)
      return readFileSync(absolute)
    },
    mode(path) {
      const stat = lstatSync(resolve(sourceRoot, path))
      return stat.mode & 0o111 ? 0o755 : 0o644
    },
    provenance: { requestedRef: "working-tree" },
  }
}

function publicWorkspaceYaml() {
  return `packages:
  - "apps/bot"
  - "apps/platform"
  - "apps/connectors"
  - "runtimes/gateway"
  - "packages/*"

allowBuilds:
  '@google/genai': true
  '@scarf/scarf': true
  '@tree-sitter-grammars/tree-sitter-yaml': true
  core-js-pure: true
  edgedriver: true
  esbuild: true
  geckodriver: true
  protobufjs: true
  tree-sitter: true
  tree-sitter-json: true
  workerd: true
`
}

function publicRootPackage() {
  return {
    name: "genioone",
    private: true,
    version: "0.1.0",
    description: "GenioOne community edition: Control Plane, AI Gateway, and Genio Bot.",
    license: "Apache-2.0",
    scripts: {
      dev: "node tooling/local-dev.mjs",
      "images:build": "node tooling/ce-build-images.mjs",
      "helm:values": "node tooling/ce-helm-values.mjs",
      "ce:verify": "node tooling/ce-verify.mjs",
      "mcp:smoke": "node tooling/ce-mcp-smoke.mjs",
      "dev:bot": "pnpm --filter genio-one-bot dev",
      "dev:platform": "pnpm --filter genio-one dev:platform",
      "env:down": "pnpm --filter genio-one env:down",
      "env:status": "pnpm --filter genio-one env:status",
      "env:logs": "pnpm --filter genio-one env:logs",
      check: "pnpm --filter genio-one typecheck && pnpm --filter genio-one-bot typecheck && pnpm --filter genio-connectors typecheck && pnpm check:packages && pnpm --filter @genioone/gateway typecheck",
      "check:packages": "pnpm --filter @genioone/protocol --filter @genioone/policy --filter @genioone/telemetry typecheck",
      "test:platform-api": "pnpm --filter genio-one test:api",
      test: "pnpm test:platform-api && pnpm --filter genio-one-bot test && pnpm --filter genio-connectors test && pnpm test:packages && pnpm --filter @genioone/gateway test",
      "test:packages": "pnpm --filter @genioone/protocol --filter @genioone/policy --filter @genioone/telemetry test",
      build: "pnpm --filter genio-one build && pnpm --filter genio-one-bot build && pnpm --filter @genioone/gateway build",
      verify: "pnpm check && pnpm test && pnpm build",
    },
    packageManager: "pnpm@12.4.2",
  }
}

function publicReadme() {
  return `<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/brand/assets/logos/genioone-horizontal-color-dark.svg">
    <img src="packages/brand/assets/logos/genioone-horizontal-color-light.svg" alt="GenioOne" width="300">
  </picture>
</p>

<h3 align="center">The control plane for every AI agent and resource</h3>

<p align="center">
  Connect your agents to the tools they need. Control access. See what happened.
</p>

<p align="center">
  <a href="https://genio.sh">Website</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="docs/public/ce/README.md">Documentation</a> ·
  <a href="https://www.producthunt.com/products/genioone?embed=true&amp;utm_source=embed&amp;utm_medium=post_embed">Product Hunt</a> ·
  <a href="README.zh-TW.md">繁體中文</a>
</p>

GenioOne is a self-hosted platform for managing AI agents, MCP tools, and model access. With Community Edition, you can publish tools, define who can use them, work with them in Genio Bot, and review requests in one management console.

![GenioOne resource management](docs/public/ce/assets/resource-management.png)

## Quickstart

You need macOS or Linux, Docker with Compose, Git, Node.js, pnpm **12.4.2**, and Bun **1.4.2**.

\`\`\`sh
curl -fsSL https://genio.sh/install.sh | sh
\`\`\`

This clones the repository, installs dependencies, and prepares \`.env.local\` files. It does not start services; run \`pnpm dev\` yourself. See \`install.sh --help\` for \`--dir\` and \`--ref\` options, or set up manually:

\`\`\`sh
git clone https://github.com/dnplus/genio-one.git
cd genio-one
pnpm install --frozen-lockfile
cp apps/platform/.env.example apps/platform/.env.local
cp apps/bot/.env.example apps/bot/.env.local
pnpm dev
\`\`\`

Open [Management](http://127.0.0.1:5173/management) and sign in with \`admin\` / \`admin\` for local development. Then follow [Gateway setup](docs/public/product/en/initial-setup.md#local-gateway-runtime) to connect your first Runtime.

Open [Genio Bot](http://127.0.0.1:5180/?lang=en) to start working with your tools. Configure your model account or provider credentials before starting a conversation.

See the [installation guide](docs/public/ce/quickstart.md) for prerequisites, service addresses, and restart instructions. These defaults are for local development; configure deployment credentials before exposing services.

## What you can do

- **Connect MCP tools.** Publish services in a shared catalog and connect personal accounts with OAuth.
- **Control access with One Policy.** Grant access to specific tools and apply policy at the Gateway.
- **Work in Genio Bot.** Give a Bot the tools and skills it needs for documentation research and product planning.
- **Inspect each request.** Review identities, policy decisions, selected connections, and correlated activity.

Community Edition includes the Platform management console and API, Gateway Runtime, and Genio Bot under Apache-2.0.

## Try a workflow

**Research → product brief.** Help the fictional Stellar Freight team plan a claims portal. Use Context7 to research framework documentation, then use the bundled Product Management skill to draft requirements and acceptance criteria.

Follow the [demo walkthrough](docs/public/ce/demo.md), or start with a [single MCP request](docs/public/ce/first-mcp-request.md). The walkthrough also covers [connecting Notion with OAuth](docs/public/ce/demo.md#optional-notion-oauth-and-bot-setup).

## Documentation

| Guide | Use it to |
| --- | --- |
| [Local installation](docs/public/ce/quickstart.md) | Start the stack and manage local services |
| [Initial setup](docs/public/product/en/initial-setup.md) | Configure identity, Resources, and a Gateway |
| [Kubernetes deployment](docs/public/ce/helm.md) | Build your images and deploy with Helm |
| [Troubleshooting](docs/public/ce/troubleshooting.md) | Diagnose startup and connection problems |
| [Known issues](docs/public/ce/known-issues.md) | Check current limitations and fixes |

## Feedback and contributions

Report bugs or suggest improvements in [GitHub Issues](https://github.com/dnplus/genio-one/issues). For a bug report, include reproduction steps and your environment; remove credentials and private data from logs.

For code changes, run \`pnpm check\`, \`pnpm test\`, and \`pnpm build\` before opening a pull request.

## Find us on Product Hunt

<table>
  <tr>
    <td><a href="https://www.producthunt.com/products/genioone?embed=true&amp;utm_source=embed&amp;utm_medium=post_embed"><img alt="GenioOne" src="https://ph-files.imgix.net/b3009653-6723-4140-9117-e777f001ff05.png?auto=compress,format&amp;codec=mozjpeg&amp;cs=strip&amp;fit=crop&amp;h=80&amp;w=80" width="64" height="64"></a></td>
    <td><strong>GenioOne</strong><br>The control plane for every AI agent and resource<br><a href="https://www.producthunt.com/products/genioone?embed=true&amp;utm_source=embed&amp;utm_medium=post_embed">Check it out on Product Hunt →</a></td>
  </tr>
</table>

## License

[Apache License 2.0](LICENSE).
`
}

function publicTraditionalChineseReadme() {
  return `<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/brand/assets/logos/genioone-horizontal-color-dark.svg">
    <img src="packages/brand/assets/logos/genioone-horizontal-color-light.svg" alt="GenioOne" width="300">
  </picture>
</p>

<h3 align="center">The control plane for every AI agent and resource</h3>

<p align="center">讓 AI 代理使用需要的工具，管理存取權，追蹤每次操作。</p>

<p align="center">
  <a href="https://genio.sh">官方網站</a> ·
  <a href="#快速開始">快速開始</a> ·
  <a href="docs/public/ce/README.zh-TW.md">使用文件</a> ·
  <a href="https://www.producthunt.com/products/genioone?embed=true&amp;utm_source=embed&amp;utm_medium=post_embed">Product Hunt</a> ·
  <a href="README.md">English</a>
</p>

GenioOne 是可自行架設的 AI 代理、MCP 工具與模型存取管理平台。使用社群版，你可以發布工具、設定使用權限，在 Genio Bot 中執行工作，再從管理介面查看請求紀錄。

![GenioOne 資源管理](docs/public/ce/assets/resource-management.png)

## 快速開始

準備 macOS 或 Linux、Docker 與 Compose、Git、Node.js、pnpm **12.4.2** 及 Bun **1.4.2**。

\`\`\`sh
curl -fsSL https://genio.sh/install.sh | sh
\`\`\`

這個指令會 clone repo、安裝依賴並準備 \`.env.local\`，不會啟動服務；最後請自行執行 \`pnpm dev\`。可用 \`install.sh --help\` 查看安裝選項，或手動安裝：

\`\`\`sh
git clone https://github.com/dnplus/genio-one.git
cd genio-one
pnpm install --frozen-lockfile
cp apps/platform/.env.example apps/platform/.env.local
cp apps/bot/.env.example apps/bot/.env.local
pnpm dev
\`\`\`

開啟 [Management](http://127.0.0.1:5173/management)，使用本機開發帳號 \`admin\`／\`admin\` 登入，再依照[首次設定](docs/public/product/zh-TW/initial-setup.md)連接 Gateway Runtime。

開啟 [Genio Bot](http://127.0.0.1:5180/) 使用工具。開始對話前，請先設定模型帳號或供應者憑證。

完整前置條件、服務位址與重啟方式請看[安裝指南](docs/public/ce/quickstart.md)。上述預設值供本機開發使用，對外部署前請設定正式環境憑證。

## 你可以做什麼

- **連接 MCP 工具**：將服務發布到共用目錄，透過 OAuth 連接個人帳號。
- **使用 One Policy 控管存取**：授予指定工具的權限，並在 Gateway 執行政策。
- **在 Genio Bot 中工作**：為 Bot 加入工具與技能，進行文件研究及產品規劃。
- **查看每次請求**：追蹤操作身分、政策判定、使用的連線與對應活動。

社群版以 Apache-2.0 授權提供 Platform 管理介面與 API、Gateway Runtime，以及 Genio Bot。

## 試用一個工作流程

**文件研究 → 產品需求摘要。** 協助虛構的 Stellar Freight 團隊規劃貨運理賠入口，先用 Context7 查詢框架文件，再用內建 Product Management 技能整理需求與驗收條件。

依照[展示指南](docs/public/ce/demo.md)操作，或從[第一筆 MCP 請求](docs/public/ce/first-mcp-request.md)開始。指南也包含[以 OAuth 連接 Notion](docs/public/ce/demo.md#optional-notion-oauth-and-bot-setup) 的步驟。

## 使用文件

| 指南 | 內容 |
| --- | --- |
| [本機安裝](docs/public/ce/quickstart.md) | 啟動服務與管理本機環境 |
| [首次設定](docs/public/product/zh-TW/initial-setup.md) | 設定身分、資源與 Gateway |
| [Kubernetes 部署](docs/public/ce/helm.md) | 建置映像檔並使用 Helm 部署 |
| [疑難排解](docs/public/ce/troubleshooting.md) | 排查啟動及連線問題 |
| [已知問題](docs/public/ce/known-issues.md) | 查看目前限制與修復狀態 |

文件預設為英文，本頁與產品首次設定提供繁體中文版本。

## 回饋與貢獻

歡迎透過 [GitHub Issues](https://github.com/dnplus/genio-one/issues) 回報問題或提出建議。回報時請附上重現步驟與環境資訊，並移除紀錄中的憑證與私人資料。

提交程式碼前，請執行 \`pnpm check\`、\`pnpm test\` 與 \`pnpm build\`。

## 在 Product Hunt 上找到我們

<table>
  <tr>
    <td><a href="https://www.producthunt.com/products/genioone?embed=true&amp;utm_source=embed&amp;utm_medium=post_embed"><img alt="GenioOne" src="https://ph-files.imgix.net/b3009653-6723-4140-9117-e777f001ff05.png?auto=compress,format&amp;codec=mozjpeg&amp;cs=strip&amp;fit=crop&amp;h=80&amp;w=80" width="64" height="64"></a></td>
    <td><strong>GenioOne</strong><br>The control plane for every AI agent and resource<br><a href="https://www.producthunt.com/products/genioone?embed=true&amp;utm_source=embed&amp;utm_medium=post_embed">Check it out on Product Hunt →</a></td>
  </tr>
</table>

## 授權

[Apache License 2.0](LICENSE)。
`
}

function generatedEntries() {
  return new Map([
    ["pnpm-workspace.yaml", Buffer.from(publicWorkspaceYaml())],
    ["package.json", Buffer.from(`${JSON.stringify(publicRootPackage(), null, 2)}\n`)],
    ["README.md", Buffer.from(publicReadme())],
    ["README.zh-TW.md", Buffer.from(publicTraditionalChineseReadme())],
  ])
}

function assertDirectoryNotSymlink(path, label) {
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${path}`)
}

function assertNoSymlinkComponents(rootPath, childPath = "") {
  assertDirectoryNotSymlink(rootPath, "destination root")
  let current = rootPath
  for (const segment of childPath.split("/").filter(Boolean)) {
    current = join(current, segment)
    if (!pathExists(current)) continue
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink in destination path: ${childPath}`)
  }
}

function assertSafeRoots(sourceRoot, destination) {
  assertDirectoryNotSymlink(sourceRoot, "source root")
  const source = realpathSync(sourceRoot)
  let existingParent = destination
  while (!pathExists(existingParent)) {
    const parent = dirname(existingParent)
    if (parent === existingParent) throw new Error(`destination has no existing ancestor: ${destination}`)
    existingParent = parent
  }
  assertNoSymlinkComponents(existingParent)
  const resolvedDestinationParent = realpathSync(existingParent)
  const destinationFromRealParent = resolve(resolvedDestinationParent, relative(existingParent, destination))
  if (pathIsInside(destinationFromRealParent, source) || pathIsInside(source, destinationFromRealParent)) {
    throw new Error("refusing source and destination that are equal or ancestors of one another")
  }
}

function loadState(destination) {
  const statePath = join(destination, stateFileName)
  if (!existsSync(statePath)) return null
  assertNoSymlinkComponents(destination, stateFileName)
  const stat = lstatSync(statePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("CE sync state must be a regular file")
  let state
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"))
  } catch {
    throw new Error("CE sync state is not valid JSON")
  }
  if (state?.schema !== stateSchema || typeof state.files !== "object" || Array.isArray(state.files) || state.files === null) {
    throw new Error("CE sync state has an unsupported schema")
  }
  for (const [path, record] of Object.entries(state.files)) {
    assertManagedPath(path, "state path")
    if (typeof record !== "object" || record === null || !/^[a-f0-9]{64}$/.test(record.sha256) || ![0o644, 0o755].includes(record.mode)) {
      throw new Error(`invalid state record for ${path}`)
    }
  }
  return state
}

function contentIsForbidden(entries, needles) {
  const hits = []
  for (const entry of entries) {
    if (entry.destination === "LICENSE") continue
    const text = entry.content.toString("utf8")
    for (const needle of needles) {
      if (text.includes(needle)) hits.push({ file: entry.destination, needle })
    }
  }
  return hits
}

function readDestinationFingerprint(destination, path) {
  const absolute = resolve(destination, path)
  assertNoSymlinkComponents(destination, path)
  if (!existsSync(absolute)) return null
  const stat = lstatSync(absolute)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`managed destination is not a regular file: ${path}`)
  return { sha256: sha256(readFileSync(absolute)), mode: stat.mode & 0o777 }
}

function mkdirSafe(destination, relativeDirectory) {
  let current = destination
  for (const segment of relativeDirectory.split("/").filter(Boolean)) {
    current = join(current, segment)
    if (!existsSync(current)) mkdirSync(current)
    assertDirectoryNotSymlink(current, "destination directory")
  }
}

function createState(entries, manifest) {
  return {
    schema: stateSchema,
    provenance: {
      exporter: "genioone-ce-sync",
      source: "git-committed-snapshot",
      manifestSha256: sha256(JSON.stringify(manifest)),
    },
    files: Object.fromEntries(entries.map((entry) => [entry.destination, { sha256: entry.hash, mode: entry.mode }]).sort(([left], [right]) => left.localeCompare(right))),
  }
}

function conflictError(conflicts) {
  const shown = conflicts.slice(0, 20)
  const remaining = conflicts.length - shown.length
  const suffix = remaining > 0 ? `\n... ${remaining} additional conflicts` : ""
  return new Error(`CE sync conflict; no files were changed:\n${shown.join("\n")}${suffix}`)
}

export function createSyncPlan({
  sourceRoot = root,
  outDir,
  gitFiles,
  manifest,
  sourceRef = "HEAD",
  readSource,
  sourceMode,
  resetManaged = false,
} = {}) {
  if (!outDir) throw new Error("--out is required")
  const destination = resolve(outDir)
  assertSafeRoots(resolve(sourceRoot), destination)
  const source = readSource
    ? { files: gitFiles || [], read: readSource, mode: (path) => sourceMode?.(path) || 0o644, provenance: { requestedRef: "injected" } }
    : gitFiles
      ? workingTreeSource(resolve(sourceRoot))
      : gitSnapshot(resolve(sourceRoot), sourceRef)
  const effectiveManifest = manifest || JSON.parse(source.read("oss-export.json").toString("utf8"))
  const files = listedSourceFiles(gitFiles || source.files, effectiveManifest)
  const entries = []
  const destinations = new Set()
  const generated = generatedEntries()

  for (const file of files) {
    const destinationPathname = generated.has(file) ? file : destinationPath(file, effectiveManifest)
    assertManagedPath(destinationPathname, "destination path")
    if (destinations.has(destinationPathname)) throw new Error(`multiple source files map to ${destinationPathname}`)
    destinations.add(destinationPathname)
    entries.push({ source: file, destination: destinationPathname, content: generated.get(file) || source.read(file), mode: generated.has(file) ? 0o644 : source.mode(file) })
  }
  for (const [path, content] of generated) {
    if (destinations.has(path)) continue
    destinations.add(path)
    entries.push({ source: "generated", destination: path, content, mode: 0o644 })
  }
  for (const entry of entries) entry.hash = sha256(entry.content)
  entries.sort((left, right) => left.destination.localeCompare(right.destination))

  const forbidden = contentIsForbidden(entries, effectiveManifest.forbiddenContent || [])
  if (forbidden.length > 0) {
    throw new Error(`export contains forbidden content:\n${forbidden.map((hit) => `${hit.file}: ${hit.needle}`).join("\n")}`)
  }

  const state = existsSync(destination) ? loadState(destination) : null
  const stateFiles = state?.files || {}
  const changes = []
  const conflicts = []
  for (const entry of entries) {
    const current = existsSync(destination) ? readDestinationFingerprint(destination, entry.destination) : null
    const recorded = stateFiles[entry.destination]
    const currentMatchesState = current && recorded && current.sha256 === recorded.sha256 && current.mode === recorded.mode
    const currentMatchesDesired = current && current.sha256 === entry.hash && current.mode === entry.mode
    if (recorded && !currentMatchesState && !currentMatchesDesired && !resetManaged) {
      conflicts.push(`${entry.destination}: managed file differs from recorded state`)
      continue
    }
    if (!recorded && current) {
      conflicts.push(`${entry.destination}: existing file is not managed by CE sync`)
      continue
    }
    if (currentMatchesDesired) changes.push({ action: "unchanged", path: entry.destination })
    else changes.push({ action: current ? "update" : "create", path: entry.destination })
  }
  for (const [path, recorded] of Object.entries(stateFiles)) {
    if (destinations.has(path)) continue
    const current = readDestinationFingerprint(destination, path)
    if (current && (current.sha256 !== recorded.sha256 || current.mode !== recorded.mode) && !resetManaged) {
      conflicts.push(`${path}: managed file differs from recorded state`)
      continue
    }
    if (current) changes.push({ action: "delete", path })
  }
  if (conflicts.length > 0) throw conflictError(conflicts)

  const nextState = createState(entries, effectiveManifest)
  const stateChanged = JSON.stringify(state) !== JSON.stringify(nextState)
  if (stateChanged) changes.push({ action: "state", path: stateFileName })
  return { outDir: destination, entries, files, forbidden, changes, nextState, sourceProvenance: source.provenance }
}

export function applySyncPlan(plan) {
  const { outDir: destination, entries, changes, nextState } = plan
  if (!existsSync(destination)) mkdirSync(destination, { recursive: true })
  assertDirectoryNotSymlink(destination, "destination root")
  const staging = mkdtempSync(join(destination, ".genioone-ce-sync-stage-"))
  try {
    for (const entry of entries) {
      const stagePath = join(staging, entry.destination)
      mkdirSync(dirname(stagePath), { recursive: true })
      writeFileSync(stagePath, entry.content)
      chmodSync(stagePath, entry.mode)
    }
    for (const change of changes.filter((change) => change.action === "create" || change.action === "update")) {
      const target = join(destination, change.path)
      assertNoSymlinkComponents(destination, change.path)
      mkdirSafe(destination, dirname(change.path))
      renameSync(join(staging, change.path), target)
    }
    for (const change of changes.filter((change) => change.action === "delete")) {
      const target = join(destination, change.path)
      assertNoSymlinkComponents(destination, change.path)
      if (existsSync(target)) rmSync(target)
    }
    if (changes.some((change) => change.action === "state")) {
      const temporaryState = join(staging, stateFileName)
      writeFileSync(temporaryState, `${JSON.stringify(nextState, null, 2)}\n`)
      assertNoSymlinkComponents(destination, stateFileName)
      renameSync(temporaryState, join(destination, stateFileName))
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return plan
}

export function exportOss(options = {}) {
  const plan = createSyncPlan(options)
  if (!options.dryRun && options.apply !== false) applySyncPlan(plan)
  return {
    ...plan,
    copied: plan.changes.filter((change) => change.action === "create" || change.action === "update").length,
  }
}

export function summarizePlan(plan, mode) {
  const totals = Object.fromEntries(["create", "update", "delete", "unchanged", "state"].map((action) => [action, 0]))
  for (const change of plan.changes) totals[change.action] += 1
  const provenance = plan.sourceProvenance?.revision
    ? `source ${plan.sourceProvenance.requestedRef} -> ${plan.sourceProvenance.revision} (tree ${plan.sourceProvenance.treeDigest})\n`
    : ""
  const changedPaths = plan.changes
    .filter((change) => ["create", "update", "delete"].includes(change.action))
    .map((change) => `${change.action} ${change.path}`)
  return `CE sync ${mode}: ${plan.outDir}\n${provenance}create ${totals.create}, update ${totals.update}, delete ${totals.delete}, unchanged ${totals.unchanged}, state ${totals.state}${changedPaths.length ? `\n${changedPaths.join("\n")}` : ""}`
}

function parseArgs(argv) {
  const options = { outDir: resolve(root, "../genioone-ce"), dryRun: false, check: false, apply: false, resetManaged: false, sourceRef: "HEAD" }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--") continue
    else if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--check") options.check = true
    else if (arg === "--apply") options.apply = true
    else if (arg === "--reset-managed") options.resetManaged = true
    else if (arg === "--out" || arg === "--source-ref" || arg === "--source") {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`)
      options[arg === "--out" ? "outDir" : arg === "--source" ? "sourceRoot" : "sourceRef"] = value
      index += 1
    } else throw new Error(`unknown option: ${arg}`)
  }
  if (options.check && (options.apply || options.dryRun)) throw new Error("--check cannot be combined with --apply or --dry-run")
  if (options.apply && options.dryRun) throw new Error("--apply cannot be combined with --dry-run")
  return options
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  const plan = createSyncPlan(options)
  const mode = options.check ? "check" : options.apply ? "apply" : "dry-run"
  process.stdout.write(`${summarizePlan(plan, mode)}\n`)
  if (options.apply) applySyncPlan(plan)
  if (options.check && plan.changes.some((change) => change.action !== "unchanged")) process.exitCode = 1
}
