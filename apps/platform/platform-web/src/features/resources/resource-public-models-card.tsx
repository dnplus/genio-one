import { PlusIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ConnectionSummary, ResourceRegistration } from "@/domain/contracts"
import {
  createPublicModel,
  listResourceModelMappings,
  listResourcePublicModels,
  type ConnectionModelMappingView,
  type PublicModelView,
} from "@/lib/product-api"

export function ResourcePublicModelsCard({
  canEdit,
  connections,
  onSaved,
  resource,
  tenantId,
}: {
  canEdit: boolean
  connections: ConnectionSummary[]
  onSaved?: () => void | Promise<void>
  resource: ResourceRegistration
  tenantId: string
}) {
  const { t } = useTranslation()
  const eligibleConnections = useMemo(
    () => connections.filter((connection) => connection.lifecycle === "ENABLED"),
    [connections],
  )
  const [models, setModels] = useState<PublicModelView[]>([])
  const [mappings, setMappings] = useState<ConnectionModelMappingView[]>([])
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [modelName, setModelName] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [connectionId, setConnectionId] = useState(eligibleConnections[0]?.connection_id ?? "")
  const selectedConnection = eligibleConnections.find((connection) => connection.connection_id === connectionId)
  const [providerModel, setProviderModel] = useState("")
  const [purpose, setPurpose] = useState("CHAT")

  useEffect(() => {
    let active = true
    setLoading(true)
    setError("")
    void Promise.all([
      listResourcePublicModels(tenantId, resource.resource_id),
      listResourceModelMappings(tenantId, resource.resource_id),
    ]).then(([nextModels, nextMappings]) => {
      if (!active) return
      setModels(nextModels)
      setMappings(nextMappings)
    }).catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : "PUBLIC_MODEL_LOAD_FAILED")
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [resource.resource_id, tenantId])

  useEffect(() => {
    const suggested = selectedConnection?.llm?.models[0]?.upstream_model_id ?? ""
    setProviderModel((current) => current || suggested)
  }, [selectedConnection])

  async function save() {
    if (!modelName.trim() || !displayName.trim() || !connectionId || !providerModel.trim()) {
      setError("PUBLIC_MODEL_FIELDS_REQUIRED")
      return
    }
    setSaving(true)
    setError("")
    try {
      await createPublicModel(tenantId, resource.resource_id, {
        modelName: modelName.trim(),
        displayName: displayName.trim(),
        connectionId,
        providerModel: providerModel.trim(),
        capabilities: purpose === "TRANSCRIPTION" ? ["TRANSCRIPTION"] : ["CHAT", "STREAMING"],
      })
      const [nextModels, nextMappings] = await Promise.all([
        listResourcePublicModels(tenantId, resource.resource_id),
        listResourceModelMappings(tenantId, resource.resource_id),
      ])
      setModels(nextModels)
      setMappings(nextMappings)
      setEditing(false)
      await onSaved?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "PUBLIC_MODEL_SAVE_FAILED")
    } finally {
      setSaving(false)
    }
  }

  if (resource.kind !== "LLM") return null

  return (
    <Card data-testid="resource-public-models">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{t("Public models")}</CardTitle>
          {canEdit && !editing ? <Button onClick={() => setEditing(true)} size="sm" variant="outline"><PlusIcon data-icon="inline-start" />{t("Add model")}</Button> : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? <Alert variant="destructive"><AlertTitle>{t("Unable to save public model")}</AlertTitle><AlertDescription>{t(error)}</AlertDescription></Alert> : null}
        {loading ? <div className="text-sm text-muted-foreground">{t("Loading")}</div> : models.length ? models.map((model) => {
          const mapping = mappings.find((candidate) => candidate.public_model_id === model.model_id)
          const connection = connections.find((candidate) => candidate.connection_id === mapping?.connection_id)
          return <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-center" key={model.model_id}>
            <div><div className="font-medium">{model.display_name}</div><div className="font-mono text-xs text-muted-foreground">{model.model_name}</div></div>
            <div className="text-sm"><div>{connection?.display_name ?? mapping?.connection_id ?? "—"}</div><div className="font-mono text-xs text-muted-foreground">{mapping?.provider_model ?? "—"}</div></div>
            <Badge variant="secondary">{t(model.lifecycle)}</Badge>
          </div>
        }) : <div className="text-sm text-muted-foreground">{t("No public models configured.")}</div>}
        {editing ? <FieldGroup className="rounded-lg border p-4">
          <Field><FieldLabel>{t("Model purpose")}</FieldLabel><Select value={purpose} onValueChange={setPurpose}><SelectTrigger aria-label={t("Model purpose")}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="CHAT">{t("Chat")}</SelectItem><SelectItem value="TRANSCRIPTION">{t("Transcription")}</SelectItem></SelectContent></Select></Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field><FieldLabel>{t("Client model name")}</FieldLabel><Input onChange={(event) => setModelName(event.target.value)} placeholder="genio-chat" value={modelName} /></Field>
            <Field><FieldLabel>{t("Display name")}</FieldLabel><Input onChange={(event) => setDisplayName(event.target.value)} placeholder={t("Genio Chat")} value={displayName} /></Field>
            <Field><FieldLabel>{t("Connection")}</FieldLabel><Select value={connectionId} onValueChange={(value) => { setConnectionId(value); setProviderModel("") }}><SelectTrigger><SelectValue placeholder={t("Select a Connection")} /></SelectTrigger><SelectContent><SelectGroup>{eligibleConnections.map((connection) => <SelectItem key={connection.connection_id} value={connection.connection_id}>{connection.display_name}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
            <Field><FieldLabel>{t("Upstream model")}</FieldLabel><Input className="font-mono" onChange={(event) => setProviderModel(event.target.value)} value={providerModel} /></Field>
          </div>
        </FieldGroup> : null}
      </CardContent>
      {editing ? <CardFooter className="justify-end gap-2"><Button onClick={() => { setEditing(false); setError("") }} variant="outline">{t("Cancel")}</Button><Button disabled={saving || eligibleConnections.length === 0} onClick={() => void save()}>{saving ? t("Saving") : t("Save model")}</Button></CardFooter> : null}
    </Card>
  )
}
