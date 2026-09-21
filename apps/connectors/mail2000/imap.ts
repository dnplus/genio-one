import { instrumentModuleGraph, observeOperation } from "@genioone/telemetry/operation-observability"
import { ImapFlow } from "imapflow"
import { decodeMail2000Message } from "./message"
import type { Mail2000Credential } from "./server"

export interface MailReference { folder: string; uid: number; uid_validity: string }

export function createMail2000Imap(config: { host: string; port: number }, factory = (credential: Mail2000Credential) => new ImapFlow({
  host: config.host, port: config.port, secure: true, logger: false,
  auth: { user: credential.username, pass: credential.password },
  connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
})) {
  async function connected<T>(credential: Mail2000Credential, action: (client: ImapFlow) => Promise<T>) {
    const client = factory(credential)
    try { await observeOperation("genio-connector-mail2000", "imap.connect", { host: config.host, port: config.port, username: credential.username }, () => client.connect()); return await action(client) }
    finally { await client.logout().catch(() => undefined) }
  }
  async function message<T>(credential: Mail2000Credential, reference: MailReference, write: boolean, action: (client: ImapFlow) => Promise<T>) {
    return connected(credential, async (client) => {
      const lock = await client.getMailboxLock(reference.folder, { readOnly: !write })
      try {
        if (!client.mailbox || String(client.mailbox.uidValidity) !== reference.uid_validity) throw new Error("MAIL2000_MAILBOX_CHANGED")
        const current = await client.fetchOne(String(reference.uid), { uid: true }, { uid: true })
        if (!current) throw new Error("MAIL2000_MESSAGE_NOT_FOUND")
        return await action(client)
      } finally { lock.release() }
    })
  }
  const api = {
    listMailboxes: (credential: Mail2000Credential) => connected(credential, async (client) => {
      const rows = await client.list()
      const result: Array<{ path: string; name: string; specialUse?: string }> = []
      for (const row of rows) {
        if (!row.flags.has("\\Noselect")) {
          const item: { path: string; name: string; specialUse?: string } = { path: row.path, name: row.name }
          if (row.specialUse !== undefined) {
            item.specialUse = row.specialUse
          }
          result.push(item)
        }
      }
      return result
    }),
    search: (credential: Mail2000Credential, args: { folder: string; text?: string; from?: string; unseen?: boolean; limit: number }) => connected(credential, async (client) => {
      const lock = await client.getMailboxLock(args.folder, { readOnly: true })
      try {
        if (!client.mailbox) throw new Error("MAIL2000_MAILBOX_NOT_FOUND")
        const uids = await client.search({ ...(args.text ? { text: args.text } : {}), ...(args.from ? { from: args.from } : {}), ...(args.unseen === undefined ? {} : { seen: !args.unseen }), all: !args.text && !args.from && args.unseen === undefined }, { uid: true }) || []
        const selected = uids.slice().sort((a, b) => b - a).slice(0, args.limit)
        const messages = []
        for (const uid of selected) {
          const result = await client.fetchOne(String(uid), { envelope: true, flags: true, size: true }, { uid: true })
          if (result) {
            const date = result.envelope?.date
            messages.push({ uid, subject: result.envelope?.subject ?? "", from: result.envelope?.from ?? [], date: date instanceof Date ? date.toISOString() : date ?? null, size: result.size, flags: [...result.flags ?? []] })
          }
        }
        return { folder: args.folder, uid_validity: String(client.mailbox.uidValidity), total: uids.length, messages }
      } finally { lock.release() }
    }),
    read: (credential: Mail2000Credential, reference: MailReference) => message(credential, reference, false, async (client) => {
      const row = await client.fetchOne(String(reference.uid), { envelope: true, flags: true, size: true, source: { start: 0, maxLength: 100_000 } }, { uid: true })
      if (!row) throw new Error("MAIL2000_MESSAGE_NOT_FOUND")
      return { ...reference, ...await decodeMail2000Message(row.source ?? Buffer.alloc(0)), flags: [...row.flags ?? []], truncated: (row.size ?? 0) > 100_000 }
    }),
    setFlags: (credential: Mail2000Credential, args: MailReference & { flags: string[] }) => message(credential, args, true, async (client) => {
      if (!await client.messageFlagsSet([args.uid], args.flags, { uid: true })) throw new Error("MAIL2000_FLAGS_FAILED")
      return { ...args }
    }),
    move: (credential: Mail2000Credential, args: MailReference & { destination: string }) => message(credential, args, true, async (client) => {
      const result = await client.messageMove([args.uid], args.destination, { uid: true })
      if (!result) throw new Error("MAIL2000_MOVE_FAILED")
      return { destination: args.destination, uid: result.uidMap?.get(args.uid) ?? null, uid_validity: result.uidValidity?.toString() ?? null }
    }),
    delete: (credential: Mail2000Credential, args: MailReference) => message(credential, args, true, async (client) => {
      if (!await client.messageDelete([args.uid], { uid: true })) throw new Error("MAIL2000_DELETE_FAILED")
      return { ...args, deleted: true }
    }),
    append: (credential: Mail2000Credential, args: { folder: string; raw_message: string }) => connected(credential, async (client) => {
      const result = await client.append(args.folder, args.raw_message)
      if (!result) throw new Error("MAIL2000_APPEND_FAILED")
      return { folder: args.folder, uid: result.uid ?? null, uid_validity: result.uidValidity?.toString() ?? null }
    }),
    createFolder: (credential: Mail2000Credential, args: { folder: string }) => connected(credential, async (client) => {
      await client.mailboxCreate(args.folder)
      return { folder: args.folder }
    }),
    renameFolder: (credential: Mail2000Credential, args: { folder: string; destination: string }) => connected(credential, async (client) => {
      await client.mailboxRename(args.folder, args.destination)
      return { folder: args.destination }
    }),
    deleteFolder: (credential: Mail2000Credential, args: { folder: string }) => connected(credential, async (client) => {
      await client.mailboxDelete(args.folder)
      return { folder: args.folder, deleted: true }
    }),
  }
  instrumentModuleGraph({ imap: api }, "genio-connector-mail2000")
  return api
}
export type Mail2000Imap = ReturnType<typeof createMail2000Imap>
