import { Search, X } from "lucide-react"
import type { ChatMessage } from "../../bots-storage"

export function SearchModal({
  messages,
  activeBotName,
  searchQuery,
  onSearchChange,
  onClose,
  onSelectMessage,
}: {
  messages: ChatMessage[]
  activeBotName: string
  searchQuery: string
  onSearchChange: (query: string) => void
  onClose: () => void
  onSelectMessage: (message: ChatMessage) => void
}) {
  const filtered = messages.filter(
    (m) => !searchQuery.trim() || m.text.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <div
      className="profile-dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section className="profile-dialog search-dialog" role="dialog" aria-modal="true">
        <div className="search-input-wrap">
          <Search />
          <input
            placeholder="搜尋當前對話訊息..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            autoFocus
          />
          <button type="button" className="icon-button" onClick={onClose} aria-label="關閉">
            <X />
          </button>
        </div>
        <div className="search-results">
          {filtered.map((m) => (
            <div className="search-result-item" key={m.id} onClick={() => onSelectMessage(m)}>
              <strong>{m.role === "assistant" ? activeBotName : "你"}</strong>
              <p>{m.text}</p>
            </div>
          ))}
          {filtered.length === 0 && <div className="search-empty">找不到符合的訊息</div>}
        </div>
      </section>
    </div>
  )
}
