import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MessageMedia } from "./MessageMedia"
import { reconstructTurnMessages } from "./codex-history"
import type { Turn } from "../../../server/generated/v2/Turn"

test("native history keeps image payloads and renders them after reconstruction", () => {
  const url = "data:image/png;base64,aGVsbG8="
  const turn = { id: "turn", status: "completed", startedAt: 123, items: [{ type: "userMessage", id: "user", clientId: null, content: [{ type: "image", url }] }] } as Turn
  const restored = reconstructTurnMessages([JSON.parse(JSON.stringify(turn))], new Set(), "thread")[0]!
  const html = renderToStaticMarkup(<MessageMedia item={restored.runtimeItem} />)
  expect(html).toContain(url)
  expect(html).toContain("附加圖片 1")
  expect(renderToStaticMarkup(<MessageMedia images={["javascript:alert(1)"]} />)).not.toContain("javascript:")
})
