import { useEffect, useRef, useState } from "react"
import { FolderPlus, X } from "lucide-react"

export function CreateGroupModal({
  botName,
  busy = false,
  error = "",
  onClose,
  onCreate,
}: {
  botName: string
  busy?: boolean
  error?: string
  onClose: () => void
  onCreate: (name: string) => void
}) {
  const [name, setName] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    onCreate(trimmed)
  }

  return (
    <div
      className="profile-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section className="profile-dialog create-group-dialog" role="dialog" aria-modal="true" aria-labelledby="create-group-title">
        <header>
          <span>
            <strong id="create-group-title">新增分組</strong>
            <small>把 {botName} 放進新的分組</small>
          </span>
          <button type="button" className="icon-button" aria-label="關閉" onClick={onClose} disabled={busy}>
            <X />
          </button>
        </header>
        <form
          className="create-group-form"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <label htmlFor="create-group-name">
            分組名稱
            <input
              ref={inputRef}
              id="create-group-name"
              value={name}
              maxLength={120}
              placeholder="例如：客服、政策審查"
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {error ? <p className="designer-error" role="alert">{error}</p> : null}
          <div className="create-group-actions">
            <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="submit" className="primary-button" disabled={busy || !name.trim()}>
              <FolderPlus size={16} /> {busy ? "建立中…" : "建立分組"}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
