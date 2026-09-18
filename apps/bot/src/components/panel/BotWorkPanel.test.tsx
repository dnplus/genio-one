import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { BotWorkPanel } from "./BotWorkPanel"
import type { BotInvocationRequest } from "../../lib/bot-api"

const pending = { requestId: "pending", callerBotId: "caller-bot", targetBotId: "owner-bot", targetOwnerSubjectId: "owner", state: "PENDING", task: "Requested work" } as BotInvocationRequest
const render = (viewer: string, state = "PENDING") => renderToStaticMarkup(<BotWorkPanel botId="owner-bot" token="test" status="就緒" messages={[]} invocations={[{ ...pending, state } as BotInvocationRequest, { ...pending, requestId: "unrelated", callerBotId: "other-a", targetBotId: "other-b", task: "Unrelated work" }]} names={{ "caller-bot": "Caller" }} viewerSubjectId={viewer} onDecision={async () => {}} onManageMemory={() => {}} onSelectMessage={() => {}} />)

test("work view only offers pending approval to the target owner and excludes unrelated Bot work", () => {
  const owner = render("owner")
  expect(owner).toContain("允許這次交接")
  expect(owner).toContain("拒絕這次交接")
  expect(owner).toContain("來自 Caller")
  expect(owner).not.toContain("Unrelated work")
  expect(render("caller")).not.toContain("允許這次交接")
  expect(render("owner", "COMPLETED")).not.toContain("允許這次交接")
})
