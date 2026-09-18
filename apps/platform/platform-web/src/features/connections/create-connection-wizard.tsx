import { ConnectorFields, emptyConnectorConfiguration } from "./connector-fields"
import type { ConnectorConfiguration } from "@/domain/contracts"
import { listInstalledConnectors, type InstalledConnector } from "@/lib/product-api"
import { InlineCredentialProfile } from "@/features/provider-credentials/inline-credential-profile"
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react"
import { LoaderCircleIcon, UploadIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { GuidedSetupSteps, type GuidedSetupStep } from "@/components/guided-setup-steps"
import { PageHeader } from "@/components/page-header"
import { TitleHelp } from "@/components/title-help"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { ConnectionKind, ProviderCredentialProfileRevision, RegisterConnectionInput, ResourceRegistration } from "@/domain/contracts"
import { connectionCatalog, type ConnectionCatalogItem } from "@/features/connections/connection-catalog"
import { listProviderCredentialProfiles, registerConnection } from "@/lib/product-api"

const steps = ["Connection", "Review"] as const

export function CreateConnectionWizard({
  tenantId,
  resources,
  defaultResourceId,
  onCancel,
  onCreated,
}: {
  tenantId: string
  resources: ResourceRegistration[]
  defaultResourceId?: string
  onCancel: () => void
  onCreated: (connectionId: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [connectorConfiguration, setConnectorConfiguration] = useState<ConnectorConfiguration | undefined>()
  const [installed, setInstalled] = useState<InstalledConnector[]>([])
  const [step, setStep] = useState(0)
  const [registeredId, setRegisteredId] = useState<string | null>(null)
  const [catalogItem, setCatalogItem] = useState<ConnectionCatalogItem | null>(null)
  const [resourceId, setResourceId] = useState(defaultResourceId ?? "")
  const [displayName, setDisplayName] = useState("")
  const [endpointUrl, setEndpointUrl] = useState("")
  const [certificateMode, setCertificateMode] = useState<"SYSTEM_CA" | "CUSTOM_CA">("SYSTEM_CA")
  const [certificatePem, setCertificatePem] = useState("")
  const [credentialReference, setCredentialReference] = useState("")
  const [mcpUpstreamAuthentication, setMcpUpstreamAuthentication] = useState<"NONE" | "API_KEY" | "USER_OAUTH" | "USER_PASSTHROUGH">("NONE")
  const [llmUpstreamAuthentication, setLlmUpstreamAuthentication] = useState<"NONE" | "PROVIDER_CREDENTIAL_PROFILE">("PROVIDER_CREDENTIAL_PROFILE")
  const [providerCredentialProfiles, setProviderCredentialProfiles] = useState<ProviderCredentialProfileRevision[]>([])
  const [providerCredentialProfileKey, setProviderCredentialProfileKey] = useState("")
  const [mcpUserCredentialHeader] = useState("x-mcp-user-token")
  const [mcpToolNamespace, setMcpToolNamespace] = useState("")
  const [llmProviderId, setLlmProviderId] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  const availableCatalog = connectionCatalog.filter((item) => !item.connectorKind || installed.some((connector) => connector.kind === item.connectorKind))
  const allowedCatalog = (() => {
    const focused = defaultResourceId ? resources.find((resource) => resource.resource_id === defaultResourceId) : undefined
    if (focused && (focused.kind === "LLM" || focused.kind === "MCP" || focused.kind === "API")) {
      return availableCatalog.filter((item) => item.kind === focused.kind)
    }
    return availableCatalog
  })()
  const eligibleResources = resources.filter((resource) =>
    !resource.installation_owned &&
    (catalogItem ? resource.kind === catalogItem.kind : ["MCP", "LLM", "API"].includes(resource.kind)),
  )
  const selectedResource = eligibleResources.find((resource) => resource.resource_id === resourceId)
  const eligibleProviderCredentialProfiles = providerCredentialProfiles.filter((profile) =>
    profile.owner_organization_id === selectedResource?.owner_organization_id &&
    (llmProviderId !== "GCP_VERTEX_AI" || profile.adapter_family === "GCP"))
  const selectedProviderCredentialProfile = eligibleProviderCredentialProfiles.find((profile) =>
    `${profile.profile_id}:${profile.revision}` === providerCredentialProfileKey)
  const guidedSteps: GuidedSetupStep[] = steps.map((label, index) => ({
    id: label,
    label: t(label),
    status: index < step ? "complete" : index === step ? "current" : "upcoming",
  }))

  useEffect(() => {
    void listInstalledConnectors(tenantId).then(setInstalled).catch(() => setError(t("Connector inventory unavailable")))
    void listProviderCredentialProfiles(tenantId)
      .then((profiles) => setProviderCredentialProfiles(profiles.filter((profile) => profile.state === "ACTIVE")))
      .catch((caught) => setError(caught instanceof Error ? caught.message : t("Provider credential profiles could not be loaded.")))
  }, [tenantId, t])

  function applyCatalogId(id: string) {
    const item = connectionCatalog.find((candidate) => candidate.id === id)
    if (!item) return
    setConnectorConfiguration(item.connectorKind ? emptyConnectorConfiguration(item.connectorKind) : undefined)
    setMcpUpstreamAuthentication("NONE")
    setCredentialReference("")
    setCatalogItem(item)
    if (item.endpoint) setEndpointUrl(item.endpoint)
    if (item.providerType) setLlmProviderId(item.providerType)
    setDisplayName(`${item.label} Connection`)
    setLlmUpstreamAuthentication(item.kind === "LLM" ? "PROVIDER_CREDENTIAL_PROFILE" : "NONE")
    const matching = resources.filter((resource) => resource.kind === item.kind)
    if (defaultResourceId && matching.some((resource) => resource.resource_id === defaultResourceId)) setResourceId(defaultResourceId)
    else if (matching.length === 1) setResourceId(matching[0]!.resource_id)
    else setResourceId("")
  }

  function onCertificateFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    void file.text().then((value) => setCertificatePem(value))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (step < steps.length - 1) {
      setError("")
      setStep((current) => current + 1)
      return
    }
    if (!selectedResource || !catalogItem) return
    if (selectedResource.kind === "LLM" && llmUpstreamAuthentication === "PROVIDER_CREDENTIAL_PROFILE" && !selectedProviderCredentialProfile) {
      setError(t("Select an active Provider Credential Profile owned by the Resource Organization."))
      return
    }
    setSubmitting(true)
    setError("")
    try {
      if (registeredId) { await onCreated(registeredId); return }
      const input: RegisterConnectionInput = {
        connectorConfiguration,
        displayName: displayName.trim(),
        kind: selectedResource.kind as ConnectionKind,
        endpointUrl: endpointUrl.trim(),
        certificateMode,
        certificatePem: certificateMode === "CUSTOM_CA" ? certificatePem.trim() : null,
        mcpToolNamespace: selectedResource.kind === "MCP" ? mcpToolNamespace.trim() : undefined,
        credentialReference: credentialReference.trim() || undefined,
        upstreamAuthentication: selectedResource.kind === "MCP"
          ? mcpUpstreamAuthentication
          : selectedResource.kind === "LLM"
            ? llmUpstreamAuthentication
            : undefined,
        userCredentialHeader: selectedResource.kind === "MCP" && mcpUpstreamAuthentication === "USER_PASSTHROUGH"
          ? mcpUserCredentialHeader.trim()
          : undefined,
        llm: selectedResource.kind === "LLM" ? {
          provider_id: llmProviderId.trim(),
          models: [],
        } : undefined,
        providerCredentialProfile: selectedProviderCredentialProfile
          ? { profile_id: selectedProviderCredentialProfile.profile_id, revision: selectedProviderCredentialProfile.revision }
          : undefined,
        resiliency: {
          timeout_ms: 30_000,
          max_attempts: 1,
          idempotency_header: null,
          circuit_failure_threshold: 5,
          circuit_open_ms: 30_000,
        },
        resourceId: selectedResource.resource_id,
        enforcementPointId: selectedResource.enforcement_point_id,
      }
      const created = await registerConnection(tenantId, input)
      setRegisteredId(created.connection_id)
      await onCreated(created.connection_id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Connection registration failed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="flex flex-col gap-6" data-testid="connection-onboarding-wizard" onSubmit={submit}>
      <div className="flex flex-col gap-5 border-b pb-6">
        <PageHeader
          backLabel={t("Back to Connections")}
          description={t("Attach one upstream to a governed Resource. A Connection belongs to exactly one Resource.")}
          onBack={onCancel}
          title={t("Add Connection")}
        />
        <GuidedSetupSteps
          activeStepId={steps[step]}
          onSelect={(stepId) => {
            const index = steps.indexOf(stepId as (typeof steps)[number])
            if (index < 0) return
            setError("")
            setStep(index)
          }}
          steps={guidedSteps}
          testId="connection-onboarding-steps"
        />
      </div>

      {step === 0 ? (
        <Card>
          <CardHeader><CardTitle><TitleHelp help={t("Choose the Connection type, then the Resource it belongs to.")}>{t("Connection")}</TitleHelp></CardTitle></CardHeader>
          <CardContent><FieldGroup>
            <Field>
              <FieldLabel>{t("Connection type")}</FieldLabel>
              <Select value={catalogItem?.id ?? ""} onValueChange={applyCatalogId}>
                <SelectTrigger className="w-full"><SelectValue placeholder={t("Select Connection type")} /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {allowedCatalog.filter((item) => !item.connectorKind).map((item) => (
                      <SelectItem key={item.id} value={item.id}>{t(item.label)}</SelectItem>
                    ))}
                  </SelectGroup>
                  {allowedCatalog.some((item) => item.connectorKind) ? <SelectGroup>
                    <SelectLabel>{t("Connector")}</SelectLabel>
                    {allowedCatalog.filter((item) => item.connectorKind).map((item) => (
                      <SelectItem key={item.id} value={item.id} disabled={!installed.some((connector) => connector.kind === item.connectorKind && connector.available)}>{t(item.label)}</SelectItem>
                    ))}
                  </SelectGroup> : null}
                </SelectContent>
              </Select>
              {catalogItem ? <FieldDescription>{t(catalogItem.description)}</FieldDescription> : null}
            </Field>
            {catalogItem ? <>
              <Field>
                <FieldLabel>{t("Governed Resource")}</FieldLabel>
                <Select value={resourceId} onValueChange={setResourceId} required>
                  <SelectTrigger className="w-full"><SelectValue placeholder={t("Select a Resource")} /></SelectTrigger>
                  <SelectContent><SelectGroup>
                    {eligibleResources.map((resource) => (
                      <SelectItem key={resource.resource_id} value={resource.resource_id}>
                        {resource.display_name} · {resource.kind} · {resource.environment_id}
                      </SelectItem>
                    ))}
                  </SelectGroup></SelectContent>
                </Select>
                <FieldDescription>{t("A Connection belongs to exactly one Resource. Create multiple Connections for the same Resource when you need failover or region alternatives.")}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="connection-display-name">{t("Display name")}</FieldLabel>
                <Input id="connection-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
              </Field>
              {connectorConfiguration ? <ConnectorFields key={connectorConfiguration.kind} value={connectorConfiguration} onChange={setConnectorConfiguration} /> : <>
              <Field>
                <FieldLabel htmlFor="connection-endpoint">{t("Upstream endpoint URL")}</FieldLabel>
                <Input id="connection-endpoint" type="url" value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} required />
                <FieldDescription>{t("Use the upstream URL only; never paste a secret into this form.")}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>{t("Upstream TLS trust")}</FieldLabel>
                <Select value={certificateMode} onValueChange={(value) => setCertificateMode(value as typeof certificateMode)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>
                    <SelectItem value="SYSTEM_CA">{t("System CA store")}</SelectItem>
                    <SelectItem value="CUSTOM_CA">{t("Imported custom CA / self-signed")}</SelectItem>
                  </SelectGroup></SelectContent>
                </Select>
              </Field>
              {certificateMode === "CUSTOM_CA" ? <Field>
                <FieldLabel htmlFor="connection-register-certificate-file">{t("Import certificate file")}</FieldLabel>
                <div className="flex items-center gap-2">
                  <input accept=".pem,.crt,.cer,application/x-pem-file,application/pkix-cert" className="sr-only" id="connection-register-certificate-file" onChange={onCertificateFileChange} type="file" />
                  <Button asChild type="button" variant="outline"><label htmlFor="connection-register-certificate-file"><UploadIcon data-icon="inline-start" />{t("Choose PEM file")}</label></Button>
                </div>
                <Textarea className="mt-3 min-h-36 font-mono text-xs" onChange={(event) => setCertificatePem(event.target.value)} placeholder={t("PEM certificate placeholder")} spellCheck={false} value={certificatePem} />
              </Field> : null}
              {selectedResource?.kind === "MCP" ? (
                <Field>
                  <FieldLabel>{t("Upstream authentication")}</FieldLabel>
                  <Select value={mcpUpstreamAuthentication} onValueChange={(value) => setMcpUpstreamAuthentication(value as typeof mcpUpstreamAuthentication)}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectGroup>
                      <SelectItem value="NONE">{t("None")}</SelectItem>
                      <SelectItem value="API_KEY">{t("API key")}</SelectItem>
                      <SelectItem value="USER_OAUTH">{t("User OAuth")}</SelectItem>
                      <SelectItem value="USER_PASSTHROUGH">{t("User credential header")}</SelectItem>
                    </SelectGroup></SelectContent>
                  </Select>
                </Field>
              ) : null}
              </>}
              {selectedResource?.kind === "LLM" ? (
                <Field>
                  <FieldLabel>{t("Provider authentication")}</FieldLabel>
                  <Select value={llmUpstreamAuthentication} onValueChange={(value) => {
                    const next = value as typeof llmUpstreamAuthentication
                    setLlmUpstreamAuthentication(next)
                    if (next === "NONE") setProviderCredentialProfileKey("")
                  }}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectGroup>
                      <SelectItem value="NONE">{t("None")}</SelectItem>
                      <SelectItem value="PROVIDER_CREDENTIAL_PROFILE">{t("Provider Credential Profile")}</SelectItem>
                    </SelectGroup></SelectContent>
                  </Select>
                </Field>
              ) : null}
              {!connectorConfiguration && selectedResource?.kind === "MCP" && mcpUpstreamAuthentication === "API_KEY" ? <Field>
                <FieldLabel htmlFor="connection-credential">{t("Credential reference")}</FieldLabel>
                <Input id="connection-credential" value={credentialReference} onChange={(event) => setCredentialReference(event.target.value)} />
              </Field> : null}
              {selectedResource?.kind === "LLM" && llmUpstreamAuthentication === "PROVIDER_CREDENTIAL_PROFILE" ? <Field>
                <FieldLabel>{t("Provider Credential Profile")}</FieldLabel>
                <SearchableSelect
                  value={providerCredentialProfileKey}
                  options={eligibleProviderCredentialProfiles.map((profile) => ({
                    value: `${profile.profile_id}:${profile.revision}`,
                    label: profile.display_name,
                    description: `${profile.strategy.kind} · revision ${profile.revision}`,
                    searchText: `${profile.profile_id} ${profile.adapter_family}`,
                  }))}
                  onValueChange={setProviderCredentialProfileKey}
                  placeholder={t("Select a Provider Credential Profile")}
                  searchPlaceholder={t("Search Provider Credential Profiles")}
                  emptyLabel={t("No active profiles are available for this Resource Organization.")}
                />
                <FieldDescription>{t("Select a reusable credential profile or create one here using a controlled secret reference.")}</FieldDescription>
                <InlineCredentialProfile key={selectedResource.owner_organization_id} tenantId={tenantId} organizationId={selectedResource.owner_organization_id} onCreated={(profile) => { setProviderCredentialProfiles((current) => [...current, profile]); setProviderCredentialProfileKey(`${profile.profile_id}:${profile.revision}`) }} />
              </Field> : null}
              {selectedResource?.kind === "MCP" ? <Field>
                <FieldLabel htmlFor="connection-mcp-namespace">{t("MCP tool namespace")}</FieldLabel>
                <Input id="connection-mcp-namespace" value={mcpToolNamespace} onChange={(event) => setMcpToolNamespace(event.target.value)} />
              </Field> : null}

            </> : null}
          </FieldGroup></CardContent>
        </Card>
      ) : null}

      {step === 1 ? (
        <Card>
          <CardHeader><CardTitle><TitleHelp help={t("Register the Connection against the selected Resource.")}>{t("Review")}</TitleHelp></CardTitle></CardHeader>
          <CardContent className="grid gap-6 md:grid-cols-2">
            <p className="text-sm text-muted-foreground md:col-span-2">{t("Save this Connection first. Test and enable it from its detail page; configure model mappings from the Resource.")}</p>
            {[
              [t("Connection"), [[t("Type"), catalogItem ? t(catalogItem.label) : ""], [t("Name"), displayName], [t("Endpoint"), connectorConfiguration ? connectorConfiguration.kind === "servicenow-csm" ? connectorConfiguration.instance_url : connectorConfiguration.imap_host : endpointUrl]]],
              [t("Resource"), [[t("Name"), selectedResource?.display_name ?? ""], [t("Kind"), selectedResource?.kind ?? ""], [t("Authentication"), connectorConfiguration ? t(connectorConfiguration.kind === "servicenow-csm" ? "User OAuth" : "Personal account") : selectedResource?.kind === "LLM" ? t(llmUpstreamAuthentication) : selectedResource?.kind === "MCP" ? t(mcpUpstreamAuthentication) : t("None")]]],
            ].map(([title, rows]) => (
              <div className="flex flex-col gap-3" key={title as string}>
                <h3 className="font-medium">{title as string}</h3>
                {(rows as string[][]).map(([label, value]) => (
                  <div className="flex justify-between gap-3 text-sm" key={label}>
                    <span className="text-muted-foreground">{label}</span>
                    <span className="max-w-52 truncate text-right font-medium" title={value}>{value}</span>
                  </div>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <FieldError>{error}</FieldError>
      <div className="flex justify-between border-t pt-5">
        <Button onClick={step === 0 ? onCancel : () => setStep((current) => current - 1)} type="button" variant="outline">{step === 0 ? t("Cancel") : t("Back")}</Button>
        <Button disabled={submitting || (step === 0 && (!catalogItem || !resourceId))} type="submit">
          {submitting ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}
          {step === 1 ? t("Register Connection") : t("Continue")}
        </Button>
      </div>
    </form>
  )
}
