import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { ImagePicker } from "./ImagePicker"

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

test("ImagePicker renders its primary control in English", () => {
  const html = withEnglishBotLocale(() => renderToStaticMarkup(
    <ImagePicker images={[]} disabled={false} onChange={() => {}} />,
  ))

  expect(html).toContain('aria-label="Add image"')
  expect(html).toContain('title="Add image"')
  expect(html).not.toContain("新增圖片")
})
