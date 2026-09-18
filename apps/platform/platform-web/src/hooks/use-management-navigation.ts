import { useCallback, useEffect, useState } from "react"

import { managementPageIds, type PageId } from "@/components/management-navigation"

const activityOwnedParameters = ["lane", "record", "table_q", "outcome", "traffic"]
const observabilityOwnedParameters = ["enforcement"]
const pageOwnedParameters = ["doc", "connection", "policy", ...observabilityOwnedParameters, ...activityOwnedParameters]

interface ManagementLocation {
  page: PageId
  search: string
  focusedResourceId: string | null
}

function readManagementLocation(): ManagementLocation {
  const parameters = new URLSearchParams(window.location.search)
  const requestedView = parameters.get("view")
  const requestedPage = (requestedView === "identity" ? "people" : requestedView) as PageId | null
  return {
    page: requestedPage && managementPageIds.has(requestedPage) ? requestedPage : "overview",
    search: parameters.get("q") ?? "",
    focusedResourceId: parameters.get("resource"),
  }
}

export function useManagementNavigation() {
  const initial = readManagementLocation()
  const [activePage, setActivePage] = useState<PageId>(initial.page)
  const [search, setSearch] = useState(initial.search)
  const [focusedResourceId, setFocusedResourceId] = useState<string | null>(initial.focusedResourceId)

  useEffect(() => {
    const restoreLocation = () => {
      const location = readManagementLocation()
      setActivePage(location.page)
      setSearch(location.search)
      setFocusedResourceId(location.focusedResourceId)
    }
    window.addEventListener("popstate", restoreLocation)
    return () => window.removeEventListener("popstate", restoreLocation)
  }, [])

  const navigate = useCallback((
    page: PageId,
    options: { filter?: string; focusedResourceId?: string | null; replace?: boolean; create?: boolean } = {},
  ) => {
    const nextSearch = options.filter ?? ""
    const nextFocusedResourceId = options.focusedResourceId ?? null
    const url = new URL(window.location.href)
    pageOwnedParameters.forEach((parameter) => url.searchParams.delete(parameter))
    if (page === "overview") url.searchParams.delete("view")
    else url.searchParams.set("view", page)
    if (nextSearch) url.searchParams.set("q", nextSearch)
    else url.searchParams.delete("q")
    if (nextFocusedResourceId) url.searchParams.set("resource", nextFocusedResourceId)
    else url.searchParams.delete("resource")
    if (page === "connections" && options.create) url.searchParams.set("create", "1")
    else url.searchParams.delete("create")

    window.history[options.replace ? "replaceState" : "pushState"]({}, "", url)
    setActivePage(page)
    setSearch(nextSearch)
    setFocusedResourceId(nextFocusedResourceId)
  }, [])

  useEffect(() => {
    const requestedView = new URLSearchParams(window.location.search).get("view")
    if (!requestedView || requestedView === "identity" || managementPageIds.has(requestedView as PageId)) return
    navigate("overview", { replace: true })
  }, [navigate])

  useEffect(() => {
    const url = new URL(window.location.href)
    const before = url.search
    if (activePage !== "product-docs") url.searchParams.delete("doc")
    if (activePage !== "activity") activityOwnedParameters.forEach((parameter) => url.searchParams.delete(parameter))
    if (!(activePage === "activity" || activePage === "audit" || activePage === "traces" || activePage === "metrics")) {
      observabilityOwnedParameters.forEach((parameter) => url.searchParams.delete(parameter))
    }
    if (activePage !== "connections" && activePage !== "resources") url.searchParams.delete("resource")
    if (activePage !== "connections") url.searchParams.delete("create")
    if (url.search !== before) window.history.replaceState({}, "", url)
  }, [activePage])

  return {
    activePage,
    search,
    focusedResourceId,
    navigate,
    setSearch,
  }
}
