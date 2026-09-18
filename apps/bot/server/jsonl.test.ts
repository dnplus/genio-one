import { describe, expect, test } from "bun:test"

import { createJsonLineCollector } from "./jsonl"

describe("createJsonLineCollector", () => {
  test("emits complete app-server messages across chunks", () => {
    const lines: string[] = []
    const collect = createJsonLineCollector((line) => lines.push(line))
    collect('{"id":1')
    collect(',"result":{}}\n{"method":"turn/started"}\n')
    expect(lines).toEqual([
      '{"id":1,"result":{}}',
      '{"method":"turn/started"}',
    ])
  })
})
