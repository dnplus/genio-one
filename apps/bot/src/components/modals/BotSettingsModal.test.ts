import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { DEFAULT_BLOUB_AVATAR } from "../../avatar/bloub-avatar"
import type { BotInstance } from "../../bots-storage"
import { BotSettingsModal, oauthConnectionCopy, oauthConnectionRequiredCopy } from "./BotSettingsModal"

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

test("renders OAuth settings actions and errors in English", () => {
  withEnglishBotLocale(() => {
    expect(oauthConnectionCopy("signInRequired")).toBe("Sign in before completing the connection")
    expect(oauthConnectionCopy("connectionPending")).toBe("The connection status is not confirmed")
    expect(oauthConnectionCopy("unsupportedPath")).toBe("This connection method is not supported")
    expect(oauthConnectionCopy("allowPopup")).toBe("Allow the OAuth window to open, then try again")
    expect(oauthConnectionCopy("notReady")).toBe("This connection is not ready. Try again later")
    expect(oauthConnectionCopy("missingConnectionId")).toBe("The connection did not return a Connection ID")
    expect(oauthConnectionCopy("missingAuthorizationUrl")).toBe("OAuth did not return an authorization URL")
    expect(oauthConnectionCopy("invalidAuthorizationUrl")).toBe("The authorization URL is invalid")
    expect(oauthConnectionCopy("statusUnconfirmed")).toBe("The connection status could not be confirmed")
    expect(oauthConnectionCopy("notComplete")).toBe("OAuth is not complete. Finish authorization, then try again")
    expect(oauthConnectionCopy("connectedAndAdded")).toBe("Connected and added")
    expect(oauthConnectionCopy("addSignInRequired")).toBe("Sign in before adding this capability; a checkbox is not authorization.")
    expect(oauthConnectionRequiredCopy("需連線")).toBe("Connection required · Complete your OAuth connection first.")
  })
})

test("renders settings navigation chrome in English without changing the profile description", () => {
  const bot: BotInstance = {
    id: "cebot1",
    name: "Existing CE Bot",
    title: "Existing CE Bot",
    role: "Original user description",
    description: "Original user description",
    avatar: DEFAULT_BLOUB_AVATAR,
    workspacePath: "/workspaces/cebot1",
    skills: [],
    createdAt: 1,
  }

  const html = withEnglishBotLocale(() => renderToStaticMarkup(createElement(BotSettingsModal, {
    bot,
    catalog: null,
    onClose: () => {},
    onSave: () => {},
  })))

  expect(html).toContain("Bot settings · Existing CE Bot")
  expect(html).toContain("Manage your profile, Bot-specific skills, and enterprise capabilities/tools")
  expect(html).toContain("Close settings")
  expect(html).toContain(">Profile<")
  expect(html).toContain(">Bot skills<")
  expect(html).toContain(">Capabilities / tools<")
  expect(html).toContain("Model route")
  expect(html).toContain("Set up your Bot")
  expect(html).toContain("What should I call you?")
  expect(html).toContain("Appearance and expression style")
  expect(html).toContain("Original user description")
  expect(html).not.toContain("Bot 設定")
})
