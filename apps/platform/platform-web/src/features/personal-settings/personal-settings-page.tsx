import {
  BellIcon,
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  PlusIcon,
  SaveIcon,
  UserRoundIcon,
} from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { PageHeader } from "@/components/page-header"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import type { IdentitySession } from "@/domain/contracts"
import { changeConsoleLanguage, type ConsoleLanguage } from "@/i18n"
import {
  loadPersonalPreferences,
  savePersonalPreferences,
  type ConsoleTimeZone,
} from "@/lib/personal-preferences"

interface PersonalSettingsPageProps {
  identity: IdentitySession
  mockMode: boolean
}

function PreferenceSwitch({
  checked,
  description,
  label,
  onCheckedChange,
}: {
  checked: boolean
  description: string
  label: string
  onCheckedChange: (checked: boolean) => void
}) {
  const id = `personal-notification-${label.toLocaleLowerCase().replaceAll(" ", "-")}`
  return (
    <Field className="border-b py-4 last:border-b-0" orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch checked={checked} id={id} onCheckedChange={onCheckedChange} />
    </Field>
  )
}

export function PersonalSettingsPage({ identity, mockMode }: PersonalSettingsPageProps) {
  const { t, i18n } = useTranslation()
  const keyId = "gok_personal_••••••••e91a"
  const initialPreferences = loadPersonalPreferences(identity.subject_id)
  const [timezone, setTimezone] = useState(initialPreferences.timezone)
  const [accessNotifications, setAccessNotifications] = useState(initialPreferences.accessNotifications)
  const [securityNotifications, setSecurityNotifications] = useState(initialPreferences.securityNotifications)
  const [productNotifications, setProductNotifications] = useState(initialPreferences.productNotifications)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [hasApiKey, setHasApiKey] = useState(mockMode)
  const [issuedSecret, setIssuedSecret] = useState<string | null>(null)

  function savePreferences() {
    savePersonalPreferences(identity.subject_id, {
      timezone: timezone as ConsoleTimeZone,
      accessNotifications,
      securityNotifications,
      productNotifications,
    })
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2000)
  }

  async function copyKeyId() {
    await navigator.clipboard.writeText(keyId)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  function createApiKey() {
    if (!mockMode) return
    setIssuedSecret(`gok_personal_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`)
    setHasApiKey(true)
  }

  function revokeApiKey() {
    if (!mockMode) return
    setHasApiKey(false)
    setIssuedSecret(null)
  }

  return (
    <div className="flex flex-col gap-5" data-testid="personal-settings-page">
      <PageHeader
        title={t("Personal settings")}
        description={t("Manage your profile, preferences, notifications, and personal API keys.")}
      />

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2"><UserRoundIcon className="size-5" />{t("Profile and preferences")}</CardTitle>
          <CardDescription>{t("These settings apply only to your signed-in account.")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Item variant="muted">
            <ItemMedia>
              <Avatar className="size-12">
                <AvatarFallback>TA</AvatarFallback>
              </Avatar>
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{identity.subject_id}</ItemTitle>
              <ItemDescription>{identity.tenant_id}</ItemDescription>
            </ItemContent>
            <ItemActions><Badge variant="secondary">{t("Signed-in account")}</Badge></ItemActions>
          </Item>
          <Separator />
          <FieldGroup className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel>{t("Language")}</FieldLabel>
              <Select value={i18n.resolvedLanguage} onValueChange={(value) => void changeConsoleLanguage(value as ConsoleLanguage)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="en">{t("English")}</SelectItem>
                    <SelectItem value="zh-TW">{t("Traditional Chinese")}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>{t("Changes the language used by this console.")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>{t("Time zone")}</FieldLabel>
              <Select value={timezone} onValueChange={(value) => setTimezone(value as ConsoleTimeZone)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="Asia/Taipei">{t("Asia/Taipei (UTC+8)")}</SelectItem>
                    <SelectItem value="Asia/Tokyo">{t("Asia/Tokyo (UTC+9)")}</SelectItem>
                    <SelectItem value="America/Los_Angeles">{t("America/Los_Angeles")}</SelectItem>
                    <SelectItem value="Europe/London">{t("Europe/London")}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>{t("Dates and activity times use this time zone.")}</FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2"><BellIcon className="size-5" />{t("Notification preferences")}</CardTitle>
          <CardDescription>{t("Choose which events should notify you in the console.")}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <PreferenceSwitch checked={accessNotifications} label={t("Access requests and approvals")} description={t("Notify me when an access request needs my attention or changes state.")} onCheckedChange={setAccessNotifications} />
            <PreferenceSwitch checked={securityNotifications} label={t("Security alerts")} description={t("Notify me about elevated risk, policy blocks, and credential events.")} onCheckedChange={setSecurityNotifications} />
            <PreferenceSwitch checked={productNotifications} label={t("Product updates")} description={t("Notify me about relevant product changes and maintenance.")} onCheckedChange={setProductNotifications} />
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2"><KeyRoundIcon className="size-5" />{t("Personal API keys")}</CardTitle>
          <CardDescription>{t("Use personal keys only for tools and scripts acting as your account.")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {issuedSecret ? (
            <Alert>
              <KeyRoundIcon />
              <AlertTitle>{t("Copy this API key now")}</AlertTitle>
              <AlertDescription>
                <p>{t("It will not be shown again after you leave this page.")}</p>
              </AlertDescription>
              <InputGroup className="col-span-full mt-2 h-10">
                <InputGroupInput className="font-mono" readOnly value={issuedSecret} aria-label={t("One-time API key")} />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton aria-label={t("Copy")} onClick={() => void navigator.clipboard.writeText(issuedSecret)}>
                    <CopyIcon />{t("Copy")}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </Alert>
          ) : null}
          {hasApiKey ? (
            <Item variant="outline">
              <ItemContent>
                <ItemTitle>
                  <span className="font-medium">{t("Development CLI")}</span>
                  <Badge variant="secondary">{t("Active")}</Badge>
                  {mockMode ? <Badge variant="outline">{t("Mock data")}</Badge> : null}
                </ItemTitle>
                <ItemDescription className="font-mono">{keyId}</ItemDescription>
                <ItemDescription>{t("Created 12 days ago · Last used 2 hours ago")}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button aria-label={t("Copy key ID")} onClick={() => void copyKeyId()} size="sm" variant="outline">
                  {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}{copied ? t("Copied") : t("Copy key ID")}
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="destructive">{t("Revoke")}</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("Revoke personal API key?")}</AlertDialogTitle>
                      <AlertDialogDescription>{t("Tools using this key will lose access immediately. This action cannot be undone.")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={revokeApiKey}>{t("Revoke API key")}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </ItemActions>
            </Item>
          ) : (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon"><KeyRoundIcon /></EmptyMedia>
                <EmptyTitle>{t("No personal API keys")}</EmptyTitle>
                <EmptyDescription>{t(mockMode ? "Create a key when a local tool needs to act as your account." : "Personal API key issuance is not available in this deployment. Use an Application credential for tool integration.")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
        <CardFooter className="justify-between gap-3">
          <p className="text-xs text-muted-foreground">{t("A new key is shown once. Store it in a secret manager.")}</p>
          <Button disabled={!mockMode || hasApiKey} onClick={createApiKey} variant="outline"><PlusIcon data-icon="inline-start" />{t("Create API key")}</Button>
        </CardFooter>
      </Card>

      <div className="sticky bottom-4 flex justify-end">
        <Button onClick={savePreferences} className="shadow-lg">
          {saved ? <CheckIcon data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}{saved ? t("Saved") : t("Save personal settings")}
        </Button>
      </div>
    </div>
  )
}
