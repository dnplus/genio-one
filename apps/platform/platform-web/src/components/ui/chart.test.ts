import { describe, expect, it } from "bun:test"
import { sanitizeCssString } from "./chart-sanitize"

describe("sanitizeCssString", () => {
  it("escapes '<' characters in CSS values/IDs/keys to avoid HTML tag breakout", () => {
    expect(sanitizeCssString("chart-123")).toBe("chart-123")
    expect(sanitizeCssString("</style><script>alert(1)</script>")).toBe(
      "\\3c /style>\\3c script>alert(1)\\3c /script>"
    )
    expect(sanitizeCssString("red; background: url('http://evil.com')")).toBe(
      "red; background: url('http://evil.com')"
    )
  })
})
