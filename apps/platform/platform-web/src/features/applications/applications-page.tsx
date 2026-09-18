import { AppWindowIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { DataEmpty } from "@/components/data-empty"
import { TitleHelp } from "@/components/title-help"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { OverviewSnapshot } from "@/domain/contracts"
import { ApplicationAccessSheet } from "@/features/applications/application-access-sheet"
import { RegisterApplicationSheet } from "@/features/applications/register-application-sheet"
import { relativeTime } from "@/lib/format"

export function ApplicationsPage({
  tenantId,
  data,
  onRefresh,
}: {
  tenantId: string
  data: OverviewSnapshot
  onRefresh: () => Promise<void>
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight"><TitleHelp help={t("Organization-owned machine identities that can receive Entitlements without replacing the Person requester.")}>{t("Applications")}</TitleHelp></h1>
        </div>
        <RegisterApplicationSheet tenantId={tenantId} organizations={data.organizations} onRegistered={onRefresh} />
      </header>
      <Card>
        <CardHeader className="border-b">
          <CardTitle><TitleHelp help={t("Application IDs are generated once and remain the canonical Target Subject for access and credentials.")}>{t("Application Subjects")}</TitleHelp></CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {data.applications.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Application")}</TableHead>
                  <TableHead>{t("Application ID")}</TableHead>
                  <TableHead>{t("Owner Organization")}</TableHead>
                  <TableHead>{t("Registered by")}</TableHead>
                  <TableHead className="text-right">{t("Registered")}</TableHead>
                  <TableHead className="text-right">{t("Actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.applications.map((application) => (
                  <TableRow key={application.application_id}>
                    <TableCell className="font-medium">{application.display_name}</TableCell>
                    <TableCell className="font-mono text-xs">{application.application_id}</TableCell>
                    <TableCell>
                      {data.organizations.find((organization) => organization.organization_id === application.owner_organization_id)?.display_name ?? application.owner_organization_id}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{application.registered_by.subject_id}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{relativeTime(application.created_at)}</TableCell>
                    <TableCell className="text-right">
                      <ApplicationAccessSheet
                        tenantId={tenantId}
                        application={application}
                        data={data}
                        onChanged={onRefresh}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <DataEmpty
              icon={AppWindowIcon}
              title={t("No registered Applications")}
              description={data.organizations.length ? t("Register the first Organization-owned Application Subject.") : t("Create an Owner Organization before registering an Application.")}
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
