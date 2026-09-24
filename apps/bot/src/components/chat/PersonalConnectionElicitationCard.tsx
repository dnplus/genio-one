import { Link2 } from "lucide-react"

import { InteractionCard } from "../common/InteractionCard"
import { PersonalConnectionCard } from "../modals/PersonalConnectionCard"
export interface PersonalConnectionPrompt {
  resourceId?: string
  resourceName?: string
  reason?: string
  message: string
}

export interface PersonalConnectionRequest extends PersonalConnectionPrompt {
  requestToken: string
  botId: string
  threadId: string
}

export function PersonalConnectionElicitationCards({
  requests,
  tenantId,
  accessToken,
  onConnected,
  onSaved,
  onDecline,
}: {
  requests: PersonalConnectionRequest[]
  tenantId?: string
  accessToken?: string
  onConnected: (requestToken: string, connectionId: string) => void | Promise<void>
  onSaved?: (requestToken: string, connectionId: string) => void | Promise<void>
  onDecline: (requestToken: string) => void | Promise<void>
}) {
  return requests.map((request) => <PersonalConnectionElicitationCard
    key={request.requestToken}
    request={request}
    tenantId={tenantId}
    accessToken={accessToken}
    onConnected={(connectionId) => onConnected(request.requestToken, connectionId)}
    onSaved={onSaved ? (connectionId) => onSaved(request.requestToken, connectionId) : undefined}
    onDecline={() => onDecline(request.requestToken)}
  />)
}

export function PersonalConnectionElicitationCard({
  request,
  tenantId,
  accessToken,
  onConnected,
  onSaved,
  onDecline,
}: {
  request: PersonalConnectionPrompt
  tenantId?: string
  accessToken?: string
  onConnected: (connectionId: string) => void | Promise<void>
  onSaved?: (connectionId: string) => void | Promise<void>
  onDecline: () => void
}) {
  if (!request.resourceId || !request.resourceName || !tenantId || !accessToken) {
    return <InteractionCard
      tone="connect"
      icon={<Link2 size={18} />}
      title={`連接 ${request.resourceName || "企業資源"}`}
      subtitle={request.reason || request.message}
      testId="personal-connection-elicitation-unavailable"
      onDismiss={onDecline}
      dismissLabel="取消連接"
    >
      <p>目前無法載入你的帳號連線設定。請重新登入後再試。</p>
    </InteractionCard>
  }

  return <PersonalConnectionCard
    tenantId={tenantId}
    resourceId={request.resourceId}
    resourceName={request.resourceName}
    reason={request.reason || request.message}
    accessToken={accessToken}
    onClose={onDecline}
    onConnected={onConnected}
    onSaved={onSaved}
  />
}
