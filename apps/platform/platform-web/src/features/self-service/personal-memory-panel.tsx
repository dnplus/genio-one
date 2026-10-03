import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react"
import {
  AlertTriangleIcon,
  BotIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { relativeTime } from "@/lib/format"
import {
  enablePersonalMemoryAgent,
  forgetPersonalMemory,
  listPersonalMemoryAgents,
  listPersonalMemories,
  rememberPersonalMemory,
  revokePersonalMemoryAgent,
  type PersonalMemory,
  type PersonalMemoryAgentGrant,
  type PersonalMemoryContext,
  type PersonalMemoryContextKind,
  type PersonalMemoryKind,
} from "@/lib/self-service-api"

interface MemoryDraft {
  memoryId: string | null
  expectedRevision: number
  key: string
  kind: PersonalMemoryKind
  contextKind: PersonalMemoryContextKind
  contextId: string
  content: string
}

type PendingOperation = "save" | "delete" | "enable-agent" | "revoke-agent" | null

function createMemoryDraft(memory?: PersonalMemory): MemoryDraft {
  return {
    memoryId: memory?.memory_id ?? null,
    expectedRevision: memory?.revision ?? 0,
    key: memory?.key ?? "",
    kind: memory?.kind ?? "preference",
    contextKind: memory?.context.kind ?? "GLOBAL",
    contextId: memory?.context.context_id ?? "",
    content: memory?.content ?? "",
  }
}

function contextFromDraft(draft: MemoryDraft): PersonalMemoryContext {
  return draft.contextKind === "GLOBAL"
    ? { kind: "GLOBAL", context_id: null }
    : { kind: draft.contextKind, context_id: draft.contextId.trim() }
}

function contextKey(memory: PersonalMemory): string {
  return JSON.stringify([memory.key, memory.context.kind, memory.context.context_id])
}

function sourceDescription(memory: PersonalMemory, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (memory.source.agent_id) {
    return t("Agent {{agent}} through {{client}}", {
      agent: memory.source.agent_id,
      client: memory.source.client_id,
    })
  }
  return t("You through {{client}}", { client: memory.source.client_id })
}

function contextDescription(memory: PersonalMemory, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (memory.context.kind === "PROJECT") {
    return t("Project memory: {{id}}", { id: memory.context.context_id })
  }
  if (memory.context.kind === "CONTEXT") {
    return t("Context memory: {{id}}", { id: memory.context.context_id })
  }
  return t("Global memory")
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export function PersonalMemoryPanel({
  accessToken,
  tenantId,
  refreshKey,
}: {
  accessToken: string
  tenantId: string
  refreshKey: number
}) {
  const { t } = useTranslation()
  const [memories, setMemories] = useState<PersonalMemory[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const [agentGrants, setAgentGrants] = useState<PersonalMemoryAgentGrant[] | null>(null)
  const [agentLoading, setAgentLoading] = useState(false)
  const [agentError, setAgentError] = useState<string | null>(null)
  const [editor, setEditor] = useState<MemoryDraft | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PersonalMemory | null>(null)
  const [pendingOperation, setPendingOperation] = useState<PendingOperation>(null)
  const [agentId, setAgentId] = useState("")
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null)
  const [contextFilter, setContextFilter] = useState<"ALL" | PersonalMemoryContextKind>("ALL")

  const loadMemories = useCallback(async (cursor: string | null = null) => {
    setMemoryLoading(true)
    setMemoryError(null)
    try {
      const page = await listPersonalMemories(accessToken, tenantId, cursor)
      setMemories((current) => cursor ? [...(current ?? []), ...page.memories] : page.memories)
      setNextCursor(page.next_cursor)
    } catch (error) {
      setMemoryError(errorMessage(error, "MEMORY_LIST_FAILED"))
    } finally {
      setMemoryLoading(false)
    }
  }, [accessToken, tenantId])

  const loadAgentGrants = useCallback(async () => {
    setAgentLoading(true)
    setAgentError(null)
    try {
      const result = await listPersonalMemoryAgents(accessToken, tenantId)
      setAgentGrants(result.agents)
    } catch (error) {
      setAgentError(errorMessage(error, "MEMORY_AGENT_LIST_FAILED"))
    } finally {
      setAgentLoading(false)
    }
  }, [accessToken, tenantId])

  const refresh = useCallback(async () => {
    await Promise.all([loadMemories(), loadAgentGrants()])
  }, [loadAgentGrants, loadMemories])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  const observedDifferences = useMemo(() => {
    const groups = new Map<string, PersonalMemory[]>()
    for (const memory of memories ?? []) {
      const entries = groups.get(contextKey(memory)) ?? []
      entries.push(memory)
      groups.set(contextKey(memory), entries)
    }
    const memoryIds = new Set<string>()
    for (const entries of groups.values()) {
      const origins = new Set(entries.map((memory) => memory.assertion_origin))
      const kinds = new Set(entries.map((memory) => memory.kind))
      if (origins.has("AGENT_INFERRED") && kinds.size > 1) {
        entries.forEach((memory) => memoryIds.add(memory.memory_id))
      }
    }
    return memoryIds
  }, [memories])

  const filteredMemories = useMemo(
    () => (memories ?? []).filter((memory) => contextFilter === "ALL" || memory.context.kind === contextFilter),
    [contextFilter, memories],
  )

  const activeAgentGrants = (agentGrants ?? []).filter((grant) => grant.revoked_at === null)
  const revokedAgentGrants = (agentGrants ?? []).filter((grant) => grant.revoked_at !== null)

  function openEditor(memory?: PersonalMemory) {
    setEditor(createMemoryDraft(memory))
    setEditorError(null)
  }

  function updateEditor(update: Partial<MemoryDraft>) {
    setEditor((current) => current ? { ...current, ...update } : current)
  }

  async function saveMemory(event: FormEvent) {
    event.preventDefault()
    if (!editor) return
    const context = contextFromDraft(editor)
    if (!editor.key.trim() || !editor.content.trim() || (context.kind !== "GLOBAL" && !context.context_id)) {
      setEditorError("MEMORY_FIELDS_REQUIRED")
      return
    }
    setPendingOperation("save")
    setEditorError(null)
    try {
      await rememberPersonalMemory(accessToken, tenantId, {
        ...(editor.memoryId ? { memory_id: editor.memoryId } : {}),
        expected_revision: editor.expectedRevision,
        idempotency_key: crypto.randomUUID(),
        key: editor.key.trim(),
        kind: editor.kind,
        context,
        content: editor.content.trim(),
      })
      await loadMemories()
      setEditor(null)
      setFeedback({ message: editor.memoryId ? "Personal memory corrected." : "Personal memory saved.", error: false })
    } catch (error) {
      setEditorError(errorMessage(error, "MEMORY_SAVE_FAILED"))
    } finally {
      setPendingOperation(null)
    }
  }

  async function deleteMemory() {
    if (!pendingDelete) return
    setPendingOperation("delete")
    try {
      await forgetPersonalMemory(accessToken, tenantId, {
        memory_id: pendingDelete.memory_id,
        expected_revision: pendingDelete.revision,
        idempotency_key: crypto.randomUUID(),
      })
      await loadMemories()
      setPendingDelete(null)
      setFeedback({ message: "Personal memory permanently deleted.", error: false })
    } catch (error) {
      setFeedback({ message: errorMessage(error, "MEMORY_DELETE_FAILED"), error: true })
    } finally {
      setPendingOperation(null)
    }
  }

  async function enableAgent() {
    const normalizedAgentId = agentId.trim()
    if (!normalizedAgentId) return
    setPendingOperation("enable-agent")
    setFeedback(null)
    try {
      await enablePersonalMemoryAgent(accessToken, tenantId, normalizedAgentId)
      await loadAgentGrants()
      setAgentId("")
      setFeedback({ message: "Agent memory access enabled.", error: false })
    } catch (error) {
      setFeedback({ message: errorMessage(error, "MEMORY_AGENT_ENABLE_FAILED"), error: true })
    } finally {
      setPendingOperation(null)
    }
  }

  async function revokeAgent(agent: PersonalMemoryAgentGrant) {
    setPendingOperation("revoke-agent")
    setFeedback(null)
    try {
      await revokePersonalMemoryAgent(accessToken, tenantId, agent.agent_id)
      await loadAgentGrants()
      setFeedback({ message: "Agent memory access revoked.", error: false })
    } catch (error) {
      setFeedback({ message: errorMessage(error, "MEMORY_AGENT_REVOKE_FAILED"), error: true })
    } finally {
      setPendingOperation(null)
    }
  }

  return (
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(22rem,0.8fr)]" data-testid="personal-memory-panel">
      <Card>
        <CardHeader className="border-b">
          <div>
            <CardTitle>{t("Personal memory")}</CardTitle>
            <CardDescription>{t("Keep facts, preferences, and decisions that belong only to you. Team and organization memories are not managed here.")}</CardDescription>
          </div>
          <CardAction className="flex w-full justify-end gap-2 sm:w-auto">
            <Button aria-label={t("Refresh personal memory")} disabled={memoryLoading || agentLoading} onClick={() => void refresh()} size="icon-sm" variant="outline">
              <RefreshCwIcon className={memoryLoading || agentLoading ? "animate-spin" : ""} />
            </Button>
            <Button onClick={() => openEditor()} size="sm">
              <PlusIcon data-icon="inline-start" />
              {t("Add memory")}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {feedback ? <p className={`text-sm font-medium ${feedback.error ? "text-destructive" : "text-primary"}`} role={feedback.error ? "alert" : "status"}>{t(feedback.message)}</p> : null}
          <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
            <p className="text-sm text-muted-foreground">{t("Global memories are available in every project and context. Project and context memories stay scoped to their identifier.")}</p>
            <label className="flex shrink-0 items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t("Show")}</span>
              <select className="h-9 rounded-md border bg-background px-2" onChange={(event) => setContextFilter(event.target.value as "ALL" | PersonalMemoryContextKind)} value={contextFilter}>
                <option value="ALL">{t("All contexts")}</option>
                <option value="GLOBAL">{t("Global")}</option>
                <option value="PROJECT">{t("Project")}</option>
                <option value="CONTEXT">{t("Context")}</option>
              </select>
            </label>
          </div>

          {memoryError ? (
            <Alert variant="destructive" data-testid="personal-memory-load-error">
              <AlertTriangleIcon />
              <AlertTitle>{t("Personal memory unavailable")}</AlertTitle>
              <AlertDescription>{t("Personal memories could not be loaded. Refresh to try again.")} <span className="font-mono text-xs">{memoryError}</span></AlertDescription>
            </Alert>
          ) : null}

          {memories === null && !memoryError ? (
            <div className="flex min-h-36 items-center justify-center"><LoaderCircleIcon className="animate-spin text-muted-foreground" /></div>
          ) : null}

          {memories !== null && !memoryError && filteredMemories.length === 0 ? (
            <Empty className="min-h-36 border">
              <EmptyHeader>
                <EmptyMedia variant="icon"><BotIcon /></EmptyMedia>
                <EmptyTitle>{contextFilter === "ALL" ? t("No personal memories") : t("No memories in this context")}</EmptyTitle>
                <EmptyDescription>{t("Add a memory when you want an authorized Agent to use the same preference, fact, or decision later.")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {filteredMemories.map((memory) => (
            <article className="rounded-lg border p-4" data-testid={`personal-memory-${memory.memory_id}`} key={memory.memory_id}>
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium">{memory.key}</h3>
                    <Badge variant="secondary">{t(memory.kind === "preference" ? "Preference" : memory.kind === "fact" ? "Fact" : "Decision")}</Badge>
                    <Badge variant="outline">{contextDescription(memory, t)}</Badge>
                    {observedDifferences.has(memory.memory_id) ? <Badge variant="destructive">{t("Observed difference")}</Badge> : null}
                  </div>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{memory.content}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button aria-label={t("Correct memory {{key}}", { key: memory.key })} onClick={() => openEditor(memory)} size="icon-sm" variant="outline"><PencilIcon /></Button>
                  <Button aria-label={t("Permanently delete memory {{key}}", { key: memory.key })} onClick={() => setPendingDelete(memory)} size="icon-sm" variant="destructive"><Trash2Icon /></Button>
                </div>
              </div>
              <div className="mt-4 grid gap-2 border-t pt-3 text-xs text-muted-foreground sm:grid-cols-2">
                <p>{t("Source")}: {sourceDescription(memory, t)} <span className="font-mono">({memory.source.actor_subject_id})</span></p>
                <p>{t("Updated {{time}} · revision {{revision}}", { time: relativeTime(memory.updated_at), revision: memory.revision })}</p>
                {memory.source.reference_id ? <p className="sm:col-span-2">{t("Source reference")}: <span className="font-mono">{memory.source.reference_id}</span></p> : null}
                {observedDifferences.has(memory.memory_id) ? <p className="sm:col-span-2 text-destructive">{t("An Agent-inferred assertion with the same key and context uses a different type among the memories currently loaded. Correct this memory to make your intent explicit.")}</p> : null}
              </div>
            </article>
          ))}

          {nextCursor && !memoryError ? <Button disabled={memoryLoading} onClick={() => void loadMemories(nextCursor)} variant="outline">
            {memoryLoading ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}
            {t("Load more memories")}
          </Button> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <div>
            <CardTitle>{t("Agent memory access")}</CardTitle>
            <CardDescription>{t("An enabled OAuth client lets its Agent read your personal memory and read or write Team and Organization shared memory according to your current permissions; if you can manage shared memory, it may also correct or permanently delete it. Revoking removes all memory access.")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Field>
            <FieldLabel htmlFor="personal-memory-agent-id">{t("Agent OAuth client ID")}</FieldLabel>
            <Input id="personal-memory-agent-id" onChange={(event) => setAgentId(event.target.value)} placeholder={t("Example: engineering-agent") } value={agentId} />
            <FieldDescription>{t("Enter the OAuth client ID used by an Agent. Enabling access does not verify that the Agent is connected.")}</FieldDescription>
          </Field>
          <Button className="self-start" disabled={!agentId.trim() || pendingOperation !== null} onClick={() => void enableAgent()}>
            {pendingOperation === "enable-agent" ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : <BotIcon data-icon="inline-start" />}
            {t("Enable Agent memory")}
          </Button>

          {agentError ? (
            <Alert variant="destructive" data-testid="personal-memory-agent-load-error">
              <AlertTriangleIcon />
              <AlertTitle>{t("Agent memory access unavailable")}</AlertTitle>
              <AlertDescription>{t("Agent grants could not be loaded. Refresh to try again.")} <span className="font-mono text-xs">{agentError}</span></AlertDescription>
            </Alert>
          ) : null}

          {agentGrants === null && !agentError ? <div className="flex min-h-16 items-center justify-center"><LoaderCircleIcon className="animate-spin text-muted-foreground" /></div> : null}

          {agentGrants !== null && !agentError ? (
            <div className="flex flex-col gap-3">
              <div>
                <h3 className="text-sm font-medium">{t("Enabled Agents")}</h3>
                <p className="text-sm text-muted-foreground">{t("Each enabled OAuth client has its own memory grant for your personal memory and the Team and Organization shared memory allowed by your current permissions.")}</p>
              </div>
              {activeAgentGrants.length ? activeAgentGrants.map((grant) => (
                <div className="rounded-lg border p-3" data-testid={`personal-memory-agent-${grant.agent_id}`} key={grant.grant_id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2"><p className="break-all font-mono text-sm font-medium">{grant.agent_id}</p><Badge variant="secondary">{t("Enabled")}</Badge></div>
                      <p className="mt-1 text-xs text-muted-foreground">{t("Enabled {{time}}", { time: relativeTime(grant.enabled_at) })}</p>
                    </div>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button disabled={pendingOperation !== null} size="sm" variant="outline">{t("Revoke")}</Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("Revoke Agent memory access?")}</AlertDialogTitle>
                          <AlertDialogDescription>{t("{{agent}} will lose all access to your personal memory and the Team and Organization shared memory allowed by your current permissions. You can enable it again later.", { agent: grant.agent_id })}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel disabled={pendingOperation === "revoke-agent"}>{t("Cancel")}</AlertDialogCancel>
                          <AlertDialogAction disabled={pendingOperation === "revoke-agent"} onClick={(event) => { event.preventDefault(); void revokeAgent(grant) }} variant="destructive">
                            {pendingOperation === "revoke-agent" ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}
                            {t("Revoke Agent access")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              )) : <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">{t("No Agent OAuth clients have memory access yet.")}</p>}

              {revokedAgentGrants.length ? (
                <div className="border-t pt-4">
                  <h3 className="text-sm font-medium">{t("Revoked Agents")}</h3>
                  <div className="mt-2 flex flex-col gap-2">
                    {revokedAgentGrants.map((grant) => <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2 text-sm" key={grant.grant_id}><span className="break-all font-mono">{grant.agent_id}</span><span className="shrink-0 text-xs text-muted-foreground">{t("Revoked {{time}}", { time: relativeTime(grant.revoked_at!) })}</span></div>)}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={editor !== null} onOpenChange={(open) => { if (!open && pendingOperation !== "save") setEditor(null) }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <form onSubmit={(event) => void saveMemory(event)}>
            <DialogHeader>
              <DialogTitle>{t(editor?.memoryId ? "Correct personal memory" : "Add personal memory")}</DialogTitle>
              <DialogDescription>{t("A correction replaces the selected record with a new revision. Your saved statement is marked as explicit.")}</DialogDescription>
            </DialogHeader>
            {editor ? <FieldGroup className="mt-5">
              <Field>
                <FieldLabel htmlFor="personal-memory-key">{t("Memory key")}</FieldLabel>
                <Input id="personal-memory-key" maxLength={256} onChange={(event) => updateEditor({ key: event.target.value })} readOnly={editor.memoryId !== null} value={editor.key} />
                <FieldDescription>{editor.memoryId ? t("The key, type, and context identify this memory and stay fixed during a correction. Delete it and create a new memory to change them.") : t("Use a short label that identifies the preference, fact, or decision.")}</FieldDescription>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="personal-memory-kind">{t("Memory type")}</FieldLabel>
                  <select className="h-9 rounded-md border bg-background px-3" disabled={editor.memoryId !== null} id="personal-memory-kind" onChange={(event) => updateEditor({ kind: event.target.value as PersonalMemoryKind })} value={editor.kind}>
                    <option value="preference">{t("Preference")}</option>
                    <option value="fact">{t("Fact")}</option>
                    <option value="decision">{t("Decision")}</option>
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="personal-memory-context">{t("Memory context")}</FieldLabel>
                  <select className="h-9 rounded-md border bg-background px-3" disabled={editor.memoryId !== null} id="personal-memory-context" onChange={(event) => updateEditor({ contextKind: event.target.value as PersonalMemoryContextKind, contextId: event.target.value === "GLOBAL" ? "" : editor.contextId })} value={editor.contextKind}>
                    <option value="GLOBAL">{t("Global")}</option>
                    <option value="PROJECT">{t("Project")}</option>
                    <option value="CONTEXT">{t("Context")}</option>
                  </select>
                </Field>
              </div>
              {editor.contextKind !== "GLOBAL" ? <Field>
                <FieldLabel htmlFor="personal-memory-context-id">{editor.contextKind === "PROJECT" ? t("Project ID") : t("Context ID")}</FieldLabel>
                <Input id="personal-memory-context-id" maxLength={256} onChange={(event) => updateEditor({ contextId: event.target.value })} readOnly={editor.memoryId !== null} value={editor.contextId} />
                <FieldDescription>{editor.contextKind === "PROJECT" ? t("This memory is available with this project and your global memories.") : t("This memory is available with this context and your global memories.")}</FieldDescription>
              </Field> : <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">{t("A global memory is available in every project and context.")}</p>}
              <Field data-invalid={Boolean(editorError)}>
                <FieldLabel htmlFor="personal-memory-content">{t("Memory")}</FieldLabel>
                <Textarea id="personal-memory-content" maxLength={12000} onChange={(event) => updateEditor({ content: event.target.value })} rows={5} value={editor.content} />
                <FieldDescription>{t("Write the statement you want an authorized Agent to use later.")}</FieldDescription>
                {editorError ? <FieldError>{t(editorError)}</FieldError> : null}
              </Field>
            </FieldGroup> : null}
            <DialogFooter className="mt-6">
              <Button disabled={pendingOperation === "save"} onClick={() => setEditor(null)} type="button" variant="outline">{t("Cancel")}</Button>
              <Button disabled={pendingOperation === "save"} type="submit">
                {pendingOperation === "save" ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}
                {t(editor?.memoryId ? "Save correction" : "Save memory")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open && pendingOperation !== "delete") setPendingDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Permanently delete personal memory?")}</AlertDialogTitle>
            <AlertDialogDescription>{t("This permanently removes {{key}} and cannot be undone.", { key: pendingDelete?.key ?? "" })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingOperation === "delete"}>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={pendingOperation === "delete"} onClick={(event) => { event.preventDefault(); void deleteMemory() }} variant="destructive">
              {pendingOperation === "delete" ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
              {t("Delete permanently")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
