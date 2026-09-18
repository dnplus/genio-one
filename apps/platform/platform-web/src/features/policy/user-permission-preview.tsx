import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { SearchableSelect } from "@/components/ui/searchable-select"
import type { OverviewSnapshot } from "@/domain/contracts"
import { previewUserPermissions, type UserPermissionPreview } from "@/lib/product-api"

export function UserPermissionPreviewDialog({ tenantId, data, onClose }: { tenantId: string; data: OverviewSnapshot; onClose: () => void }) {
  const { t } = useTranslation()
  const [subjectId, setSubjectId] = useState("")
  const [runtimeId, setRuntimeId] = useState("codex")
  const [clientId, setClientId] = useState("genio-one-bot")
  const [botId, setBotId] = useState("genio.personal-bot")
  const [result, setResult] = useState<UserPermissionPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const generation = useRef(0)
  const subjects = (data.identity?.subjects ?? []).filter((subject) => subject.kind === "PERSON").map((subject) => ({ value: subject.subject_id, label: subject.profile.display_name ?? subject.profile.email ?? subject.subject_id }))
  const runtimes = [...new Map([{ value: "codex", label: "Codex" }, ...data.runtimes.map((runtime) => ({ value: runtime.runtime_id, label: runtime.runtime_id }))].map((value) => [value.value, value])).values()]
  const clients = [...new Map([{ value: "genio-one-bot", label: "Genio Bot" }, ...data.applications.map((application) => ({ value: application.subject_id, label: application.display_name }))].map((value) => [value.value, value])).values()]
  const bots = [...new Map([{ value: "genio.personal-bot", label: "Genio Bot" }, ...data.resources.filter((resource) => resource.service_kind === "GENIO_BOT").map((resource) => ({ value: resource.resource_id, label: resource.display_name }))].map((value) => [value.value, value])).values()]
  function change(set: (value: string) => void, value: string) {
    generation.current++
    set(value)
    setResult(null)
    setError("")
    setBusy(false)
  }
  async function preview() {
    const current = ++generation.current
    setBusy(true)
    setResult(null)
    setError("")
    try {
      const value = await previewUserPermissions(tenantId, { subject_id: subjectId, runtime_id: runtimeId, client_id: clientId, bot_id: botId })
      if (generation.current === current) setResult(value)
    } catch (caught) {
      if (generation.current === current) setError(caught instanceof Error ? caught.message : "PREVIEW_FAILED")
    } finally {
      if (generation.current === current) setBusy(false)
    }
  }
  return <Dialog open onOpenChange={(open) => { if (!open) { generation.current++; onClose() } }}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl" data-testid="user-permission-preview"><DialogHeader><DialogTitle>{t("View as user permissions")}</DialogTitle><DialogDescription>{t("Preview permissions only. Conversations, memory, attachments and personal credentials are not loaded. No models or tools are invoked.")}</DialogDescription></DialogHeader>
    <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel>{t("Preview user")}</FieldLabel><SearchableSelect value={subjectId} options={subjects} onValueChange={(value) => change(setSubjectId, value)} placeholder={t("Select a person or subject")} searchPlaceholder={t("Search people and subjects")} emptyLabel={t("No results.")} /></Field><Field><FieldLabel>{t("Runtime")}</FieldLabel><SearchableSelect value={runtimeId} options={runtimes} onValueChange={(value) => change(setRuntimeId, value)} placeholder={t("Runtime")} searchPlaceholder={t("Search runtimes")} emptyLabel={t("No results.")} /></Field></div>
    <details><summary className="cursor-pointer text-sm">{t("Evaluation context")}</summary><div className="mt-3 grid gap-4 sm:grid-cols-2"><Field><FieldLabel>{t("Acting client")}</FieldLabel><SearchableSelect value={clientId} options={clients} onValueChange={(value) => change(setClientId, value)} placeholder={t("Acting client")} searchPlaceholder={t("Search clients")} emptyLabel={t("No results.")} /></Field><Field><FieldLabel>{t("Bot")}</FieldLabel><SearchableSelect value={botId} options={bots} onValueChange={(value) => change(setBotId, value)} placeholder={t("Bot")} searchPlaceholder={t("Search bots")} emptyLabel={t("No results.")} /></Field></div></details>
    <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => { generation.current++; onClose() }}>{t("Exit preview")}</Button><Button disabled={!subjectId || busy} onClick={() => void preview()}>{t(busy ? "Loading..." : "Preview permissions")}</Button></div>
    {error ? <Alert variant="destructive"><AlertDescription>{t(error)}</AlertDescription></Alert> : null}
    {result ? <div className="space-y-5"><Alert className="sticky top-0 z-10 bg-background"><AlertDescription>{t("Viewing permissions as {{name}}", { name: result.subject_display_name })} · {t(result.role)} · {result.runtime_id} · {result.client_id}<Button className="ml-auto" size="sm" variant="outline" onClick={() => { generation.current++; onClose() }}>{t("Exit preview")}</Button></AlertDescription></Alert>
      <Alert variant={result.bot_access.decision === "DENY" ? "destructive" : "default"}><AlertDescription>{t("Bot entry permission")} · {t(result.bot_access.decision)} · {t(result.bot_access.reason_code)}</AlertDescription></Alert>
      <section className="space-y-3"><h3 className="font-medium">{t("Available catalog capabilities")}</h3><p className="text-sm text-muted-foreground">{t("Catalog access and runtime policy are separate checks. Credentials and live provider readiness are not tested.")}</p>{result.capabilities.length ? result.capabilities.map((capability) => <div key={`${capability.resource_id}:${capability.capability_id}`} className="rounded border p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><span>{capability.resource_display_name} · {capability.capability_display_name}</span><Badge variant="outline">{t(capability.access)}</Badge><Badge variant="outline">{t(capability.connection_status)}</Badge></div>{capability.restriction_reason ? <p>{t(capability.restriction_reason)}</p> : null}</div>) : <p className="text-sm text-muted-foreground">{t("No catalog capabilities are visible to this user.")}</p>}</section>
      <section className="space-y-3"><h3 className="font-medium">{t("Runtime permission results")}</h3>{result.runtime_decisions.map((decision) => <div key={`${decision.capability_id}:${decision.action}`} className="rounded border p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><span>{t(decision.capability_id, { defaultValue: data.resources.flatMap((resource) => resource.capabilities).find((capability) => capability.capability_id === decision.capability_id)?.display_name ?? decision.capability_id })} · {t(decision.action === "expose" ? "Discover capability" : decision.action)}</span><Badge variant={decision.effective_decision === "ALLOW" ? "secondary" : "outline"}>{t(decision.effective_decision)}</Badge></div><p className="mt-1 text-muted-foreground">{t(result.bot_access.decision === "DENY" ? result.bot_access.reason_code : decision.reason_code.startsWith("RULE_ALLOW:") ? "Allowed by policy rule" : decision.reason_code.startsWith("RULE_DENY:") ? "Denied by policy rule" : decision.reason_code)}{decision.policy_display_name ? ` · ${decision.policy_display_name}` : ""}</p>{decision.constraints.length || decision.obligations.length ? <p className="mt-1">{[...decision.constraints, ...decision.obligations].map((value) => t(value.kind)).join("、")}</p> : null}</div>)}</section>
    </div> : null}
  </DialogContent></Dialog>
}
