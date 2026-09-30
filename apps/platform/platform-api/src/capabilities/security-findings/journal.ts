import { PlatformApiError } from "../errors"

export const REVOKED_AUTHORITY_CONTINUED_USE = "REVOKED_AUTHORITY_CONTINUED_USE"

export type RevokedAuthority =
  | { kind: "ENTITLEMENT"; entitlement_id: string }
  | { kind: "CREDENTIAL_GENERATION"; credential_id: string; generation: number }

export interface SecurityFindingEvidence {
  audit_event_ids: string[]
  correlation_ids: string[]
  upstream_attempted: boolean
  first_seen_at: number
  last_seen_at: number
  use_count: number
}

export interface SecurityFinding {
  finding_id: string
  tenant_id: string
  rule_id: typeof REVOKED_AUTHORITY_CONTINUED_USE
  severity: "HIGH"
  status: "OPEN" | "ACKNOWLEDGED" | "CLOSED"
  subject_id: string
  authority: RevokedAuthority
  evidence: SecurityFindingEvidence
  opened_at: number
  acknowledged_at: number | null
  closed_at: number | null
  dedupe_key: string
}

export interface SecurityFindingJournal {
  recordRevocation(input: {
    tenantId: string
    authority: RevokedAuthority
    revokedAt: number
    subjectId: string | null
  }): void
  observeUse(input: {
    tenantId: string
    subjectId: string
    occurredAt: number
    auditEventId: string
    correlationId: string
    upstreamAttempted: boolean
    authority: RevokedAuthority
  }): SecurityFinding | null
  list(tenantId: string): SecurityFinding[]
  acknowledge(input: { tenantId: string; findingId: string; at: number }): SecurityFinding
  close(input: { tenantId: string; findingId: string; at: number }): SecurityFinding
}

const EVIDENCE_ID_LIMIT = 32

function authorityKey(authority: RevokedAuthority): string {
  if (authority.kind === "ENTITLEMENT") return `entitlement:${authority.entitlement_id}`
  return `credential:${authority.credential_id}:${authority.generation}`
}

function cloneFinding(finding: SecurityFinding): SecurityFinding {
  return structuredClone(finding)
}

export function createSecurityFindingJournal(): SecurityFindingJournal {
  const revocations = new Map<string, number>()
  const findings = new Map<string, SecurityFinding>()
  const seenEvents = new Set<string>()
  let sequence = 0

  const findByEvent = (tenantId: string, auditEventId: string) =>
    [...findings.values()].find((finding) =>
      finding.tenant_id === tenantId && finding.evidence.audit_event_ids.includes(auditEventId))

  return {
    recordRevocation(input) {
      const key = `${input.tenantId}\0${authorityKey(input.authority)}`
      const existing = revocations.get(key)
      if (existing === undefined || input.revokedAt < existing) {
        revocations.set(key, input.revokedAt)
      }
    },

    observeUse(input) {
      if (!input.auditEventId || !input.subjectId) return null
      const eventKey = `${input.tenantId}\0${input.auditEventId}`
      if (seenEvents.has(eventKey)) return findByEvent(input.tenantId, input.auditEventId) ?? null
      const revokedAt = revocations.get(`${input.tenantId}\0${authorityKey(input.authority)}`)
      if (revokedAt === undefined || input.occurredAt <= revokedAt) return null

      const dedupeKey = `${input.tenantId}\0${authorityKey(input.authority)}\0${input.subjectId}`
      const related = [...findings.values()].filter((finding) => finding.dedupe_key === dedupeKey)
      const open = related.find((finding) => finding.status !== "CLOSED")
      if (!open) {
        const latestClosed = related
          .filter((finding) => finding.status === "CLOSED")
          .sort((left, right) => (right.closed_at ?? 0) - (left.closed_at ?? 0))[0]
        if (latestClosed && input.occurredAt <= (latestClosed.closed_at ?? 0)) return null
      }

      seenEvents.add(eventKey)
      if (open) {
        open.evidence.use_count += 1
        open.evidence.last_seen_at = Math.max(open.evidence.last_seen_at, input.occurredAt)
        open.evidence.first_seen_at = Math.min(open.evidence.first_seen_at, input.occurredAt)
        open.evidence.upstream_attempted = open.evidence.upstream_attempted || input.upstreamAttempted
        if (open.evidence.audit_event_ids.length < EVIDENCE_ID_LIMIT) {
          open.evidence.audit_event_ids.push(input.auditEventId)
        }
        if (
          open.evidence.correlation_ids.length < EVIDENCE_ID_LIMIT &&
          !open.evidence.correlation_ids.includes(input.correlationId)
        ) {
          open.evidence.correlation_ids.push(input.correlationId)
        }
        return cloneFinding(open)
      }

      sequence += 1
      const finding: SecurityFinding = {
        finding_id: `finding-${sequence}`,
        tenant_id: input.tenantId,
        rule_id: REVOKED_AUTHORITY_CONTINUED_USE,
        severity: "HIGH",
        status: "OPEN",
        subject_id: input.subjectId,
        authority: structuredClone(input.authority),
        evidence: {
          audit_event_ids: [input.auditEventId],
          correlation_ids: [input.correlationId],
          upstream_attempted: input.upstreamAttempted,
          first_seen_at: input.occurredAt,
          last_seen_at: input.occurredAt,
          use_count: 1,
        },
        opened_at: input.occurredAt,
        acknowledged_at: null,
        closed_at: null,
        dedupe_key: dedupeKey,
      }
      findings.set(finding.finding_id, finding)
      return cloneFinding(finding)
    },

    list(tenantId) {
      return [...findings.values()]
        .filter((finding) => finding.tenant_id === tenantId)
        .sort((left, right) => right.opened_at - left.opened_at || right.finding_id.localeCompare(left.finding_id))
        .map(cloneFinding)
    },

    acknowledge(input) {
      const finding = findings.get(input.findingId)
      if (!finding || finding.tenant_id !== input.tenantId) {
        throw new PlatformApiError("SECURITY_FINDING_NOT_FOUND", 404)
      }
      if (finding.status === "CLOSED") {
        throw new PlatformApiError("SECURITY_FINDING_STATE_CONFLICT", 409)
      }
      if (finding.status === "OPEN") {
        finding.status = "ACKNOWLEDGED"
        finding.acknowledged_at = input.at
      }
      return cloneFinding(finding)
    },

    close(input) {
      const finding = findings.get(input.findingId)
      if (!finding || finding.tenant_id !== input.tenantId) {
        throw new PlatformApiError("SECURITY_FINDING_NOT_FOUND", 404)
      }
      if (finding.status !== "CLOSED") {
        finding.status = "CLOSED"
        finding.closed_at = input.at
      }
      return cloneFinding(finding)
    },
  }
}
