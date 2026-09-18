import assert from "node:assert/strict"
import test from "node:test"

import { mcpOAuthReturnUrl } from "../src/capabilities/mcp-oauth/module"

test("MCP OAuth returns to the owning Resource connections", () => {
  assert.equal(
    mcpOAuthReturnUrl(new URL("http://127.0.0.1:5173"), "resource-notion"),
    "http://127.0.0.1:5173/management?view=connections&resource=resource-notion",
  )
})
