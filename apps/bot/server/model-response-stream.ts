import { randomUUID } from "node:crypto"

type JsonRecord = Record<string, unknown>

export async function* chatStreamToResponses(body: ReadableStream<Uint8Array>, model: string, onFinish: (outcome: "COMPLETED" | "FAILED", reason?: string) => Promise<void>) {
  const responseId = `resp_${randomUUID().replaceAll("-", "")}`
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const reader = body.getReader()
  const output: JsonRecord[] = []
  const tools = new Map<number, { item: JsonRecord; index: number }>()
  let textItem: JsonRecord | undefined
  let textIndex = -1
  let fullText = ""
  let buffer = ""
  let eventData: string[] = []
  let sequence = 0
  let finishReason: string | null = null
  let usage: JsonRecord | undefined
  let finalized = false
  const event = (type: string, value: JsonRecord) => encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...value, sequence_number: sequence++ })}\n\n`)
  const response = (status: string) => ({ id: responseId, object: "response", status, model, created_at: Math.floor(Date.now() / 1000), output, ...(usage ? { usage } : {}) })
  function consume(raw: string): Uint8Array[] {
    if (raw === "[DONE]") {
      if (!finishReason) throw new Error("MODEL_STREAM_TERMINATION_MISSING")
      return []
    }
    const chunk = JSON.parse(raw) as JsonRecord
    if (chunk.error) throw new Error("MODEL_PROVIDER_STREAM_ERROR")
    if (chunk.usage && typeof chunk.usage === "object") {
      const value = chunk.usage as JsonRecord
      usage = { input_tokens: value.prompt_tokens ?? 0, output_tokens: value.completion_tokens ?? 0, total_tokens: value.total_tokens ?? 0 }
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    const choice = choices[0] as JsonRecord | undefined
    if (!choice) return []
    const delta = choice.delta && typeof choice.delta === "object" ? choice.delta as JsonRecord : {}
    const events: Uint8Array[] = []
    if (typeof delta.content === "string" && delta.content) {
      if (!textItem) {
        textIndex = output.length
        textItem = { id: `msg_${randomUUID().replaceAll("-", "")}`, type: "message", status: "in_progress", role: "assistant", content: [] }
        output.push(textItem)
        events.push(event("response.output_item.added", { output_index: textIndex, item: { ...textItem } }))
        events.push(event("response.content_part.added", { item_id: textItem.id, output_index: textIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }))
      }
      fullText += delta.content
      events.push(event("response.output_text.delta", { item_id: textItem.id, output_index: textIndex, content_index: 0, delta: delta.content }))
    }
    for (const fragment of Array.isArray(delta.tool_calls) ? delta.tool_calls as JsonRecord[] : []) {
      if (!Number.isInteger(fragment.index) || Number(fragment.index) < 0) throw new Error("MODEL_TOOL_CALL_INVALID")
      const key = Number(fragment.index)
      const fn = fragment.function && typeof fragment.function === "object" ? fragment.function as JsonRecord : {}
      let tool = tools.get(key)
      if (!tool) {
        if (typeof fragment.id !== "string" || !fragment.id || typeof fn.name !== "string" || !fn.name) throw new Error("MODEL_TOOL_CALL_INVALID")
        tool = { index: output.length, item: { id: `fc_${randomUUID().replaceAll("-", "")}`, type: "function_call", status: "in_progress", call_id: fragment.id, name: fn.name, arguments: "" } }
        tools.set(key, tool)
        output.push(tool.item)
        events.push(event("response.output_item.added", { output_index: tool.index, item: { ...tool.item } }))
      }
      if (typeof fn.arguments === "string" && fn.arguments) {
        tool.item.arguments = String(tool.item.arguments) + fn.arguments
        events.push(event("response.function_call_arguments.delta", { item_id: tool.item.id, output_index: tool.index, delta: fn.arguments }))
      }
    }
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason
    return events
  }
  try {
    yield event("response.created", { response: response("in_progress") })
    yield event("response.in_progress", { response: response("in_progress") })
    while (true) {
      const result = await reader.read()
      buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true })
      if (result.done && buffer && !buffer.endsWith("\n")) buffer += "\n"
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "")
        buffer = buffer.slice(newline + 1)
        if (line.startsWith("data:")) eventData.push(line.slice(5).trimStart())
        else if (!line && eventData.length) {
          for (const value of consume(eventData.join("\n"))) yield value
          eventData = []
        }
      }
      if (result.done) break
    }
    if (eventData.length) for (const value of consume(eventData.join("\n"))) yield value
    if (!finishReason) throw new Error("MODEL_STREAM_TERMINATION_MISSING")
    if (!["stop", "tool_calls", "length", "content_filter"].includes(finishReason)) throw new Error("MODEL_STREAM_FINISH_UNSUPPORTED")
    const incomplete = finishReason === "length" || finishReason === "content_filter"
    if (finishReason === "tool_calls" && !tools.size) throw new Error("MODEL_TOOL_CALL_MISSING")
    if (!incomplete) for (const { item } of tools.values()) {
      try { JSON.parse(String(item.arguments)) } catch { throw new Error("MODEL_TOOL_ARGUMENTS_INVALID") }
    }
    await onFinish(incomplete ? "FAILED" : "COMPLETED", incomplete ? `MODEL_STREAM_${String(finishReason).toUpperCase()}` : undefined)
    finalized = true
    if (textItem) {
      textItem.status = incomplete ? "incomplete" : "completed"
      textItem.content = [{ type: "output_text", text: fullText, annotations: [] }]
      yield event("response.output_text.done", { item_id: textItem.id, output_index: textIndex, content_index: 0, text: fullText })
      yield event("response.content_part.done", { item_id: textItem.id, output_index: textIndex, content_index: 0, part: (textItem.content as JsonRecord[])[0] })
    }
    for (const { item, index } of tools.values()) {
      item.status = incomplete ? "incomplete" : "completed"
      yield event("response.function_call_arguments.done", { item_id: item.id, output_index: index, arguments: item.arguments })
    }
    for (const [index, item] of output.entries()) yield event("response.output_item.done", { output_index: index, item })
    yield event(incomplete ? "response.incomplete" : "response.completed", { response: { ...response(incomplete ? "incomplete" : "completed"), ...(incomplete ? { incomplete_details: { reason: finishReason === "length" ? "max_output_tokens" : "content_filter" } } : {}) } })
  } catch (error) {
    let reason = error instanceof Error && error.message.startsWith("MODEL_") ? error.message : "MODEL_STREAM_FAILED"
    if (!finalized) {
      try { await onFinish("FAILED", reason) } catch { reason = "RUNTIME_POLICY_REPORT_UNAVAILABLE" }
      finalized = true
    }
    yield event("response.failed", { response: { ...response("failed"), error: { code: reason, message: reason } } })
  } finally {
    try { if (!finalized) await onFinish("FAILED", "MODEL_STREAM_CANCELLED") }
    finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}
