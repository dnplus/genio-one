import { fitDistillationExcerpt } from "@genioone/protocol/distillation-triage"

import type { Turn } from "../generated/v2/Turn"

type Excerpt = { text: string; truncated: boolean }

function visibleParts(turn: Turn): string[] {
  const parts: string[] = []
  for (const item of turn.items ?? []) {
    if (item.type === "userMessage") {
      for (const part of item.content) if (part.type === "text" && part.text) parts.push(part.text)
    } else if (item.type === "agentMessage" && item.text) {
      parts.push(item.text)
    }
  }
  return parts
}

function excerptFromParts(parts: readonly string[]): Excerpt {
  let text = ""
  let truncated = false
  for (const part of parts) {
    const next = text ? `${text}\n${part}` : part
    const fitted = fitDistillationExcerpt(next)
    text = fitted.text
    if (fitted.truncated || fitted.text !== next) {
      truncated = true
      break
    }
  }
  return { text, truncated }
}

export function excerptFromTurn(turn: Turn): Excerpt {
  return excerptFromParts(visibleParts(turn))
}

export function legacyExcerptFromTurn(turn: Turn): Excerpt {
  const parts = visibleParts(turn)
  if (turn.error?.message) parts.push(turn.error.message)
  return excerptFromParts(parts)
}
