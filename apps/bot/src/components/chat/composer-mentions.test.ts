import { describe, expect, test } from "bun:test"
import { mentionToken, splitMentionSegments, moveBotMentionSpans, stripBotMention, type MentionItem } from "./composer-mentions"
import { extractMentionedBotIds } from "./handoff-ui"
import { parseBotView } from "./bot-view-state"

const nova: MentionItem = {
  id: "bot-nova",
  name: "Nova",
  description: "d",
  kind: "bot",
}
const snow: MentionItem = {
  id: "servicenow-csm",
  name: "ServiceNow CSM 助手",
  description: "d",
  kind: "skill",
}

describe("composer mention segments", () => {
  test("dispatch and stripping use literal token boundaries, including later valid occurrences", () => {
    const special: MentionItem = { ...nova, id: "special", name: "N(o)+a" }
    const text = "email@N(o)+a @N(o)+a，工作"
    expect(extractMentionedBotIds("@Nova2 工作", [nova])).toEqual([])
    expect(extractMentionedBotIds(text, [special])).toEqual(["special"])
    expect(stripBotMention(text, special)).toBe("email@N(o)+a ，工作")
  })

  test("duplicate names require selected Bot identity that survives rename and draft reload", () => {
    const other = { ...nova, id: "other" }
    const text = "@Nova 工作"
    expect(splitMentionSegments(text, [nova, other])[0]?.type).toBe("ambiguous")
    expect(extractMentionedBotIds(text, [nova, other])).toEqual([])
    const mentions = [{ botId: "other", start: 0, end: 5, token: "@Nova" }]
    const restored = parseBotView(JSON.stringify({ draft: text, mentions }))
    expect(extractMentionedBotIds(restored.draft, [nova, { ...other, name: "Renamed" }], restored.mentions)).toEqual(["other"])
    expect(splitMentionSegments(text, [nova], mentions)[0]?.type).toBe("ambiguous")
    expect(extractMentionedBotIds("@other 工作", [nova, other])).toEqual(["other"])
  })

  test("draft edits shift untouched spans and remove edited mention bindings", () => {
    const mentions = [{ botId: "bot-nova", start: 0, end: 5, token: "@Nova" }]
    expect(moveBotMentionSpans("@Nova 工作", "請 @Nova 工作", mentions)[0]).toEqual({ ...mentions[0], start: 2, end: 7 })
    expect(moveBotMentionSpans("@Nova 工作", "@Nora 工作", mentions)).toEqual([])
    expect(parseBotView(JSON.stringify({ draft: "@Nora", mentions })).mentions).toEqual([])
  })
  test("bot token is @name", () => {
    expect(mentionToken(nova)).toBe("@Nova")
    expect(mentionToken(snow)).toBe("@servicenow-csm")
  })

  test("splits bot mention from following text", () => {
    const segments = splitMentionSegments("@Nova say hi", [nova, snow])
    expect(segments).toEqual([
      { type: "mention", item: nova, token: "@Nova" },
      { type: "text", value: " say hi" },
    ])
  })

  test("does not treat @Nova2 as Nova", () => {
    const segments = splitMentionSegments("@Nova2 hello", [nova])
    expect(segments).toEqual([{ type: "text", value: "@Nova2 hello" }])
  })
})
