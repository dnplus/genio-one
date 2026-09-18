import { useEffect, useMemo, useState, type FormEvent } from "react"
import { LoaderCircleIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import type { ApiRequestParameterRule, ConnectionSummary, ResourceRegistration } from "@/domain/contracts"
import { updateResourceConnectionRequestMapping } from "@/lib/product-api"

type EditableRule = ApiRequestParameterRule & { id: string }

function editableRules(connection: ConnectionSummary): EditableRule[] {
  return (connection.request_mapping?.rules ?? []).map((rule) => ({
    ...rule,
    id: crypto.randomUUID(),
  }))
}

export function ApiRequestMappingSheet({
  tenantId,
  resource,
  connection,
  onUpdated,
}: {
  tenantId: string
  resource: ResourceRegistration
  connection: ConnectionSummary
  onUpdated: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [rules, setRules] = useState<EditableRule[]>(() => editableRules(connection))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const operations = resource.api?.operations ?? []
  const operationOptions = useMemo(() => [
    { value: "*", label: t("All operations") },
    ...operations.map((operation) => ({
      value: operation.operation_id,
      label: operation.operation_id,
      description: `${operation.method} ${operation.path}`,
    })),
  ], [operations, t])

  useEffect(() => {
    if (open) setRules(editableRules(connection))
  }, [connection, open])

  function updateRule(id: string, update: Partial<EditableRule>) {
    setRules((current) => current.map((rule) => rule.id === id ? { ...rule, ...update } : rule))
  }

  function parameterOptions(rule: EditableRule) {
    return [...new Set(operations
      .filter((operation) => rule.operation_id === null || operation.operation_id === rule.operation_id)
      .flatMap((operation) => operation.parameters ?? [])
      .filter((parameter) => parameter.location === rule.location)
      .map((parameter) => parameter.name))]
      .sort()
      .map((name) => ({ value: name, label: name }))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (rules.some((rule) => !rule.name.trim())) {
      setError(t("Upstream parameter is required."))
      return
    }
    if (rules.some((rule) => rule.action === "SET" && !rule.value?.trim())) {
      setError(t("Override value is required."))
      return
    }
    setSubmitting(true)
    setError("")
    try {
      await updateResourceConnectionRequestMapping(
        tenantId,
        resource.resource_id,
        connection.connection_id,
        connection.configuration_revision,
        {
          default_action: "PASSTHROUGH",
          rules: rules.map((rule) => ({
            operation_id: rule.operation_id,
            location: rule.location,
            name: rule.name.trim(),
            action: rule.action,
            value: rule.action === "SET" ? rule.value?.trim() ?? null : null,
          })),
        },
      )
      await onUpdated()
      setOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Request mapping update failed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline">{t("Configure request mapping")}</Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <form className="flex min-h-full flex-col" onSubmit={submit}>
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>{t("Upstream request mapping")}</SheetTitle>
            <SheetDescription>{t("Unspecified headers and query parameters pass through. Rules can preserve, override, or remove individual values.")}</SheetDescription>
          </SheetHeader>
          <FieldGroup className="p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium">{connection.display_name}</div>
              <Button
                onClick={() => setRules((current) => [...current, {
                  id: crypto.randomUUID(),
                  operation_id: operations[0]?.operation_id ?? null,
                  location: "HEADER",
                  name: "",
                  action: "SET",
                  value: null,
                }])}
                size="sm"
                type="button"
                variant="outline"
              >
                <PlusIcon />
                {t("Add rule")}
              </Button>
            </div>
            {rules.map((rule) => {
              const knownParameters = parameterOptions(rule)
              return (
                <div className="grid gap-3 rounded-lg border p-3" key={rule.id}>
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field>
                      <FieldLabel>{t("Operation")}</FieldLabel>
                      <SearchableSelect
                        emptyLabel={t("No operations found.")}
                        onValueChange={(value) => updateRule(rule.id, { operation_id: value === "*" ? null : value })}
                        options={operationOptions}
                        placeholder={t("Select operation")}
                        searchPlaceholder={t("Search operations")}
                        value={rule.operation_id ?? "*"}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>{t("Location")}</FieldLabel>
                      <Select value={rule.location} onValueChange={(value) => updateRule(rule.id, { location: value as "HEADER" | "QUERY" })}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectGroup><SelectItem value="HEADER">{t("Header")}</SelectItem><SelectItem value="QUERY">{t("Query parameter")}</SelectItem></SelectGroup></SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field>
                      <FieldLabel>{t("Declared parameter")}</FieldLabel>
                      <SearchableSelect
                        emptyLabel={t("No parameters found in the OpenAPI document.")}
                        onValueChange={(value) => updateRule(rule.id, { name: value })}
                        options={knownParameters}
                        placeholder={t("Select parameter")}
                        searchPlaceholder={t("Search parameters")}
                        value={rule.name}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`provider-parameter-${rule.id}`}>{t("Provider-specific parameter")}</FieldLabel>
                      <Input id={`provider-parameter-${rule.id}`} onChange={(event) => updateRule(rule.id, { name: event.target.value })} value={rule.name} />
                      <FieldDescription>{t("Select a declared parameter or enter a provider-specific header or query parameter.")}</FieldDescription>
                    </Field>
                  </div>
                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                    <Field>
                      <FieldLabel>{t("Action")}</FieldLabel>
                      <Select value={rule.action} onValueChange={(value) => updateRule(rule.id, { action: value as ApiRequestParameterRule["action"], value: value === "SET" ? rule.value : null })}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectGroup><SelectItem value="PASSTHROUGH">{t("Pass through")}</SelectItem><SelectItem value="SET">{t("Override")}</SelectItem><SelectItem value="REMOVE">{t("Remove")}</SelectItem></SelectGroup></SelectContent>
                      </Select>
                    </Field>
                    <Button aria-label={t("Remove rule")} className="self-end" onClick={() => setRules((current) => current.filter((candidate) => candidate.id !== rule.id))} size="icon" type="button" variant="ghost"><Trash2Icon /></Button>
                  </div>
                  {rule.action === "SET" ? <Field><FieldLabel>{t("Override value")}</FieldLabel><Input aria-label={t("Override value")} onChange={(event) => updateRule(rule.id, { value: event.target.value })} value={rule.value ?? ""} /></Field> : null}
                </div>
              )
            })}
            {rules.length === 0 ? <FieldDescription>{t("No override rules. All upstream parameters pass through.")}</FieldDescription> : null}
            {error ? <FieldError>{error}</FieldError> : null}
          </FieldGroup>
          <SheetFooter className="mt-auto border-t bg-background px-6 py-4">
            <Button onClick={() => setOpen(false)} type="button" variant="outline">{t("Cancel")}</Button>
            <Button disabled={submitting} type="submit">
              {submitting ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}
              {t(submitting ? "Saving…" : "Save request mapping")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
