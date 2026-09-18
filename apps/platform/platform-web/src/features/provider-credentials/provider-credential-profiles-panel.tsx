import { useEffect, useMemo, useState, type FormEvent } from "react"
import { KeyRoundIcon, LoaderCircleIcon, PlusIcon, ShieldOffIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ProviderCredentialProfileRevision, ProviderCredentialStrategy, Organization } from "@/domain/contracts"
import { ProviderCredentialCreateFields } from "@/features/provider-credentials/provider-credential-create-fields"
import {
  createProviderCredentialProfile,
  listProviderCredentialProfiles,
  reviseProviderCredentialProfile,
} from "@/lib/product-api"

import { CredentialMaterialField } from "./credential-material-field"

export function ProviderCredentialProfilesPanel({
  tenantId,
  organizations,
}: {
  tenantId: string
  organizations: Organization[]
}) {
  const { t } = useTranslation()
  const [profiles, setProfiles] = useState<ProviderCredentialProfileRevision[]>([])
  const [search, setSearch] = useState("")
  const [organizationId, setOrganizationId] = useState(organizations[0]?.organization_id ?? "")
  const [draft, setDraft] = useState<{ displayName: string; strategy: ProviderCredentialStrategy; credentialMaterial?: string } | null>(null)
  const [editing, setEditing] = useState<ProviderCredentialProfileRevision | null>(null)
  const [material, setMaterial] = useState<string | undefined>()
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const organizationLabels = useMemo(
    () => new Map(organizations.map((organization) => [organization.organization_id, organization.display_name])),
    [organizations],
  )
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query) return profiles
    return profiles.filter((profile) => [
      profile.display_name,
      profile.profile_id,
      profile.owner_organization_id,
      organizationLabels.get(profile.owner_organization_id) ?? "",
      profile.strategy.kind,
      profile.adapter_family,
    ].some((value) => value.toLocaleLowerCase().includes(query)))
  }, [organizationLabels, profiles, search])

  async function reload() {
    setProfiles(await listProviderCredentialProfiles(tenantId))
  }

  useEffect(() => {
    void reload().catch((error) => setResult(error instanceof Error ? error.message : t("Provider credential profiles could not be loaded.")))
  }, [tenantId])

  useEffect(() => {
    if (!organizationId && organizations[0]) setOrganizationId(organizations[0].organization_id)
  }, [organizationId, organizations])

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft) return
    setBusy("create")
    setResult(null)
    try {
      await createProviderCredentialProfile(tenantId, {
        ownerOrganizationId: organizationId,
        displayName: draft.displayName,
        strategy: draft.strategy,
        credentialMaterial: draft.credentialMaterial,
      })
      await reload()
      setDraft(null)
      setResult(t("Provider credential profile created."))
    } catch (error) {
      setResult(error instanceof Error ? error.message : t("Provider credential profile could not be created."))
    } finally {
      setBusy(null)
    }
  }

  async function saveCredential() {
    if (!editing || !material) return
    setBusy(editing.profile_id)
    setResult(null)
    try {
      await reviseProviderCredentialProfile(tenantId, editing, "ACTIVE", material)
      await reload()
      setEditing(null)
      setMaterial(undefined)
      setResult(t("Credential revision saved. Select this revision on the connection and publish to apply it."))
    } catch (error) {
      setResult(error instanceof Error ? error.message : t("Credential revision could not be saved."))
    } finally {
      setBusy(null)
    }
  }

  async function revoke(profile: ProviderCredentialProfileRevision) {
    setBusy(profile.profile_id)
    setResult(null)
    try {
      await reviseProviderCredentialProfile(tenantId, profile, "REVOKED")
      await reload()
      setResult(t("Provider credential profile revoked."))
    } catch (error) {
      setResult(error instanceof Error ? error.message : t("Provider credential profile could not be revoked."))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card data-testid="provider-credential-profiles">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2"><KeyRoundIcon className="size-4" />{t("Provider credential profiles")}</CardTitle>
        <CardDescription>{t("Manage outbound Runtime credentials separately from Application caller federation. Connections bind an exact profile revision during publication.")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(32rem,1.2fr)]">
        <form onSubmit={(event) => void create(event)}>
          <FieldGroup>
            <Field><FieldLabel>{t("Owner Organization")}</FieldLabel><SearchableSelect value={organizationId} options={organizations.map((organization) => ({ value: organization.organization_id, label: organization.display_name }))} onValueChange={setOrganizationId} placeholder={t("Select Organization")} searchPlaceholder={t("Search Organizations")} emptyLabel={t("No Organizations found.")} /></Field>
            <ProviderCredentialCreateFields idPrefix="provider-credential" onReady={setDraft} />
            <Button type="submit" className="self-start" disabled={busy !== null || !organizationId || !draft}><PlusIcon data-icon="inline-start" />{busy === "create" ? t("Creating…") : t("Create profile")}</Button>
            {result ? <p role="status" className="text-sm text-muted-foreground">{result}</p> : null}
          </FieldGroup>
        </form>
        <div className="min-w-0 space-y-3">
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("Search profiles, Organizations, strategies, or IDs")} aria-label={t("Search provider credential profiles")} />
          {editing ? <div className="space-y-3 rounded-lg border p-4">
            <p className="font-medium">{editing.display_name} · {t("New credential revision")}</p>
            <CredentialMaterialField key={editing.profile_id} id="replace-provider-credential" disabled={busy !== null} onChange={setMaterial} />
            <div className="flex flex-wrap gap-2"><Button type="button" disabled={!material || busy !== null} onClick={() => void saveCredential()}>{t("Save credential revision")}</Button><Button type="button" variant="outline" disabled={busy !== null} onClick={() => { setEditing(null); setMaterial(undefined) }}>{t("Cancel")}</Button></div>
          </div> : null}
          <div className="rounded-lg border">
            <Table>
              <TableHeader><TableRow><TableHead>{t("Profile")}</TableHead><TableHead>{t("Organization")}</TableHead><TableHead>{t("Strategy")}</TableHead><TableHead>{t("Revision")}</TableHead><TableHead>{t("State")}</TableHead><TableHead className="text-right">{t("Actions")}</TableHead></TableRow></TableHeader>
              <TableBody>{filtered.map((profile) => <TableRow key={profile.profile_id}>
                <TableCell><div className="font-medium">{profile.display_name}</div><div className="font-mono text-xs text-muted-foreground">{profile.profile_id}</div></TableCell>
                <TableCell>{organizationLabels.get(profile.owner_organization_id) ?? profile.owner_organization_id}</TableCell>
                <TableCell><Badge variant="outline">{t(profile.strategy.kind)}</Badge><div className="mt-1 text-xs text-muted-foreground">{profile.adapter_family}</div>{profile.strategy.kind === "RUNTIME_IDENTITY" ? <div className="mt-1 text-xs text-muted-foreground">{t(profile.credential_configured ? "Encrypted credential saved" : "Uses environment identity")}</div> : null}</TableCell>
                <TableCell className="tabular-nums">{profile.revision}</TableCell>
                <TableCell><Badge variant={profile.state === "ACTIVE" ? "secondary" : "outline"}>{t(profile.state)}</Badge></TableCell>
                <TableCell className="text-right">{profile.state === "ACTIVE" && profile.strategy.kind === "RUNTIME_IDENTITY" ? <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => { setEditing(profile); setMaterial(undefined) }}>{t("Upload or replace credential")}</Button> : null}{profile.state === "ACTIVE" ? <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void revoke(profile)}>{busy === profile.profile_id ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <ShieldOffIcon data-icon="inline-start" />}{t("Revoke")}</Button> : null}</TableCell>
              </TableRow>)}</TableBody>
            </Table>
            {filtered.length === 0 ? <div className="p-6 text-center text-sm text-muted-foreground">{t(search ? "No matching provider credential profiles." : "No provider credential profiles have been created.")}</div> : null}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
