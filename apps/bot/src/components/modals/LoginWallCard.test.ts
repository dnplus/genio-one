import { describe, expect, test } from "bun:test"

import { loginWallCardHasPasswordInputs } from "./LoginWallCard"

describe("LoginWallCard", () => {
  test("helper reports no password inputs on empty DOM", () => {
    const fake = { querySelectorAll: () => [] as unknown as ArrayLike<Element> }
    expect(loginWallCardHasPasswordInputs(fake)).toBe(false)
  })
})
