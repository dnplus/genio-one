import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { PersonalConnectionElicitationCard, PersonalConnectionElicitationCards, type PersonalConnectionRequest } from "./PersonalConnectionElicitationCard"

const request: PersonalConnectionRequest = {
  requestToken: "connection-request-301",
  botId: "bot-1",
  threadId: "thread-1",
  message: "需要你的 Notion 帳號連線",
  resourceId: "notion",
  resourceName: "Notion",
  reason: "讀取上週承諾並寫入本週週會素材",
}

describe("PersonalConnectionElicitationCard", () => {
  test("renders the resource and task reason before asking for authorization", () => {
    const html = renderToStaticMarkup(createElement(PersonalConnectionElicitationCard, {
      request,
      tenantId: "tenant-1",
      accessToken: "token",
      onConnected: () => {},
      onSaved: () => {},
      onDecline: () => {},
    }))

    expect(html).toContain("連接 Notion")
    expect(html).toContain("讀取上週承諾並寫入本週週會素材")
    expect(html).toContain("確認連線狀態")
  })

  test("does not claim that a connection is available without an account session", () => {
    const html = renderToStaticMarkup(createElement(PersonalConnectionElicitationCard, {
      request,
      onConnected: () => {},
      onDecline: () => {},
    }))

    expect(html).toContain("目前無法載入你的帳號連線設定")
    expect(html).not.toContain("可以使用工具")
  })

  test("renders every pending connection request", () => {
    const html = renderToStaticMarkup(createElement(PersonalConnectionElicitationCards, {
      requests: [request, {
        ...request,
        requestToken: "connection-request-302",
        resourceId: "mail",
        resourceName: "Mail",
        reason: "讀取本週待處理郵件",
      }],
      tenantId: "tenant-1",
      accessToken: "token",
      onConnected: () => {},
      onSaved: () => {},
      onDecline: () => {},
    }))

    expect(html).toContain("連接 Notion")
    expect(html).toContain("連接 Mail")
    expect(html).toContain("讀取上週承諾並寫入本週週會素材")
    expect(html).toContain("讀取本週待處理郵件")
  })
})
