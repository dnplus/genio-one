import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ProviderCredentialStrategy } from "@/domain/contracts"
import {
  buildProviderCredentialStrategy,
  type ProviderCredentialStrategyKind,
} from "@/features/provider-credentials/provider-credential-strategy"

import { CredentialMaterialField } from "./credential-material-field"

export function ProviderCredentialCreateFields({
  idPrefix,
  defaultDisplayName = "",
  onReady,
}: {
  idPrefix: string
  defaultDisplayName?: string
  onReady: (value: { displayName: string; strategy: ProviderCredentialStrategy; credentialMaterial?: string } | null) => void
}) {
  const { t } = useTranslation()
  const [credentialMaterial, setCredentialMaterial] = useState<string | undefined>()
  const [displayName, setDisplayName] = useState(defaultDisplayName)
  const [strategyKind, setStrategyKind] = useState<ProviderCredentialStrategyKind>("STATIC_SECRET_REFERENCE")
  const [secretReference, setSecretReference] = useState("")
  const [projectName, setProjectName] = useState("")
  const [region, setRegion] = useState("us-central1")
  const [issuer, setIssuer] = useState("")
  const [clientId, setClientId] = useState("")
  const [audience, setAudience] = useState("")
  const [projectId, setProjectId] = useState("")
  const [poolName, setPoolName] = useState("")
  const [providerName, setProviderName] = useState("")
  const [serviceAccountName, setServiceAccountName] = useState("")
  const requiresGcp = strategyKind !== "STATIC_SECRET_REFERENCE"

  function publish(next: Partial<{
    credentialMaterial: string | undefined
    displayName: string
    strategyKind: ProviderCredentialStrategyKind
    secretReference: string
    projectName: string
    region: string
    issuer: string
    clientId: string
    audience: string
    projectId: string
    poolName: string
    providerName: string
    serviceAccountName: string
  }> = {}) {
    const merged = {
      credentialMaterial,
      displayName,
      strategyKind,
      secretReference,
      projectName,
      region,
      issuer,
      clientId,
      audience,
      projectId,
      poolName,
      providerName,
      serviceAccountName,
      ...next,
    }
    const name = merged.displayName.trim()
    if (!name) {
      onReady(null)
      return
    }
    if (merged.strategyKind !== "RUNTIME_IDENTITY" && !merged.secretReference.trim()) {
      onReady(null)
      return
    }
    onReady({
      displayName: name,
      ...(merged.strategyKind === "RUNTIME_IDENTITY" && merged.credentialMaterial ? { credentialMaterial: merged.credentialMaterial } : {}),
      strategy: buildProviderCredentialStrategy({
        kind: merged.strategyKind,
        secretReference: merged.secretReference,
        projectName: merged.projectName,
        region: merged.region,
        issuer: merged.issuer,
        clientId: merged.clientId,
        audience: merged.audience,
        projectId: merged.projectId,
        poolName: merged.poolName,
        providerName: merged.providerName,
        serviceAccountName: merged.serviceAccountName,
      }),
    })
  }

  return (
    <FieldGroup data-testid={`${idPrefix}-fields`}>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-name`}>{t("Profile name")}</FieldLabel>
        <Input
          id={`${idPrefix}-name`}
          value={displayName}
          onChange={(event) => {
            setDisplayName(event.target.value)
            publish({ displayName: event.target.value })
          }}
        />
      </Field>
      <Field>
        <FieldLabel>{t("Credential strategy")}</FieldLabel>
        <Select
          value={strategyKind}
          onValueChange={(value) => {
            const kind = value as ProviderCredentialStrategyKind
            setStrategyKind(kind)
            publish({ strategyKind: kind })
          }}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="STATIC_SECRET_REFERENCE">{t("Static secret reference")}</SelectItem>
              <SelectItem value="RUNTIME_IDENTITY">{t("Runtime identity · GCP ADC")}</SelectItem>
              <SelectItem value="OIDC_FEDERATION">{t("OIDC federation · GCP STS")}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>{t("Presets choose an adapter; the profile remains the credential authority.")}</FieldDescription>
      </Field>
      {strategyKind !== "RUNTIME_IDENTITY" ? (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-secret-ref`}>{t("Secret reference")}</FieldLabel>
          <Input
            id={`${idPrefix}-secret-ref`}
            value={secretReference}
            onChange={(event) => {
              setSecretReference(event.target.value)
              publish({ secretReference: event.target.value })
            }}
          />
          <FieldDescription>{t("Enter the reference configured by your deployment administrator in the secret store. Do not paste an API key or service-account JSON here.")}</FieldDescription>
        </Field>
      ) : null}
      {strategyKind === "RUNTIME_IDENTITY" ? <CredentialMaterialField id={`${idPrefix}-material`} onChange={(material) => { setCredentialMaterial(material); publish({ credentialMaterial: material }) }} /> : null}
      {requiresGcp ? (
        <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2" data-testid={`${idPrefix}-gcp-fields`}>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-project`}>{t("GCP project ID")}</FieldLabel>
            <Input
              id={`${idPrefix}-project`}
              value={projectName}
              onChange={(event) => {
                setProjectName(event.target.value)
                publish({ projectName: event.target.value })
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-region`}>{t("GCP region")}</FieldLabel>
            <Input
              id={`${idPrefix}-region`}
              value={region}
              onChange={(event) => {
                setRegion(event.target.value)
                publish({ region: event.target.value })
              }}
            />
          </Field>
          {strategyKind === "OIDC_FEDERATION" ? <>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${idPrefix}-issuer`}>{t("OIDC issuer")}</FieldLabel>
              <Input
                id={`${idPrefix}-issuer`}
                type="url"
                value={issuer}
                onChange={(event) => {
                  setIssuer(event.target.value)
                  publish({ issuer: event.target.value })
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-client`}>{t("OIDC client ID")}</FieldLabel>
              <Input
                id={`${idPrefix}-client`}
                value={clientId}
                onChange={(event) => {
                  setClientId(event.target.value)
                  publish({ clientId: event.target.value })
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-audience`}>{t("OIDC audience")}</FieldLabel>
              <Input
                id={`${idPrefix}-audience`}
                value={audience}
                onChange={(event) => {
                  setAudience(event.target.value)
                  publish({ audience: event.target.value })
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-project-id`}>{t("GCP project ID")}</FieldLabel>
              <Input
                id={`${idPrefix}-project-id`}
                value={projectId}
                onChange={(event) => {
                  setProjectId(event.target.value)
                  publish({ projectId: event.target.value })
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-pool`}>{t("Workload identity pool")}</FieldLabel>
              <Input
                id={`${idPrefix}-pool`}
                value={poolName}
                onChange={(event) => {
                  setPoolName(event.target.value)
                  publish({ poolName: event.target.value })
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-provider`}>{t("Workload identity provider")}</FieldLabel>
              <Input
                id={`${idPrefix}-provider`}
                value={providerName}
                onChange={(event) => {
                  setProviderName(event.target.value)
                  publish({ providerName: event.target.value })
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-service-account`}>{t("Service account")}</FieldLabel>
              <Input
                id={`${idPrefix}-service-account`}
                value={serviceAccountName}
                onChange={(event) => {
                  setServiceAccountName(event.target.value)
                  publish({ serviceAccountName: event.target.value })
                }}
              />
            </Field>
          </> : null}
        </div>
      ) : null}
    </FieldGroup>
  )
}
