import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"

import { verifyCompactEdDsaJws, type VerificationKeyRing } from "./compact-jws"

// Ephemeral keys keep the tests independent of deployment keys and secrets.
const signingKey = generateKeyPairSync("ed25519")
const otherKey = generateKeyPairSync("ed25519")
const publicKeyPem = signingKey.publicKey.export({ type: "spki", format: "pem" }).toString()
const keyRing: VerificationKeyRing = {
  schema_version: 1,
  keys: [{ key_id: "test-key", public_key_pem: publicKeyPem }],
}
const header = { alg: "EdDSA", kid: "test-key" }
const payload = { tenant: "租戶😀", nested: { items: [null, true, 42, "café", { message: "你好" }] } }
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

function signedSegments(encodedHeader: string, encodedPayload: string): string {
  const input = `${encodedHeader}.${encodedPayload}`
  return `${input}.${sign(null, Buffer.from(input), signingKey.privateKey).toString("base64url")}`
}

function token(customHeader: unknown = header, customPayload: unknown = payload): string {
  return signedSegments(encode(customHeader), encode(customPayload))
}

const validToken = token()

describe("verifyCompactEdDsaJws", () => {
  test("verifies an ephemeral Ed25519 signature and preserves nested Unicode payload", () => {
    expect(verifyCompactEdDsaJws(validToken, keyRing)).toEqual(payload)
  })

  test("selects the matching kid when it is not the first key", () => {
    const ring: VerificationKeyRing = { schema_version: 1, keys: [
      { key_id: "other", public_key_pem: otherKey.publicKey.export({ type: "spki", format: "pem" }).toString() },
      ...keyRing.keys,
    ] }
    expect(verifyCompactEdDsaJws(validToken, ring)).toEqual(payload)
  })

  for (const value of [null, true, 17, "文字", [1, "two"]]) {
    test(`returns authenticated JSON payload ${JSON.stringify(value)}`, () => {
      expect(verifyCompactEdDsaJws(token(header, value), keyRing)).toEqual(value)
    })
  }

  test("rejects payload replacement without a new signature", () => {
    const [encodedHeader, , signature] = validToken.split(".")
    expect(() => verifyCompactEdDsaJws(`${encodedHeader}.${encode({ tenant: "other" })}.${signature}`, keyRing)).toThrow("compact JWS signature is invalid")
  })

  test("authenticates header fields as well as the payload", () => {
    const [, encodedPayload, signature] = validToken.split(".")
    expect(() => verifyCompactEdDsaJws(`${encode({ ...header, typ: "changed" })}.${encodedPayload}.${signature}`, keyRing)).toThrow("compact JWS signature is invalid")
  })

  test("rejects a bit-flipped signature", () => {
    const [encodedHeader, encodedPayload, signature] = validToken.split(".")
    const bytes = Buffer.from(signature!, "base64url")
    bytes[0] = bytes[0]! ^ 1
    expect(() => verifyCompactEdDsaJws(`${encodedHeader}.${encodedPayload}.${bytes.toString("base64url")}`, keyRing)).toThrow("compact JWS signature is invalid")
  })

  test("rejects an empty signature", () => {
    const [encodedHeader, encodedPayload] = validToken.split(".")
    expect(() => verifyCompactEdDsaJws(`${encodedHeader}.${encodedPayload}.`, keyRing)).toThrow("compact JWS signature is invalid")
  })

  for (const malformed of ["", "one", "one.two", "one.two.three.four"]) {
    test(`rejects incorrect compact segment count ${JSON.stringify(malformed)}`, () => {
      expect(() => verifyCompactEdDsaJws(malformed, keyRing)).toThrow("payload is not compact JWS")
    })
  }

  test("rejects a malformed JSON header even when signed", () => {
    expect(() => verifyCompactEdDsaJws(signedSegments(Buffer.from("{broken").toString("base64url"), encode(payload)), keyRing)).toThrow()
  })

  for (const invalidHeader of [
    {}, { ...header, alg: "none" }, { ...header, alg: "RS256" },
    { alg: "EdDSA" }, { ...header, kid: "" }, { ...header, kid: " " },
    { ...header, kid: " test-key" }, { ...header, kid: "test-key " }, { ...header, kid: 7 },
  ]) {
    test(`rejects invalid header ${JSON.stringify(invalidHeader)}`, () => {
      expect(() => verifyCompactEdDsaJws(token(invalidHeader), keyRing)).toThrow("compact JWS header is invalid")
    })
  }

  test("rejects an unknown signing key identifier", () => {
    expect(() => verifyCompactEdDsaJws(token({ ...header, kid: "unknown" }), keyRing)).toThrow("signing key is unknown")
  })

  test("does not trust a matching kid with a different Ed25519 public key", () => {
    const ring: VerificationKeyRing = { schema_version: 1, keys: [{ key_id: "test-key", public_key_pem: otherKey.publicKey.export({ type: "spki", format: "pem" }).toString() }] }
    expect(() => verifyCompactEdDsaJws(validToken, ring)).toThrow("compact JWS signature is invalid")
  })

  test("rejects authenticated payload bytes that are not JSON", () => {
    expect(() => verifyCompactEdDsaJws(signedSegments(encode(header), Buffer.from("not JSON").toString("base64url")), keyRing)).toThrow()
  })

  for (const [index, invalidRing] of [
    { schema_version: 2, keys: keyRing.keys }, { schema_version: 1, keys: [] },
    { schema_version: 1, keys: null }, { schema_version: 1, keys: {} },
    ...["", " ", " test-key", "test-key ", 1].map(key_id => ({ schema_version: 1, keys: [{ key_id, public_key_pem: publicKeyPem }] })),
    ...["", " \n", 1].map(public_key_pem => ({ schema_version: 1, keys: [{ key_id: "test-key", public_key_pem }] })),
  ].entries()) {
    test(`rejects invalid keyring fixture ${index + 1}`, () => {
      expect(() => verifyCompactEdDsaJws(validToken, invalidRing as VerificationKeyRing)).toThrow("verification keyring is invalid")
    })
  }

  test("validates unused keyring entries before accepting a signature", () => {
    const ring: VerificationKeyRing = { ...keyRing, keys: [...keyRing.keys, { key_id: "", public_key_pem: publicKeyPem }] }
    expect(() => verifyCompactEdDsaJws(validToken, ring)).toThrow("verification keyring is invalid")
  })

  test("rejects a selected public key that cannot be parsed", () => {
    expect(() => verifyCompactEdDsaJws(validToken, { schema_version: 1, keys: [{ key_id: "test-key", public_key_pem: "not a PEM key" }] })).toThrow()
  })
})
