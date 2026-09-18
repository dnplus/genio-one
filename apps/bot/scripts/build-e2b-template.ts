import { Template, defaultBuildLogger } from "@e2b/desktop"

import { selfHostedE2BConfiguration } from "../server/e2b-self-host"

const configuration = selfHostedE2BConfiguration()
const desktopTemplate = Template()
  .fromTemplate(configuration.desktopBaseTemplate)
  .setUser("root")
  .runCmd("apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y socat && rm -rf /var/lib/apt/lists/*")

const headlessTemplate = Template()
  .fromImage("ubuntu:22.04")
  .setUser("root")
  .setWorkdir("/")
const nodeArchive = "/tmp/node-v22.18.0-linux-x64.tar.xz"
const headlessTemplateWithRuntime = headlessTemplate
  .runCmd("apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git jq socat xz-utils && rm -rf /var/lib/apt/lists/*")
  .runCmd(`curl --fail --location --retry 3 https://nodejs.org/dist/v22.18.0/node-v22.18.0-linux-x64.tar.xz --output ${nodeArchive} && tar -C /usr/local --strip-components=1 -xJf ${nodeArchive} && rm -f ${nodeArchive}`)
  .runCmd("node --version | grep -F 'v22.18.0'")
  .runCmd(`npm install --global @openai/codex@${configuration.codexVersion}`)
  .runCmd(`codex --version | grep -F "codex-cli ${configuration.codexVersion}"`)
  .setUser("user")
  .setWorkdir("/home/user")

const desktopCpuCount = Number(process.env.GENIO_BOT_E2B_BUILD_CPU_COUNT?.trim() || "8")
const desktopMemoryMB = Number(process.env.GENIO_BOT_E2B_BUILD_MEMORY_MB?.trim() || "8192")

if (
  process.env.GENIO_BOT_E2B_BUILD_DESKTOP !== "false" &&
  configuration.desktopTemplate !== configuration.desktopBaseTemplate
) {
  const build = await Template.build(desktopTemplate, configuration.desktopTemplate, {
    ...configuration.connection,
    cpuCount: desktopCpuCount,
    memoryMB: desktopMemoryMB,
    onBuildLogs: defaultBuildLogger(),
  })

  console.log(JSON.stringify({
    event: "genio-bot.e2b-template.ready",
    name: build.name,
    templateId: build.templateId,
    buildId: build.buildId,
  }))
}

if (process.env.GENIO_BOT_E2B_BUILD_HEADLESS !== "false") {
  const headlessCpuCount = Number(process.env.GENIO_BOT_E2B_HEADLESS_CPU_COUNT?.trim() || "2")
  const headlessMemoryMB = Number(process.env.GENIO_BOT_E2B_HEADLESS_MEMORY_MB?.trim() || "2048")
  const headlessBuild = await Template.build(headlessTemplateWithRuntime, configuration.headlessTemplate, {
    ...configuration.connection,
    cpuCount: headlessCpuCount,
    memoryMB: headlessMemoryMB,
    onBuildLogs: defaultBuildLogger(),
  })
  console.log(JSON.stringify({
    event: "genio-bot.e2b-headless-template.ready",
    name: headlessBuild.name,
    templateId: headlessBuild.templateId,
    buildId: headlessBuild.buildId,
  }))
}
