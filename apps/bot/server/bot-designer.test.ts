import { describe, expect, test } from "bun:test"

import {
  assertDesignerReadBack,
  composeDesignerDescription,
  designerCreatePayload,
  normalizeDesignerDraft,
  parseDesignerDescription,
} from "./bot-designer"

const draft = {
  name: "阿庫婭",
  oneJob: "把模糊需求收成可驗收切片",
  antiJobs: "不代寄信、不擅自啟用 routine、不裝市集插件",
  voice: "直球、短句、可靠",
  wake: "chat" as const,
  avatar: { shape: "cercle", color: "turquoise", expression: "attentif" },
}

describe("slice D Bot Designer compose/parse", () => {
  test("compose → parse round-trips designer fields", () => {
    const payload = designerCreatePayload(draft)
    expect(payload.title).toBe(draft.oneJob)
    expect(payload.skills).toEqual([])
    expect(payload.defaultRuntimeTier).toBe("none")
    expect(payload.modelRoute).toBe("codex-subscription")
    const parsed = parseDesignerDescription(payload.description)
    expect(parsed).toEqual({
      oneJob: draft.oneJob,
      antiJobs: draft.antiJobs,
      voice: draft.voice,
      wake: draft.wake,
    })
  })

  test("wake labels round-trip for routine and both without enabling routines", () => {
    for (const wake of ["routine", "both"] as const) {
      const composed = composeDesignerDescription({
        oneJob: "值班",
        antiJobs: "不啟用 routine",
        voice: "冷靜",
        wake,
      })
      expect(composed).toContain("本 slice 不啟用 routine")
      expect(parseDesignerDescription(composed)?.wake).toBe(wake)
    }
  })

  test("normalize rejects empty designer fields", () => {
    expect(() => normalizeDesignerDraft({ ...draft, oneJob: "  " })).toThrow("DESIGNER_ONE_JOB_REQUIRED")
    expect(() => normalizeDesignerDraft({ ...draft, antiJobs: "" })).toThrow("DESIGNER_ANTI_JOBS_REQUIRED")
    expect(() => normalizeDesignerDraft({ ...draft, modelRoute: "unsupported" as never })).toThrow("DESIGNER_MODEL_ROUTE_INVALID")
  })

  test("designer payload preserves both model routes", () => {
    for (const modelRoute of ["codex-subscription", "genio-gateway"] as const) {
      expect(designerCreatePayload({ ...draft, modelRoute }).modelRoute).toBe(modelRoute)
    }
  })

  test("assertDesignerReadBack accepts matching live profile", () => {
    const payload = designerCreatePayload(draft)
    expect(() => assertDesignerReadBack(draft, {
      name: payload.name,
      title: payload.title,
      description: payload.description,
      antiJobs: payload.antiJobs,
      voice: payload.voice,
      wake: payload.wake,
      modelRoute: payload.modelRoute,
      visibility: "PRIVATE",
    })).not.toThrow()
    expect(() => assertDesignerReadBack(draft, {
      name: payload.name,
      title: "wrong",
      description: payload.description,
      antiJobs: payload.antiJobs,
      voice: payload.voice,
      wake: payload.wake,
    })).toThrow(/title\/oneJob/)
    expect(() => assertDesignerReadBack(draft, {
      name: payload.name,
      title: payload.title,
      description: payload.description,
      antiJobs: payload.antiJobs,
      voice: payload.voice,
      wake: payload.wake,
      modelRoute: "genio-gateway",
      visibility: "PRIVATE",
    })).toThrow(/model route/)
  })
})
