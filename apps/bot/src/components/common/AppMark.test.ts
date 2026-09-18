import { describe, expect, test } from "bun:test"
import { identityAvatarState } from "./AppMark"

describe("identityAvatarState", () => {
  test("keeps blob identity instead of glyph poses", () => {
    expect(identityAvatarState("alert")).toBe("idle")
    expect(identityAvatarState("exclaim")).toBe("idle")
    expect(identityAvatarState("thinking")).toBe("thinking")
    expect(identityAvatarState("orbit")).toBe("orbit")
  })
})
