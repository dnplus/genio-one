import { test, expect, spyOn } from "bun:test"
import * as telemetry from "@genioone/telemetry/operation-observability"
import { createMail2000Smtp } from "./smtp"

test("SMTP uses personal credentials, preserves reply headers and closes transport", async () => {
  let closed = false
  const send = createMail2000Smtp({ host: "smtp.test", port: 465 }, (credential) => {
    expect(credential.username).toBe("alice")
    return {
      async sendMail(mail) {
        expect(mail.to).toEqual(["bob@example.test"])
        expect(mail.inReplyTo).toBe("<previous@example.test>")
        expect(mail.disableFileAccess).toBe(true)
        expect(mail.disableUrlAccess).toBe(true)
        return { messageId: "<sent@example.test>", accepted: ["bob@example.test"], rejected: [] }
      },
      close() { closed = true },
    }
  })
  const result = await send({ username: "alice", password: "test" }, { from: "alice@example.test", to: ["bob@example.test"], subject: "回覆", text: "測試", in_reply_to: "<previous@example.test>" })
  expect(result.message_id).toBe("<sent@example.test>")
  expect(closed).toBe(true)
})
test("SMTP failures are not automatically retried", async () => {
  let attempts = 0
  let closed = false
  const send = createMail2000Smtp({ host: "smtp.test", port: 465 }, () => ({
    async sendMail() { attempts++; throw new Error("timeout after DATA") }, close() { closed = true },
  }))
  await expect(send({ username: "alice", password: "test" }, { from: "alice@example.test", to: ["bob@example.test"], subject: "測試", text: "內容" })).rejects.toThrow()
  expect(attempts).toBe(1)
  expect(closed).toBe(true)
})

test("SMTP observation receives only transport metadata and delivery counts", async () => {
  const observations: unknown[] = []
  const observer = spyOn(telemetry, "observeOperation").mockImplementation((service, operation, input, run) => {
    observations.push({ service, operation, input })
    return Promise.resolve(run()).then(output => { observations.push(output); return output }) as ReturnType<typeof run>
  })
  const credential = { username: "private-user@example.test", password: "synthetic-secret" }
  const args = { from: "sender@example.test", to: ["to@example.test"], cc: ["cc@example.test"], bcc: ["bcc@example.test"], subject: "private-subject", text: "private-body", in_reply_to: "<private-reply@example.test>" }
  const delivery = { messageId: "<private-message@example.test>", accepted: args.to, rejected: args.bcc }
  let actual: unknown
  const send = createMail2000Smtp({ host: "smtp.test", port: 465 }, (received) => {
    expect(received).toBe(credential)
    return { async sendMail(options) { actual = options; return delivery }, close() {} }
  })
  try {
    expect(await send(credential, args)).toEqual({ message_id: delivery.messageId, accepted: delivery.accepted, rejected: delivery.rejected })
    expect(actual).toEqual({ from: args.from, to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, text: args.text, inReplyTo: args.in_reply_to, disableFileAccess: true, disableUrlAccess: true })
    expect(observations).toEqual([
      { service: "genio-connector-mail2000", operation: "smtp.send", input: { host: "smtp.test", port: 465, recipient_count: 3 } },
      { accepted_count: 1, rejected_count: 1 },
    ])
  } finally { observer.mockRestore() }
})

test("SMTP observer receives a safe failure while callers retain the original error", async () => {
  let observedError: unknown
  const observer = spyOn(telemetry, "observeOperation").mockImplementation((_service, _operation, _input, run) => {
    return Promise.resolve(run()).catch(error => { observedError = error; throw error }) as ReturnType<typeof run>
  })
  const original = new Error("550 private-recipient@example.test rejected: private-body")
  const send = createMail2000Smtp({ host: "smtp.test", port: 465 }, () => ({ async sendMail() { throw original }, close() {} }))
  try {
    let callerError: unknown
    try { await send({ username: "private-user", password: "synthetic-secret" }, { from: "sender@example.test", to: ["private-recipient@example.test"], subject: "private-subject", text: "private-body" }) } catch (error) { callerError = error }
    expect(callerError).toBe(original)
    expect(observedError).toBeInstanceOf(Error)
    expect((observedError as Error).message).toBe("MAIL2000_SMTP_SEND_FAILED")
    expect(JSON.stringify(observedError, Object.getOwnPropertyNames(observedError))).not.toContain("private-")
  } finally { observer.mockRestore() }
})
