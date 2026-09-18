import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { FormattedMessage } from "./formatted-message"

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

test("renders CE summaries with GFM structure, safe source links, and copyable code", () => {
  const html = withEnglishBotLocale(() => renderToStaticMarkup(
    <FormattedMessage text={"# CE Product Summary\n\n- **Gateway:** ready\n- **Audit:** recorded\n\n| Source | Status |\n| --- | --- |\n| [CE guide](https://example.com/ce-guide) | Ready |\n\n```ts\nconst status = \"ready\"\n```"} />,
  ))

  expect(html).toContain("<h1>CE Product Summary</h1>")
  expect(html).toContain("<ul>")
  expect(html).toContain("<table>")
  expect(html).toContain('href="https://example.com/ce-guide"')
  expect(html).toContain('target="_blank"')
  expect(html).toContain('rel="noreferrer"')
  expect(html).toContain('class="message-code-block"')
  expect(html).toContain("Copy")
  expect(html).toContain("const status")
})

test("keeps Bot mentions while rendering surrounding Markdown", () => {
  const html = renderToStaticMarkup(
    <FormattedMessage
      text="Ask @Research Bot to review [the CE source](https://example.com/source)."
      mentions={[{ id: "research", name: "Research Bot", description: "Research", kind: "bot" }]}
    />,
  )

  expect(html).toContain('class="composer-mention composer-mention--bot message-mention"')
  expect(html).toContain("Research Bot")
  expect(html).toContain('href="https://example.com/source"')
})

test("keeps Bot-looking code literal for display and copy content", () => {
  const html = renderToStaticMarkup(
    <FormattedMessage
      text={"Ask @Research Bot to review.\n\n```ts\nconst target = \"@Research Bot\"\n```\n\nUse `@Research Bot` as a literal."}
      mentions={[{ id: "research", name: "Research Bot", description: "Research", kind: "bot" }]}
    />,
  )

  expect(html.match(/message-mention/g)).toHaveLength(1)
  expect(html).toContain("const target = &quot;@Research Bot&quot;")
  expect(html).toContain("<code>@Research Bot</code>")
  expect(html).not.toContain("genio.invalid")
})

test("does not render raw HTML or javascript URLs from message text", () => {
  const html = renderToStaticMarkup(
    <FormattedMessage text={'[unsafe](javascript:alert(1))\n\n<script>alert("unsafe")</script>'} />,
  )

  expect(html).not.toContain("javascript:")
  expect(html).not.toContain("<script")
  expect(html).not.toContain('href=""')
})
