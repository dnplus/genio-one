import { expect, test } from "bun:test"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useManagementNavigation } from "@/hooks/use-management-navigation"

const testControlLabels = {
  openDeniedActivity: "Open denied Activity",
  openOverview: "Open Overview",
}

function NavigationHarness() {
  const { activePage, focusedResourceId, navigate, search } = useManagementNavigation()

  return <>
    <output
      data-page={activePage}
      data-resource={focusedResourceId ?? ""}
      data-search={search}
      data-testid="management-navigation-state"
    />
    <button onClick={() => navigate("activity", { filter: "DENIED" })} type="button">{testControlLabels.openDeniedActivity}</button>
    <button onClick={() => navigate("overview", { replace: true })} type="button">{testControlLabels.openOverview}</button>
  </>
}

function expectNavigationState(page: string, search: string, resource = "") {
  const state = screen.getByTestId("management-navigation-state")
  expect(state.getAttribute("data-page")).toBe(page)
  expect(state.getAttribute("data-search")).toBe(search)
  expect(state.getAttribute("data-resource")).toBe(resource)
}

test("deep links initialise state and navigation writes the selected view through history", async () => {
  const originalUrl = window.location.href
  const originalPushState = window.history.pushState
  const originalReplaceState = window.history.replaceState
  const historyCalls: Array<{ method: "push" | "replace"; search: string }> = []
  let mounted: ReturnType<typeof render> | undefined

  try {
    window.location.href = "http://platform.test/management?view=connections&q=Customer%20API&resource=resource-42&create=1"
    mounted = render(<NavigationHarness />)
    expectNavigationState("connections", "Customer API", "resource-42")

    window.history.pushState = ((data: unknown, unused: string, url?: string | URL | null) => {
      const target = new URL(String(url), window.location.href)
      historyCalls.push({ method: "push", search: target.search })
      return originalPushState.call(window.history, data, unused, url)
    }) as History["pushState"]
    window.history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
      const target = new URL(String(url), window.location.href)
      historyCalls.push({ method: "replace", search: target.search })
      return originalReplaceState.call(window.history, data, unused, url)
    }) as History["replaceState"]

    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: testControlLabels.openDeniedActivity }))
    await waitFor(() => expectNavigationState("activity", "DENIED"))
    expect(new URLSearchParams(window.location.search).get("view")).toBe("activity")
    expect(new URLSearchParams(window.location.search).get("q")).toBe("DENIED")
    expect(new URLSearchParams(window.location.search).has("resource")).toBe(false)
    expect(new URLSearchParams(window.location.search).has("create")).toBe(false)
    expect(historyCalls).toEqual([{ method: "push", search: "?view=activity&q=DENIED" }])

    await user.click(screen.getByRole("button", { name: testControlLabels.openOverview }))
    await waitFor(() => expectNavigationState("overview", ""))
    expect(window.location.search).toBe("")
    expect(historyCalls).toEqual([
      { method: "push", search: "?view=activity&q=DENIED" },
      { method: "replace", search: "" },
    ])
  } finally {
    window.history.pushState = originalPushState
    window.history.replaceState = originalReplaceState
    mounted?.unmount()
    window.location.href = originalUrl
  }
})

test("popstate restores a resource deep link and the legacy identity view", async () => {
  const originalUrl = window.location.href
  let mounted: ReturnType<typeof render> | undefined

  try {
    window.location.href = "http://platform.test/management"
    mounted = render(<NavigationHarness />)
    expectNavigationState("overview", "")

    act(() => {
      window.history.pushState({}, "", "/management?view=resources&q=OpenAI&resource=resource-7")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await waitFor(() => expectNavigationState("resources", "OpenAI", "resource-7"))

    act(() => {
      window.history.pushState({}, "", "/management?view=identity&q=Grace")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await waitFor(() => expectNavigationState("people", "Grace"))
  } finally {
    mounted?.unmount()
    window.location.href = originalUrl
  }
})
