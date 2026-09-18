import { test, expect } from "bun:test"
import { decodeMail2000Message } from "./message"

test("MIME read decodes Chinese headers/body and keeps attachment data out of tool output", async () => {
  const source = Buffer.from([
    `Subject: =?UTF-8?B?${Buffer.from("測試郵件").toString("base64")}?=`,
    "Message-ID: <message@example.test>", "From: Alice <alice@example.test>",
    "To: Bob <bob@example.test>", 'Content-Type: multipart/mixed; boundary="parts"', "",
    "--parts", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "",
    Buffer.from("郵件本文").toString("base64"),
    "--parts", 'Content-Type: application/octet-stream; name="file.bin"', 'Content-Disposition: attachment; filename="file.bin"',
    "Content-Transfer-Encoding: base64", "", Buffer.from("attachment-bytes").toString("base64"), "--parts--",
  ].join("\r\n"))
  const mail = await decodeMail2000Message(source)
  expect(mail.subject).toBe("測試郵件")
  expect(mail.body_text.trim()).toBe("郵件本文")
  expect(mail.message_id).toBe("<message@example.test>")
  expect(mail.attachments[0]?.filename).toBe("file.bin")
  expect(JSON.stringify(mail)).not.toContain("attachment-bytes")
})
