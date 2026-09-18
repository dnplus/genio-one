import { Template, defaultBuildLogger } from "@e2b/desktop"

import { selfHostedE2BConfiguration } from "../server/e2b-self-host"

const configuration = selfHostedE2BConfiguration()
const cpuCount = Number(process.env.GENIO_BOT_E2B_BUILD_CPU_COUNT?.trim() || "2")
const memoryMB = Number(process.env.GENIO_BOT_E2B_BUILD_MEMORY_MB?.trim() || "2048")
const skipCache = process.env.GENIO_BOT_E2B_BUILD_SKIP_CACHE === "1"

const template = Template()
  .fromImage("ubuntu:22.04")
  .setUser("root")
  .setWorkdir("/")
  .setEnvs({
    DEBIAN_FRONTEND: "noninteractive",
    DEBIAN_PRIORITY: "high",
  })
  .runCmd(
    "apt-get update && " +
    "DEBIAN_FRONTEND=noninteractive apt-get install -y " +
    "xserver-xorg x11-xserver-utils xvfb x11-utils xauth xfce4 xfce4-terminal " +
    "sudo curl git wget xdotool scrot x11vnc net-tools netcat-openbsd dbus-x11 ca-certificates && " +
    "wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb " +
    "-O /tmp/google-chrome.deb && " +
    "DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/google-chrome.deb && " +
    "rm -f /tmp/google-chrome.deb && " +
    "rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*",
  )
  .gitClone("https://github.com/e2b-dev/noVNC.git", "/opt/noVNC", { branch: "e2b-desktop" })
  .gitClone("https://github.com/novnc/websockify.git", "/opt/noVNC/utils/websockify", { branch: "v0.12.0" })
  .setUser("user")
  .setWorkdir("/home/user")

const build = await Template.build(template, configuration.desktopBaseTemplate, {
  ...configuration.connection,
  cpuCount,
  memoryMB,
  skipCache,
  onBuildLogs: defaultBuildLogger(),
})

console.log(JSON.stringify({
  event: "genio-bot.e2b-desktop-base.ready",
  name: build.name,
  templateId: build.templateId,
  buildId: build.buildId,
  cpuCount,
  memoryMB,
}))
