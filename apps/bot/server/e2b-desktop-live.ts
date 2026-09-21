import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { Sandbox } from "@e2b/desktop"

import { selfHostedE2BConfiguration } from "./e2b-self-host"
import { remoteCodexBootstrapCommand, remoteCodexPathPrefix } from "./runtime"

const configuration = selfHostedE2BConfiguration()
const screenshotPath = resolve(
  process.env.GENIO_BOT_E2B_SCREENSHOT?.trim() || "artifacts/e2b-desktop-live.png",
)
const sandbox = await Sandbox.create(configuration.desktopTemplate, {
  ...configuration.connection,
  resolution: [1440, 900],
  timeoutMs: 15 * 60 * 1000,
  metadata: {
    app: "genio-one-bot",
    purpose: "desktop-live-gate",
  },
})

try {
  console.info(JSON.stringify({ event: "e2b.desktop.live.stage", stage: "sandbox.ready", sandbox_id: sandbox.sandboxId }))
  let codex: { exitCode: number; stdout: string } | null = null
  try {
    codex = await sandbox.commands.run(`${remoteCodexPathPrefix()} codex --version`, { timeoutMs: 10_000 })
  } catch {}
  if (!codex || codex.exitCode !== 0 || codex.stdout.trim() !== `codex-cli ${configuration.codexVersion}`) {
    console.info(JSON.stringify({ event: "e2b.desktop.live.stage", stage: "codex.bootstrap", sandbox_id: sandbox.sandboxId }))
    let bootstrap: { exitCode: number; stdout: string } | null = null
    try {
      bootstrap = await sandbox.commands.run(remoteCodexBootstrapCommand(configuration.codexVersion), { timeoutMs: 180_000 })
    } catch {}
    if (!bootstrap || bootstrap.exitCode !== 0 || bootstrap.stdout.trim() !== `codex-cli ${configuration.codexVersion}`) {
      throw new Error("SELF_HOSTED_E2B_CODEX_VERSION_MISMATCH")
    }
    codex = bootstrap
  }
  if (codex.exitCode !== 0 || codex.stdout.trim() !== `codex-cli ${configuration.codexVersion}`) {
    throw new Error("SELF_HOSTED_E2B_CODEX_VERSION_MISMATCH")
  }

  console.info(JSON.stringify({ event: "e2b.desktop.live.stage", stage: "desktop.stream", sandbox_id: sandbox.sandboxId }))
  await sandbox.stream.start({ requireAuth: true })
  const streamReady = true
  console.info(JSON.stringify({ event: "e2b.desktop.live.stage", stage: "desktop.chrome", sandbox_id: sandbox.sandboxId }))
  await sandbox.launch("google-chrome", "https://example.com")
  const browserReady = await sandbox.waitAndVerify(
    "xdotool search --onlyvisible --class 'google-chrome'",
    (result) => result.exitCode === 0 && result.stdout.trim().length > 0,
    20,
    1,
  )
  if (!browserReady) throw new Error("SELF_HOSTED_E2B_DESKTOP_NOT_READY")
  console.info(JSON.stringify({ event: "e2b.desktop.live.stage", stage: "desktop.ready", sandbox_id: sandbox.sandboxId }))
  await mkdir(dirname(screenshotPath), { recursive: true })
  await Bun.write(screenshotPath, await sandbox.screenshot())

  console.info(JSON.stringify({
    event: "e2b.desktop.live",
    sandbox_id: sandbox.sandboxId,
    stream_ready: streamReady,
    screenshot_path: screenshotPath,
    codex_version: codex.stdout.trim(),
  }))
} finally {
  await sandbox.stream.stop().catch(() => undefined)
  await sandbox.kill().catch(() => undefined)
  console.info(JSON.stringify({
    event: "e2b.desktop.terminated",
    sandbox_id: sandbox.sandboxId,
  }))
}
