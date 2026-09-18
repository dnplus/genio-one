import { describe, expect, test } from "bun:test"

import { BotEngine } from "../vendor/bloub/bot/engine"
import { RAYON } from "../vendor/bloub/bot/repere"
import { SEQUENCE, STATE_BY_ID } from "../vendor/bloub/bot/states"
import { COLORS, SHAPES } from "../vendor/bloub/bot/skins"
import { EXPRESSIONS } from "../vendor/bloub/bot/expressions"
import { DEFAULT_BLOUB_AVATAR, isBloubAvatarValue } from "./bloub-avatar"

describe("Bloub avatar port", () => {
  test("keeps every upstream animation state renderable", () => {
    expect(SEQUENCE).toHaveLength(14)
    const engine = new BotEngine(RAYON)
    let time = 0
    for (const state of SEQUENCE) {
      engine.setState(state, time)
      time += (STATE_BY_ID.get(state)?.morph ?? 0) + 1
      const frame = engine.sample(time)
      expect(frame.bodyPath.length).toBeGreaterThan(10)
      expect(Number.isFinite(frame.bodyAlpha)).toBeTrue()
    }
  })

  test("keeps the complete upstream avatar customizer surface", () => {
    expect(SHAPES).toHaveLength(8)
    expect(COLORS).toHaveLength(12)
    expect(EXPRESSIONS).toHaveLength(16)
    expect(isBloubAvatarValue(DEFAULT_BLOUB_AVATAR)).toBeTrue()
    expect(isBloubAvatarValue({ shape: "missing", color: "encre", expression: "neutre" })).toBeFalse()
  })
})
