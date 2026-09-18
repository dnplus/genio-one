import { useCallback, useEffect, useRef, useState } from "react"

export function useRecordSelection(parameter: string, initialValue: string | null = null) {
  const read = () => new URLSearchParams(window.location.search).get(parameter)
  const listScroll = useRef(0)
  const [selected, setSelected] = useState<string | null>(() => read() ?? initialValue)
  useEffect(() => {
    const restore = () => setSelected(read())
    window.addEventListener("popstate", restore)
    return () => window.removeEventListener("popstate", restore)
  }, [parameter, initialValue])
  const select = useCallback((value: string | null) => {
    if (value) listScroll.current = window.scrollY
    const url = new URL(window.location.href)
    if (value && parameter === "connection") url.searchParams.delete("create")
    if (value) url.searchParams.set(parameter, value)
    else url.searchParams.delete(parameter)
    if (url.href !== window.location.href) window.history.pushState({ ...window.history.state, scrollY: window.scrollY }, "", url)
    setSelected(value)
    requestAnimationFrame(() => window.scrollTo({ top: value ? 0 : listScroll.current }))
  }, [parameter])
  return [selected, select] as const
}
