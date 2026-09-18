import { useEffect, useMemo, useState, type FormEvent } from "react"
import { LoaderCircleIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { parse as parseYaml } from "yaml"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { GuidedSetupSteps, type GuidedSetupStep } from "@/components/guided-setup-steps"
import { PageHeader } from "@/components/page-header"
import { TitleHelp } from "@/components/title-help"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import type { ApiRequestParameterRule, BotPackageManifest, CreateResourceInput, OverviewSnapshot, ResourceKind } from "@/domain/contracts"
import { organizationAdministratorSubjectIds } from "@/domain/organization-roles"
import { createResource, importOpenApiResource } from "@/lib/product-api"
import { loadBrowserOidcConfiguration } from "@/lib/browser-oidc"
import {
  allowedAuthorizationAuthorities,
  allowedInboundAuthentications,
  coerceControlSelections,
  controlOptionFamily,
  inboundAuthenticationOptionLabel,
} from "@/features/resources/resource-control-options"

type WizardKind = Extract<ResourceKind, "API" | "MCP" | "LLM"> | "A2A" | "SITE" | "SKILL" | "PLUGIN" | "BOT"
type AccessAuthority = "ONE_POLICY" | "GATEWAY_NATIVE" | "UPSTREAM"
type InboundAuthentication = "PLATFORM_OAUTH" | "EXTERNAL_OAUTH" | "API_KEY" | "MTLS" | "GATEWAY_NATIVE"
type OpenApiSource = "UPLOAD" | "URL" | "PASTE"
type ExtensionSourceMode = "UPLOAD" | "GITHUB"
type NestedPackageRole = "PLUGIN" | "SKILL"
type PackageSourceRow = {
  id: string
  role: "ROOT" | NestedPackageRole
  repositoryUrl: string
  ref: string
  path: string
}

const botAvatarShapes = ["cercle", "galet", "squircle", "capsule", "triangle", "hexagone", "nuage", "goutte"] as const
const botAvatarColors = ["encre", "brun", "rouge", "orange", "ambre", "vert", "turquoise", "bleu", "violet", "rose", "gris", "creme"] as const
const botAvatarExpressions = ["neutre", "attentif", "surpris", "heureux", "curieux", "fier", "timide"] as const

function extensionPackageType(resource: { kind: string; extension_metadata?: { package_type?: string } | null }) {
  if (resource.kind !== "EXTENSION") return null
  const packageType = resource.extension_metadata?.package_type
  return packageType === "PLUGIN" || packageType === "SKILL" || packageType === "BOT" ? packageType : null
}

function emptyPackageSource(role: PackageSourceRow["role"] = "ROOT"): PackageSourceRow {
  return { id: crypto.randomUUID(), role, repositoryUrl: "", ref: "", path: "" }
}

const steps = ["Resource", "Controls", "Review"] as const

const resourceTypes: Array<{ value: WizardKind; label: string; description: string; connection: "later" | "none" }> = [
  { value: "LLM", label: "AI Service", description: "Governed model Resource. Register the Provider Connection after the Draft exists.", connection: "later" },
  { value: "MCP", label: "MCP Resource", description: "Governed MCP tools. Register the MCP Connection after the Draft exists.", connection: "later" },
  { value: "API", label: "API Product", description: "Governed API from an OpenAPI contract. Register the upstream Connection later.", connection: "later" },
  { value: "A2A", label: "A2A Agent", description: "Agent-to-agent Resource. Register the upstream Connection later.", connection: "later" },
  { value: "SITE", label: "Site", description: "Access Gateway destination. No upstream Connection.", connection: "none" },
  { value: "SKILL", label: "Agent Skill", description: "Runtime Skill. Bind MCP or LLM Resources. A Plugin or Bot can include many Skills.", connection: "none" },
  { value: "PLUGIN", label: "Plugin", description: "Runtime Plugin. Bind many Skills, plus MCP or LLM Resources.", connection: "none" },
  { value: "BOT", label: "Corp Bot package", description: "Corp Bot profile plus a 1:N hierarchy of Plugins and Skills. Bind MCP or LLM Resources as well.", connection: "none" },
]

const sampleOpenApi = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Internal Incident API", version: "1.0.0" },
  paths: {
    "/incidents": {
      get: {
        operationId: "incident.list",
        summary: "List incidents",
        parameters: [
          { name: "x-api-version", in: "header", schema: { type: "string" } },
          { name: "locale", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
  },
}, null, 2)

const sampleA2AOpenApi = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Agent task endpoint", version: "1.0.0" },
  paths: {
    "/message:send": {
      post: { operationId: "a2a.message.send", responses: { "200": { description: "ok" } } },
    },
  },
}, null, 2)

const gateways: Record<WizardKind, string> = {
  API: "API Gateway",
  A2A: "AI Gateway",
  LLM: "AI Gateway",
  MCP: "AI Gateway",
  SITE: "Access Gateway",
  SKILL: "Agent Runtime",
  PLUGIN: "Agent Runtime",
  BOT: "Agent Runtime",
}

function parseOpenApi(text: string): Record<string, unknown> {
  const parsed: unknown = parseYaml(text)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OpenAPI document must be an object")
  return parsed as Record<string, unknown>
}

async function sha256Digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

function countOperations(text: string) {
  try {
    const document = parseOpenApi(text)
    const paths = document.paths && typeof document.paths === "object" ? document.paths as Record<string, unknown> : {}
    const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"])
    return Object.values(paths).reduce<number>((count, path) => {
      if (!path || typeof path !== "object") return count
      return count + Object.keys(path).filter((method) => methods.has(method.toLowerCase())).length
    }, 0)
  } catch {
    return 0
  }
}

type ImportedApiOperation = {
  operationId: string
  method: string
  path: string
  parameters: Array<{ location: "HEADER" | "QUERY"; name: string }>
}

function importedApiOperations(text: string): ImportedApiOperation[] {
  try {
    const document = parseOpenApi(text)
    const paths = document.paths && typeof document.paths === "object"
      ? document.paths as Record<string, unknown>
      : {}
    const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"])
    const result: ImportedApiOperation[] = []
    for (const [path, pathValue] of Object.entries(paths)) {
      if (!pathValue || typeof pathValue !== "object" || Array.isArray(pathValue)) continue
      const pathItem = pathValue as Record<string, unknown>
      for (const [method, operationValue] of Object.entries(pathItem)) {
        if (!methods.has(method.toLowerCase()) || !operationValue || typeof operationValue !== "object" || Array.isArray(operationValue)) continue
        const operation = operationValue as Record<string, unknown>
        const declaredId = typeof operation.operationId === "string" ? operation.operationId.trim() : ""
        const parameters = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])]
          .flatMap((parameter): Array<{ location: "HEADER" | "QUERY"; name: string }> => {
            if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) return []
            const value = parameter as Record<string, unknown>
            const location = value.in === "header" ? "HEADER" : value.in === "query" ? "QUERY" : null
            return location && typeof value.name === "string" && value.name.trim()
              ? [{ location, name: value.name.trim() }]
              : []
          })
        result.push({
          operationId: declaredId || `${method.toUpperCase()} ${path}`,
          method: method.toUpperCase(),
          path,
          parameters,
        })
      }
    }
    return result.sort((left, right) => left.operationId.localeCompare(right.operationId))
  } catch {
    return []
  }
}

export function CreateResourceWizard({
  tenantId,
  organizations,
  resources = [],
  agents,
  onCancel,
  onCreated,
}: {
  tenantId: string
  connections?: OverviewSnapshot["connections"]
  resources?: OverviewSnapshot["resources"]
  organizations: OverviewSnapshot["organizations"]
  agents: NonNullable<OverviewSnapshot["identity"]>["subjects"]
  onCancel: () => void
  onCreated: (resourceId: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [step, setStep] = useState(0)
  const [kind, setKind] = useState<WizardKind>("LLM")
  const [destinationMatcher, setDestinationMatcher] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [environment] = useState("production")
  const [ownerOrganizationId, setOwnerOrganizationId] = useState(() => organizations[0]?.organization_id ?? "")
  const version = "v1"
  const [extensionSourceMode, setExtensionSourceMode] = useState<ExtensionSourceMode>("GITHUB")
  const [extensionFileName, setExtensionFileName] = useState("")
  const [packageSources, setPackageSources] = useState<PackageSourceRow[]>(() => [emptyPackageSource("ROOT")])
  const [botTitle, setBotTitle] = useState("")
  const [botDescription, setBotDescription] = useState("")
  const [avatarShape, setAvatarShape] = useState<(typeof botAvatarShapes)[number]>("cercle")
  const [avatarColor, setAvatarColor] = useState<(typeof botAvatarColors)[number]>("turquoise")
  const [avatarExpression, setAvatarExpression] = useState<(typeof botAvatarExpressions)[number]>("neutre")
  const [pluginResourceIds, setPluginResourceIds] = useState<string[]>([])
  const [skillResourceIds, setSkillResourceIds] = useState<string[]>([])
  const [bindingKeys, setBindingKeys] = useState<string[]>([])
  const [accessAuthority, setAccessAuthority] = useState<AccessAuthority>("ONE_POLICY")
  const [inboundAuthentication, setInboundAuthentication] = useState<InboundAuthentication>("PLATFORM_OAUTH")
  const [identityMapping, setIdentityMapping] = useState("")
  const [publicPath, setPublicPath] = useState("/internal-api")
  const [oauthIssuer, setOauthIssuer] = useState("")
  const [oauthAudience, setOauthAudience] = useState("")
  const [oauthJwksUrl, setOauthJwksUrl] = useState("")
  const [oauthScope, setOauthScope] = useState("genioone-invocation")
  const [documentText, setDocumentText] = useState(sampleOpenApi)
  const [openApiSource, setOpenApiSource] = useState<OpenApiSource>("UPLOAD")
  const [openApiUrl, setOpenApiUrl] = useState("")
  const [openApiFileName, setOpenApiFileName] = useState("")
  const [schemaValidation, setSchemaValidation] = useState(true)
  const [apiRequestRules, setApiRequestRules] = useState<ApiRequestParameterRule[]>([])
  const [targetAgentSubjectId, setTargetAgentSubjectId] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  const isExtension = kind === "SKILL" || kind === "PLUGIN" || kind === "BOT"
  const isAccessDestination = kind === "SITE"
  const isApi = kind === "API" || kind === "A2A"
  const controlFamily = controlOptionFamily(kind)
  const authorizationOptions = allowedAuthorizationAuthorities(controlFamily)
  const inboundOptions = allowedInboundAuthentications(controlFamily, accessAuthority)
  const selectedType = resourceTypes.find((candidate) => candidate.value === kind)
  const ownerOrganization = organizations.find((organization) => organization.organization_id === ownerOrganizationId)
  useEffect(() => {
    const next = coerceControlSelections(controlOptionFamily(kind), accessAuthority, inboundAuthentication)
    if (next.authority !== accessAuthority) setAccessAuthority(next.authority)
    if (next.inbound !== inboundAuthentication) setInboundAuthentication(next.inbound)
  }, [accessAuthority, inboundAuthentication, kind])

  const bindableResources = useMemo(() => resources.filter((resource) =>
    (resource.kind === "MCP" || resource.kind === "LLM") &&
    (resource.lifecycle === "PUBLISHED" || resource.lifecycle === "DRAFT"),
  ), [resources])
  const bindablePlugins = useMemo(() => resources.filter((resource) =>
    extensionPackageType(resource) === "PLUGIN" &&
    (resource.lifecycle === "PUBLISHED" || resource.lifecycle === "DRAFT"),
  ), [resources])
  const bindableSkills = useMemo(() => resources.filter((resource) =>
    extensionPackageType(resource) === "SKILL" &&
    (resource.lifecycle === "PUBLISHED" || resource.lifecycle === "DRAFT"),
  ), [resources])
  const ownerOrganizationOptions = useMemo(() => organizations.map((organization) => ({
    value: organization.organization_id,
    label: organization.display_name,
    description: organization.organization_id,
  })), [organizations])
  const importedOperations = useMemo(
    () => importedApiOperations(documentText),
    [documentText],
  )
  const apiOperationOptions = useMemo(() => [
    { value: "*", label: t("All operations") },
    ...importedOperations.map((operation) => ({
      value: operation.operationId,
      label: operation.operationId,
      description: `${operation.method} ${operation.path}`,
    })),
  ], [importedOperations, t])

  const guidedSteps: GuidedSetupStep[] = steps.map((label, index) => ({
    id: label,
    label: t(label),
    status: index < step ? "complete" : index === step ? "current" : "upcoming",
  }))
  const enforcementPointId = kind === "API" ? "genio-api-management" : kind === "SITE" ? "genio-access-gateway" : isExtension ? "genio-agent-runtime" : "genio-ai-mcp-gateway"
  const rootPackageSource = packageSources.find((source) => source.role === "ROOT") ?? packageSources[0]
  const extensionSourceSummary = extensionSourceMode === "UPLOAD"
    ? extensionFileName
    : packageSources.map((source) => [source.role === "ROOT" ? kind : source.role, source.repositoryUrl, source.ref, source.path].filter(Boolean).join(" · ")).join(" | ")
  function next() {
    setError("")
    setStep((current) => Math.min(current + 1, steps.length - 1))
  }

  function addApiRequestRule() {
    const operation = importedOperations[0]
    const parameter = operation?.parameters[0]
    setApiRequestRules((current) => [...current, {
      operation_id: operation?.operationId ?? null,
      location: parameter?.location ?? "HEADER",
      name: parameter?.name ?? "",
      action: "PASSTHROUGH",
      value: null,
    }])
  }

  function updateApiRequestRule(index: number, update: Partial<ApiRequestParameterRule>) {
    setApiRequestRules((current) => current.map((rule, position) =>
      position === index ? { ...rule, ...update } : rule))
  }

  function parameterOptionsFor(rule: ApiRequestParameterRule) {
    const operations = rule.operation_id === null
      ? importedOperations
      : importedOperations.filter((operation) => operation.operationId === rule.operation_id)
    return [...new Set(operations.flatMap((operation) => operation.parameters)
      .filter((parameter) => parameter.location === rule.location)
      .map((parameter) => parameter.name))]
      .sort()
      .map((name) => ({ value: name, label: name }))
  }

  function validateDraft() {
    const missing: string[] = []
    if (!displayName.trim()) missing.push(t("Display name"))
    if (!ownerOrganizationId) missing.push(t("Owner Organization"))
    if (isExtension) {
      if (extensionSourceMode === "UPLOAD" && !extensionFileName) missing.push(t("Extension package"))
      if (kind === "BOT" && !botDescription.trim()) missing.push(t("Work description"))
      if (extensionSourceMode === "GITHUB") {
        if (packageSources.some((source) => !source.repositoryUrl.trim())) missing.push(t("GitHub repository"))
        if (packageSources.some((source) => !source.ref.trim())) missing.push(t("Git ref"))
      }
    } else if (isAccessDestination) {
      if (!destinationMatcher.trim()) missing.push(t("Destination matcher"))
    }
    if (!isExtension && inboundAuthentication === "EXTERNAL_OAUTH") {
      if (!oauthIssuer.trim()) missing.push(t("Issuer"))
      if (!oauthAudience.trim()) missing.push(t("Audience"))
      if (!oauthJwksUrl.trim()) missing.push(t("JWKS URL"))
    }
    if (isApi) {
      if (openApiSource === "UPLOAD" && !openApiFileName) missing.push(t("OpenAPI file"))
      if (openApiSource === "URL" && !openApiUrl.trim()) missing.push(t("OpenAPI URL"))
      if (openApiSource === "PASTE" && !documentText.trim()) missing.push(t("OpenAPI document"))
      if (!publicPath.trim()) missing.push(t("Gateway public path"))
      if (apiRequestRules.some((rule) => !rule.name.trim())) missing.push(t("Upstream parameter"))
      if (apiRequestRules.some((rule) => rule.action === "SET" && !rule.value?.trim())) missing.push(t("Override value"))
      if (kind === "A2A" && !targetAgentSubjectId) missing.push(t("Target Agent"))
    }
    return missing
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (step < steps.length - 1) {
      next()
      return
    }
    const missing = validateDraft()
    if (missing.length) {
      setError(t("Complete required fields: {{fields}}", { fields: missing.join(", ") }))
      return
    }
    setSubmitting(true)
    setError("")
    try {
      let resourceId = `resource-${crypto.randomUUID()}`
      if (isApi) {
        const platformOidc = inboundAuthentication === "PLATFORM_OAUTH"
          ? await loadBrowserOidcConfiguration()
          : null
        const effectiveIssuer = (platformOidc?.issuer ?? oauthIssuer).replace(/\/$/, "")
        const sourceText = openApiSource === "URL"
          ? await fetch(openApiUrl).then((response) => {
              if (!response.ok) throw new Error(t("OpenAPI URL could not be loaded"))
              return response.text()
            })
          : documentText
        const parsed = parseOpenApi(sourceText)
        const info = typeof parsed.info === "object" && parsed.info ? parsed.info as Record<string, unknown> : {}
        parsed.info = { ...info, title: displayName, version }
        const createdResource = await importOpenApiResource(tenantId, {
          resourceId,
          authenticationStrategy: inboundAuthentication === "API_KEY" ? "API_KEY" : inboundAuthentication === "MTLS" ? "MTLS" : inboundAuthentication === "GATEWAY_NATIVE" ? "NONE" : "OAUTH",
          environmentId: environment,
          version,
          apiProductId: `api-product-${crypto.randomUUID()}`,
          publicPath,
          inboundSecurity: inboundAuthentication === "API_KEY" ? "API_KEY" : inboundAuthentication === "GATEWAY_NATIVE" ? "KEYLESS" : "OAUTH2",
          oauthIssuer: effectiveIssuer,
          oauthAudience: platformOidc ? "genio-one-product-api" : oauthAudience,
          oauthJwksUrl: platformOidc
            ? `${effectiveIssuer}/protocol/openid-connect/certs`
            : oauthJwksUrl,
          oauthScope,
          requestSchemaValidation: schemaValidation,
          enforcementPointId,
          ownerOrganizationId: ownerOrganizationId,
          document: parsed,
          ...(kind === "A2A" ? { a2a: { protocol_version: "1.0", operation: "SEND_MESSAGE", target_agent_subject_id: targetAgentSubjectId } as const } : {}),
        })
        resourceId = createdResource.resource_id
      } else {
        const resourceKind: ResourceKind = kind === "SITE" ? "SAAS" : kind === "SKILL" || kind === "PLUGIN" || kind === "BOT" ? "EXTENSION" : kind
        const resourceBindings = bindingKeys.flatMap((key) => {
          const [resourceId, capabilityId] = key.split("::")
          return resourceId && capabilityId ? [{ resource_id: resourceId, capability_id: capabilityId }] : []
        })
        const nestedGithubSkills = packageSources.filter((source) => source.role === "SKILL").map((source) => ({
          id: source.path.trim() || source.repositoryUrl.trim(),
          path: [source.repositoryUrl.trim(), source.ref.trim(), source.path.trim()].filter(Boolean).join("#"),
        }))
        const nestedGithubPlugins = packageSources.filter((source) => source.role === "PLUGIN").map((source) => ({
          name: source.path.trim() || source.repositoryUrl.trim(),
          marketplace: source.repositoryUrl.trim(),
        }))
        const extensionMetadata: BotPackageManifest | undefined = isExtension ? {
          package_type: kind === "PLUGIN" ? "PLUGIN" : kind === "SKILL" ? "SKILL" : "BOT",
          version,
          profile: {
            title: (kind === "BOT" ? botTitle.trim() : "") || displayName.trim(),
            description: botDescription.trim() || displayName.trim(),
            avatar: { shape: avatarShape, color: avatarColor, expression: avatarExpression },
          },
          skills: [
            ...skillResourceIds.map((resourceId) => ({ id: resourceId, path: `resource:${resourceId}` })),
            ...nestedGithubSkills,
          ],
          plugins: [
            ...pluginResourceIds.map((resourceId) => ({ name: resourceId, marketplace: `resource:${resourceId}` })),
            ...nestedGithubPlugins,
          ],
          resource_bindings: resourceBindings,
          default_runtime_tier: "none",
          manifest_digest: await sha256Digest(JSON.stringify({ displayName, botTitle, botDescription, avatarShape, avatarColor, avatarExpression, extensionSourceSummary, resourceBindings, pluginResourceIds, skillResourceIds })),
          artifact_digest: await sha256Digest(extensionSourceSummary || displayName.trim()),
          source: {
            kind: extensionSourceMode,
            ref: extensionSourceMode === "GITHUB"
              ? (rootPackageSource?.ref.trim() || displayName.trim())
              : (extensionSourceSummary || displayName.trim()),
            ...(rootPackageSource?.path.trim() ? { path: rootPackageSource.path.trim() } : {}),
          },
        } : undefined
        const input: CreateResourceInput = {
          displayName,
          kind: resourceKind,
          capabilityId: kind === "LLM" ? "model.invoke" : kind === "MCP" ? "mcp.invoke" : kind === "SKILL" ? "skill.execute" : kind === "PLUGIN" ? "plugin.execute" : kind === "BOT" ? "bot.invoke" : "site.access",
          capabilityName: kind === "LLM" ? "Invoke model" : kind === "MCP" ? "Invoke MCP tools" : kind === "SKILL" ? "Execute skill" : kind === "PLUGIN" ? "Execute plugin" : kind === "BOT" ? "Invoke Bot" : "Access site",
          environmentId: environment,
          version,
          authenticationStrategy: inboundAuthentication === "API_KEY" ? "API_KEY" : inboundAuthentication === "MTLS" ? "MTLS" : inboundAuthentication === "GATEWAY_NATIVE" ? "NONE" : "OAUTH",
          enforcementPointId,
          ownerOrganizationId: ownerOrganizationId,
          ...(extensionMetadata ? { extensionMetadata } : {}),
        }
        const createdResource = await createResource(tenantId, input)
        resourceId = createdResource.resource_id
      }
      await onCreated(resourceId)
      onCancel()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Resource creation failed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="flex flex-col gap-6" data-testid="resource-onboarding-wizard" onSubmit={submit}>
      <div className="flex flex-col gap-5 border-b pb-6">
        <PageHeader
          backLabel={t("Back to Resources")}
          description={t("Create a Resource Draft. Connections are registered later only for types that talk to an upstream.")}
          onBack={onCancel}
          title={t("Add resource")}
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
          testId="resource-onboarding-steps"
        />
      </div>

      {step === 0 ? (
        <Card>
          <CardHeader><CardTitle><TitleHelp help={t("Name the governed Resource and choose its type.")}>{t("Resource")}</TitleHelp></CardTitle></CardHeader>
          <CardContent><FieldGroup>
            <Field>
              <FieldLabel htmlFor="resource-name">{t("Display name")}</FieldLabel>
              <Input id="resource-name" onChange={(event) => setDisplayName(event.target.value)} value={displayName} />
            </Field>
            <Field>
              <FieldLabel>{t("Resource type")}</FieldLabel>
              <Select value={kind} onValueChange={(value) => {
                const next = value as WizardKind
                setKind(next)
                if (next === "A2A") { setDocumentText(sampleA2AOpenApi); setOpenApiSource("PASTE"); setPublicPath("/a2a") }
                if (next === "API") { setDocumentText(sampleOpenApi); setPublicPath("/internal-api") }
              }}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>
                  {resourceTypes.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{t(option.label)}</SelectItem>
                  ))}
                </SelectGroup></SelectContent>
              </Select>
              <FieldDescription>{t(selectedType?.description ?? "Governed model Resource. Register the Provider Connection after the Draft exists.")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>{t("Owner Organization")}</FieldLabel>
              <SearchableSelect
                value={ownerOrganizationId}
                options={ownerOrganizationOptions}
                onValueChange={setOwnerOrganizationId}
                placeholder={t("Select an Owner Organization")}
                searchPlaceholder={t("Search Owner Organizations")}
                emptyLabel={t("No Owner Organizations found.")}
              />
              <FieldDescription>{ownerOrganization ? t("{{count}} organization administrator(s)", {
                count: organizationAdministratorSubjectIds(ownerOrganization).length,
              }) : t("Create an Organization before registering a Resource.")}</FieldDescription>
            </Field>
            {isApi ? <div className="flex flex-col gap-5 rounded-lg border p-5">
              <div><h3 className="font-medium"><TitleHelp help={t("Operations in the contract become governed Resource Capabilities.")}>{t("Import OpenAPI / Swagger")}</TitleHelp></h3></div>
              <Field><FieldLabel>{t("Import source")}</FieldLabel><Select value={openApiSource} onValueChange={(value) => setOpenApiSource(value as OpenApiSource)}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="UPLOAD">{t("Upload JSON or YAML")}</SelectItem><SelectItem value="URL">{t("OpenAPI URL")}</SelectItem><SelectItem value="PASTE">{t("Paste document")}</SelectItem></SelectGroup></SelectContent></Select></Field>
              {openApiSource === "UPLOAD" ? <Field><FieldLabel htmlFor="openapi-file">{t("OpenAPI file")}</FieldLabel><Input accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml" id="openapi-file" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; setOpenApiFileName(file.name); void file.text().then(setDocumentText) }} type="file" /><FieldDescription>{openApiFileName || t("JSON, YAML, OpenAPI 3.x, or Swagger 2.0")}</FieldDescription></Field> : null}
              {openApiSource === "URL" ? <Field><FieldLabel htmlFor="openapi-url">{t("OpenAPI URL")}</FieldLabel><Input id="openapi-url" onChange={(event) => setOpenApiUrl(event.target.value)} placeholder={t("OpenAPI URL example")} type="url" value={openApiUrl} /></Field> : null}
              {openApiSource === "PASTE" ? <Field><FieldLabel htmlFor="openapi-document">{t("OpenAPI document")}</FieldLabel><Textarea className="min-h-72 font-mono text-xs" id="openapi-document" onChange={(event) => setDocumentText(event.target.value)} value={documentText} /></Field> : null}
              <div className="grid gap-5 md:grid-cols-2"><Field><FieldLabel htmlFor="public-path">{t("Gateway public path")}</FieldLabel><Input id="public-path" onChange={(event) => setPublicPath(event.target.value)} value={publicPath} /></Field><div className="rounded-lg bg-muted p-4"><div className="text-2xl font-semibold tabular-nums">{countOperations(documentText)}</div><div className="text-sm text-muted-foreground">{t("Operations detected")}</div></div></div>
              {kind === "A2A" ? <Field><FieldLabel>{t("Target Agent")}</FieldLabel><SearchableSelect value={targetAgentSubjectId} options={agents.filter((subject) => subject.kind === "AGENT").map((subject) => ({ value: subject.subject_id, label: subject.profile.display_name ?? subject.subject_id }))} onValueChange={setTargetAgentSubjectId} placeholder={t("Select Agent")} searchPlaceholder={t("Search Agents")} emptyLabel={t("No Agents found.")} /><FieldDescription>{t("The target Agent is frozen into the signed Release; task metadata cannot replace it.")}</FieldDescription></Field> : null}
            </div> : null}
            {isAccessDestination ? <Field><FieldLabel htmlFor="destination-matcher">{t("Destination matcher")}</FieldLabel><Input id="destination-matcher" onChange={(event) => setDestinationMatcher(event.target.value)} placeholder={t("Domain or URL pattern")} value={destinationMatcher} /><FieldDescription>{t("Access Gateway matches this destination without creating an upstream Connection.")}</FieldDescription></Field> : null}
            {isExtension ? <>
              {kind === "BOT" ? <>
                <Field>
                  <FieldLabel htmlFor="bot-title">{t("Title / job")}</FieldLabel>
                  <Input id="bot-title" onChange={(event) => setBotTitle(event.target.value)} placeholder={t("Title / job example")} value={botTitle} />
                  <FieldDescription>{t("Same as Genio Bot title: the Bot's standing job, not the package file name.")}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="bot-description">{t("Work description")}</FieldLabel>
                  <Textarea id="bot-description" onChange={(event) => setBotDescription(event.target.value)} placeholder={t("Work description example")} value={botDescription} />
                  <FieldDescription>{t("Standing rules and anti-jobs. Matches the Genio Bot profile description.")}</FieldDescription>
                </Field>
                <div className="grid gap-5 md:grid-cols-3">
                  <Field>
                    <FieldLabel>{t("Avatar shape")}</FieldLabel>
                    <Select value={avatarShape} onValueChange={(value) => setAvatarShape(value as typeof avatarShape)}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectGroup>{botAvatarShapes.map((value) => <SelectItem key={value} value={value}>{t(value)}</SelectItem>)}</SelectGroup></SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel>{t("Avatar color")}</FieldLabel>
                    <Select value={avatarColor} onValueChange={(value) => setAvatarColor(value as typeof avatarColor)}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectGroup>{botAvatarColors.map((value) => <SelectItem key={value} value={value}>{t(value)}</SelectItem>)}</SelectGroup></SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel>{t("Avatar expression")}</FieldLabel>
                    <Select value={avatarExpression} onValueChange={(value) => setAvatarExpression(value as typeof avatarExpression)}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectGroup>{botAvatarExpressions.map((value) => <SelectItem key={value} value={value}>{t(value)}</SelectItem>)}</SelectGroup></SelectContent>
                    </Select>
                  </Field>
                </div>
                <FieldDescription>{t("Avatar uses the same shape, color, and expression identifiers as Genio Bot.")}</FieldDescription>
              </> : <Field>
                <FieldLabel htmlFor="package-description">{t("Package description")}</FieldLabel>
                <Textarea id="package-description" onChange={(event) => setBotDescription(event.target.value)} value={botDescription} />
              </Field>}
              {kind === "BOT" ? (
                <Field>
                  <FieldLabel>{t("Bound Plugins")}</FieldLabel>
                  <SearchableSelect
                    value=""
                    options={bindablePlugins.filter((resource) => !pluginResourceIds.includes(resource.resource_id)).map((resource) => ({
                      value: resource.resource_id,
                      label: resource.display_name,
                      description: `${resource.version} · ${resource.lifecycle}`,
                      searchText: `${resource.display_name} ${resource.resource_id}`,
                    }))}
                    onValueChange={(value) => { if (value) setPluginResourceIds((current) => current.includes(value) ? current : [...current, value]) }}
                    placeholder={t("Search Plugin Resources")}
                    searchPlaceholder={t("Search Plugin Resources")}
                    emptyLabel={t("No Plugin Resources found. Create a Plugin first.")}
                  />
                  <FieldDescription>{t("A Bot includes many Plugins. Create those Plugin Resources first, then bind them here.")}</FieldDescription>
                  {pluginResourceIds.map((resourceId) => {
                    const bound = resources.find((resource) => resource.resource_id === resourceId)
                    return (
                      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm" key={resourceId}>
                        <span>{bound?.display_name ?? resourceId}</span>
                        <Button onClick={() => setPluginResourceIds((current) => current.filter((candidate) => candidate !== resourceId))} size="sm" type="button" variant="ghost">{t("Remove")}</Button>
                      </div>
                    )
                  })}
                </Field>
              ) : null}
              {kind === "BOT" || kind === "PLUGIN" ? (
                <Field>
                  <FieldLabel>{t("Bound Skills")}</FieldLabel>
                  <SearchableSelect
                    value=""
                    options={bindableSkills.filter((resource) => !skillResourceIds.includes(resource.resource_id)).map((resource) => ({
                      value: resource.resource_id,
                      label: resource.display_name,
                      description: `${resource.version} · ${resource.lifecycle}`,
                      searchText: `${resource.display_name} ${resource.resource_id}`,
                    }))}
                    onValueChange={(value) => { if (value) setSkillResourceIds((current) => current.includes(value) ? current : [...current, value]) }}
                    placeholder={t("Search Skill Resources")}
                    searchPlaceholder={t("Search Skill Resources")}
                    emptyLabel={t("No Skill Resources found. Create a Skill first.")}
                  />
                  <FieldDescription>{t(kind === "PLUGIN" ? "A Plugin includes many Skills." : "A Bot can also include Skills directly, besides Skills nested under its Plugins.")}</FieldDescription>
                  {skillResourceIds.map((resourceId) => {
                    const bound = resources.find((resource) => resource.resource_id === resourceId)
                    return (
                      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm" key={resourceId}>
                        <span>{bound?.display_name ?? resourceId}</span>
                        <Button onClick={() => setSkillResourceIds((current) => current.filter((candidate) => candidate !== resourceId))} size="sm" type="button" variant="ghost">{t("Remove")}</Button>
                      </div>
                    )
                  })}
                </Field>
              ) : null}
              <Field>
                <FieldLabel>{t("Bound MCP and LLM Resources")}</FieldLabel>
                <SearchableSelect
                  value=""
                  options={bindableResources.flatMap((resource) => resource.capabilities.map((capability) => ({
                    value: `${resource.resource_id}::${capability.capability_id}`,
                    label: `${resource.display_name} · ${capability.display_name}`,
                    description: `${resource.kind} · ${resource.lifecycle}`,
                    searchText: `${resource.display_name} ${resource.resource_id} ${capability.capability_id}`,
                  }))).filter((option) => !bindingKeys.includes(option.value))}
                  onValueChange={(value) => {
                    if (value) setBindingKeys((current) => current.includes(value) ? current : [...current, value])
                  }}
                  placeholder={t("Search published MCP or LLM Resources")}
                  searchPlaceholder={t("Search published MCP or LLM Resources")}
                  emptyLabel={t("No published MCP or LLM Resources found. Create that Resource first.")}
                />
                <FieldDescription>{t("Bind an existing governed Resource. Do not register a new MCP Connection on this package.")}</FieldDescription>
                {bindingKeys.length ? <div className="flex flex-col gap-2">
                  {bindingKeys.map((key) => {
                    const [resourceId, capabilityId] = key.split("::")
                    const bound = resources.find((resource) => resource.resource_id === resourceId)
                    return (
                      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm" key={key}>
                        <span>{bound?.display_name ?? resourceId} · {capabilityId}</span>
                        <Button onClick={() => setBindingKeys((current) => current.filter((candidate) => candidate !== key))} size="sm" type="button" variant="ghost">{t("Remove")}</Button>
                      </div>
                    )
                  })}
                </div> : null}
              </Field>
              <Field>
                <FieldLabel>{t("Package sources")}</FieldLabel>
                <Tabs onValueChange={(value) => setExtensionSourceMode(value as ExtensionSourceMode)} value={extensionSourceMode}>
                  <TabsList>
                    <TabsTrigger value="GITHUB">{t("GitHub repository")}</TabsTrigger>
                    <TabsTrigger value="UPLOAD">{t("Upload package")}</TabsTrigger>
                  </TabsList>
                  <TabsContent value="GITHUB">
                    <FieldGroup>
                      {packageSources.map((source) => (
                        <div className="grid gap-3 rounded-lg border p-3" key={source.id}>
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-sm font-medium">{t(source.role === "ROOT" ? "This package" : source.role === "PLUGIN" ? "Plugin source" : "Skill source")}</div>
                            {source.role !== "ROOT" ? <Button onClick={() => setPackageSources((current) => current.filter((candidate) => candidate.id !== source.id))} size="sm" type="button" variant="ghost">{t("Remove")}</Button> : null}
                          </div>
                          {source.role !== "ROOT" ? (
                            <Field>
                              <FieldLabel>{t("Package role")}</FieldLabel>
                              <Select value={source.role} onValueChange={(value) => setPackageSources((current) => current.map((candidate) => candidate.id === source.id ? { ...candidate, role: value as NestedPackageRole } : candidate))}>
                                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent><SelectGroup>
                                  {kind === "BOT" ? <SelectItem value="PLUGIN">{t("Plugin")}</SelectItem> : null}
                                  <SelectItem value="SKILL">{t("Agent Skill")}</SelectItem>
                                </SelectGroup></SelectContent>
                              </Select>
                            </Field>
                          ) : null}
                          <Field>
                            <FieldLabel htmlFor={`extension-repository-${source.id}`}>{t("GitHub repository")}</FieldLabel>
                            <Input id={`extension-repository-${source.id}`} onChange={(event) => setPackageSources((current) => current.map((candidate) => candidate.id === source.id ? { ...candidate, repositoryUrl: event.target.value } : candidate))} placeholder={t("GitHub repository example")} type="url" value={source.repositoryUrl} />
                          </Field>
                          <FieldGroup className="grid gap-5 md:grid-cols-2">
                            <Field>
                              <FieldLabel htmlFor={`extension-ref-${source.id}`}>{t("Git ref")}</FieldLabel>
                              <Input id={`extension-ref-${source.id}`} onChange={(event) => setPackageSources((current) => current.map((candidate) => candidate.id === source.id ? { ...candidate, ref: event.target.value } : candidate))} placeholder={t("Tag or commit SHA")} value={source.ref} />
                              <FieldDescription>{t("A tag or commit keeps the installable revision reproducible.")}</FieldDescription>
                            </Field>
                            <Field>
                              <FieldLabel htmlFor={`extension-path-${source.id}`}>{t("Package directory")}</FieldLabel>
                              <Input id={`extension-path-${source.id}`} onChange={(event) => setPackageSources((current) => current.map((candidate) => candidate.id === source.id ? { ...candidate, path: event.target.value } : candidate))} placeholder={t("Package directory example")} value={source.path} />
                              <FieldDescription>{t("Optional path inside a monorepo.")}</FieldDescription>
                            </Field>
                          </FieldGroup>
                        </div>
                      ))}
                      {kind !== "SKILL" ? (
                        <Button
                          onClick={() => setPackageSources((current) => [...current, emptyPackageSource(kind === "PLUGIN" ? "SKILL" : "PLUGIN")])}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <PlusIcon />
                          {t("Add package source")}
                        </Button>
                      ) : null}
                    </FieldGroup>
                  </TabsContent>
                  <TabsContent value="UPLOAD">
                    <Field><FieldLabel htmlFor="extension-file">{t("Extension package")}</FieldLabel><Input accept=".zip,.tar,.tar.gz,.tgz,application/zip,application/gzip" id="extension-file" onChange={(event) => setExtensionFileName(event.target.files?.[0]?.name ?? "")} type="file" /><FieldDescription>{extensionFileName || t("ZIP or tar.gz package")}</FieldDescription></Field>
                  </TabsContent>
                </Tabs>
                <FieldDescription>{t("The root package can include additional GitHub sources for nested Plugins and Skills. Bind existing Resources when those packages are already registered.")}</FieldDescription>
              </Field>
            </> : null}
          </FieldGroup></CardContent>
        </Card>
      ) : null}

      {step === 1 ? (
        <div className="grid gap-5 xl:grid-cols-2">
          <Card>
            <CardHeader><CardTitle><TitleHelp help={t("Configure credential verification and authorization separately.")}>{t("Access control")}</TitleHelp></CardTitle></CardHeader>
            <CardContent><FieldGroup>
              {isExtension ? <><Field><FieldLabel>{t("Execution authorization")}</FieldLabel><Input readOnly value={t("One Policy")} /><FieldDescription>{t("One Policy decides which Identity may install or execute this Extension.")}</FieldDescription></Field><Field><FieldLabel>{t("Package validation")}</FieldLabel><Input readOnly value={t("Required before publish")} /><FieldDescription>{t("The imported source is scanned, validated, and resolved into an immutable installable revision.")}</FieldDescription></Field></> : <>
              <Field><FieldLabel>{t("Authorization authority")}</FieldLabel><Select value={accessAuthority} onValueChange={(value) => setAccessAuthority(value as AccessAuthority)}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{authorizationOptions.map((value) => <SelectItem key={value} value={value}>{t(value === "ONE_POLICY" ? "One Policy" : value === "GATEWAY_NATIVE" ? "Gateway native policy" : "Upstream authorization")}</SelectItem>)}</SelectGroup></SelectContent></Select><FieldDescription>{t("Authorization decides whether the verified identity may use this Resource capability.")}</FieldDescription></Field>
              {inboundOptions.length ? <Field><FieldLabel>{t(controlFamily === "AI" ? "One Policy login" : "Inbound authentication")}</FieldLabel><Select value={inboundAuthentication} onValueChange={(value) => setInboundAuthentication(value as InboundAuthentication)}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{inboundOptions.map((value) => <SelectItem key={value} value={value}>{t(inboundAuthenticationOptionLabel(value, controlFamily))}</SelectItem>)}</SelectGroup></SelectContent></Select><FieldDescription>{t(controlFamily === "AI" ? "One Policy login is API key, OS, or pass through." : "Authentication verifies the credential and produces an identity context.")}</FieldDescription></Field> : null}
              {inboundAuthentication === "EXTERNAL_OAUTH" && inboundOptions.includes("EXTERNAL_OAUTH") ? <FieldGroup><Field><FieldLabel htmlFor="oauth-issuer">{t("Issuer")}</FieldLabel><Input id="oauth-issuer" onChange={(event) => setOauthIssuer(event.target.value)} value={oauthIssuer} /></Field><Field><FieldLabel htmlFor="oauth-audience">{t("Audience")}</FieldLabel><Input id="oauth-audience" onChange={(event) => setOauthAudience(event.target.value)} value={oauthAudience} /></Field><Field><FieldLabel htmlFor="oauth-jwks">{t("JWKS URL")}</FieldLabel><Input id="oauth-jwks" onChange={(event) => setOauthJwksUrl(event.target.value)} type="url" value={oauthJwksUrl} /></Field><Field><FieldLabel htmlFor="oauth-scope">{t("Scope")}</FieldLabel><Input id="oauth-scope" onChange={(event) => setOauthScope(event.target.value)} value={oauthScope} /></Field></FieldGroup> : null}
              {inboundAuthentication === "API_KEY" && inboundOptions.includes("API_KEY") ? <Field><FieldLabel htmlFor="identity-mapping">{t("Identity mapping")}</FieldLabel><Input id="identity-mapping" onChange={(event) => setIdentityMapping(event.target.value)} placeholder={t("Workload Identity or mapping rule")} value={identityMapping} /><FieldDescription>{t("The Gateway validates the key; One Policy receives the mapped identity, not the secret.")}</FieldDescription></Field> : null}
              </>}
            </FieldGroup></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle><TitleHelp help={isExtension ? t("Runtime installation and execution controls.") : t("Reserve ordered processing stages around authentication, authorization, and upstream invocation.")}>{isExtension ? t("Runtime processing") : t("Processing workflow")}</TitleHelp></CardTitle></CardHeader>
            <CardContent><FieldGroup>
              {!isExtension ? <>
                <div className="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-2 text-center text-xs md:grid-cols-[repeat(6,minmax(0,1fr))]">
                  {["Authentication stage", "Pre-policy", "Authorization", "Request processing stage", "Upstream", "Response"].map((stage) => <div className="rounded-md border bg-muted/30 px-2 py-3 font-medium" key={stage}>{t(stage)}</div>)}
                </div>
                <Field><FieldLabel>{t("Standard gateway workflow")}</FieldLabel><FieldDescription>{t("Configure processing rules in One Policy after creating the Resource.")}</FieldDescription></Field>
              </> : null}
              {isApi ? <>
                <Field><FieldLabel>{t("Request schema validation")}</FieldLabel><Select value={schemaValidation ? "ENABLED" : "DISABLED"} onValueChange={(value) => setSchemaValidation(value === "ENABLED")}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="ENABLED">{t("Enabled")}</SelectItem><SelectItem value="DISABLED">{t("Disabled")}</SelectItem></SelectGroup></SelectContent></Select></Field>
                <div className="flex items-center justify-between gap-3">
                  <div><div className="text-sm font-medium">{t("Upstream request mapping")}</div><div className="text-xs text-muted-foreground">{t("Unspecified headers and query parameters pass through. Rules can preserve, override, or remove individual values.")}</div></div>
                  <Button onClick={addApiRequestRule} size="sm" type="button" variant="outline"><PlusIcon />{t("Add rule")}</Button>
                </div>
                {apiRequestRules.map((rule, index) => <div className="grid gap-3 rounded-lg border p-3" key={`${index}-${rule.operation_id}-${rule.location}-${rule.name}`}>
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field><FieldLabel>{t("Operation")}</FieldLabel><SearchableSelect value={rule.operation_id ?? "*"} options={apiOperationOptions} onValueChange={(value) => updateApiRequestRule(index, { operation_id: value === "*" ? null : value, name: "" })} placeholder={t("Select operation")} searchPlaceholder={t("Search operations")} emptyLabel={t("No operations found.")} /></Field>
                    <Field><FieldLabel>{t("Location")}</FieldLabel><Select value={rule.location} onValueChange={(value) => updateApiRequestRule(index, { location: value as "HEADER" | "QUERY", name: "" })}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="HEADER">{t("Header")}</SelectItem><SelectItem value="QUERY">{t("Query parameter")}</SelectItem></SelectGroup></SelectContent></Select></Field>
                  </div>
                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                    <Field>
                      <FieldLabel>{t("Upstream parameter")}</FieldLabel>
                      <SearchableSelect value={rule.name} options={parameterOptionsFor(rule)} onValueChange={(value) => updateApiRequestRule(index, { name: value })} placeholder={t("Select parameter")} searchPlaceholder={t("Search parameters")} emptyLabel={t("No parameters found in the OpenAPI document.")} />
                      <Input aria-label={t("Provider-specific parameter")} onChange={(event) => updateApiRequestRule(index, { name: event.target.value })} placeholder={t("Provider-specific parameter")} value={rule.name} />
                      <FieldDescription>{t("Select a declared parameter or enter a provider-specific header or query parameter.")}</FieldDescription>
                    </Field>
                    <Field><FieldLabel>{t("Action")}</FieldLabel><Select value={rule.action} onValueChange={(value) => updateApiRequestRule(index, { action: value as ApiRequestParameterRule["action"], value: value === "SET" ? rule.value : null })}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="PASSTHROUGH">{t("Pass through")}</SelectItem><SelectItem value="SET">{t("Override")}</SelectItem><SelectItem value="REMOVE">{t("Remove")}</SelectItem></SelectGroup></SelectContent></Select></Field>
                    <Button aria-label={t("Remove rule")} className="self-end" onClick={() => setApiRequestRules((current) => current.filter((_, position) => position !== index))} size="icon" type="button" variant="ghost"><Trash2Icon /></Button>
                  </div>
                  {rule.action === "SET" ? <Field><FieldLabel>{t("Override value")}</FieldLabel><Input onChange={(event) => updateApiRequestRule(index, { value: event.target.value })} value={rule.value ?? ""} /></Field> : null}
                </div>)}
                <div className="grid gap-3 text-sm"><div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Imported operations")}</span><span className="font-medium tabular-nums">{countOperations(documentText)}</span></div><div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Gateway public path")}</span><span className="font-medium">{publicPath}</span></div></div>
              </> : <div className="grid gap-3 text-sm"><div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Gateway")}</span><span className="font-medium">{t(gateways[kind])}</span></div><div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Capability")}</span><span className="font-medium">{kind === "LLM" ? "model.invoke" : kind === "MCP" ? "mcp.invoke" : kind === "SKILL" ? "skill.execute" : kind === "PLUGIN" ? "plugin.execute" : kind === "BOT" ? "bot.invoke" : "site.access"}</span></div></div>}
            </FieldGroup></CardContent>
          </Card>
        </div>
      ) : null}

      {step === 2 ? (
        <Card>
          <CardHeader><CardTitle><TitleHelp help={t("Save the Resource configuration as Draft. Publishing is a separate action.")}>{t("Review Draft")}</TitleHelp></CardTitle></CardHeader>
          <CardContent className="grid gap-6 md:grid-cols-3">
            {[
              [t("Resource"), [[t("Name"), displayName], [t("Type"), kind], [t("Version"), version], ...(kind === "BOT" ? [[t("Title / job"), botTitle || displayName], [t("Work description"), botDescription]] : []), [t("Owner Organization"), ownerOrganization?.display_name ?? ownerOrganizationId], [t("Gateway"), t(gateways[kind])]]],
              [t("Source"), isExtension ? [[t("Source type"), t(extensionSourceMode === "GITHUB" ? "GitHub repository" : "Upload package")], [t("Package sources"), t("{{count}} sources", { count: extensionSourceMode === "GITHUB" ? packageSources.length : 1 })], [t("Bound Plugins"), String(pluginResourceIds.length)], [t("Bound Skills"), String(skillResourceIds.length)], [t("Bound MCP and LLM Resources"), String(bindingKeys.length)], [t("Runtime"), t("Agent Runtime")]] : isAccessDestination ? [[t("Destination matcher"), destinationMatcher], [t("Gateway"), t("Access Gateway")]] : [[t("Connection"), selectedType?.connection === "later" ? t("Register later") : t("Not required")], [t("Gateway"), t(gateways[kind])]]],
              [t("Controls"), isExtension ? [[t("Execution authorization"), t("One Policy")], [t("Package validation"), t("Required before publish")], [t("Draft access"), t("Owner Organization testing")], [t("State"), t("Draft")]] : [[t("Authorization authority"), t(accessAuthority === "ONE_POLICY" ? "One Policy" : accessAuthority === "GATEWAY_NATIVE" ? "Gateway native policy" : "Upstream authorization")], ...(inboundOptions.length ? [[t(controlFamily === "AI" ? "One Policy login" : "Inbound authentication"), t(inboundAuthenticationOptionLabel(inboundAuthentication, controlFamily))]] : []), [t("Workflow"), t("Standard gateway workflow")], ...(isApi ? [[t("Request schema validation"), t(schemaValidation ? "Enabled" : "Disabled")], [t("Upstream request mapping"), t("{{count}} rules", { count: apiRequestRules.length })]] : []), [t("Draft access"), t("Owner Organization testing")], [t("State"), t("Draft")]]],
            ].map(([title, rows]) => <div className="flex flex-col gap-3" key={title as string}><h3 className="font-medium">{title as string}</h3>{(rows as string[][]).map(([label, value]) => <div className="flex justify-between gap-3 text-sm" key={label}><span className="text-muted-foreground">{label}</span><span className="max-w-52 truncate text-right font-medium" title={value}>{value}</span></div>)}</div>)}
          </CardContent>
        </Card>
      ) : null}

      <FieldError>{error}</FieldError>
      <div className="flex justify-between border-t pt-5">
        <Button onClick={step === 0 ? onCancel : () => setStep((current) => current - 1)} type="button" variant="outline">{step === 0 ? t("Cancel") : t("Back")}</Button>
        <Button disabled={submitting} type="submit">{submitting ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}{step === 2 ? t("Create Draft") : t("Continue")}</Button>
      </div>
    </form>
  )
}
