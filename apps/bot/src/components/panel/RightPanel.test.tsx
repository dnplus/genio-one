import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { RightPanel } from "./RightPanel"

test("desktop view offers a visible recovery action while its short-lived browser credential is active", () => {
  const html = renderToStaticMarkup(
    <RightPanel
      activeTab="desktop"
      onTabChange={() => {}}
      bot={{ id: "bot-1", name: "Desktop Bot", role: "", title: "Desktop Bot", description: "", avatar: "aqua", workspacePath: "/home/user", skills: [], createdAt: 1 } as any}
      messages={[]}
      onSelectMessage={() => {}}
      runtime={{ kind: "e2b-self-hosted", tier: "desktop", cwd: "/home/user", desktopUrl: "/api/desktop/runtime-1/vnc.html", sandboxId: "sandbox-1", environmentId: "e2b-sandbox-1", execServerUrl: "ws://executor", execReady: true }}
      status="已連線"
      mcpStatus="已連線"
      activities={[]}
      onEnsureRuntime={() => {}}
    />,
  )
  expect(html).toContain("重新連線")
  expect(html).toContain("/api/desktop/runtime-1/vnc.html")
})
