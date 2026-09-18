import { describe, expect, test } from "bun:test"
import type { UserInputQuestionRequest } from "./UserInputQuestionCard"

describe("UserInputQuestionCard contract", () => {
  test("structures question request with options and custom answers payload correctly", () => {
    const request: UserInputQuestionRequest = {
      id: 42,
      questions: [
        {
          id: "action_choice",
          header: "下一步操作",
          question: "請選擇要執行的任務",
          isOther: true,
          options: [
            { label: "查詢案件", description: "查詢特定 CSM 案件進度" },
            { label: "列出全部", description: "取得目前所有指派中的案件" },
          ],
        },
      ],
    }

    expect(request.id).toBe(42)
    expect(request.questions[0].options).toHaveLength(2)
    expect(request.questions[0].isOther).toBe(true)

    const sampleAnswers = { [request.questions[0].id]: [request.questions[0].options![0].label] }
    expect(sampleAnswers["action_choice"]).toEqual(["查詢案件"])
  })
})
