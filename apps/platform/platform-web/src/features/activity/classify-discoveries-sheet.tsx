import { useMemo, useState, type FormEvent } from "react"
import { LoaderCircleIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type {
  ClassifyDiscoveredResourcesInput,
  EndpointActivityInventory,
} from "@/domain/contracts"
import { classifyDiscoveredResources } from "@/lib/product-api"

type Discovery = EndpointActivityInventory["resources"][number]
type ClassificationKind = ClassifyDiscoveredResourcesInput["kind"]

const initialDefaults: Omit<ClassifyDiscoveredResourcesInput, "resources"> = {
  kind: "LLM",
  visibility: "VISIBLE",
  access: "REQUEST",
  authenticationStrategy: "OAUTH",
  environmentId: "production",
  version: "v1",
  capabilityId: "model.invoke",
  capabilityName: "Invoke model",
  enforcementPointId: "genio-ai-mcp-gateway",
}

function resourceIdFor(discovery: Discovery) {
  const host = discovery.destination_hosts[0] ?? discovery.resource_id.replace(/^unclassified:/, "")
  return host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

export function ClassifyDiscoveriesSheet({
  tenantId,
  discoveries,
  open,
  onOpenChange,
  onClassified,
}: {
  tenantId: string
  discoveries: Discovery[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onClassified: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [defaults, setDefaults] = useState(initialDefaults)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const resources = useMemo(
    () =>
      discoveries.map((discovery) => ({
        sourceResourceId: discovery.resource_id,
        resourceId: resourceIdFor(discovery),
        displayName: discovery.destination_hosts[0] ?? discovery.resource_id,
      })),
    [discoveries],
  )

  function update<Key extends keyof typeof defaults>(key: Key, value: (typeof defaults)[Key]) {
    setDefaults((current) => ({ ...current, [key]: value }))
  }

  function updateKind(kind: ClassificationKind) {
    if (kind === "MCP") {
      setDefaults((current) => ({
        ...current,
        kind,
        capabilityId: "mcp.invoke",
        capabilityName: "Invoke MCP tools",
        enforcementPointId: "genio-ai-mcp-gateway",
      }))
    } else if (kind === "SAAS") {
      setDefaults((current) => ({
        ...current,
        kind,
        capabilityId: "service.access",
        capabilityName: "Access service",
        enforcementPointId: "genio-endpoint",
      }))
    } else {
      setDefaults((current) => ({
        ...current,
        kind,
        capabilityId: "model.invoke",
        capabilityName: "Invoke model",
        enforcementPointId: "genio-ai-mcp-gateway",
      }))
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!resources.length) return
    setSubmitting(true)
    setError("")
    try {
      await classifyDiscoveredResources(tenantId, { ...defaults, resources })
      await onClassified()
      setDefaults(initialDefaults)
      onOpenChange(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Resource classification failed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <form className="flex min-h-full flex-col" onSubmit={submit}>
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>{t("Classify discovered Resources")}</SheetTitle>
            <SheetDescription>
              {t("Create Draft Resources while preserving every Endpoint discovery as provenance.")}
            </SheetDescription>
          </SheetHeader>
          <FieldGroup className="p-6">
            <Field>
              <FieldLabel>{t("Selected discoveries")}</FieldLabel>
              <div className="rounded-lg border bg-muted/20">
                {resources.map((resource) => (
                  <div
                    key={resource.sourceResourceId}
                    className="border-b px-3 py-2 last:border-b-0"
                  >
                    <div className="text-sm font-medium">{resource.displayName}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {resource.sourceResourceId} → {resource.resourceId}
                    </div>
                  </div>
                ))}
              </div>
              <FieldDescription>
                {t("Batch classification applies the same type and policy defaults atomically.")}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>{t("Resource type")}</FieldLabel>
              <Select value={defaults.kind} onValueChange={(value) => updateKind(value as ClassificationKind)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>
                  <SelectItem value="LLM">{t("AI Service")}</SelectItem>
                  <SelectItem value="SAAS">{t("SaaS")}</SelectItem>
                  <SelectItem value="MCP">{t("MCP Server")}</SelectItem>
                </SelectGroup></SelectContent>
              </Select>
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field>
                <FieldLabel>{t("Default visibility")}</FieldLabel>
                <Select value={defaults.visibility} onValueChange={(value) => update("visibility", value as typeof defaults.visibility)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>
                    <SelectItem value="VISIBLE">{t("Visible")}</SelectItem>
                    <SelectItem value="HIDDEN">{t("Hidden")}</SelectItem>
                  </SelectGroup></SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>{t("Default access mode")}</FieldLabel>
                <Select value={defaults.access} onValueChange={(value) => update("access", value as typeof defaults.access)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>
                    <SelectItem value="REQUEST">{t("Request access")}</SelectItem>
                    <SelectItem value="AUTO_GRANT">{t("Auto grant")}</SelectItem>
                    <SelectItem value="DENY">{t("Deny")}</SelectItem>
                  </SelectGroup></SelectContent>
                </Select>
              </Field>
            </div>
            <Field>
              <FieldLabel>{t("Authentication strategy")}</FieldLabel>
              <Select value={defaults.authenticationStrategy} onValueChange={(value) => update("authenticationStrategy", value as typeof defaults.authenticationStrategy)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>
                  <SelectItem value="OAUTH">{t("OAuth")}</SelectItem>
                  <SelectItem value="EMA">EMA</SelectItem>
                  <SelectItem value="API_KEY">{t("API key")}</SelectItem>
                  <SelectItem value="MTLS">mTLS</SelectItem>
                  <SelectItem value="NONE">{t("None")}</SelectItem>
                </SelectGroup></SelectContent>
              </Select>
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field><FieldLabel htmlFor="classification-environment">{t("Environment")}</FieldLabel><Input id="classification-environment" value={defaults.environmentId} onChange={(event) => update("environmentId", event.target.value)} required /></Field>
              <Field><FieldLabel htmlFor="classification-version">{t("Version")}</FieldLabel><Input id="classification-version" value={defaults.version} onChange={(event) => update("version", event.target.value)} required /></Field>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field>
                <FieldLabel>{t("Capability ID")}</FieldLabel>
                <div className="rounded-md border bg-muted/20 px-3 py-2 font-mono text-sm">{defaults.capabilityId}</div>
                <FieldDescription>{t("Capability ID is derived from the Resource type.")}</FieldDescription>
              </Field>
              <Field><FieldLabel htmlFor="classification-capability-name">{t("Capability name")}</FieldLabel><Input id="classification-capability-name" value={defaults.capabilityName} onChange={(event) => update("capabilityName", event.target.value)} required /></Field>
            </div>
            <Field>
              <FieldLabel>{t("Enforcement point")}</FieldLabel>
              <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm">
                <div>{defaults.enforcementPointId === "genio-endpoint" ? t("Endpoint") : t("AI Gateway")}</div>
                <div className="font-mono text-xs text-muted-foreground">{defaults.enforcementPointId}</div>
              </div>
              <FieldDescription>{t("Enforcement point is derived from the Resource type. This is a Draft default and does not publish or grant access.")}</FieldDescription>
            </Field>
            {error ? <FieldError>{t(error)}</FieldError> : null}
          </FieldGroup>
          <SheetFooter className="border-t bg-background px-6 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel")}</Button>
            <Button type="submit" disabled={submitting || !resources.length}>
              {submitting ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : null}
              {t("Create Draft Resources")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
