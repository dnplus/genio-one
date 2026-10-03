import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
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
  forgetSharedMemory,
  listMemoryScopes,
  listSharedMemories,
  listSharedMemoryCorrectionProposals,
  proposeSharedMemoryCorrection,
  rememberSharedMemory,
  reviewSharedMemoryCorrection,
  type MemoryScopeAccess,
  type PersonalMemoryContext,
  type PersonalMemoryContextKind,
  type PersonalMemoryKind,
  type PersonalMemorySource,
  type SharedMemory,
  type SharedMemoryCorrectionProposal,
  type SharedMemoryCorrectionProposalStatus,
  type SharedMemoryScopeTarget,
} from "@/lib/self-service-api"

type SharedMemoryScopeAccess = MemoryScopeAccess & { target: SharedMemoryScopeTarget }

interface SharedMemoryDraft {
  memoryId: string | null
  expectedRevision: number
  key: string
  kind: PersonalMemoryKind
  contextKind: PersonalMemoryContextKind
  contextId: string
  content: string
}

interface CorrectionDraft {
  memory: SharedMemory
  content: string
}

interface ProposalPageState {
  proposals: SharedMemoryCorrectionProposal[]
  nextCursor: string | null
  loading: boolean
  error: string | null
}

type PendingOperation = "save" | "delete" | "propose" | "review" | null

function isSharedMemoryScope(scope: MemoryScopeAccess): scope is SharedMemoryScopeAccess {
  return scope.target.scope === "TEAM" || scope.target.scope === "ORGANIZATION"
}

function scopeKey(target: SharedMemoryScopeTarget): string {
  return target.scope === "TEAM"
    ? `TEAM:${target.workspace_id}`
    : `ORGANIZATION:${target.organization_id}`
}

function createMemoryDraft(memory?: SharedMemory): SharedMemoryDraft {
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

function contextFromDraft(draft: SharedMemoryDraft): PersonalMemoryContext {
  return draft.contextKind === "GLOBAL"
    ? { kind: "GLOBAL", context_id: null }
    : { kind: draft.contextKind, context_id: draft.contextId.trim() }
}

function sourceDescription(source: PersonalMemorySource, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (source.agent_id) {
    return t("Agent {{agent}} through {{client}}", {
      agent: source.agent_id,
      client: source.client_id,
    })
  }
  return t("Person {{subject}} through {{client}}", {
    subject: source.actor_subject_id,
    client: source.client_id,
  })
}

function scopeTypeLabel(target: SharedMemoryScopeTarget, t: (key: string, options?: Record<string, unknown>) => string): string {
  return target.scope === "TEAM" ? t("Team") : t("Organization")
}

function scopeOptionLabel(scope: SharedMemoryScopeAccess, t: (key: string, options?: Record<string, unknown>) => string): string {
  return t("{{scope}} · {{name}}", {
    scope: scopeTypeLabel(scope.target, t),
    name: scope.display_name,
  })
}

function contextDescription(memory: SharedMemory, scope: SharedMemoryScopeAccess, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (memory.context.kind === "PROJECT") {
    return t("Project memory: {{id}}", { id: memory.context.context_id })
  }
  if (memory.context.kind === "CONTEXT") {
    return t("Context memory: {{id}}", { id: memory.context.context_id })
  }
  return t("Global context in {{scope}}", { scope: scope.display_name })
}

function observedDifferenceIds(memories: SharedMemory[]): Set<string> {
  const groups = new Map<string, SharedMemory[]>()
  for (const memory of memories) {
    const key = JSON.stringify([memory.key, memory.context.kind, memory.context.context_id])
    const entries = groups.get(key) ?? []
    entries.push(memory)
    groups.set(key, entries)
  }
  const ids = new Set<string>()
  for (const entries of groups.values()) {
    const statements = new Set(entries.map((memory) => JSON.stringify([memory.kind, memory.content])))
    if (statements.size > 1) entries.forEach((memory) => ids.add(memory.memory_id))
  }
  return ids
}

function proposalStatusLabel(status: SharedMemoryCorrectionProposalStatus, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (status === "PENDING") return t("Pending")
  if (status === "ACCEPTED") return t("Accepted")
  if (status === "REJECTED") return t("Rejected")
  return t("Stale")
}

function proposalStatusVariant(status: SharedMemoryCorrectionProposalStatus) {
  if (status === "ACCEPTED") return "secondary" as const
  if (status === "REJECTED") return "destructive" as const
  return "outline" as const
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export function SharedMemoryPanel({
  accessToken,
  tenantId,
  refreshKey,
}: {
  accessToken: string
  tenantId: string
  refreshKey: number
}) {
  const { t } = useTranslation()
  const [scopes, setScopes] = useState<MemoryScopeAccess[] | null>(null)
  const [scopeLoading, setScopeLoading] = useState(false)
  const [scopeError, setScopeError] = useState<string | null>(null)
  const [selectedScopeKey, setSelectedScopeKey] = useState("")
  const [memories, setMemories] = useState<SharedMemory[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const [proposalPages, setProposalPages] = useState<Record<string, ProposalPageState>>({})
  const [editor, setEditor] = useState<SharedMemoryDraft | null>(null)
  const [proposalEditor, setProposalEditor] = useState<CorrectionDraft | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [proposalEditorError, setProposalEditorError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SharedMemory | null>(null)
  const [pendingOperation, setPendingOperation] = useState<PendingOperation>(null)
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null)
  const [contextFilter, setContextFilter] = useState<"ALL" | PersonalMemoryContextKind>("ALL")
  const [scopeRefreshNonce, setScopeRefreshNonce] = useState(0)
  const activeScopeKey = useRef<string | null>(null)

  const sharedScopes = useMemo(
    () => (scopes ?? []).filter(isSharedMemoryScope),
    [scopes],
  )
  const selectedScope = useMemo(
    () => sharedScopes.find((scope) => scopeKey(scope.target) === selectedScopeKey) ?? null,
    [selectedScopeKey, sharedScopes],
  )

  const loadProposals = useCallback(async (
    scope: SharedMemoryScopeAccess,
    memoryId: string,
    cursor: string | null = null,
  ) => {
    if (!scope.can_manage) return
    const currentScopeKey = scopeKey(scope.target)
    setProposalPages((current) => {
      const existing = current[memoryId]
      return {
        ...current,
        [memoryId]: {
          proposals: cursor ? (existing?.proposals ?? []) : [],
          nextCursor: cursor ? (existing?.nextCursor ?? null) : null,
          loading: true,
          error: null,
        },
      }
    })
    try {
      const page = await listSharedMemoryCorrectionProposals(
        accessToken,
        tenantId,
        scope.target,
        memoryId,
        { cursor },
      )
      if (activeScopeKey.current !== currentScopeKey) return
      setProposalPages((current) => {
        const existing = current[memoryId]
        return {
          ...current,
          [memoryId]: {
            proposals: cursor ? [...(existing?.proposals ?? []), ...page.proposals] : page.proposals,
            nextCursor: page.next_cursor,
            loading: false,
            error: null,
          },
        }
      })
    } catch (error) {
      if (activeScopeKey.current !== currentScopeKey) return
      setProposalPages((current) => ({
        ...current,
        [memoryId]: {
          proposals: cursor ? (current[memoryId]?.proposals ?? []) : [],
          nextCursor: current[memoryId]?.nextCursor ?? null,
          loading: false,
          error: errorMessage(error, "SHARED_MEMORY_PROPOSAL_LIST_FAILED"),
        },
      }))
    }
  }, [accessToken, tenantId])

  const loadMemories = useCallback(async (
    scope: SharedMemoryScopeAccess,
    cursor: string | null = null,
  ) => {
    const currentScopeKey = scopeKey(scope.target)
    setMemoryLoading(true)
    setMemoryError(null)
    try {
      const page = await listSharedMemories(accessToken, tenantId, scope.target, cursor)
      if (activeScopeKey.current !== currentScopeKey) return
      setMemories((current) => cursor ? [...(current ?? []), ...page.memories] : page.memories)
      setNextCursor(page.next_cursor)
      if (scope.can_manage) {
        void Promise.all(page.memories.map((memory) => loadProposals(scope, memory.memory_id)))
      }
    } catch (error) {
      if (activeScopeKey.current !== currentScopeKey) return
      setMemoryError(errorMessage(error, "SHARED_MEMORY_LIST_FAILED"))
    } finally {
      if (activeScopeKey.current === currentScopeKey) setMemoryLoading(false)
    }
  }, [accessToken, loadProposals, tenantId])

  const loadScopes = useCallback(async () => {
    setScopeLoading(true)
    setScopeError(null)
    try {
      const result = await listMemoryScopes(accessToken, tenantId)
      setScopes(result.scopes)
    } catch (error) {
      setScopeError(errorMessage(error, "SHARED_MEMORY_SCOPE_LIST_FAILED"))
    } finally {
      setScopeLoading(false)
    }
  }, [accessToken, tenantId])

  useEffect(() => {
    void loadScopes()
  }, [loadScopes, refreshKey, scopeRefreshNonce])

  useEffect(() => {
    setSelectedScopeKey((current) => {
      if (sharedScopes.some((scope) => scopeKey(scope.target) === current)) return current
      return sharedScopes[0] ? scopeKey(sharedScopes[0].target) : ""
    })
  }, [sharedScopes])

  useEffect(() => {
    const currentScopeKey = selectedScope ? scopeKey(selectedScope.target) : null
    activeScopeKey.current = currentScopeKey
    setMemories(null)
    setNextCursor(null)
    setMemoryError(null)
    setProposalPages({})
    setEditor(null)
    setProposalEditor(null)
    setPendingDelete(null)
    if (selectedScope) void loadMemories(selectedScope)
  }, [loadMemories, selectedScope])

  const observedDifferences = useMemo(
    () => observedDifferenceIds(memories ?? []),
    [memories],
  )
  const filteredMemories = useMemo(
    () => (memories ?? []).filter((memory) => contextFilter === "ALL" || memory.context.kind === contextFilter),
    [contextFilter, memories],
  )

  function updateEditor(update: Partial<SharedMemoryDraft>) {
    setEditor((current) => current ? { ...current, ...update } : current)
  }

  async function saveMemory(event: FormEvent) {
    event.preventDefault()
    if (!editor || !selectedScope) return
    if (editor.memoryId ? !selectedScope.can_manage : !selectedScope.can_contribute) {
      setEditorError("SHARED_MEMORY_WRITE_NOT_ALLOWED")
      return
    }
    const context = contextFromDraft(editor)
    if (!editor.key.trim() || !editor.content.trim() || (context.kind !== "GLOBAL" && !context.context_id)) {
      setEditorError("MEMORY_FIELDS_REQUIRED")
      return
    }
    setPendingOperation("save")
    setEditorError(null)
    try {
      await rememberSharedMemory(accessToken, tenantId, selectedScope.target, {
        ...(editor.memoryId ? { memory_id: editor.memoryId } : {}),
        expected_revision: editor.expectedRevision,
        idempotency_key: crypto.randomUUID(),
        key: editor.key.trim(),
        kind: editor.kind,
        context,
        content: editor.content.trim(),
      })
      await loadMemories(selectedScope)
      setEditor(null)
      setFeedback({ message: editor.memoryId ? "Shared memory corrected." : "Shared memory saved.", error: false })
    } catch (error) {
      setEditorError(errorMessage(error, "SHARED_MEMORY_SAVE_FAILED"))
    } finally {
      setPendingOperation(null)
    }
  }

  async function deleteMemory() {
    if (!pendingDelete || !selectedScope || !selectedScope.can_manage) return
    setPendingOperation("delete")
    try {
      await forgetSharedMemory(accessToken, tenantId, selectedScope.target, {
        memory_id: pendingDelete.memory_id,
        expected_revision: pendingDelete.revision,
        idempotency_key: crypto.randomUUID(),
      })
      await loadMemories(selectedScope)
      setPendingDelete(null)
      setFeedback({ message: "Shared memory permanently deleted.", error: false })
    } catch (error) {
      setFeedback({ message: errorMessage(error, "SHARED_MEMORY_DELETE_FAILED"), error: true })
    } finally {
      setPendingOperation(null)
    }
  }

  async function submitCorrectionProposal(event: FormEvent) {
    event.preventDefault()
    if (!proposalEditor || !selectedScope || !selectedScope.can_contribute || selectedScope.can_manage) return
    if (!proposalEditor.content.trim()) {
      setProposalEditorError("MEMORY_FIELDS_REQUIRED")
      return
    }
    setPendingOperation("propose")
    setProposalEditorError(null)
    try {
      await proposeSharedMemoryCorrection(
        accessToken,
        tenantId,
        selectedScope.target,
        proposalEditor.memory.memory_id,
        {
          expected_revision: proposalEditor.memory.revision,
          idempotency_key: crypto.randomUUID(),
          content: proposalEditor.content.trim(),
        },
      )
      setProposalEditor(null)
      setFeedback({ message: "Shared memory correction proposed.", error: false })
    } catch (error) {
      setProposalEditorError(errorMessage(error, "SHARED_MEMORY_PROPOSAL_SAVE_FAILED"))
    } finally {
      setPendingOperation(null)
    }
  }

  async function reviewProposal(memory: SharedMemory, proposal: SharedMemoryCorrectionProposal, action: "ACCEPT" | "REJECT") {
    if (!selectedScope || !selectedScope.can_manage || proposal.status !== "PENDING") return
    setPendingOperation("review")
    try {
      const result = await reviewSharedMemoryCorrection(
        accessToken,
        tenantId,
        selectedScope.target,
        memory.memory_id,
        proposal.proposal_id,
        action,
      )
      setFeedback({
        message: result.proposal.status === "STALE"
          ? "This correction proposal is stale and was not applied. Check the current memory and try again."
          : action === "ACCEPT" ? "Shared memory correction accepted." : "Shared memory correction rejected.",
        error: result.proposal.status === "STALE",
      })
    } catch (error) {
      setFeedback({ message: errorMessage(error, "SHARED_MEMORY_PROPOSAL_REVIEW_FAILED"), error: true })
    } finally {
      await Promise.all([
        loadMemories(selectedScope),
        loadProposals(selectedScope, memory.memory_id),
      ])
      setPendingOperation(null)
    }
  }

  const canContribute = selectedScope?.can_contribute ?? false
  const canManage = selectedScope?.can_manage ?? false
  const panelLoading = scopeLoading || memoryLoading

  return (
    <section data-testid="shared-memory-panel">
      <Card>
        <CardHeader className="border-b">
          <div>
            <CardTitle>{t("Shared memory")}</CardTitle>
            <CardDescription>{t("Choose a Team or Organization you can read. Shared memory is kept inside that selected scope and remains separate from your personal memory.")}</CardDescription>
          </div>
          <CardAction className="flex w-full justify-end gap-2 sm:w-auto">
            <Button aria-label={t("Refresh shared memory")} disabled={panelLoading} onClick={() => setScopeRefreshNonce((value) => value + 1)} size="icon-sm" variant="outline">
              <RefreshCwIcon className={panelLoading ? "animate-spin" : ""} />
            </Button>
            {selectedScope && canContribute ? <Button onClick={() => { setEditor(createMemoryDraft()); setEditorError(null) }} size="sm">
              <PlusIcon data-icon="inline-start" />
              {t("Add shared memory")}
            </Button> : null}
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {feedback ? <p className={`text-sm font-medium ${feedback.error ? "text-destructive" : "text-primary"}`} role={feedback.error ? "alert" : "status"}>{t(feedback.message)}</p> : null}

          {scopeError ? (
            <Alert data-testid="shared-memory-scope-load-error" variant="destructive">
              <AlertTriangleIcon />
              <AlertTitle>{t("Shared memory scopes unavailable")}</AlertTitle>
              <AlertDescription>{t("Your available Team and Organization memory scopes could not be loaded. Refresh to try again.")} <span className="font-mono text-xs">{scopeError}</span></AlertDescription>
            </Alert>
          ) : null}

          {scopes === null && !scopeError ? <div className="flex min-h-36 items-center justify-center"><LoaderCircleIcon className="animate-spin text-muted-foreground" /></div> : null}

          {scopes !== null && !scopeError && sharedScopes.length === 0 ? (
            <Empty className="min-h-36 border" data-testid="shared-memory-no-scopes">
              <EmptyHeader>
                <EmptyMedia variant="icon"><BotIcon /></EmptyMedia>
                <EmptyTitle>{t("No shared memory scopes")}</EmptyTitle>
                <EmptyDescription>{t("You do not currently have read access to a Team or Organization memory scope. Your personal memory remains available above.")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {selectedScope ? <>
            <div className="flex flex-col justify-between gap-4 rounded-lg border bg-muted/20 p-4 sm:flex-row sm:items-start">
              <div className="min-w-0">
                <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="shared-memory-scope">
                  {t("Shared memory scope")}
                  <select className="h-9 rounded-md border bg-background px-3 font-normal" id="shared-memory-scope" onChange={(event) => setSelectedScopeKey(event.target.value)} value={selectedScopeKey}>
                    {sharedScopes.map((scope) => <option key={scopeKey(scope.target)} value={scopeKey(scope.target)}>{scopeOptionLabel(scope, t)}</option>)}
                  </select>
                </label>
                <p className="mt-3 text-sm text-muted-foreground">{t("A global context is shared only inside {{scope}}. Project and context records remain within their identifier.", { scope: scopeOptionLabel(selectedScope, t) })}</p>
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Badge variant="outline">{scopeTypeLabel(selectedScope.target, t)}</Badge>
                {selectedScope.can_read ? <Badge variant="secondary">{t("Read")}</Badge> : null}
                {selectedScope.can_contribute ? <Badge variant="secondary">{t("Contribute")}</Badge> : null}
                {selectedScope.can_manage ? <Badge variant="secondary">{t("Manage")}</Badge> : null}
              </div>
            </div>

            <p className="text-sm text-muted-foreground">
              {canManage
                ? t("You can directly correct, permanently delete, and review correction proposals in this scope.")
                : canContribute
                  ? t("You can add records and submit correction proposals. A scope manager must accept a proposal before it replaces a shared memory.")
                  : t("You can view this scope. Only contributors can add records, and only managers can directly correct, delete, or review proposals.")}
            </p>

            <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
              <p className="text-sm text-muted-foreground">{t("Differences shown below are observed only among memories currently loaded for this selected scope.")}</p>
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
              <Alert data-testid="shared-memory-load-error" variant="destructive">
                <AlertTriangleIcon />
                <AlertTitle>{t("Shared memory unavailable")}</AlertTitle>
                <AlertDescription>{t("Shared memories could not be loaded for this scope. Refresh to try again.")} <span className="font-mono text-xs">{memoryError}</span></AlertDescription>
              </Alert>
            ) : null}

            {memories === null && !memoryError ? <div className="flex min-h-36 items-center justify-center"><LoaderCircleIcon className="animate-spin text-muted-foreground" /></div> : null}

            {memories !== null && !memoryError && filteredMemories.length === 0 ? (
              <Empty className="min-h-36 border">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><BotIcon /></EmptyMedia>
                  <EmptyTitle>{contextFilter === "ALL" ? t("No shared memories") : t("No memories in this context")}</EmptyTitle>
                  <EmptyDescription>{canContribute ? t("Add a shared memory when this Team or Organization should use the same preference, fact, or decision later.") : t("A contributor can add a shared memory for this scope when the group needs a durable preference, fact, or decision.")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}

            {filteredMemories.map((memory) => {
              const proposalPage = proposalPages[memory.memory_id]
              return <article className="rounded-lg border p-4" data-testid={`shared-memory-${memory.memory_id}`} key={memory.memory_id}>
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium">{memory.key}</h3>
                      <Badge variant="secondary">{t(memory.kind === "preference" ? "Preference" : memory.kind === "fact" ? "Fact" : "Decision")}</Badge>
                      <Badge variant="outline">{contextDescription(memory, selectedScope, t)}</Badge>
                      <Badge variant="outline">{t(memory.assertion_origin === "AGENT_INFERRED" ? "Agent inferred" : "User explicit")}</Badge>
                      {observedDifferences.has(memory.memory_id) ? <Badge variant="destructive">{t("Observed difference")}</Badge> : null}
                    </div>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{memory.content}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {canManage ? <>
                      <Button aria-label={t("Correct shared memory {{key}}", { key: memory.key })} disabled={pendingOperation !== null} onClick={() => { setEditor(createMemoryDraft(memory)); setEditorError(null) }} size="icon-sm" variant="outline"><PencilIcon /></Button>
                      <Button aria-label={t("Permanently delete shared memory {{key}}", { key: memory.key })} disabled={pendingOperation !== null} onClick={() => setPendingDelete(memory)} size="icon-sm" variant="destructive"><Trash2Icon /></Button>
                    </> : canContribute ? <Button disabled={pendingOperation !== null} onClick={() => { setProposalEditor({ memory, content: memory.content }); setProposalEditorError(null) }} size="sm" variant="outline">{t("Propose correction")}</Button> : null}
                  </div>
                </div>
                <div className="mt-4 grid gap-2 border-t pt-3 text-xs text-muted-foreground sm:grid-cols-2">
                  <p>{t("Source")}: {sourceDescription(memory.source, t)} <span className="font-mono">({memory.source.actor_subject_id})</span></p>
                  <p>{t("Updated {{time}} · revision {{revision}}", { time: relativeTime(memory.updated_at), revision: memory.revision })}</p>
                  {memory.source.reference_id ? <p className="sm:col-span-2">{t("Source reference")}: <span className="font-mono">{memory.source.reference_id}</span></p> : null}
                  {observedDifferences.has(memory.memory_id) ? <p className="sm:col-span-2 text-destructive">{t("A different statement or type uses the same key and context among memories currently loaded for this scope. This observation does not rule out additional differences outside this page.")}</p> : null}
                </div>

                {canManage ? <section className="mt-4 border-t pt-4" data-testid={`shared-memory-proposals-${memory.memory_id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-medium">{t("Correction proposals")}</h4>
                      <p className="text-xs text-muted-foreground">{t("Pending proposals do not replace a shared memory until a scope manager accepts them.")}</p>
                    </div>
                    {proposalPage?.loading ? <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" /> : null}
                  </div>
                  {proposalPage?.error ? <p className="mt-3 text-sm text-destructive" role="alert">{t("Correction proposals could not be loaded. Refresh to try again.")} <span className="font-mono text-xs">{proposalPage.error}</span></p> : null}
                  {proposalPage && !proposalPage.error && proposalPage.proposals.length === 0 && !proposalPage.loading ? <p className="mt-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground">{t("No correction proposals for this memory.")}</p> : null}
                  {proposalPage?.proposals.length ? <div className="mt-3 flex flex-col gap-3">
                    {proposalPage.proposals.map((proposal) => <div className="rounded-md border bg-muted/20 p-3" data-testid={`shared-memory-proposal-${proposal.proposal_id}`} key={proposal.proposal_id}>
                      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={proposalStatusVariant(proposal.status)}>{proposalStatusLabel(proposal.status, t)}</Badge>
                            <Badge variant="outline">{t(proposal.proposed_kind === "preference" ? "Preference" : proposal.proposed_kind === "fact" ? "Fact" : "Decision")}</Badge>
                          </div>
                          {proposal.proposed_content ? <p className="mt-3 whitespace-pre-wrap text-sm leading-6"><span className="font-medium">{t("Proposed memory")}: </span>{proposal.proposed_content}</p> : <p className="mt-3 text-sm text-muted-foreground">{t("Proposal content is retained only while it is pending.")}</p>}
                        </div>
                        {proposal.status === "PENDING" && canManage ? <div className="flex shrink-0 gap-2">
                          <Button disabled={pendingOperation !== null} onClick={() => void reviewProposal(memory, proposal, "ACCEPT")} size="sm">{t("Accept correction")}</Button>
                          <Button disabled={pendingOperation !== null} onClick={() => void reviewProposal(memory, proposal, "REJECT")} size="sm" variant="outline">{t("Reject correction")}</Button>
                        </div> : null}
                      </div>
                      <div className="mt-3 grid gap-2 border-t pt-3 text-xs text-muted-foreground sm:grid-cols-2">
                        <p>{t("Proposed by")}: {sourceDescription(proposal.source, t)}</p>
                        <p>{t("Base revision {{revision}}", { revision: proposal.base_revision })}</p>
                        <p>{t("Proposed {{time}}", { time: relativeTime(proposal.created_at) })}</p>
                        {proposal.reviewer_subject_id ? <p>{t("Reviewed by {{subject}}", { subject: proposal.reviewer_subject_id })}</p> : null}
                      </div>
                    </div>)}
                  </div> : null}
                  {proposalPage?.nextCursor ? <Button className="mt-3" disabled={proposalPage.loading} onClick={() => void loadProposals(selectedScope, memory.memory_id, proposalPage.nextCursor)} size="sm" variant="outline">{t("Load more correction proposals")}</Button> : null}
                </section> : null}
              </article>
            })}

            {nextCursor && !memoryError ? <Button disabled={memoryLoading} onClick={() => void loadMemories(selectedScope, nextCursor)} variant="outline">
              {memoryLoading ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}
              {t("Load more memories")}
            </Button> : null}
          </> : null}
        </CardContent>
      </Card>

      <Dialog open={editor !== null} onOpenChange={(open) => { if (!open && pendingOperation !== "save") setEditor(null) }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <form onSubmit={(event) => void saveMemory(event)}>
            <DialogHeader>
              <DialogTitle>{t(editor?.memoryId ? "Correct shared memory" : "Add shared memory")}</DialogTitle>
              <DialogDescription>{t(editor?.memoryId ? "A manager correction replaces this shared record with a new revision." : "A new record is shared only with the selected Team or Organization scope.")}</DialogDescription>
            </DialogHeader>
            {editor ? <FieldGroup className="mt-5">
              <Field>
                <FieldLabel htmlFor="shared-memory-key">{t("Memory key")}</FieldLabel>
                <Input id="shared-memory-key" maxLength={256} onChange={(event) => updateEditor({ key: event.target.value })} readOnly={editor.memoryId !== null} value={editor.key} />
                <FieldDescription>{editor.memoryId ? t("The key, type, and context identify this memory and stay fixed during a correction. Delete it and create a new memory to change them.") : t("Use a short label that identifies the preference, fact, or decision.")}</FieldDescription>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="shared-memory-kind">{t("Memory type")}</FieldLabel>
                  <select className="h-9 rounded-md border bg-background px-3" disabled={editor.memoryId !== null} id="shared-memory-kind" onChange={(event) => updateEditor({ kind: event.target.value as PersonalMemoryKind })} value={editor.kind}>
                    <option value="preference">{t("Preference")}</option>
                    <option value="fact">{t("Fact")}</option>
                    <option value="decision">{t("Decision")}</option>
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="shared-memory-context">{t("Memory context")}</FieldLabel>
                  <select className="h-9 rounded-md border bg-background px-3" disabled={editor.memoryId !== null} id="shared-memory-context" onChange={(event) => updateEditor({ contextKind: event.target.value as PersonalMemoryContextKind, contextId: event.target.value === "GLOBAL" ? "" : editor.contextId })} value={editor.contextKind}>
                    <option value="GLOBAL">{t("Global")}</option>
                    <option value="PROJECT">{t("Project")}</option>
                    <option value="CONTEXT">{t("Context")}</option>
                  </select>
                </Field>
              </div>
              {editor.contextKind !== "GLOBAL" ? <Field>
                <FieldLabel htmlFor="shared-memory-context-id">{editor.contextKind === "PROJECT" ? t("Project ID") : t("Context ID")}</FieldLabel>
                <Input id="shared-memory-context-id" maxLength={256} onChange={(event) => updateEditor({ contextId: event.target.value })} readOnly={editor.memoryId !== null} value={editor.contextId} />
                <FieldDescription>{t("This context stays inside the selected shared scope and is never treated as personal memory.")}</FieldDescription>
              </Field> : <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">{t("A global context in shared memory is available only to the selected Team or Organization scope.")}</p>}
              <Field data-invalid={Boolean(editorError)}>
                <FieldLabel htmlFor="shared-memory-content">{t("Memory")}</FieldLabel>
                <Textarea id="shared-memory-content" maxLength={12000} onChange={(event) => updateEditor({ content: event.target.value })} rows={5} value={editor.content} />
                <FieldDescription>{t("Write the statement this selected scope should use later.")}</FieldDescription>
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

      <Dialog open={proposalEditor !== null} onOpenChange={(open) => { if (!open && pendingOperation !== "propose") setProposalEditor(null) }}>
        <DialogContent className="sm:max-w-xl">
          <form onSubmit={(event) => void submitCorrectionProposal(event)}>
            <DialogHeader>
              <DialogTitle>{t("Propose shared memory correction")}</DialogTitle>
              <DialogDescription>{t("Your proposal stays pending until a scope manager accepts it. It cannot directly replace the current shared memory.")}</DialogDescription>
            </DialogHeader>
            {proposalEditor && selectedScope ? <FieldGroup className="mt-5">
              <div className="rounded-md bg-muted/50 p-3 text-sm">
                <p className="font-medium">{proposalEditor.memory.key}</p>
                <p className="mt-1 text-muted-foreground">{contextDescription(proposalEditor.memory, selectedScope, t)}</p>
              </div>
              <Field data-invalid={Boolean(proposalEditorError)}>
                <FieldLabel htmlFor="shared-memory-proposal-content">{t("Proposed memory")}</FieldLabel>
                <Textarea id="shared-memory-proposal-content" maxLength={12000} onChange={(event) => setProposalEditor((current) => current ? { ...current, content: event.target.value } : current)} rows={5} value={proposalEditor.content} />
                <FieldDescription>{t("Change only the statement. The key, type, and context remain tied to the current shared memory.")}</FieldDescription>
                {proposalEditorError ? <FieldError>{t(proposalEditorError)}</FieldError> : null}
              </Field>
            </FieldGroup> : null}
            <DialogFooter className="mt-6">
              <Button disabled={pendingOperation === "propose"} onClick={() => setProposalEditor(null)} type="button" variant="outline">{t("Cancel")}</Button>
              <Button disabled={pendingOperation === "propose"} type="submit">
                {pendingOperation === "propose" ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}
                {t("Submit correction proposal")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open && pendingOperation !== "delete") setPendingDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Permanently delete shared memory?")}</AlertDialogTitle>
            <AlertDialogDescription>{t("This permanently removes {{key}} from the selected shared scope and cannot be undone.", { key: pendingDelete?.key ?? "" })}</AlertDialogDescription>
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
