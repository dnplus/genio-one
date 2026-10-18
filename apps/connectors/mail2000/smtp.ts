import { observeOperation } from "@genioone/telemetry/operation-observability"
import nodemailer from "nodemailer"
import type { SendMailOptions } from "nodemailer"
import { z } from "zod"
import type { Mail2000Credential } from "./server"

export const sendMailSchema = {
  from: z.string().email(),
  to: z.array(z.string().email()).min(1).max(100),
  cc: z.array(z.string().email()).max(100).optional(),
  bcc: z.array(z.string().email()).max(100).optional(),
  subject: z.string().max(998).regex(/^[^\r\n]*$/),
  text: z.string().min(1).max(200_000),
  in_reply_to: z.string().max(998).regex(/^[^\r\n]+$/).optional(),
}
export type OutgoingMail = z.infer<z.ZodObject<typeof sendMailSchema>>
interface MailTransport {
  sendMail(options: SendMailOptions): Promise<{ messageId: string; accepted: unknown[]; rejected: unknown[] }>
  close(): void
}

export function createMail2000Smtp(config: { host: string; port: number }, factory: (credential: Mail2000Credential) => MailTransport = (credential) => nodemailer.createTransport({
  host: config.host, port: config.port, secure: config.port === 465, requireTLS: true,
  auth: { user: credential.username, pass: credential.password },
  connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  disableFileAccess: true, disableUrlAccess: true,
})) {
  return async (credential: Mail2000Credential, args: OutgoingMail) => {
    let result: { message_id: string; accepted: unknown[]; rejected: unknown[] } | undefined
    let failure: unknown
    let failed = false
    try {
      await observeOperation("genio-connector-mail2000", "smtp.send", { host: config.host, port: config.port, recipient_count: args.to.length + (args.cc?.length ?? 0) + (args.bcc?.length ?? 0) }, async () => {
        try {
          if (args.to.length + (args.cc?.length ?? 0) + (args.bcc?.length ?? 0) > 100) throw new Error("MAIL2000_TOO_MANY_RECIPIENTS")
          const transport = factory(credential)
          try {
            const sent = await transport.sendMail({ from: args.from, to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, text: args.text, inReplyTo: args.in_reply_to, disableFileAccess: true, disableUrlAccess: true })
            result = { message_id: sent.messageId, accepted: sent.accepted, rejected: sent.rejected }
            // Keep delivery details for the caller; the observer sees only counts.
            return { accepted_count: sent.accepted.length, rejected_count: sent.rejected.length }
          } finally { transport.close() }
        } catch (error) {
          failure = error
          failed = true
          // SMTP errors can contain recipient addresses or server responses.
          throw new Error("MAIL2000_SMTP_SEND_FAILED")
        }
      })
    } catch (error) {
      throw failed ? failure : error
    }
    return result!
  }
}
