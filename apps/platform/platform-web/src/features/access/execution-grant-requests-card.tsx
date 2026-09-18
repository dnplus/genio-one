import { RelationValue } from "@/components/relation-value"
import { createActivityDisplayDirectory } from "@/features/activity/activity-display"
import { useState } from "react"
import { KeyRoundIcon, LoaderCircleIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { DataEmpty } from "@/components/data-empty"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ExecutionGrantRequest, OverviewSnapshot } from "@/domain/contracts"
import { formatEpochSeconds } from "@/lib/personal-preferences"
import { decideExecutionGrantRequest } from "@/lib/product-api"

export function ExecutionGrantRequestsCard({
  tenantId,
  data,
  requests,
  onChanged,
}: {
  tenantId: string
  data: OverviewSnapshot
  requests: ExecutionGrantRequest[]
  onChanged: () => Promise<void>
}) {
  const { t } = useTranslation()
  const display = createActivityDisplayDirectory(data)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")

  async function decide(request: ExecutionGrantRequest, decision: "APPROVE" | "DENY") {
    setBusy(request.request_id)
    setError("")
    try {
      await decideExecutionGrantRequest(tenantId, request.request_id, request.revision, decision, decision === "APPROVE" ? "Confirmed action digest" : "Action confirmation denied")
      await onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy("")
    }
  }

  return (
    <Card data-testid="execution-grant-requests">
      <CardHeader className="border-b"><div><CardTitle>{t("Execution Grant Requests")}</CardTitle><CardDescription>{t("One-time confirmation for an exact action digest; approval does not create an Entitlement.")}</CardDescription></div></CardHeader>
      <CardContent className="px-0">
        {requests.length ? <Table>
          <TableHeader><TableRow><TableHead>{t("Subject / Acting Client")}</TableHead><TableHead>{t("Resource / Capability")}</TableHead><TableHead>{t("Action digest")}</TableHead><TableHead>{t("State")}</TableHead><TableHead>{t("Expires")}</TableHead><TableHead className="text-right">{t("Action")}</TableHead></TableRow></TableHeader>
          <TableBody>{requests.map((request) => <TableRow key={request.request_id} data-testid={`execution-grant-request-${request.request_id}`}>
            <TableCell><RelationValue id={request.subject_id} label={display.subject(request.subject_id).label} /><RelationValue id={request.acting_client_id} label={display.application(request.acting_client_id).label} /></TableCell>
            <TableCell><RelationValue id={request.resource_id} label={display.resource(request.resource_id).label} /><RelationValue id={request.capability_id} label={display.capability(request.resource_id, request.capability_id).label} /></TableCell>
            <TableCell className="max-w-44 truncate font-mono text-xs" title={request.action_digest}>{request.action_digest}</TableCell>
            <TableCell><Badge variant={request.state === "DENIED" ? "destructive" : "secondary"}>{t(request.state)}</Badge>{request.execution_grant_id ? <div className="mt-1 font-mono text-xs text-muted-foreground">{request.execution_grant_id}</div> : null}</TableCell>
            <TableCell>{formatEpochSeconds(request.requested_expires_at)}</TableCell>
            <TableCell className="text-right">{request.state === "PENDING" ? <div className="flex justify-end gap-2"><Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void decide(request, "DENY")}>{t("Deny")}</Button><Button size="sm" disabled={Boolean(busy)} onClick={() => void decide(request, "APPROVE")}>{busy === request.request_id ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}{t("Confirm action")}</Button></div> : "—"}</TableCell>
          </TableRow>)}</TableBody>
        </Table> : <DataEmpty icon={KeyRoundIcon} title={t("No Execution Grant Requests")} description={t("High-risk actions awaiting Human confirmation appear here.")} />}
        {error ? <p className="px-6 py-3 text-sm text-destructive" role="alert">{t(error)}</p> : null}
      </CardContent>
    </Card>
  )
}
