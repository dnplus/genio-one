import { useEffect, useMemo, useState, type FormEvent } from "react"
import { LoaderCircleIcon, ShieldPlusIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
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
  SheetTrigger,
} from "@/components/ui/sheet"
import type {
  ApplicationRegistration,
  FederationExchangeEvent,
  FederationTrustRevision,
  OverviewSnapshot,
} from "@/domain/contracts"
import { ApplicationCredentialsPanel } from "@/features/applications/application-credentials-panel"
import {
  createApplicationFederationTrust,
  listApplicationFederationExchanges,
  listApplicationFederationTrusts,
  requestApplicationAccess,
} from "@/lib/product-api"

type CapabilityOption = {
  key: string
  resourceId: string
  resourceName: string
  environmentId: string
  capabilityId: string
  capabilityName: string
}

export function ApplicationAccessSheet({
  tenantId,
  application,
  data,
  onChanged,
}: {
  tenantId: string
  application: ApplicationRegistration
  data: OverviewSnapshot
  onChanged: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [selection, setSelection] = useState("")
  const [justification, setJustification] = useState("")
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [federationTrusts, setFederationTrusts] = useState<FederationTrustRevision[]>([])
  const [federationExchanges, setFederationExchanges] = useState<FederationExchangeEvent[]>([])
  const [federationDisplayName, setFederationDisplayName] = useState("")
  const [federationIssuer, setFederationIssuer] = useState("")
  const [federationJwksUri, setFederationJwksUri] = useState("")
  const [federationAudience, setFederationAudience] = useState("genio-one-sts")
  const [federationAlgorithm, setFederationAlgorithm] = useState<"RS256" | "ES256" | "EdDSA">("RS256")
  const [federationExternalSubject, setFederationExternalSubject] = useState("")
  const [federationClaimName, setFederationClaimName] = useState("")
  const [federationClaimValue, setFederationClaimValue] = useState("")
  const [federationMaxTtl, setFederationMaxTtl] = useState("600")

  useEffect(() => {
    if (!open) return
    let active = true
    setError("")
    void Promise.all([
      listApplicationFederationTrusts(tenantId, application.application_id),
      listApplicationFederationExchanges(tenantId, application.application_id),
    ])
      .then(([nextTrusts, nextExchanges]) => {
        if (!active) return
        setFederationTrusts(nextTrusts)
        setFederationExchanges(nextExchanges)
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : t("API credential load failed"))
      })
    return () => {
      active = false
    }
  }, [application.application_id, open, t, tenantId])

  const options = useMemo<CapabilityOption[]>(
    () => data.resources
      .filter((resource) =>
        (resource.kind === "API" || resource.kind === "LLM")
        && (resource.lifecycle === "PUBLISHED" || resource.lifecycle === "DEPRECATED")
        && (
          resource.publication_endpoint?.visibility === "REQUEST"
          || (
            resource.publication_endpoint?.visibility === "PRIVATE"
            && resource.owner_organization_id === application.owner_organization_id
          )
        ),
      )
      .flatMap((resource) => resource.capabilities.map((capability) => ({
        key: `${resource.resource_id}::${capability.capability_id}`,
        resourceId: resource.resource_id,
        resourceName: resource.display_name,
        environmentId: resource.environment_id,
        capabilityId: capability.capability_id,
        capabilityName: capability.display_name,
      }))),
    [application.owner_organization_id, data.resources],
  )
  const selected = options.find((option) => option.key === selection)
  const applicationRequests = data.accessRequests.filter(
    (request) => request.target_subject === application.subject_id,
  )
  const selectedRequest = selected
    ? applicationRequests.find(
        (request) => {
          if (request.resource_id !== selected.resourceId || request.capability_id !== selected.capabilityId) {
            return false
          }
          if (request.state === "PENDING") return true
          return request.state === "APPROVED" && data.ownedEntitlements.some(
            (entitlement) => entitlement.subject_id === application.subject_id
              && entitlement.resource_id === selected.resourceId
              && entitlement.capability_id === selected.capabilityId
              && entitlement.state === "ACTIVE",
          )
        },
      )
    : null

  function resetTransientState() {
    setSelection("")
    setJustification("")
    setBusy("")
    setError("")
  }

  function closeSheet() {
    resetTransientState()
    setOpen(false)
  }

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected || !justification.trim()) return
    setBusy("request")
    setError("")
    try {
      await requestApplicationAccess(
        tenantId,
        application.subject_id,
        selected.resourceId,
        selected.capabilityId,
        justification.trim(),
      )
      setJustification("")
      await onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Application access request failed"))
    } finally {
      setBusy("")
    }
  }

  async function createFederationTrust(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const maxTtl = Number(federationMaxTtl)
    if (
      !federationDisplayName.trim() ||
      !federationIssuer.trim() ||
      !federationJwksUri.trim() ||
      !federationAudience.trim() ||
      !federationExternalSubject.trim() ||
      !Number.isInteger(maxTtl) ||
      maxTtl < 1 ||
      maxTtl > 3600
    ) return
    setBusy("federation-trust")
    setError("")
    try {
      await createApplicationFederationTrust(tenantId, application.application_id, {
        displayName: federationDisplayName,
        issuer: federationIssuer,
        jwksUri: federationJwksUri,
        audience: federationAudience,
        algorithm: federationAlgorithm,
        externalSubjectId: federationExternalSubject,
        requiredClaimName: federationClaimName,
        requiredClaimValue: federationClaimValue,
        maxAssertionTtlSeconds: maxTtl,
      })
      setFederationTrusts(await listApplicationFederationTrusts(tenantId, application.application_id))
      setFederationDisplayName("")
      setFederationExternalSubject("")
      setFederationClaimName("")
      setFederationClaimValue("")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Federation Trust creation failed"))
    } finally {
      setBusy("")
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) resetTransientState()
      }}
    >
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <ShieldPlusIcon data-icon="inline-start" />
          {t("Manage access")}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl" data-testid={`application-access-${application.application_id}`}>
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>{t("Application access & credentials")}</SheetTitle>
          <SheetDescription>
            {application.display_name} · {application.application_id}
          </SheetDescription>
        </SheetHeader>
        <p className="border-b px-6 py-3 text-xs text-muted-foreground">
          {t("Resource credentials require an active Application Entitlement. Platform API keys use the Application's current role and permissions.")}
        </p>

        <form onSubmit={submitRequest}>
          <FieldGroup className="border-b p-6">
            <div>
              <h3 className="text-sm font-medium">{t("Request API Capability")}</h3>
              <p className="mt-1 text-xs text-muted-foreground" data-testid="application-requester-target">
                {t("The signed-in Person remains the Requester; this Application is the Target Subject.")}
              </p>
            </div>
            <Field>
              <FieldLabel>{t("API / Capability")}</FieldLabel>
              <Select value={selection} onValueChange={setSelection} required>
                <SelectTrigger className="w-full"><SelectValue placeholder={t("Select a Published API Capability")}>{selected ? `${selected.resourceName} · ${selected.environmentId} · ${selected.capabilityName}` : undefined}</SelectValue></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {options.map((option) => (
                      <SelectItem key={option.key} value={option.key}>
                        {option.resourceName} · {option.environmentId} · {option.capabilityName}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>{t("Select a published API or model Capability. Credentials use the Application's active access after approval.")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`application-justification-${application.application_id}`}>{t("Justification")}</FieldLabel>
              <Input
                id={`application-justification-${application.application_id}`}
                value={justification}
                onChange={(event) => setJustification(event.target.value)}
                placeholder={t("Explain why this Application needs the Capability")}
                required
              />
            </Field>
            {selectedRequest ? (
              <div className="flex items-center gap-2 text-sm">
                <span>{t("Existing request")}</span>
                <Badge variant="outline">{t(selectedRequest.state)}</Badge>
              </div>
            ) : null}
            <Button
              type="submit"
              className="self-start"
              disabled={!selected || !justification.trim() || Boolean(selectedRequest) || Boolean(busy)}
            >
              {busy === "request" ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : null}
              {t("Submit for Human Approval")}
            </Button>
          </FieldGroup>
        </form>

        <div className="flex flex-col gap-4 p-6">
          {open ? <ApplicationCredentialsPanel tenantId={tenantId} application={application} data={data} onChanged={onChanged} /> : null}

          <form className="mt-2 border-t pt-4" onSubmit={createFederationTrust} data-testid="application-federation-trust">
            <div>
              <h3 className="text-sm font-medium">{t("Workload Identity Federation")}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("Bind a trusted external workload assertion to this canonical Application Subject without granting Entitlement.")}
              </p>
            </div>
            <FieldGroup className="mt-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={`federation-name-${application.application_id}`}>{t("Trust name")}</FieldLabel>
                  <Input id={`federation-name-${application.application_id}`} value={federationDisplayName} onChange={(event) => setFederationDisplayName(event.target.value)} required />
                </Field>
                <Field>
                  <FieldLabel>{t("Assertion algorithm")}</FieldLabel>
                  <Select value={federationAlgorithm} onValueChange={(value) => setFederationAlgorithm(value as typeof federationAlgorithm)}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="RS256">{t("RS256")}</SelectItem>
                      <SelectItem value="ES256">{t("ES256")}</SelectItem>
                      <SelectItem value="EdDSA">{t("EdDSA")}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor={`federation-issuer-${application.application_id}`}>{t("External issuer")}</FieldLabel>
                <Input id={`federation-issuer-${application.application_id}`} type="url" value={federationIssuer} onChange={(event) => setFederationIssuer(event.target.value)} placeholder={t("https://issuer.example.com")} required />
              </Field>
              <Field>
                <FieldLabel htmlFor={`federation-jwks-${application.application_id}`}>{t("JWKS URI")}</FieldLabel>
                <Input id={`federation-jwks-${application.application_id}`} type="url" value={federationJwksUri} onChange={(event) => setFederationJwksUri(event.target.value)} placeholder={t("https://issuer.example.com/.well-known/jwks.json")} required />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={`federation-audience-${application.application_id}`}>{t("Assertion audience")}</FieldLabel>
                  <Input id={`federation-audience-${application.application_id}`} value={federationAudience} onChange={(event) => setFederationAudience(event.target.value)} required />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`federation-ttl-${application.application_id}`}>{t("Maximum assertion TTL (seconds)")}</FieldLabel>
                  <Input id={`federation-ttl-${application.application_id}`} type="number" min="1" max="3600" step="1" value={federationMaxTtl} onChange={(event) => setFederationMaxTtl(event.target.value)} required />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor={`federation-subject-${application.application_id}`}>{t("External subject")}</FieldLabel>
                <Input id={`federation-subject-${application.application_id}`} value={federationExternalSubject} onChange={(event) => setFederationExternalSubject(event.target.value)} required />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={`federation-claim-name-${application.application_id}`}>{t("Required claim (optional)")}</FieldLabel>
                  <Input id={`federation-claim-name-${application.application_id}`} value={federationClaimName} onChange={(event) => setFederationClaimName(event.target.value)} placeholder={t("environment")} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`federation-claim-value-${application.application_id}`}>{t("Required value (optional)")}</FieldLabel>
                  <Input id={`federation-claim-value-${application.application_id}`} value={federationClaimValue} onChange={(event) => setFederationClaimValue(event.target.value)} placeholder={t("production")} />
                </Field>
              </div>
              <Button type="submit" className="self-start" disabled={Boolean(busy)}>
                {busy === "federation-trust" ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <ShieldPlusIcon data-icon="inline-start" />}
                {t("Create Federation Trust revision")}
              </Button>
            </FieldGroup>
          </form>

          {federationTrusts.length ? (
            <div className="grid gap-3" data-testid="federation-trust-list">
              {federationTrusts.map((trust) => (
                <div key={trust.trust_id} className="rounded-lg border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{trust.display_name}</span>
                    <Badge variant="outline">{t(trust.state)}</Badge>
                  </div>
                  <div className="mt-2 font-mono text-xs text-muted-foreground">{trust.trust_id} · {t("Revision {{revision}}", { revision: trust.revision })}</div>
                  <div className="mt-1 break-all text-xs text-muted-foreground">{trust.issuer} · {trust.external_subject_id}</div>
                </div>
              ))}
            </div>
          ) : null}

          {federationExchanges.length ? (
            <div className="grid gap-2" data-testid="federation-exchange-evidence">
              <h3 className="text-sm font-medium">{t("Federation exchange evidence")}</h3>
              {federationExchanges.slice(0, 5).map((exchange) => (
                <div key={exchange.exchange_id} className="rounded-lg border p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono">{exchange.correlation_id}</span>
                    <Badge variant="outline">{t(exchange.outcome)}</Badge>
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    {exchange.application_subject_id} · {exchange.credential_generation ? `${t("Generation")} ${exchange.credential_generation}` : exchange.rejection_reason}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {error ? <FieldError>{t(error)}</FieldError> : null}
        </div>
        <SheetFooter className="border-t bg-background px-6 py-4">
          <Button type="button" variant="outline" onClick={closeSheet}>{t("Close")}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
