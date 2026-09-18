import { expect, test } from "bun:test"
import { chatStreamToResponses } from "./model-response-stream"
import { responsesToChatRequest } from "./model-gateway-relay"
async function collect(chunks: unknown[]) {
  const reports: string[] = []
  const bytes = new TextEncoder().encode(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join(""))
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close() } })
  let result = ""
  for await (const data of chatStreamToResponses(body, "company-model", async (outcome) => { reports.push(outcome) })) result += new TextDecoder().decode(data)
  return { reports, events: result.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))) }
}
test("streams fragmented tool calls with complete arguments and usage", async () => {
  const result = await collect([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "list_cases", arguments: '{"query":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"案件"}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
  ])
  const completed = result.events.find(event => event.type === "response.completed")
  expect(completed.response.output).toHaveLength(1)
  expect(completed.response.output[0]).toMatchObject({ type: "function_call", call_id: "call-1", name: "list_cases", arguments: '{"query":"案件"}', status: "completed" })
  expect(completed.response.usage.total_tokens).toBe(5)
  expect(result.reports).toEqual(["COMPLETED"])
})
test("provider errors and truncated streams never become completed responses", async () => {
  for (const chunks of [[{ error: { message: "failed" } }], [{ choices: [{ delta: { content: "partial" } }] }]]) {
    const result = await collect(chunks)
    expect(result.events.some(event => event.type === "response.completed")).toBe(false)
    expect(result.events.at(-1).type).toBe("response.failed")
    expect(result.reports).toEqual(["FAILED"])
  }
})
test("token limit remains an incomplete response", async () => {
  const result = await collect([{ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }])
  expect(result.events.at(-1).type).toBe("response.incomplete")
  expect(result.reports).toEqual(["FAILED"])
})
test("missing model is rejected without a test model fallback", () => {
  expect(() => responsesToChatRequest({ input: "hello" })).toThrow("MODEL_REQUIRED")
})

test("early cancellation releases the upstream reader even if audit reporting fails", async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  const stream = chatStreamToResponses(body, "company-model", async () => { throw new Error("audit unavailable") })
  await stream.next()
  await expect(stream.return()).rejects.toThrow("audit unavailable")
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})
