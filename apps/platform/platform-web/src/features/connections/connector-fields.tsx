import { useState } from "react"
import { mail2000DavSettings } from "../../../../../connectors/mail2000/site"
import { useTranslation } from "react-i18next"
import type { ConnectorConfiguration, ConnectorKind } from "@/domain/contracts"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

export function emptyConnectorConfiguration(kind: ConnectorKind): ConnectorConfiguration {
  return kind === "servicenow-csm"
    ? { kind, instance_url: "", oauth_client_id: "", oauth_scopes: [] }
    : { kind, imap_host: "", imap_port: 993, smtp_host: "", smtp_port: 465 }
}

export function ConnectorFields({ value, onChange }: { value: ConnectorConfiguration; onChange: (value: ConnectorConfiguration) => void }) {
  const { t } = useTranslation()
  const [scopeText, setScopeText] = useState(value.kind === "servicenow-csm" ? value.oauth_scopes.join(" ") : "")
  function field(label: string, key: string, current: string | number, type: "text" | "url" | "number" = "text", optional = false) {
    return <Field key={key}>
      <FieldLabel htmlFor={`connector-${key}`}>{t(label)}</FieldLabel>
      <Input id={`connector-${key}`} type={type} value={current} required={!optional} min={type === "number" ? 1 : undefined} max={type === "number" ? 65535 : undefined} onChange={(event) => onChange({ ...value, [key]: type === "number" ? Number(event.target.value) : optional && !event.target.value ? undefined : event.target.value })} />
    </Field>
  }
  const dav = value.kind === "mail2000" ? mail2000DavSettings({ imap_host: value.imap_host }) : null
  return <div className="grid gap-4" data-testid="connector-site-configuration">
    <FieldDescription>{t("Site settings belong to this Connection. Personal credentials are connected separately by each user.")}</FieldDescription>
    {value.kind === "servicenow-csm" ? <>
      {field("ServiceNow instance URL", "instance_url", value.instance_url, "url")}
      {field("OAuth Client ID", "oauth_client_id", value.oauth_client_id)}
      <Field><FieldLabel htmlFor="connector-scopes">{t("OAuth scopes")}</FieldLabel><Input id="connector-scopes" value={scopeText} onChange={(event) => { setScopeText(event.target.value); onChange({ ...value, oauth_scopes: event.target.value.split(/\s+/).filter(Boolean) }) }} /></Field>
      <FieldDescription>{t("Register this OAuth redirect URI in ServiceNow:")} {`${window.location.origin}/v1/mcp-oauth/callback`}</FieldDescription>
    </> : <>
      {field("IMAP host", "imap_host", value.imap_host)}
      {field("IMAP port", "imap_port", value.imap_port, "number")}
      {field("SMTP host", "smtp_host", value.smtp_host)}
      {field("SMTP port", "smtp_port", value.smtp_port, "number")}
      <FieldDescription>{dav?.caldav_url ? t("Calendar and contacts use the Mail2000 site defaults and are discovered with each user's account.") : t("For other mail sites, configure calendar and contact endpoints under advanced settings.")}</FieldDescription>
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer font-medium">{t("Advanced DAV settings (optional)")}</summary>
        <div className="grid gap-4 pt-4">
          <FieldDescription>{t("Override only for a custom deployment. Leave blank to use the site defaults.")}</FieldDescription>
          {field("CalDAV URL", "caldav_url", value.caldav_url ?? "", "url", true)}
          {field("CardDAV URL", "carddav_url", value.carddav_url ?? "", "url", true)}
          <FieldDescription>{t("Use HTTPS for DAV. The path may contain {username}; IMAP and SMTP use TLS.")}</FieldDescription>
        </div>
      </details>
    </>}
  </div>
}
