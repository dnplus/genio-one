import { describe, expect, test } from "bun:test"

import { operationalError } from "./operational-log"

describe("Gateway operational errors", () => {
  test("redacts common credentials and removes log-injection control characters", () => {
    const result = operationalError(new Error(
      "failed https://person:password@example.test/path?access_token=top-secret\nAuthorization: Bearer abc.def",
    ))

    expect(result).toEqual({
      error_name: "Error",
      error_message: "failed https://[REDACTED]@example.test/path?access_token=[REDACTED] Authorization: Bearer [REDACTED]",
    })
  })
})
