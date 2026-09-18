export function isEnglishBotLocale() {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("lang") === "en"
}

export function botCopy<T>(english: T, traditionalChinese: T): T {
  return isEnglishBotLocale() ? english : traditionalChinese
}

export function botDisplayName(bot: { name: string; sourceResourceId?: string | null }) {
  if (bot.sourceResourceId === "genio.demo.bot" && bot.name === "CE 文件與規格 Bot") {
    return botCopy("CE Documentation & Product Bot", bot.name)
  }
  return bot.name
}

export function botStatusText(value: string) {
  if (!isEnglishBotLocale()) return value
  const localWorkspacePrefix = "本機工作資料夾："
  if (value.startsWith(localWorkspacePrefix)) {
    return `Local workspace: ${value.slice(localWorkspacePrefix.length)}`
  }
  const replacements: Array<[string, string]> = [
    ["已連線", "Connected"],
    ["重新連線中", "Reconnecting"],
    ["連線中", "Connecting"],
    ["就緒", "Ready"],
    ["執行工具中", "Running tools"],
    ["思考中", "Thinking"],
    ["等待登入", "Waiting for sign-in"],
    ["等待回答", "Waiting for answer"],
    ["等待確認", "Waiting for confirmation"],
    ["發生錯誤", "Error"],
    ["載入 Bot", "Loading Bot"],
    ["本機已連接", "Local endpoint connected"],
    ["本機已離線", "Local endpoint offline"],
    ["受控電腦", "Managed Desktop"],
    ["沙盒就緒", "Sandbox ready"],
    ["沙盒未啟動", "Sandbox not started"],
    ["遠端受控電腦已連線，點擊切換畫面", "Remote managed desktop connected; click to switch views"],
    ["基礎遠端沙盒可執行；尚未開啟桌面畫面", "Basic remote sandbox is ready; the desktop view is not open"],
    ["對話與企業工具可用；執行程式時才會啟動遠端沙盒", "Conversation and enterprise tools are available; the remote sandbox starts when code execution is needed"],
  ]
  for (const [from, to] of replacements) {
    if (value === from) return to
  }
  return value.replace(/(\d+)\s*個工具/g, (_match, count: string) => `${count} ${Number(count) === 1 ? "tool" : "tools"}`)
}
