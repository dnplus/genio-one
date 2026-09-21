import type { BotInstance, ChatMessage } from "../../bots-storage"
import type { GenioCatalog } from "../../lib/genio-one"
import type { ModelRoute } from "../../lib/model-route"
import { BotSettingsModal, SearchModal, ToolCatalogModal } from "../modals"

export interface WorkspaceModalsProps {
  activeBot: BotInstance
  catalog: GenioCatalog | null
  modelDirectory: ModelRoute | null
  accessToken?: string
  messages: ChatMessage[]
  toolStatusText: string
  mcpStatus: string
  settingsOpen: boolean
  searchOpen: boolean
  catalogOpen: boolean
  searchQuery: string
  onSearchChange: (query: string) => void
  onCloseSettings: () => void
  onCloseSearch: () => void
  onCloseCatalog: () => void
  onUpdateBot: (bot: BotInstance) => void | Promise<void>
  onToggleBinding: (botId: string, resourceId: string, capabilityId: string, currentlyInstalled: boolean) => Promise<void>
  onDuplicateBot?: (bot: BotInstance) => void
  onDeleteBot?: (bot: BotInstance) => void
  onRetryMcp: () => void
}

export function WorkspaceModals({
  activeBot,
  catalog,
  modelDirectory,
  accessToken,
  messages,
  toolStatusText,
  mcpStatus,
  settingsOpen,
  searchOpen,
  catalogOpen,
  searchQuery,
  onSearchChange,
  onCloseSettings,
  onCloseSearch,
  onCloseCatalog,
  onUpdateBot,
  onToggleBinding,
  onDuplicateBot,
  onDeleteBot,
  onRetryMcp,
}: WorkspaceModalsProps) {
  return (
    <>
      {settingsOpen && (
        <BotSettingsModal
          bot={activeBot}
          catalog={catalog}
          modelDirectory={modelDirectory}
          accessToken={accessToken}
          onClose={onCloseSettings}
          onSave={onUpdateBot}
          onDuplicate={onDuplicateBot ? () => onDuplicateBot(activeBot) : undefined}
          onDelete={onDeleteBot ? () => onDeleteBot(activeBot) : undefined}
          onBindingsChanged={onUpdateBot}
        />
      )}

      {searchOpen && (
        <SearchModal
          messages={messages}
          activeBotName={activeBot.name}
          searchQuery={searchQuery}
          onSearchChange={onSearchChange}
          onClose={onCloseSearch}
          onSelectMessage={onCloseSearch}
        />
      )}

      {catalogOpen && (
        <ToolCatalogModal
          catalog={catalog}
          accessToken={accessToken}
          toolStatusText={toolStatusText}
          mcpStatus={mcpStatus}
          activeBot={activeBot}
          onClose={onCloseCatalog}
          onRetryMcp={onRetryMcp}
          onToggleBinding={onToggleBinding}
        />
      )}
    </>
  )
}
