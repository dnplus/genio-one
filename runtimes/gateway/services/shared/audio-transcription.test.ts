import { describe, expect, test } from "bun:test"
import { prepareTranscriptionRequest, transcriptionFields } from "./audio-transcription"

async function upload(models = ["breeze-asr"]) {
  const form = new FormData()
  for (const model of models) form.append("model", model)
  form.append("file", new Blob([new Uint8Array([0, 255, 10, 13, 128])]), "audio.webm")
  const request = new Response(form)
  const type = request.headers.get("content-type")!
  return { body: new Uint8Array(await request.arrayBuffer()), type }
}

describe("transcription gateway boundary", () => {
  test("reads the uploaded model and preserves every binary byte", async () => {
    const input = await upload()
    const prepared = await prepareTranscriptionRequest(input.body, input.type, false)
    expect(JSON.parse(Buffer.from(prepared.body).toString())).toEqual({ model: "breeze-asr" })
    expect(prepared.restore(prepared.body)).toEqual(input.body)
    expect(() => prepared.restore(Buffer.from('{"model":"other-model"}'))).toThrow("ASR_REQUEST_REWRITE_UNSUPPORTED")
  })
  test("rejects duplicate models and text processors on audio", async () => {
    const input = await upload(["allowed", "denied"])
    await expect(transcriptionFields(input.body, input.type)).rejects.toThrow("ASR_INVALID_FIELD")
    await expect(prepareTranscriptionRequest(input.body, input.type, true)).rejects.toThrow("ASR_REQUEST_PROCESSORS_UNSUPPORTED")
  })
  test("retains JSON request processing", async () => {
    const body = Buffer.from('{"model":"chat"}')
    const prepared = await prepareTranscriptionRequest(body, "application/json", true)
    const changed = Buffer.from('{"model":"classified"}')
    expect(prepared.restore(changed)).toBe(changed)
  })
})
