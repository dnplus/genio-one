export function belongsToThread(message: Record<string, unknown>, threadId: string | null) {
  const params = message.params as { threadId?: string | null; thread?: { id?: string }; turn?: { threadId?: string } } | undefined
  const eventThreadId = params?.threadId ?? params?.thread?.id ?? params?.turn?.threadId
  if (eventThreadId) return eventThreadId === threadId
  const method = typeof message.method === "string" ? message.method : ""
  return !method.startsWith("item/") && !method.startsWith("turn/") && method !== "mcpServer/elicitation/request"
}
