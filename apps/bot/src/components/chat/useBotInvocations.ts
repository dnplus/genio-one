import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react"
import {
  createBotHandoff,
  getBotTimeline,
  decideInvocation,
  listInvocations,
  type BotHandoffAckDto,
  type BotInvocationRequest,
} from "../../lib/bot-api"
import {
  readBotMessages,
  saveBotMessages,
  type BotInstance,
  type ChatMessage,
} from "../../bots-storage"
import type { StateId } from "../../vendor/bloub/bot/states"
import type { MentionItem } from "./ChatComposer"
import { projectHandoffTimeline } from "../../../shared/handoff-timeline"

export interface UseBotInvocationsOptions {
  activeBotId: string
  token: string
  demo: boolean
  isMountedRef: RefObject<boolean>
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  setRuntimeState: Dispatch<SetStateAction<string>>
  setAgentState: Dispatch<SetStateAction<StateId>>
  bots?: BotInstance[]
  onMarkBotUnread?: (id: string) => void
}

export function useBotInvocations({
  activeBotId,
  token,
  demo,
  isMountedRef,
  setMessages,
  setRuntimeState,
  setAgentState,
  bots,
  onMarkBotUnread,
}: UseBotInvocationsOptions) {
  const selectedBot = useRef(activeBotId)
  selectedBot.current = activeBotId
  const [botInvocations, setBotInvocations] = useState<BotInvocationRequest[]>([])

  const refreshBotInvocations = useCallback(async () => {
    if (demo || !token) return
    try {
      const [caller, owner] = await Promise.all([
        listInvocations(token, "caller"),
        listInvocations(token, "owner"),
      ])
      if (!isMountedRef.current) return
      const merged = new Map<string, BotInvocationRequest>()
      for (const item of [...caller, ...owner]) merged.set(item.requestId, item)
      const next = [...merged.values()].sort((left, right) => right.createdAt - left.createdAt)
      setBotInvocations(next)
    } catch (error) { if (isMountedRef.current) setRuntimeState(error instanceof Error ? error.message : "交接狀態更新失敗") }
  }, [bots, demo, isMountedRef, setMessages, token])

  useEffect(() => {
    void refreshBotInvocations()
    if (demo) return
    const interval = setInterval(() => void refreshBotInvocations(), 5_000)
    return () => clearInterval(interval)
  }, [demo, refreshBotInvocations])

  const handleBotInvocationDecision = useCallback(async (requestId: string, decision: "APPROVE" | "DENY") => {
    if (demo) {
      const resultSummary = decision === "APPROVE" ? "Target Bot 已完成 ServiceNow Case 摘要，並回傳 bounded 結果。" : null
      setBotInvocations((current) => current.map((item) => item.requestId === requestId
        ? { ...item, state: decision === "APPROVE" ? "COMPLETED" : "DENIED", decisionReason: decision === "APPROVE" ? "Owner approved this Bot request" : "Owner denied this Bot request", decidedAt: Date.now(), resultSummary }
        : item))
      if (resultSummary) setMessages((current) => [...current, { id: `invocation-result-${requestId}`, role: "assistant", text: resultSummary, createdAt: Date.now() }])
      setRuntimeState("就緒")
      setAgentState("idle")
      return
    }
    if (!token) return
    try {
      await decideInvocation(token, requestId, decision, decision === "APPROVE" ? "Owner approved this Bot request" : "Owner denied this Bot request")
      await refreshBotInvocations()
    } catch (error) {
      if (isMountedRef.current) setRuntimeState(error instanceof Error ? error.message : "Bot request update failed")
      throw error
    }
  }, [demo, isMountedRef, refreshBotInvocations, setAgentState, setMessages, setRuntimeState, token])

  const handoffBot = useCallback(async ({
    mentionedBot,
    text,
    activeBotId,
    kind = "task",
    mentions,
    clientRequestId,
    originalMessage,
  }: {
    mentionedBot: MentionItem
    text: string
    activeBotId: string
    kind?: "task" | "fyi"
    mentions?: BotMentionSpan[]
    clientRequestId?: string
    originalMessage?: string
  }) => {
    const fact = stripBotMention(text, mentionedBot, mentions) || text
    const targetBotId = mentionedBot.botId || mentionedBot.id
    const targetBot = bots?.find((b) => b.id === targetBotId)
    const fromBot = bots?.find((b) => b.id === activeBotId)
    const fromBotName = fromBot?.name || "前手 Bot"
    const targetBotName = targetBot?.name || mentionedBot.name
    if (demo) {
      const now = Date.now()
      const handoffId = `demo-handoff-${now}`
      const simulated: BotHandoffAckDto = {
        handoffId,
        invocationId: `demo-invocation-${now}`,
        state: "ACKED",
        kind,
        visibility: kind === "fyi" ? "silent" : "visible",
        fromBotId: activeBotId,
        toBotId: targetBotId,
        fact,
        summary: kind === "fyi" ? `FYI → ${targetBotName}` : `交接 → ${targetBotName}`,
        async: true,
        processed: false,
        createdAt: now,
        events: [
          {
            eventId: `demo-acked-${now}`,
            handoffId,
            tenantId: "demo",
            botId: activeBotId,
            peerBotId: targetBotId,
            kind,
            visibility: "visible",
            type: "handoff.acked",
            summary: `已交接給 ${targetBotName}（對方稍後處理）`,
            fact,
            invocationId: null,
            createdAt: now,
          },
        ],
      }
      const events = simulated.events.map((event) => ({ ...event, fromBotId: activeBotId, toBotId: targetBotId, fromName: fromBotName, toName: targetBotName }))
      setMessages((current) => [...current, { id: `handoff-source:${clientRequestId ?? handoffId}`, role: "user", text: originalMessage ?? text, createdAt: now }, ...projectHandoffTimeline(activeBotId, events)])
      const targetThreadId = `thread-${targetBotId}-default`
      const inbox = projectHandoffTimeline(targetBotId, events.map((event) => ({ ...event, botId: targetBotId, peerBotId: activeBotId, visibility: kind === "fyi" ? "silent" : "visible", type: "handoff.queued" })))
      const existingTarget = readBotMessages(targetBotId, targetThreadId)
      saveBotMessages(targetBotId, targetThreadId, [...existingTarget, ...inbox])
      if (onMarkBotUnread) onMarkBotUnread(targetBotId)
      return simulated
    }
    if (!token) {
      setRuntimeState("尚未完成 GenioOne 登入")
      setAgentState("exclaim")
      return null
    }
    try {
      const result = await createBotHandoff(token, {
        clientRequestId, originalMessage: originalMessage ?? text,
        fromBotId: activeBotId,
        toBotId: targetBotId,
        fact,
        kind,
      })
      if (!isMountedRef.current) return null
      const ack = "acks" in result ? result.acks[0] : result
      if (!ack) throw new Error("BOT_HANDOFF_EMPTY")
      const canonical = await getBotTimeline(token, activeBotId)
      if (selectedBot.current !== activeBotId || !isMountedRef.current) return ack
      setMessages((current) => {
        const persisted = new Map(canonical.map((message) => [message.id, message]))
        return [...current.filter((message) => !persisted.has(message.id)), ...canonical].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      })
      setRuntimeState("交接已送出，結果會回到這裡")
      setAgentState("idle")
      if (onMarkBotUnread) onMarkBotUnread(targetBotId)

      return ack
    } catch (error) {
      if (!isMountedRef.current) return null
      setRuntimeState(error instanceof Error ? error.message : "交接失敗")
      setAgentState("exclaim")
      return null
    }
  }, [bots, demo, isMountedRef, onMarkBotUnread, setAgentState, setMessages, setRuntimeState, token])

  return {
    botInvocations,
    setBotInvocations,
    refreshBotInvocations,
    handleBotInvocationDecision,
    handoffBot,
  }
}
import { stripBotMention, type BotMentionSpan } from "./composer-mentions"
