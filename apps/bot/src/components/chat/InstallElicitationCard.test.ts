import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { InstallElicitationCard, type InstallElicitationRequest } from "./InstallElicitationCard"

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")

function withEnglishBotLocale<T>(run: () => T): T {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search: "?lang=en" } },
  })
  try {
    return run()
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor)
    else Reflect.deleteProperty(globalThis, "window")
  }
}

describe("InstallElicitationCard contract", () => {
  test("structures elicitation request with schema properties correctly", () => {
    const request: InstallElicitationRequest = {
      id: 101,
      serverName: "servicenow-csm",
      message: "請輸入 ServiceNow CSM 服務憑證與網址",
      mode: "form",
      properties: {
        instanceUrl: {
          title: "執行個體網址",
          description: "例如 https://dev12345.service-now.com",
          default: "https://dev12345.service-now.com",
        },
        apiToken: {
          title: "API 金鑰",
          format: "password",
        },
      },
    }

    expect(request.id).toBe(101)
    expect(request.serverName).toBe("servicenow-csm")
    expect(request.mode).toBe("form")
    expect(Object.keys(request.properties!)).toHaveLength(2)
    expect(request.properties!.instanceUrl.default).toBe("https://dev12345.service-now.com")
    expect(request.properties!.apiToken.format).toBe("password")
  })

  test("renders the Context7 lookup confirmation in English without translating its content", () => {
    const html = withEnglishBotLocale(() => renderToStaticMarkup(createElement(InstallElicitationCard, {
      request: {
        id: 102,
        serverName: "genio_context7",
        message: "只讀查詢內容",
        mode: "form",
      },
      onAccept: () => {},
      onDecline: () => {},
    })))

    expect(html).toContain("Confirm tool operation · genio_context7")
    expect(html).toContain("Review the following before responding")
    expect(html).toContain("Allow this operation")
    expect(html).toContain("只讀查詢內容")
  })

  test("renders another managed no-field tool confirmation in English", () => {
    const html = withEnglishBotLocale(() => renderToStaticMarkup(createElement(InstallElicitationCard, {
      request: {
        id: 103,
        serverName: "microsoft-learn",
        message: "只讀查詢內容",
        mode: "form",
      },
      onAccept: () => {},
      onDecline: () => {},
    })))

    expect(html).toContain("Confirm tool operation · microsoft-learn")
    expect(html).toContain("Review the following before responding")
    expect(html).toContain("Allow this operation")
    expect(html).toContain("只讀查詢內容")
  })

  test("keeps URL and field requests on their existing copy", () => {
    const urlHtml = withEnglishBotLocale(() => renderToStaticMarkup(createElement(InstallElicitationCard, {
      request: {
        id: 104,
        serverName: "microsoft-learn",
        message: "請完成登入",
        mode: "url",
        url: "https://learn.microsoft.com",
      },
      onAccept: () => {},
      onDecline: () => {},
    })))
    const formHtml = withEnglishBotLocale(() => renderToStaticMarkup(createElement(InstallElicitationCard, {
      request: {
        id: 105,
        serverName: "microsoft-learn",
        message: "請輸入搜尋字詞",
        mode: "form",
        properties: { query: { title: "搜尋字詞" } },
      },
      onAccept: () => {},
      onDecline: () => {},
    })))

    expect(urlHtml).toContain("連接工具 · microsoft-learn")
    expect(urlHtml).toContain("前往外部頁面完成授權")
    expect(formHtml).toContain("補充資訊 · microsoft-learn")
    expect(formHtml).toContain("送出資訊")
  })
})
