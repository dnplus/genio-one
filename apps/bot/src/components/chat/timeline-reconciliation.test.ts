import { expect, test } from "bun:test"
import { reconcileTimeline } from "./timeline-reconciliation"
import type { ChatMessage } from "../../bots-storage"

const answer = (text: string, timelineRevision: number): ChatMessage => ({ id: "thread:item", role: "assistant", text, timelineRevision })

test("an older HTTP snapshot cannot replace a newer streamed answer or erase a newly arrived item", () => {
  const current = [answer("完整回答", 4)]
  expect(reconcileTimeline(current, [answer("完整", 2)])).toEqual(current)
  expect(reconcileTimeline(current, [])).toEqual(current)
  expect(reconcileTimeline(current, [answer("已完成的回答", 5)])).toEqual([answer("已完成的回答", 5)])
})

test("native acknowledgement replaces the optimistic user bubble by client identity", () => {
  const pending: ChatMessage = { id: "optimistic", role: "user", text: "請繼續", clientMessageId: "client-1" }
  const accepted: ChatMessage = { id: "thread:user", role: "user", text: "請繼續", clientMessageId: "client-1", timelineRevision: 1 }
  expect(reconcileTimeline([pending], [accepted])).toEqual([accepted])
})
