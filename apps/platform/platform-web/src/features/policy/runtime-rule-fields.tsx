import { useTranslation } from "react-i18next"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { RuntimePolicyConstraint, RuntimePolicyObligation } from "@/lib/product-api"
export const constraintKinds = ["path_allowlist", "command_allowlist", "command_deny", "network", "approval_required", "read_only", "cwd", "template", "ttl"] as const
export const obligationKinds = ["audit", "require_approval", "redact", "usage"] as const
export function newConstraint(kind: typeof constraintKinds[number]): RuntimePolicyConstraint {
  if (kind === "path_allowlist") return { kind, parameters: { paths: [] } }
  if (kind === "command_allowlist") return { kind, parameters: { commands: [] } }
  if (kind === "command_deny") return { kind, parameters: { commands: [] } }
  if (kind === "network") return { kind, parameters: { allow: [], deny: [] } }
  if (kind === "approval_required") return { kind, parameters: { enabled: true } }
  if (kind === "read_only") return { kind, parameters: { enabled: true } }
  if (kind === "cwd") return { kind, parameters: { path: "" } }
  if (kind === "template") return { kind, parameters: { template: "" } }
  return { kind, parameters: { ttl_seconds: 3600 } }
}

export function newObligation(kind: typeof obligationKinds[number]): RuntimePolicyObligation {
  if (kind === "audit") return { kind, parameters: {} }
  if (kind === "require_approval") return { kind, parameters: {} }
  if (kind === "redact") return { kind, parameters: { fields: [] } }
  return { kind, parameters: { meter: "runtime" } }
}

function listValue(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))]
}

export function ConstraintFields({ value, onChange, disabled }: { value: RuntimePolicyConstraint; onChange: (value: RuntimePolicyConstraint) => void; disabled: boolean }) {
  const { t } = useTranslation()
  if (value.kind === "path_allowlist") return <Input disabled={disabled} value={value.parameters.paths.join(", ")} placeholder={t("/workspace/project")} onChange={(event) => onChange({ ...value, parameters: { paths: listValue(event.target.value) } })} />
  if (value.kind === "command_allowlist" || value.kind === "command_deny") return <Input disabled={disabled} value={value.parameters.commands.join(", ")} placeholder={t("git status, git diff")} onChange={(event) => onChange({ ...value, parameters: { commands: listValue(event.target.value) } })} />
  if (value.kind === "network") return <div className="grid gap-2 sm:grid-cols-2"><Input disabled={disabled} value={value.parameters.allow.join(", ")} placeholder={t("Allowed hosts")} onChange={(event) => onChange({ ...value, parameters: { ...value.parameters, allow: listValue(event.target.value) } })} /><Input disabled={disabled} value={value.parameters.deny.join(", ")} placeholder={t("Denied hosts")} onChange={(event) => onChange({ ...value, parameters: { ...value.parameters, deny: listValue(event.target.value) } })} /></div>
  if (value.kind === "approval_required" || value.kind === "read_only") return <Field orientation="horizontal"><Checkbox disabled={disabled} checked={value.parameters.enabled} onCheckedChange={(checked) => onChange({ ...value, parameters: { enabled: checked === true } })} /><FieldLabel>{t("Enabled")}</FieldLabel></Field>
  if (value.kind === "cwd") return <Input disabled={disabled} value={value.parameters.path} placeholder={t("/workspace/project")} onChange={(event) => onChange({ ...value, parameters: { path: event.target.value } })} />
  if (value.kind === "template") return <Input disabled={disabled} value={value.parameters.template} placeholder={t("safe-command")} onChange={(event) => onChange({ ...value, parameters: { template: event.target.value } })} />
  return <Input disabled={disabled} type="number" min={1} max={86400} value={value.parameters.ttl_seconds} onChange={(event) => onChange({ ...value, parameters: { ttl_seconds: Number(event.target.value) } })} />
}

export function ObligationFields({ value, onChange, disabled }: { value: RuntimePolicyObligation; onChange: (value: RuntimePolicyObligation) => void; disabled: boolean }) {
  const { t } = useTranslation()
  if (value.kind === "audit") return <Select disabled={disabled} value={value.parameters.event_kind ?? "any"} onValueChange={(next) => onChange({ ...value, parameters: next === "any" ? {} : { event_kind: next as "expose" | "invoke" | "denied" } })}><SelectTrigger><SelectValue placeholder={t("All runtime events")} /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="any">{t("All runtime events")}</SelectItem><SelectItem value="expose">{t("expose")}</SelectItem><SelectItem value="invoke">{t("invoke")}</SelectItem><SelectItem value="denied">{t("denied")}</SelectItem></SelectGroup></SelectContent></Select>
  if (value.kind === "require_approval") return <Input disabled={disabled} value={value.parameters.reason ?? ""} placeholder={t("Approval reason (optional)")} onChange={(event) => onChange({ ...value, parameters: event.target.value ? { reason: event.target.value } : {} })} />
  if (value.kind === "redact") return <Input disabled={disabled} value={value.parameters.fields.join(", ")} placeholder={t("secret,token")} onChange={(event) => onChange({ ...value, parameters: { fields: listValue(event.target.value) } })} />
  return <Input disabled={disabled} value={value.parameters.meter} placeholder={t("runtime-usage")} onChange={(event) => onChange({ ...value, parameters: { meter: event.target.value } })} />
}
