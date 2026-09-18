import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

export function CredentialMaterialField({ id, disabled, onChange }: {
  id: string
  disabled?: boolean
  onChange: (material: string | undefined) => void
}) {
  const { t } = useTranslation()
  const sequence = useRef(0)
  const [error, setError] = useState("")
  return <Field>
    <FieldLabel htmlFor={id}>{t("GCP credential JSON")}</FieldLabel>
    <Input id={id} type="file" accept=".json,application/json" disabled={disabled} onChange={async (event) => {
      const request = ++sequence.current
      const file = event.target.files?.[0]
      onChange(undefined)
      setError("")
      if (!file) return
      try {
        if (file.size > 65536) throw new Error()
        const material = await file.text()
        const value = JSON.parse(material)
        if (!value || !["authorized_user", "service_account"].includes(value.type)) throw new Error()
        if (request === sequence.current) onChange(material)
      } catch {
        if (request === sequence.current) setError(t("Choose a valid GCP ADC or service account JSON file up to 64 KB."))
      }
    }} />
    <FieldDescription>{t("Credentials are encrypted when saved. Publish a connection using this revision to apply them to its Gateway.")}</FieldDescription>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </Field>
}
