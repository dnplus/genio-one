import { useCallback, useEffect, useRef, useState } from "react"
import type { DraftImage } from "./ImagePicker"

let opening: Promise<IDBDatabase> | undefined
const writes = new Map<string, Promise<unknown>>()

function database() {
  if (!opening) opening = new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false
    const request = indexedDB.open("genio-bot-drafts", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("images")
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return }
      request.result.onversionchange = () => { request.result.close(); opening = undefined }
      resolve(request.result)
    }
    request.onerror = () => { opening = undefined; reject(request.error) }
    request.onblocked = () => { blocked = true; opening = undefined; reject(new Error("IMAGE_DRAFT_DATABASE_BLOCKED")) }
  }).catch((error) => { opening = undefined; throw error })
  return opening
}

async function readImages(key: string): Promise<DraftImage[]> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction("images", "readonly")
    const request = tx.objectStore("images").get(key)
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : [])
    request.onerror = () => reject(request.error)
  })
}

function mutateImages(key: string, change: (current: DraftImage[]) => DraftImage[]) {
  const previous = writes.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    const db = await database()
    return new Promise<DraftImage[]>((resolve, reject) => {
      const tx = db.transaction("images", "readwrite")
      const store = tx.objectStore("images")
      const request = store.get(key)
      let result: DraftImage[] = []
      request.onsuccess = () => {
        result = change(Array.isArray(request.result) ? request.result : [])
        if (result.length) store.put(result, key)
        else store.delete(key)
      }
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error("IMAGE_DRAFT_WRITE_ABORTED"))
    })
  })
  writes.set(key, operation)
  void operation.finally(() => { if (writes.get(key) === operation) writes.delete(key) }).catch(() => {})
  return operation
}

export function useImageDrafts(key: string) {
  const failedOperation = useRef<"save" | "cleanup" | null>(null)
  const cleanupIds = useRef(new Set<string>())
  const currentKey = useRef(key)
  currentKey.current = key
  const [reload, setReload] = useState(0)
  const [state, setState] = useState({ key, images: [] as DraftImage[], loading: true, saving: false, error: "" })
  useEffect(() => {
    let cancelled = false
    failedOperation.current = null
    setState({ key, images: [], loading: true, saving: false, error: "" })
    void (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(() => readImages(key)).then((images) => {
      if (!cancelled) setState({ key, images, loading: false, saving: false, error: "" })
    }).catch(() => {
      if (!cancelled) setState({ key, images: [], loading: false, saving: false, error: "圖片草稿尚未恢復，暫時無法送出。請重試載入圖片草稿。" })
    })
    return () => { cancelled = true }
  }, [key, reload])
  const setImages = useCallback((images: DraftImage[]) => {
    setState((current) => current.key === key ? { ...current, images, saving: true, error: "" } : current)
    void mutateImages(key, () => images).then(() => {
      if (currentKey.current === key) setState((current) => ({ ...current, saving: false }))
    }).catch(() => {
      if (currentKey.current === key) {
        failedOperation.current = "save"
        setState((current) => ({ ...current, saving: false, error: "圖片尚未保存，重新整理可能失去這次變更。請重試保存。" }))
      }
    })
  }, [key])
  const removeSent = useCallback(async (ids: Set<string>) => {
    if (!ids.size) return
    if (currentKey.current === key) setState((current) => ({ ...current, saving: true }))
    try {
      await mutateImages(key, (images) => images.filter((image) => !ids.has(image.id)))
      if (currentKey.current === key) setState((current) => ({ ...current, images: current.images.filter((image) => !ids.has(image.id)), saving: false, error: "" }))
    } catch {
      if (currentKey.current === key) {
        failedOperation.current = "cleanup"
        cleanupIds.current = ids
        setState((current) => ({ ...current, saving: false, error: "訊息已送出，但圖片草稿清理失敗；請重試清理，避免重複送出。" }))
      }
    }
  }, [key])
  return { images: state.key === key ? state.images : [], loading: state.key !== key || state.loading, saving: state.key === key && state.saving, error: state.key === key ? state.error : "", setImages, removeSent, retry: () => {
    if (failedOperation.current === "save") setImages(state.images)
    else if (failedOperation.current === "cleanup") void removeSent(cleanupIds.current)
    else setReload((value) => value + 1)
  } }
}
