import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { ConnectCard, connectCardPhaseLabel } from "./ConnectCard"

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")

function withEnglishBotLocale<T>(run: () => T): T {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search: "?demo=documents&lang=en" } },
  })
  try {
    return run()
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor)
    else Reflect.deleteProperty(globalThis, "window")
  }
}

describe("ConnectCard phases", () => {
  test("phase labels stay in human vocabulary", () => {
    expect(connectCardPhaseLabel("choose")).toBe("需連線")
    expect(connectCardPhaseLabel("failed")).toBe("需連線")
    expect(connectCardPhaseLabel("connected")).toBe("可用")
    expect(connectCardPhaseLabel("oauth_pending")).toBe("連線中")
  })
})

test("renders OAuth connection system copy in English without changing provider copy", () => {
  const { chooseHtml, pendingHtml, connectedHtml } = withEnglishBotLocale(() => {
    expect(connectCardPhaseLabel("choose")).toBe("Connection required")
    expect(connectCardPhaseLabel("oauth_pending")).toBe("Connecting")
    expect(connectCardPhaseLabel("connected")).toBe("Available")
    const baseProps = {
      resourceId: "microsoft-learn",
      resourceDisplayName: "Microsoft Learn",
      onSelectPath: () => {},
      onCancel: () => {},
    }
    return {
      chooseHtml: renderToStaticMarkup(createElement(ConnectCard, {
        ...baseProps,
        phase: "choose",
        message: "Provider response stays unchanged",
      })),
      pendingHtml: renderToStaticMarkup(createElement(ConnectCard, {
        ...baseProps,
        phase: "oauth_pending",
      })),
      connectedHtml: renderToStaticMarkup(createElement(ConnectCard, {
        ...baseProps,
        phase: "connected",
      })),
    }
  })

  expect(chooseHtml).toContain("Connect · Microsoft Learn")
  expect(chooseHtml).toContain("Status: Connection required · It will return to “Available” when complete")
  expect(chooseHtml).toContain("Close connection card")
  expect(chooseHtml).toContain("Connect my account")
  expect(chooseHtml).toContain("Connect your account for this service before adding it to this Bot.")
  expect(chooseHtml).toContain("Provider response stays unchanged")
  expect(chooseHtml).not.toContain("連接我的帳號")
  expect(pendingHtml).toContain("Waiting for the account authorization callback. It will not be marked available until the connection is confirmed.")
  expect(connectedHtml).toContain("Connected. The capability is available again; you can continue adding or invoking it.")
  expect(connectedHtml).toContain("Back to list")
})
