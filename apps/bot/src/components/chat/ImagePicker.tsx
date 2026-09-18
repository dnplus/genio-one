import { useRef, useState } from "react"
import { Plus } from "lucide-react"

import { botCopy } from "../../lib/ui-copy"

export type DraftImage = { id: string; name: string; url: string }

export function ImagePicker({ images, onChange, disabled, onReadingChange }: { images: DraftImage[]; onChange: (images: DraftImage[]) => void; disabled: boolean; onReadingChange?: (reading: boolean) => void }) {
  const picker = useRef<HTMLInputElement>(null)
  const [error, setError] = useState("")
  const [reading, setReading] = useState(false)
  return <div className="image-picker">
    <input ref={picker} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={async (event) => {
      const files = [...(event.target.files ?? [])]
      event.target.value = ""
      if (!files.length) return
      if (images.length + files.length > 4 || files.some((file) => !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) || file.size > 2 * 1024 * 1024)) {
        setError("最多附加 4 張圖片，每張上限 2 MB（PNG、JPEG、WebP 或 GIF）。")
        return
      }
      setReading(true)
      onReadingChange?.(true)
      setError("")
      try {
        const added = await Promise.all(files.map(async (file) => ({ id: crypto.randomUUID(), name: file.name, url: await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(file)
        }) })))
        onChange([...images, ...added])
      } catch { setError("圖片讀取失敗，請重新選取。") }
      finally { setReading(false); onReadingChange?.(false) }
    }} />
    <button type="button" className="composer-tool-btn" aria-label={botCopy("Add image", "新增圖片")} title={botCopy("Add image", "新增圖片")} disabled={disabled || reading} onClick={() => picker.current?.click()}><Plus /></button>
    {images.map((image) => <span className="draft-image" key={image.id}>
      <img src={image.url} alt={image.name} />
      <button type="button" aria-label={`移除 ${image.name}`} disabled={reading || disabled} onClick={() => onChange(images.filter((entry) => entry.id !== image.id))}>×</button>
    </span>)}
    {error && <p role="alert">{error}</p>}
  </div>
}
