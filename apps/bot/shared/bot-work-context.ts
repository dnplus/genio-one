export interface BotWorkContext {
  completeHistory: false
  turns: Array<{
    threadId: string
    turnId: string
    status: string
    startedAt: number | null
    request: string
    response: string
    truncated: boolean
    sourceMessageIds: string[]
    omittedAttachments: boolean
  }>
}
