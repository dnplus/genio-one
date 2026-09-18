import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SignIn } from "./SignIn"

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

test("renders the documents demo sign-in entry in English", () => {
  const html = withEnglishBotLocale(() => renderToStaticMarkup(<SignIn />))

  expect(html).toContain("Start with your organization account")
  expect(html).toContain("After you sign in to GenioOne, the Bot sees only Resources you can use or request.")
  expect(html).toContain("Sign in with GenioOne")
  expect(html).toContain("Sign in with another account")
})
