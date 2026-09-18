import { RelationValue } from "@/components/relation-value"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { createActivityDisplayDirectory } from "@/features/activity/activity-display"
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangleIcon,
  CheckIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchXIcon,
  ShieldCheckIcon,
  UserRoundIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { DataEmpty } from "@/components/data-empty"
import { TitleHelp } from "@/components/title-help"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type {
  EntitlementAccessReview,
  IdentitySession,
  OverviewSnapshot,
  RiskLevel,
  SubjectRiskAssessment,
} from "@/domain/contracts"
import {
  completeAccessReview,
  createAccessReview,
  decideAccessReviewItem,
  ProductApiError,
  loadAccessReviews,
  loadEntitlementRisks,
} from "@/lib/product-api"

interface AccessGovernancePageProps {
  tenantId: string
  identity: IdentitySession
  data: OverviewSnapshot
}

const riskVariant = (level: RiskLevel) => level === "CRITICAL" || level === "HIGH" ? "destructive" : level === "MEDIUM" ? "secondary" : "outline"
const subjectCommandValue = (subject: NonNullable<OverviewSnapshot["identity"]>["subjects"][number]) => `${subject.profile.display_name ?? ""} ${subject.subject_id} ${subject.kind}`


export function AccessGovernancePage({ tenantId, identity, data }: AccessGovernancePageProps) {
  const { t } = useTranslation()
  const display = useMemo(() => createActivityDisplayDirectory(data), [data])
  const subjects = useMemo(() => data.identity?.subjects ?? [], [data.identity?.subjects])
  const [risks, setRisks] = useState<SubjectRiskAssessment[]>([])
  const [reviews, setReviews] = useState<EntitlementAccessReview[]>([])
  const [subjectId, setSubjectId] = useState("")
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewName, setReviewName] = useState("Quarterly access review")
  const [reviewerId, setReviewerId] = useState(identity.subject_id)
  const [reviewDeadlineDays, setReviewDeadlineDays] = useState("7")
  const [reviewNotifications, setReviewNotifications] = useState(true)
  const [busy, setBusy] = useState(true)
  const [reviewNotInstalled, setReviewNotInstalled] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [riskServiceUnavailable, setRiskServiceUnavailable] = useState(false)
  const [reviewServiceUnavailable, setReviewServiceUnavailable] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    const [riskResult, reviewResult] = await Promise.allSettled([loadEntitlementRisks(tenantId), loadAccessReviews(tenantId)])
    if (riskResult.status === "fulfilled") {
      setRisks(riskResult.value)
      setRiskServiceUnavailable(false)
    } else {
      setRiskServiceUnavailable(true)
    }
    if (reviewResult.status === "fulfilled") {
      setReviews(reviewResult.value)
      setReviewServiceUnavailable(false)
      setReviewNotInstalled(false)
    } else {
      setReviewServiceUnavailable(true)
      setReviewNotInstalled(reviewResult.reason instanceof ProductApiError && reviewResult.reason.status === 404)
    }
    setBusy(false)
  }, [tenantId])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (subjectId && subjects.some((subject) => subject.subject_id === subjectId)) return
    setSubjectId(subjects[0]?.subject_id ?? "")
  }, [subjectId, subjects])

  async function mutate(action: () => Promise<unknown>) {
    setBusy(true)
    setMutationError(null)
    try {
      await action()
      await load()
      return true
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  const selectedSubject = subjects.find((subject) => subject.subject_id === subjectId)
  const selectedSubjectName = selectedSubject?.profile.display_name ?? selectedSubject?.subject_id ?? t("Select a Subject")
  const selectedRisk = risks.find((risk) => risk.subject_id === subjectId)
  const selectedEntitlements = data.ownedEntitlements.filter((entitlement) =>
    entitlement.subject_id === subjectId && entitlement.state === "ACTIVE")
  const resourceCount = new Set(selectedEntitlements.map((entitlement) => entitlement.resource_id)).size
  const capabilityCount = new Set(selectedEntitlements.map((entitlement) =>
    `${entitlement.resource_id}:${entitlement.capability_id}`)).size

  async function createSelectedSubjectReview() {
    if (!subjectId || !reviewName.trim()) return
    const created = await mutate(() => createAccessReview(tenantId, {
      name: reviewName.trim(),
      scope: {
        subject_ids: [subjectId],
        subject_kinds: [],
        resource_ids: [],
        capability_ids: [],
        access_group_ids: [],
      },
      defaultReviewerId: reviewerId.trim() || null,
      deadline: Math.floor(Date.now() / 1000) + Number(reviewDeadlineDays) * 24 * 60 * 60,
      notificationsEnabled: reviewNotifications,
    }))
    if (created) setReviewOpen(false)
  }

  return <div className="flex flex-col gap-6 p-4 sm:p-6" data-testid="access-governance-page">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-[1.75rem]"><TitleHelp help={t("Review frozen active Entitlements without reconstructing One Policy in the browser.")}>{t("Access reviews")}</TitleHelp></h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("Select a Subject, inspect current Entitlement scope, and run an explicit review.")}</p>
      </div>
      <Button variant="outline" onClick={() => void load()} disabled={busy}>{busy ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon />}{t("Refresh")}</Button>
    </div>

    {riskServiceUnavailable || reviewServiceUnavailable ? <Alert>
      <AlertTriangleIcon />
      <AlertTitle>{t(reviewNotInstalled ? "Access review service is not installed" : "Risk scoring is not provided by this deployment")}</AlertTitle>
      <AlertDescription>{t(reviewNotInstalled ? "This deployment does not provide access review APIs. Current entitlements remain available below; creating reviews requires deploying the review service." : "Entitlement risk scores are not available, so none are shown. The entitlement inventory below is the current access evidence and is complete.")}</AlertDescription>
    </Alert> : null}

    {mutationError ? <p role="alert" className="text-sm text-destructive">{mutationError}</p> : null}
    <div className="grid w-full min-w-0 gap-4 2xl:grid-cols-[20rem_minmax(0,1fr)]">
      <Card>
        <CardHeader><CardTitle>{t("Subjects")}</CardTitle><CardDescription>{t("Choose a person, application or agent to review.")}</CardDescription></CardHeader>
        <CardContent className="p-2 pt-0">
          <Command className="border bg-transparent" value={selectedSubject ? subjectCommandValue(selectedSubject) : undefined} onValueChange={(value) => {
            const subject = subjects.find((candidate) => subjectCommandValue(candidate) === value)
            if (subject) setSubjectId(subject.subject_id)
          }}>
            <CommandInput placeholder={t("Search Subjects")} />
            <CommandList><CommandEmpty>{t("No Subjects found")}</CommandEmpty><CommandGroup>
              {subjects.map((subject) => {
                const entitlementCount = data.ownedEntitlements.filter((entitlement) => entitlement.subject_id === subject.subject_id && entitlement.state === "ACTIVE").length
                const risk = risks.find((candidate) => candidate.subject_id === subject.subject_id)
                return <CommandItem key={subject.subject_id} value={subjectCommandValue(subject)} data-checked={subject.subject_id === subjectId} onSelect={() => setSubjectId(subject.subject_id)}>
                  <UserRoundIcon />
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium">{subject.profile.display_name ?? subject.subject_id}</span><span className="block truncate text-xs text-muted-foreground">{t(subject.kind)} · {entitlementCount} {t("active Entitlements")}</span></span>
                  {risk ? <Badge variant={riskVariant(risk.level)}>{risk.score}</Badge> : null}
                </CommandItem>
              })}
            </CommandGroup></CommandList>
          </Command>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle>{selectedSubjectName}</CardTitle><CardDescription>{selectedSubject ? `${t(selectedSubject.kind)} · ${resourceCount} ${t("Resources")} · ${capabilityCount} ${t("Capabilities")}` : t("Select a Subject")}</CardDescription></div><div className="flex items-center gap-2">{selectedRisk ? <Badge variant={riskVariant(selectedRisk.level)}>{t("Risk")} {selectedRisk.score}</Badge> : null}<Button disabled={busy || reviewServiceUnavailable || !selectedSubject} onClick={() => setReviewOpen(true)}><ShieldCheckIcon />{t("Create access review")}</Button></div></div></CardHeader>
        <CardContent>{selectedSubject ? <div className="grid gap-3 sm:grid-cols-3"><div className="rounded-lg border p-3"><div className="text-2xl font-semibold">{selectedEntitlements.length}</div><div className="text-xs text-muted-foreground">{t("Active Entitlements")}</div></div><div className="rounded-lg border p-3"><div className="text-2xl font-semibold">{resourceCount}</div><div className="text-xs text-muted-foreground">{t("Resources")}</div></div><div className="rounded-lg border p-3"><div className="text-2xl font-semibold">{capabilityCount}</div><div className="text-xs text-muted-foreground">{t("Capabilities")}</div></div></div> : <DataEmpty icon={UserRoundIcon} title={t("Select a Subject")} description={t("Select a Subject to inspect current Entitlement scope.")} />}</CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle>{t("Access reviews")}</CardTitle><CardDescription>{t("Review a frozen Subject scope and retain or revoke each active Entitlement.")}</CardDescription></div><Button disabled={busy || reviewServiceUnavailable || !selectedSubject} onClick={() => setReviewOpen(true)}><ShieldCheckIcon />{t("Create access review")}</Button></div></CardHeader>
      <CardContent className="space-y-4">
        {reviews.map((review) => <Card key={review.review_id} size="sm" data-testid={`access-review-${review.review_id}`}>
          <CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle>{review.name}</CardTitle><CardDescription>{review.items.filter((item) => item.decision).length}/{review.items.length} {t("decided")}</CardDescription></div><div className="flex items-center gap-2"><Badge variant={review.state === "COMPLETED" ? "outline" : "secondary"}>{review.state}</Badge>{review.report ? <Button variant="outline" onClick={() => { const blob = new Blob([JSON.stringify(review.report, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${review.report!.report_id}.json`; anchor.click(); URL.revokeObjectURL(url) }}>{t("Export report")}</Button> : null}{review.state === "OPEN" ? <Button disabled={busy || review.items.some((item) => !item.decision)} onClick={() => void mutate(() => completeAccessReview(tenantId, review.review_id))}><CheckIcon />{t("Complete review")}</Button> : null}</div></div></CardHeader>
          <CardContent className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>{t("Subject")}</TableHead><TableHead>{t("Resource")}</TableHead><TableHead>{t("Capability")}</TableHead><TableHead>{t("Risk")}</TableHead><TableHead>{t("Reviewer")}</TableHead><TableHead>{t("Decision")}</TableHead></TableRow></TableHeader><TableBody>{review.items.map((item) => <TableRow key={item.entitlement_id}><TableCell><RelationValue id={item.subject_id} label={display.subject(item.subject_id).label} /></TableCell><TableCell><RelationValue id={item.resource_id} label={display.resource(item.resource_id).label} href={`?view=resources&resource=${encodeURIComponent(item.resource_id)}`} /></TableCell><TableCell>{display.capability(item.resource_id, item.capability_id).label}</TableCell><TableCell><Badge variant={riskVariant(item.risk.level)}>{item.risk.level} {item.risk.score}</Badge></TableCell><TableCell><RelationValue id={item.reviewer_id} label={display.subject(item.reviewer_id).label} /></TableCell><TableCell>{item.decision ? <span className="text-sm">{t(item.decision.decision)}{item.revoked ? ` · ${t("revoked")}` : ""}</span> : item.reviewer_id === identity.subject_id ? <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void mutate(() => decideAccessReviewItem(tenantId, review.review_id, item.entitlement_id, "RETAIN", "Continued access remains required"))}>{t("Retain")}</Button><Button size="sm" variant="destructive" onClick={() => void mutate(() => decideAccessReviewItem(tenantId, review.review_id, item.entitlement_id, "REVOKE", "Continued access is no longer required"))}>{t("Recommend revoke")}</Button></div> : <span className="text-xs text-muted-foreground">{t("Awaiting assigned reviewer")}</span>}</TableCell></TableRow>)}</TableBody></Table></CardContent>
        </Card>)}
        {reviews.length === 0 && !busy ? <DataEmpty icon={reviewServiceUnavailable ? SearchXIcon : ShieldCheckIcon} title={reviewServiceUnavailable ? t("Review service unavailable") : t("No access reviews")} description={reviewServiceUnavailable ? t(reviewNotInstalled ? "Deploy the access review service to enable reviews." : "Try again after the Product API is available.") : t("Select a Subject and create a focused access review.")} /> : null}
      </CardContent>
    </Card>

    <Sheet open={reviewOpen} onOpenChange={setReviewOpen}>
      <SheetContent presentation="side" className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t("Create access review")}</SheetTitle>
          <SheetDescription>{t("Freeze the selected Subject's active Entitlements for explicit retain or revoke decisions.")}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="review-name">{t("Review name")}</FieldLabel>
              <Input id="review-name" value={reviewName} onChange={(event) => setReviewName(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel>{t("Scope")}</FieldLabel>
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="font-medium">{selectedSubjectName}</p>
                <p className="mt-1 text-sm text-muted-foreground">{resourceCount} {t("Resources")} · {capabilityCount} {t("Capabilities")}</p>
              </div>
              <FieldDescription>{t("The system resolves Resource and Capability IDs from the selected Subject when the review starts.")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="reviewer">{t("Default reviewer")}</FieldLabel>
              <SearchableSelect id="reviewer" value={reviewerId} options={subjects.filter((subject) => subject.kind === "PERSON").map((subject) => ({ value: subject.subject_id, label: subject.profile.display_name ?? subject.profile.email ?? subject.subject_id }))} onValueChange={setReviewerId} placeholder={t("Select a person")} searchPlaceholder={t("Search people")} emptyLabel={t("No results.")} />
            </Field>
            <Field>
              <FieldLabel>{t("Deadline")}</FieldLabel>
              <Select value={reviewDeadlineDays} onValueChange={setReviewDeadlineDays}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>
                  {["7", "14", "30"].map((days) => <SelectItem key={days} value={days}>{t("{{count}} days", { count: Number(days) })}</SelectItem>)}
                </SelectGroup></SelectContent>
              </Select>
            </Field>
            <Field orientation="horizontal">
              <FieldContent><FieldTitle>{t("Notifications")}</FieldTitle><FieldDescription>{t("Notify the reviewer about assignments and deadline changes.")}</FieldDescription></FieldContent>
              <Switch checked={reviewNotifications} onCheckedChange={setReviewNotifications} aria-label={t("Notifications")} />
            </Field>
          </FieldGroup>
        </div>
        <SheetFooter>
          <Button variant="outline" onClick={() => setReviewOpen(false)}>{t("Cancel")}</Button>
          <Button disabled={busy || reviewServiceUnavailable || !subjectId || !reviewName.trim()} onClick={() => void createSelectedSubjectReview()}>{busy ? <LoaderCircleIcon className="animate-spin" /> : <ShieldCheckIcon />}{t("Create review")}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  </div>
}
