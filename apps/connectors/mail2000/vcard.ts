export interface Mail2000DirectoryEntry {
  uid: string | null
  full_name: string
  emails: string[]
  organization: string | null
  title: string | null
  categories: string[]
  kind: "person" | "group"
  member_emails: string[]
  address_book: string
  address_book_path: string
  address_book_url: string
  object_url: string
}

function unescapeValue(value: string): string {
  return value
    .replace(/\\[nN]/g, "\n")
    .replace(/\\([,;\\])/g, "$1")
    .trim()
}

function splitEscaped(value: string, separator: string): string[] {
  const parts: string[] = []
  let current = ""
  let escaped = false
  for (const character of value) {
    if (escaped) {
      current += "\\" + character
      escaped = false
    } else if (character === "\\") {
      escaped = true
    } else if (character === separator) {
      parts.push(current)
      current = ""
    } else {
      current += character
    }
  }
  if (escaped) current += "\\"
  parts.push(current)
  return parts
}

function property(line: string): { name: string; value: string } | null {
  let escaped = false
  let separator = -1
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (escaped) escaped = false
    else if (character === "\\") escaped = true
    else if (character === ":") {
      separator = index
      break
    }
  }
  if (separator < 1) return null
  const descriptor = line.slice(0, separator).split(";")[0]?.split(".").at(-1)?.toUpperCase()
  return descriptor ? { name: descriptor, value: line.slice(separator + 1) } : null
}

function emailFromValue(value: string): string | null {
  const normalized = unescapeValue(value).replace(/^mailto:/i, "").trim().toLowerCase()
  return /^[^\s@<>]+@[^\s@<>]+$/.test(normalized) ? normalized : null
}

export function parseMail2000VCard(input: { url: string; data: string; addressBook: string; addressBookUrl: string }): Mail2000DirectoryEntry | null {
  const unfolded = input.data.replace(/\r?\n[ \t]/g, "")
  const fields = new Map<string, string[]>()
  for (const line of unfolded.split(/\r?\n/)) {
    const item = property(line)
    if (!item) continue
    fields.set(item.name, [...(fields.get(item.name) ?? []), item.value])
  }
  const first = (name: string) => fields.get(name)?.[0]
  const emails = [...new Set((fields.get("EMAIL") ?? []).map(emailFromValue).filter((value): value is string => Boolean(value)))].sort()
  const memberEmails = [...new Set((fields.get("MEMBER") ?? []).map(emailFromValue).filter((value): value is string => Boolean(value)))].sort()
  const fullName = unescapeValue(first("FN") ?? "")
  const structuredName = (first("N") ?? "").split(";").slice(0, 3).map(unescapeValue).filter(Boolean).reverse().join(" ").trim()
  const organization = splitEscaped(first("ORG") ?? "", ";").map(unescapeValue).filter(Boolean).join(" / ") || null
  const categories = [...new Set((fields.get("CATEGORIES") ?? []).flatMap((value) => splitEscaped(value, ",").map(unescapeValue).filter(Boolean)))].sort()
  const kind = (first("KIND") ?? "").toLowerCase() === "group" || memberEmails.length > 0 ? "group" : "person"
  const name = fullName || structuredName || emails[0] || ""
  if (!name && memberEmails.length === 0) return null
  return {
    uid: first("UID") ? unescapeValue(first("UID")!) : null,
    full_name: name,
    emails,
    organization,
    title: first("TITLE") ? unescapeValue(first("TITLE")!) : null,
    categories,
    kind,
    member_emails: memberEmails,
    address_book: input.addressBook,
    address_book_path: new URL(input.addressBookUrl).pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment)).join("/"),
    address_book_url: input.addressBookUrl,
    object_url: input.url,
  }
}

export function searchMail2000Directory(entries: Mail2000DirectoryEntry[], args: { query: string; kind: "all" | "person" | "group"; limit: number }) {
  const query = args.query.normalize("NFKC").trim().toLocaleLowerCase()
  const matches = entries.filter((entry) => {
    if (args.kind !== "all" && entry.kind !== args.kind) return false
    const searchable = [entry.full_name, entry.organization ?? "", entry.title ?? "", entry.address_book, entry.address_book_path, entry.address_book_url, ...entry.emails, ...entry.categories, ...entry.member_emails]
      .join("\n").normalize("NFKC").toLocaleLowerCase()
    return searchable.includes(query)
  })
  const peopleByEmail = new Map<string, Mail2000DirectoryEntry>()
  for (const entry of entries) if (entry.kind === "person") for (const email of entry.emails) peopleByEmail.set(email, entry)
  const selected = matches.slice(0, args.limit)
  return {
    query: args.query,
    total_matches: matches.length,
    truncated: matches.length > selected.length,
    results: selected.map((entry) => ({
      ...entry,
      ...(entry.kind === "group" ? {
        // The member cap must apply to every member field, or member_emails would still return all addresses.
        member_emails: entry.member_emails.slice(0, 100),
        members: entry.member_emails.slice(0, 100).map((email) => {
          const member = peopleByEmail.get(email)
          return { email, full_name: member?.full_name ?? null, organization: member?.organization ?? null, title: member?.title ?? null, found_in_directory: Boolean(member) }
        }),
        members_truncated: entry.member_emails.length > 100,
      } : {}),
    })),
  }
}
