import { expect, test } from "bun:test"
import { isGenioSessionRejection } from "./session-rejection"

test("only identity rejection invalidates login, not capability or runtime session failures", () => {
  for (const reason of ["GENIO_ONE_SESSION_REJECTED", "GENIO_ONE_SESSION_INVALID", "GENIO_ONE_SESSION_TOKEN_REQUIRED"]) expect(isGenioSessionRejection(reason)).toBe(true)
  for (const reason of ["PERSONAL_BOT_NOT_ENTITLED", "RUNTIME_SESSION_NOT_FOUND", "HANDSHAKE_TIMEOUT", "BOT_MODEL_ROUTE_UNAVAILABLE", undefined]) expect(isGenioSessionRejection(reason)).toBe(false)
})
