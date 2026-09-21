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

test("timeline refresh retains local workspace notices until their lifecycle removes them", () => {
  const progress: ChatMessage = { id: "workspace-progress", role: "assistant", text: "正在準備工作區", localOnly: true }
  const canceled: ChatMessage = { id: "workspace-canceled", role: "system", text: "工作已取消，請重新送出", localOnly: true }
  const persisted = answer("已保存的回答", 1)
  expect(reconcileTimeline([progress], [persisted])).toEqual([persisted, progress])
  expect(reconcileTimeline([canceled], [persisted])).toEqual([persisted, canceled])
  expect(reconcileTimeline([persisted], [persisted])).toEqual([persisted])
})
