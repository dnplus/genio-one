import { } from "@/components/relation-value"
import { PageHeader } from "@/components/page-header"
import { } from "@tanstack/react-table"
import {
  IdCardIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { } from "@/components/data-table/data-table"
import { } from "@/components/data-table/record-filter-bar"
import { DataEmpty } from "@/components/data-empty"
import { } from "@/components/ui/searchable-select"
import { } from "@/components/route-badge"
import { TitleHelp } from "@/components/title-help"
import { Badge } from "@/components/ui/badge"
import { } from "@/components/ui/button"
import { } from "@/components/ui/checkbox"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { } from "@/components/ui/input"
import { } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { IdentitySession, OverviewSnapshot } from "@/domain/contracts"
import { } from "@/features/provider-credentials/provider-credential-profiles-panel"
import { } from "@/features/access/access-request-sheet"
import { } from "@/features/access/grant-entitlement-sheet"
import { } from "@/features/access/execution-grant-requests-card"
import { } from "@/features/access/revoke-entitlement-sheet"
import { } from "@/features/activity/audit-decision-sheet"
import { } from "@/features/activity/ai-usage-dashboard"
import { } from "@/features/activity/usage-governance-panel"
import { } from "@/features/activity/activity-evidence"
import { } from "@/features/activity/activity-display"
import { } from "@/features/activity/api-gateway-transaction-sheet"
import { } from "@/features/activity/classify-discoveries-sheet"
import { } from "@/features/self-service/access-lifecycle"
export { ResourceCatalogPage as ResourcesPage } from "@/features/resources/resource-catalog-page"
import { } from "@/features/runtimes/register-gateway-sheet"
import { } from "@/features/runtimes/gateway-diagnostics-sheet"
import { CreateOrganizationSheet } from "@/features/identity/create-organization-sheet"
import { ManageOrganizationSheet } from "@/features/identity/manage-organization-sheet"
import { } from "@/features/identity/register-agent-sheet"
import { } from "@/features/identity/agent-delegations-card"
import { } from "@/features/identity/identity-providers-card"
import { } from "@/features/identity/suspend-person-action"
import { organizationAdministratorSubjectIds } from "@/domain/organization-roles"
import { } from "@/lib/personal-preferences"

export function OrganizationPage({
  tenantId,
  identity,
  data,
  onReload,
}: {
  tenantId: string
  identity: IdentitySession
  data: OverviewSnapshot
  onReload: () => Promise<void>
}) {
  const { t } = useTranslation()
  const peopleById = new Map((data.identity?.subjects ?? []).map((subject) => [subject.subject_id, subject]))
  const tenantAdministrators = data.identity?.tenant_administrators ?? []
  const canManageRoles = identity.role === "TENANT_ADMINISTRATOR" || identity.role === "ORGANIZATION_ADMINISTRATOR"
  const canCreateOrganization = identity.role === "TENANT_ADMINISTRATOR"
  const canViewTenantAdministrators = identity.role === "TENANT_ADMINISTRATOR"
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("Organization and roles")}
        description={t("Manage organization membership, roles, and data scope.")}
        actions={canCreateOrganization
          ? <CreateOrganizationSheet tenantId={tenantId} identity={data.identity} onCreated={onReload} />
          : undefined}
      />
      {canViewTenantAdministrators ? <Card>
        <CardHeader className="border-b">
          <CardTitle><TitleHelp help={t("Tenant-wide administration and data access across all organizations.")}>{t("Administrators")}</TitleHelp></CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {tenantAdministrators.map((subjectId) => <Badge key={subjectId} variant="secondary">{peopleById.get(subjectId)?.profile.display_name ?? subjectId}</Badge>)}
        </CardContent>
      </Card> : null}
      <Card>
        <CardHeader className="border-b">
          <CardTitle><TitleHelp help={t("Membership is maintained in GenioOne; Organization Administrators manage only their Organization.")}>{t("Organizations")}</TitleHelp></CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {data.organizations.length ? (
            <Table>
              <TableHeader><TableRow><TableHead>{t("Organization")}</TableHead><TableHead>{t("Membership source")}</TableHead><TableHead>{t("Members")}</TableHead><TableHead>{t("Organization Administrators")}</TableHead><TableHead>{t("Data scope")}</TableHead><TableHead className="text-right">{t("Actions")}</TableHead></TableRow></TableHeader>
              <TableBody>{data.organizations.map((organization) => {
                const organizationAdministrators = organizationAdministratorSubjectIds(organization)
                const users = organization.member_subject_ids
                return <TableRow key={organization.organization_id}>
                  <TableCell className="font-medium">{organization.display_name}</TableCell>
                  <TableCell><div className="flex flex-wrap gap-1">{(organization.membership_sources?.length ? organization.membership_sources : [{ kind: "MANUAL" as const, reference: "console", status: "SYNCED" as const }]).map((source) => <Badge key={`${source.kind}-${source.reference}`} variant={source.status === "ERROR" ? "destructive" : "outline"}>{t(source.kind)} · {source.reference} · {t(source.status)}</Badge>)}</div></TableCell>
                  <TableCell className="tabular-nums">{users.length}</TableCell>
                  <TableCell className="tabular-nums">{organizationAdministrators.length}</TableCell>
                  <TableCell>{t("Organization only")}</TableCell>
                  <TableCell className="text-right">{canManageRoles && (identity.role === "TENANT_ADMINISTRATOR" || (identity.organization_ids ?? []).includes(organization.organization_id)) ? <ManageOrganizationSheet tenantId={tenantId} organization={organization} identity={data.identity} subjectScope={identity.role === "TENANT_ADMINISTRATOR" ? "tenant" : "organization"} onSaved={onReload} /> : "—"}</TableCell>
                </TableRow>
              })}</TableBody>
            </Table>
          ) : <DataEmpty icon={IdCardIcon} title={t("No Organizations")} description={t("Create an Organization before assigning Users and administrative roles.")} />}
        </CardContent>
      </Card>
    </div>
  )
}
