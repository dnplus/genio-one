import assert from "node:assert/strict"
import test from "node:test"

import { discoveryCandidates } from "../src/capabilities/mcp-discovery/candidates"

test("MCP discovery drift remains NEW and preserves explicit ignore or block only for the same revision", () => {
  const observation = {
    protocol_version: "2025-06-18",
    server_name: "engineering",
    server_version: "1",
    tools: [
      { name: "issues.search", title: "Search", description: null },
      { name: "issues.delete", title: "Delete", description: null },
    ],
  }
  const first = discoveryCandidates("connection-mcp", observation, ["issues.search"])
  assert.deepEqual(first.map((value) => [value.tool_name, value.state]), [
    ["issues.delete", "NEW"],
    ["issues.search", "PUBLISHED"],
  ])
  assert.match(first[0]!.capability_id, /^mcp-tool-[a-f0-9]{32}$/)
  const ignored = first.map((value) => value.tool_name === "issues.delete" ? { ...value, state: "IGNORED" as const } : value)
  const unchanged = discoveryCandidates("connection-mcp", observation, ["issues.search"], ignored)
  assert.equal(unchanged[0]!.state, "IGNORED")
  const drifted = discoveryCandidates("connection-mcp", {
    ...observation,
    tools: [{ name: "issues.delete", title: "Delete permanently", description: null }],
  }, [], ignored)
  assert.equal(drifted[0]!.state, "NEW")
})

test("MCP discovery digest binds the input schema and upstream read-only hint", () => {
  const base = {
    protocol_version: "2025-06-18",
    server_name: "engineering",
    server_version: "1",
    tools: [{
      name: "issues.search",
      title: "Search",
      description: "Search issues",
      input_schema: { type: "object", properties: { query: { type: "string" } } },
      read_only_hint: true,
    }],
  }
  const initial = discoveryCandidates("connection-mcp", base, [])
  const changedSchema = discoveryCandidates("connection-mcp", {
    ...base,
    tools: [{
      ...base.tools[0]!,
      input_schema: { type: "object", properties: { query: { type: "string" }, project: { type: "string" } } },
    }],
  }, [])
  const changedHint = discoveryCandidates("connection-mcp", {
    ...base,
    tools: [{ ...base.tools[0]!, read_only_hint: false }],
  }, [])
  assert.notEqual(changedSchema[0]?.revision_digest, initial[0]?.revision_digest)
  assert.notEqual(changedHint[0]?.revision_digest, initial[0]?.revision_digest)
})
