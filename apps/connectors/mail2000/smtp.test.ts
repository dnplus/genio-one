import { test, expect } from "bun:test"
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
