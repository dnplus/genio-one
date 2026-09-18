import { randomUUID } from "node:crypto"
import type { CodexRuntime, RuntimeCallbacks } from "./runtime"

export class CodexRpcChannels {
  private readonly requests = new Map<string, { owner: RuntimeCallbacks; id: string | number; method: string }>()
  private initialization: { id: string; waiters: Array<{ owner: RuntimeCallbacks; id: string | number }> } | null = null
  private initializeResult: unknown
  private initialized = false
  private initializedSent = false

  channel(runtime: CodexRuntime, owner: RuntimeCallbacks): CodexRuntime {
    return {
      send: async (line) => {
        const message = JSON.parse(line)
        if (message.method === "initialized") {
          if (this.initializedSent) return
          this.initializedSent = true
          try { await runtime.send(line) }
          catch (error) { this.initializedSent = false; throw error }
          return
        }
        if (typeof message.method !== "string" || (typeof message.id !== "number" && typeof message.id !== "string")) {
          await runtime.send(line)
          return
        }
        const id = `genio:${randomUUID()}`
        if (message.method === "initialize") {
          if (this.initialized) {
            owner.onMessage(JSON.stringify({ id: message.id, result: this.initializeResult }))
            return
          }
          if (this.initialization) {
            this.initialization.waiters.push({ owner, id: message.id })
            return
          }
          this.initialization = { id, waiters: [{ owner, id: message.id }] }
          try { await runtime.send(JSON.stringify({ ...message, id })) }
          catch (error) {
            const pending = this.initialization
            this.initialization = null
            for (const waiter of pending?.waiters ?? []) waiter.owner.onMessage(JSON.stringify({ id: waiter.id, error: { code: -32603, message: "Runtime initialization transport failed" } }))
            throw error
          }
          return
        }
        this.requests.set(id, { owner, id: message.id, method: message.method })
        try {
          await runtime.send(JSON.stringify({ ...message, id }))
        } catch (error) {
          this.requests.delete(id)
          throw error
        }
      },
      close: async () => { this.detach(owner) },
      ...(runtime.updateToken ? { updateToken: (token: string) => runtime.updateToken!(token) } : {}),
    }
  }

  receive(message: { id?: unknown; method?: string; result?: unknown }, onInitialize: (result: unknown) => void) {
    if (message.method || typeof message.id !== "string") return false
    if (this.initialization?.id === message.id) {
      const pending = this.initialization
      this.initialization = null
      if (message.result !== undefined) {
        this.initialized = true
        this.initializeResult = message.result
        onInitialize(message.result)
      }
      for (const waiter of pending.waiters) waiter.owner.onMessage(JSON.stringify({ ...message, id: waiter.id }))
      return true
    }
    const request = this.requests.get(message.id)
    if (!request) return message.id.startsWith("genio:")
    this.requests.delete(message.id)
    if (request.method === "initialize" && message.result !== undefined) onInitialize(message.result)
    request.owner.onMessage(JSON.stringify({ ...message, id: request.id }))
    return true
  }

  detach(owner: RuntimeCallbacks) {
    if (this.initialization) this.initialization.waiters = this.initialization.waiters.filter((waiter) => waiter.owner !== owner)
    for (const [id, request] of this.requests) {
      if (request.owner === owner) this.requests.delete(id)
    }
  }
}
