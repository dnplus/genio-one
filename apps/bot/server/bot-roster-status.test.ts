import { describe, expect, test } from "bun:test"

import {
  assertRosterHumanPrimaryCopy,
  projectRosterSidebarStatus,
  rosterStatusLabelFor,
  rosterStatusPreview,
  ROSTER_SIDEBAR_HUMAN_LABELS,
} from "./bot-roster-status"

describe("UX P1-c roster sidebar status projection", () => {
  test("live questions and approvals take priority over working and unread", () => {
    expect(projectRosterSidebarStatus({ unread: true, workState: "working", waitingFor: "answer" }))
      .toEqual({ status: "needs-attention", statusLabel: "等待你回答" })
    expect(rosterStatusPreview({ unread: false, workState: "working", waitingFor: "approval" }, "preview")).toBe("等待你確認")
  })
  test("three states from BotSession fields", () => {
    expect(projectRosterSidebarStatus({ unread: false, workState: "working" })).toEqual({
      status: "working",
      statusLabel: "工作中",
    })
    expect(projectRosterSidebarStatus({ unread: true, workState: "idle" })).toEqual({
      status: "unread",
      statusLabel: "未讀動態",
    })
    expect(projectRosterSidebarStatus({ unread: true, workState: "stopped" })).toEqual({
      status: "needs-attention",
      statusLabel: "需要注意",
    })
    expect(projectRosterSidebarStatus({ unread: false, workState: "idle" })).toEqual({
      status: null,
      statusLabel: null,
    })
  })

  test("working beats unread; stopped projects needs-attention not unread", () => {
    expect(projectRosterSidebarStatus({ unread: true, workState: "working" }).status).toBe("working")
    expect(projectRosterSidebarStatus({ unread: true, workState: "stopped" }).status).toBe("needs-attention")
    expect(projectRosterSidebarStatus({ unread: false, workState: "stopped" }).status).toBe("needs-attention")
  })

  test("human labels and preview copy", () => {
    expect(rosterStatusLabelFor("working")).toBe(ROSTER_SIDEBAR_HUMAN_LABELS.working)
    expect(rosterStatusLabelFor("unread")).toBe(ROSTER_SIDEBAR_HUMAN_LABELS.unread)
    expect(rosterStatusLabelFor("needs-attention")).toBe(ROSTER_SIDEBAR_HUMAN_LABELS["needs-attention"])

    expect(rosterStatusPreview({ unread: false, workState: "working" }, "摘要")).toBe("工作中…")
    expect(rosterStatusPreview({ unread: true, workState: "stopped" }, "摘要")).toBe("已停止，未回覆")
    expect(rosterStatusPreview({ unread: true, workState: "idle" }, "摘要")).toBe("未讀動態")
    expect(rosterStatusPreview({ unread: false, workState: "idle" }, "摘要")).toBe("摘要")

    assertRosterHumanPrimaryCopy("工作中", "未讀動態", "需要注意", "已停止，未回覆")
    expect(() => assertRosterHumanPrimaryCopy("STOPPED")).toThrow(/protocol token/)
  })
})
