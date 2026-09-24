import { describe, expect, test } from "bun:test"

import { canonicalBytes, canonicalJson, canonicalValue, compareUtf8 } from "./canonical"

describe("compareUtf8", () => {
  test("orders by UTF-8 bytes, not by locale collation", () => {
    expect(compareUtf8("context7", "context_requirements")).toBeLessThan(0)
    expect("context7".localeCompare("context_requirements")).toBeGreaterThan(0)
  })

  test("orders by UTF-8 bytes, not by UTF-16 code units", () => {
    const wide = "Ａ"
    const supplementary = "\u{1D400}"
    expect(compareUtf8(wide, supplementary)).toBeLessThan(0)
    expect([supplementary, wide].sort().at(0)).toBe(supplementary)
  })

  test("matches UTF-8 byte order for mixed ASCII, CJK and BMP boundary strings", () => {
    // The non-surrogate fast path must agree with Buffer.compare; these samples
    // straddle every UTF-8 encoding-length boundary inside the BMP.
    const samples = [
      "", "a", "Z", "_", "context7", "context_", "\u007F", "\u0080", "é", "߿", "ࠀ",
      "中", "中文", "中a", "a中", "文", "Ａ", "ｱ", "퟿", "", "�", "￿",
    ]
    const sign = (value: number) => Math.sign(value)
    for (const left of samples) {
      for (const right of samples) {
        const expected = sign(Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))
        expect(sign(compareUtf8(left, right))).toBe(expected)
      }
    }
  })

  test("uses UTF-8 order when only one side contains a surrogate pair", () => {
    // UTF-16 code units put U+FFFF after U+10000 (0xFFFF > 0xD800); UTF-8 bytes do not.
    expect(compareUtf8("￿", "\u{10000}")).toBeLessThan(0)
    expect(compareUtf8("\u{10000}", "￿")).toBeGreaterThan(0)
    expect(compareUtf8("中￿", "中\u{1F600}")).toBeLessThan(0)
  })

  test("is a total order consistent with equality", () => {
    expect(compareUtf8("a", "a")).toBe(0)
    expect(compareUtf8("a", "b")).toBeLessThan(0)
    expect(compareUtf8("b", "a")).toBeGreaterThan(0)
    expect(compareUtf8("a", "ab")).toBeLessThan(0)
  })
})

describe("canonicalValue", () => {
  test("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  test("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]")
  })

  test("sorts keys inside array elements", () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]')
  })

  test("sorts numeric keys lexically at every object depth", () => {
    expect(canonicalJson({
      2: { 2: "two", 10: "ten" },
      10: { 2: "two", 10: "ten" },
      items: [{ 2: "two", 10: "ten" }],
    })).toBe('{"10":{"10":"ten","2":"two"},"2":{"10":"ten","2":"two"},"items":[{"10":"ten","2":"two"}]}')
  })

  test("drops undefined-valued properties so the value matches its serialization", () => {
    expect(canonicalValue({ a: undefined, b: 1 })).toEqual({ b: 1 })
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}')
  })

  test("matches JSON undefined handling for array items", () => {
    expect(canonicalJson({ values: [undefined, , { b: undefined, a: 1 }] })).toBe('{"values":[null,null,{"a":1}]}')
  })

  test("is stable regardless of insertion order", () => {
    expect(canonicalJson({ z: 1, a: 2 })).toBe(canonicalJson({ a: 2, z: 1 }))
  })

  test("leaves primitives alone", () => {
    expect(canonicalJson(null)).toBe("null")
    expect(canonicalJson("text")).toBe('"text"')
    expect(canonicalJson(7)).toBe("7")
    expect(canonicalJson(true)).toBe("true")
  })
})

describe("canonicalBytes", () => {
  test("encodes the canonical JSON as UTF-8", () => {
    expect(new TextDecoder().decode(canonicalBytes({ b: 1, a: 2 }))).toBe('{"a":2,"b":1}')
  })
})
