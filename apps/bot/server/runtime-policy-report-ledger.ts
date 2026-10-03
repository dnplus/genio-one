import type { Database } from "bun:sqlite"

export interface PendingRuntimePolicyReport {
  tenantId: string
  correlationId: string
  body: string
  keyId: string
  signature: string
}

export interface StoredRuntimePolicyReport extends PendingRuntimePolicyReport {
  delivered: boolean
}

export class RuntimePolicyReportLedger {
  constructor(private readonly db: Database) {
    db.exec("pragma synchronous = full")
    db.exec(`create table if not exists runtime_policy_report_delivery (
      tenant_id text not null,
      correlation_id text not null,
      body text not null,
      key_id text not null,
      signature text not null,
      delivered_at integer,
      created_at integer not null,
      primary key (tenant_id, correlation_id)
    ); create index if not exists runtime_policy_report_delivery_pending on runtime_policy_report_delivery(delivered_at, created_at)`)
  }

  get(tenantId: string, correlationId: string): StoredRuntimePolicyReport | null {
    const row = this.db.query("select body, key_id, signature, delivered_at from runtime_policy_report_delivery where tenant_id = ? and correlation_id = ?").get(tenantId, correlationId) as { body: string; key_id: string; signature: string; delivered_at: number | null } | null
    return row ? { tenantId, correlationId, body: row.body, keyId: row.key_id, signature: row.signature, delivered: row.delivered_at !== null } : null
  }

  enqueue(report: PendingRuntimePolicyReport): StoredRuntimePolicyReport {
    const existing = this.get(report.tenantId, report.correlationId)
    if (existing) {
      if (existing.body !== report.body) throw new Error("RUNTIME_POLICY_REPORT_CORRELATION_CONFLICT")
      return existing
    }
    this.db.query("insert into runtime_policy_report_delivery (tenant_id, correlation_id, body, key_id, signature, created_at) values (?, ?, ?, ?, ?, ?)").run(report.tenantId, report.correlationId, report.body, report.keyId, report.signature, Date.now())
    return { ...report, delivered: false }
  }

  pending(): PendingRuntimePolicyReport[] {
    const rows = this.db.query("select tenant_id, correlation_id, body, key_id, signature from runtime_policy_report_delivery where delivered_at is null order by created_at, tenant_id, correlation_id").all() as Array<{ tenant_id: string; correlation_id: string; body: string; key_id: string; signature: string }>
    return rows.map((row) => ({ tenantId: row.tenant_id, correlationId: row.correlation_id, body: row.body, keyId: row.key_id, signature: row.signature }))
  }

  acknowledge(tenantId: string, correlationId: string): void {
    this.db.query("update runtime_policy_report_delivery set delivered_at = coalesce(delivered_at, ?) where tenant_id = ? and correlation_id = ?").run(Date.now(), tenantId, correlationId)
  }
}
