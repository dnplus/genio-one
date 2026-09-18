import { simpleParser } from "mailparser"

export async function decodeMail2000Message(source: Buffer) {
  const parsed = await simpleParser(source, { skipTextToHtml: true })
  return {
    message_id: parsed.messageId ?? null,
    subject: parsed.subject ?? "",
    date: parsed.date?.toISOString() ?? null,
    from: parsed.from?.value ?? [],
    to: Array.isArray(parsed.to) ? parsed.to.flatMap((address) => address.value) : parsed.to?.value ?? [],
    cc: Array.isArray(parsed.cc) ? parsed.cc.flatMap((address) => address.value) : parsed.cc?.value ?? [],
    body_text: (parsed.text ?? "").slice(0, 100_000),
    body_truncated: (parsed.text?.length ?? 0) > 100_000,
    attachments: parsed.attachments.map((attachment) => ({ filename: attachment.filename ?? null, content_type: attachment.contentType, size: attachment.size, content_id: attachment.contentId ?? null })),
  }
}
