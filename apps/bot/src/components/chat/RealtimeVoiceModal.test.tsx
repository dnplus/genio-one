import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RealtimeVoiceModal } from "./RealtimeVoiceModal"
import { VoiceInput } from "./VoiceInput"
import { DEFAULT_BLOUB_AVATAR } from "../../avatar/bloub-avatar"
import type { BotInstance } from "../../bots-storage"

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

const dummyBot: BotInstance = {
  id: "bot-realtime-test",
  name: "語音測試助手",
  role: "助手",
  title: "助手",
  description: "說明",
  avatar: DEFAULT_BLOUB_AVATAR,
  workspacePath: "/tmp",
  skills: [],
  bindings: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

test("RealtimeVoiceModal renders active bot name, status, visualizer, and end call controls", () => {
  const html = renderToStaticMarkup(
    <RealtimeVoiceModal
      isOpen={true}
      onClose={() => {}}
      activeBot={dummyBot}
      threadId="thread-test-1"
      clientRef={{ current: null }}
      demo={true}
    />
  )

  expect(html).toContain("語音測試助手")
  expect(html).toContain("即時語音通話")
  expect(html).toContain("voice-modal-backdrop")
  expect(html).toContain("voice-visualizer-container")
  expect(html).toContain("voice-transcript-box")
  expect(html).toContain("結束通話")
})

test("RealtimeVoiceModal returns null when closed", () => {
  const html = renderToStaticMarkup(
    <RealtimeVoiceModal
      isOpen={false}
      onClose={() => {}}
      activeBot={dummyBot}
      threadId="thread-test-1"
      clientRef={{ current: null }}
      demo={true}
    />
  )

  expect(html).toBe("")
})

test("VoiceInput renders recording button and is accessible in demo mode", () => {
  const html = renderToStaticMarkup(
    <VoiceInput
      token=""
      disabled={false}
      demo={true}
      onTranscript={() => {}}
      onBusyChange={() => {}}
    />
  )

  expect(html).toContain("voice-input")
  expect(html).toContain("voice-input-button")
  expect(html).toContain("語音輸入")
  expect(html).not.toContain("disabled")
})

test("VoiceInput renders the primary control in English", () => {
  const html = withEnglishBotLocale(() => renderToStaticMarkup(
    <VoiceInput
      token=""
      disabled={false}
      demo={true}
      onTranscript={() => {}}
      onBusyChange={() => {}}
    />
  ))

  expect(html).toContain("Voice input")
  expect(html).toContain("Voice input, up to 60 seconds")
  expect(html).not.toContain("語音輸入")
})
