import type {
  ApiGatewayActivityEvent,
  ApiGatewayTransactionDetail,
  GatewayActivitySessionTimeline,
  InvocationAccountingRecord,
  OutcomeAttribution,
  OverviewSnapshot,
  RoutingReconstruction,
} from "@/domain/contracts"
import {
  gatewayActivityDetailAvailability,
  shouldLoadGatewayActivityDetail,
} from "@/features/activity/activity-detail-policy"
import {
  createActivityDisplayDirectory,
  type ActivityDisplayDirectory,
} from "@/features/activity/activity-display"
import {
  listActivityOutcomeAttributions,
  loadApiGatewayTransactionDetail,
  loadGatewayActivitySessionTimeline,
  loadInvocationAccounting,
  loadRoutingReconstruction,
  ProductApiError,
} from "@/lib/product-api"

export type ActivityEvidenceSource = "detail" | "outcomes" | "session" | "routing" | "accounting"

export interface ActivityEvidence {
  accounting: InvocationAccountingRecord[]
  detail: ApiGatewayTransactionDetail
  display: ActivityDisplayDirectory
  errors: Partial<Record<ActivityEvidenceSource, string>>
  outcomeAttributions: OutcomeAttribution[]
  reconstruction: RoutingReconstruction | null
  sessionTimeline: GatewayActivitySessionTimeline | null
}

export interface ActivityEvidenceLoaders {
  detail: typeof loadApiGatewayTransactionDetail
  outcomes: typeof listActivityOutcomeAttributions
  session: typeof loadGatewayActivitySessionTimeline
  routing: typeof loadRoutingReconstruction
  accounting: typeof loadInvocationAccounting
}

const defaultLoaders: ActivityEvidenceLoaders = {
  detail: loadApiGatewayTransactionDetail,
  outcomes: listActivityOutcomeAttributions,
  session: loadGatewayActivitySessionTimeline,
  routing: loadRoutingReconstruction,
  accounting: loadInvocationAccounting,
}

function fallbackDetail(event: ApiGatewayActivityEvent): ApiGatewayTransactionDetail {
  return {
    correlation_id: event.correlation_id,
    availability: gatewayActivityDetailAvailability(event),
    captured_at: null,
    expires_at: event.detail_expires_at,
    redacted_fields: [],
    request: null,
    response: null,
  }
}

export async function loadActivityAccountingEvidence(input: {
  tenantId: string
  correlationId: string
  loader?: typeof loadInvocationAccounting
}): Promise<{ accounting: InvocationAccountingRecord[]; error: string | null }> {
  try {
    return {
      accounting: await (input.loader ?? loadInvocationAccounting)(input.tenantId, input.correlationId),
      error: null,
    }
  } catch {
    return { accounting: [], error: "Canonical accounting could not be loaded." }
  }
}

export async function loadActivityEvidence(input: {
  tenantId: string
  event: ApiGatewayActivityEvent
  data: Pick<OverviewSnapshot, "applications" | "connections" | "identity" | "resources">
  loaders?: ActivityEvidenceLoaders
}): Promise<ActivityEvidence> {
  const { tenantId, event, data } = input
  const loaders = input.loaders ?? defaultLoaders
  const errors: Partial<Record<ActivityEvidenceSource, string>> = {}
  const fallback = fallbackDetail(event)

  const detailPromise = shouldLoadGatewayActivityDetail(event)
    ? loaders.detail(tenantId, event).catch((error: unknown) => {
        if (!(error instanceof ProductApiError && error.status === 404)) {
          errors.detail = "Transaction detail could not be loaded."
        }
        return fallback
      })
    : Promise.resolve(fallback)
  const outcomesPromise = loaders.outcomes(tenantId, event.correlation_id).catch(() => {
    errors.outcomes = "Outcome attribution could not be loaded."
    return []
  })
  const sessionPromise = event.session_id
    ? loaders.session(tenantId, event.session_id).catch(() => {
        errors.session = "Session timeline could not be loaded."
        return null
      })
    : Promise.resolve(null)
  const routingPromise = loaders.routing(tenantId, event.correlation_id).catch(() => {
    errors.routing = "Routing reconstruction could not be loaded."
    return null
  })
  const accountingPromise = loadActivityAccountingEvidence({
    tenantId,
    correlationId: event.correlation_id,
    loader: loaders.accounting,
  })

  const [detail, outcomeAttributions, sessionTimeline, reconstruction, accountingEvidence] = await Promise.all([
    detailPromise,
    outcomesPromise,
    sessionPromise,
    routingPromise,
    accountingPromise,
  ])
  if (accountingEvidence.error) errors.accounting = accountingEvidence.error

  return {
    accounting: accountingEvidence.accounting,
    detail,
    display: createActivityDisplayDirectory(data),
    errors,
    outcomeAttributions,
    reconstruction,
    sessionTimeline,
  }
}
