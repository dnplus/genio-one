import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { PlayIcon, LoaderCircleIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { testResourceConnection, type ConnectionTestResult } from "@/lib/product-api"
import type { ConnectionSummary } from "@/domain/contracts"

export function ConnectionTestPanel({ tenantId, connection }: { tenantId: string; connection: ConnectionSummary }) {
  const { t } = useTranslation()
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ConnectionTestResult | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    if (connection.verification_state !== "VERIFIED") return
    setResult(null)
    setError("")
  }, [connection.connection_id, connection.verification_state])
  const unavailable = result?.reason_code === "CONNECTION_LIVE_TEST_UNAVAILABLE"
  async function run() {
    setRunning(true)
    setError("")
    setResult(null)
    try { setResult(await testResourceConnection(tenantId, connection.resource_id, connection.connection_id)) }
    catch (caught) { setError(caught instanceof Error ? caught.message : "CONNECTION_TEST_FAILED") }
    finally { setRunning(false) }
  }
  return <Card data-testid="connection-live-test">
    <CardHeader className="gap-1 border-b">
      <CardTitle>{t("Live connection test")}</CardTitle>
      <CardDescription>{t("Test the saved configuration without enabling or publishing the Connection.")}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
      <div><Button onClick={() => void run()} disabled={running || connection.lifecycle === "REVOKED"} variant="outline">
        {running ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}{t(running ? "Testing connection…" : "Test connection")}
      </Button></div>
      <p className="text-sm text-muted-foreground">{t(connection.connector_configuration ? "This tests the installed Connector transport. Each user must connect their account before the enterprise site and data access can be verified." : "This checks connectivity from the Control Plane. Runtime health and authorized invocation are verified separately.")}</p>
      {error ? <Alert variant="destructive"><AlertTitle>{t("Connection test unavailable")}</AlertTitle><AlertDescription>{t(error)}</AlertDescription></Alert> : null}
      {result ? <Alert variant={result.passed || unavailable ? "default" : "destructive"}>
        <AlertTitle>{t(unavailable ? "Connection test unavailable" : result.passed ? "Connection test passed" : "Connection test failed")}</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <span>{t(result.check)} {result.http_status !== null ? `HTTP ${result.http_status}` : ""}</span>
          {!result.passed ? <span>{t(result.reason_code)}</span> : null}
          <span>{new Date(result.checked_at * 1000).toLocaleString()} · {t("{{duration}} ms", { duration: result.duration_ms })} · {t("Revision")} {result.configuration_revision}</span>
          {!result.passed && !unavailable ? <span>{t("Check the endpoint, certificate and credential configuration, then retry.")}</span> : null}
          {result.configuration_revision !== connection.configuration_revision ? <span>{t("Configuration changed. Run the test again.")}</span> : null}
        </AlertDescription>
      </Alert> : null}
    </CardContent>
  </Card>
}
