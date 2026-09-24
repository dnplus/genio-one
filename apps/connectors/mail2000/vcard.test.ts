import { expect, test } from "bun:test"
import { parseMail2000VCard, searchMail2000Directory } from "./vcard"

test("CardDAV directory parsing preserves organization hints and resolves group members", () => {
  const addressBookUrl = "https://mail.test/addressbooks/bdsvd/"
  const group = parseMail2000VCard({
    url: `${addressBookUrl}weekly.vcf`,
    addressBook: "BDSVD",
    addressBookUrl,
    data: [
      "BEGIN:VCARD", "VERSION:4.0", "UID:weekly", "FN:BDSVD 週會", "ORG:GSS;BDSVD", "CATEGORIES:weekly,工程\\,設計", "KIND:group",
      "MEMBER:mailto:dnplus@example.com", "MEMBER:mailto:member@example.com", "END:VCARD",
    ].join("\r\n"),
  })!
  const person = parseMail2000VCard({
    url: `${addressBookUrl}member.vcf`,
    addressBook: "BDSVD",
    addressBookUrl,
    data: ["BEGIN:VCARD", "VERSION:4.0", "UID:member", "FN:王小明", "EMAIL:member@example.com", "ORG:GSS;BDSVD", "TITLE:工程師", "END:VCARD"].join("\r\n"),
  })!
  const result = searchMail2000Directory([group, person], { query: "BDSVD", kind: "group", limit: 10 })
  expect(result.total_matches).toBe(1)
  expect(result.results[0]?.organization).toBe("GSS / BDSVD")
  expect(result.results[0]?.categories).toEqual(["weekly", "工程,設計"])
  expect(result.results[0]?.members).toEqual([
    { email: "dnplus@example.com", full_name: null, organization: null, title: null, found_in_directory: false },
    { email: "member@example.com", full_name: "王小明", organization: "GSS / BDSVD", title: "工程師", found_in_directory: true },
  ])
  expect(result.results[0]?.address_book_path).toBe("addressbooks/bdsvd")
})

test("CardDAV people use exact connection email and parse folded and escaped values", () => {
  const person = parseMail2000VCard({
    url: "https://mail.test/addressbooks/people/person.vcf",
    addressBook: "People",
    addressBookUrl: "https://mail.test/addressbooks/people/",
    data: ["BEGIN:VCARD", "N:陳;小華;;;", "FN:小華\\n陳", "EMAIL:dnplus@example.com", "TITLE:產品\\,經理", "END:VCARD"].join("\r\n"),
  })!
  expect(person.full_name).toBe("小華\n陳")
  expect(person.title).toBe("產品,經理")
  expect(person.emails).toEqual(["dnplus@example.com"])
  expect(person.kind).toBe("person")
})

test("large CardDAV groups cap every member field so truncation actually bounds the response", () => {
  // Why: a group of hundreds of addresses must not leak the full list through member_emails
  // while members_truncated tells the caller the result was capped.
  const addressBookUrl = "https://mail.test/addressbooks/all/"
  const members = Array.from({ length: 150 }, (_, index) => `MEMBER:mailto:user${index}@example.com`)
  const group = parseMail2000VCard({
    url: `${addressBookUrl}everyone.vcf`,
    addressBook: "All",
    addressBookUrl,
    data: ["BEGIN:VCARD", "VERSION:4.0", "UID:everyone", "FN:全公司", "KIND:group", ...members, "END:VCARD"].join("\r\n"),
  })!
  expect(group.member_emails).toHaveLength(150)
  const result = searchMail2000Directory([group], { query: "user149@example.com", kind: "group", limit: 10 })
  expect(result.total_matches).toBe(1)
  expect(result.results[0]?.members_truncated).toBe(true)
  expect(result.results[0]?.members).toHaveLength(100)
  expect(result.results[0]?.member_emails).toHaveLength(100)
  expect(result.results[0]?.member_emails).toEqual(result.results[0]!.members!.map((member) => member.email))
})
