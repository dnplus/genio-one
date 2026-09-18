import { expect, test } from "bun:test"
import { botDisplayName, botStatusText } from "./ui-copy"

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")

function withEnglishBotLocale<T>(run: () => T): T {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search: "?lang=en" } },
  })
  try {
    return run()
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor)
    else Reflect.deleteProperty(globalThis, "window")
  }
}

test("translates only the original CE demo Bot name and header status tooltips", () => {
  withEnglishBotLocale(() => {
    expect(botDisplayName({ name: "CE 文件與規格 Bot", sourceResourceId: "genio.demo.bot" })).toBe("CE Documentation & Product Bot")
    expect(botDisplayName({ name: "Ada's research Bot", sourceResourceId: "genio.demo.bot" })).toBe("Ada's research Bot")
    expect(botStatusText("1 個工具 · GenioOne SSO")).toBe("1 tool · GenioOne SSO")
    expect(botStatusText("2 個工具 · GenioOne SSO")).toBe("2 tools · GenioOne SSO")
    expect(botStatusText("本機工作資料夾：/workspaces/demo")).toBe("Local workspace: /workspaces/demo")
    expect(botStatusText("遠端受控電腦已連線，點擊切換畫面")).toBe("Remote managed desktop connected; click to switch views")
    expect(botStatusText("基礎遠端沙盒可執行；尚未開啟桌面畫面")).toBe("Basic remote sandbox is ready; the desktop view is not open")
    expect(botStatusText("對話與企業工具可用；執行程式時才會啟動遠端沙盒")).toBe("Conversation and enterprise tools are available; the remote sandbox starts when code execution is needed")
  })
})
