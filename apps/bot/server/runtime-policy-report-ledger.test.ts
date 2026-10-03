import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash, generateKeyPairSync } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createRuntimePolicyClient } from "./runtime-policy"
import { RuntimePolicyReportLedger } from "./runtime-policy-report-ledger"
import { runtimePolicyResponseVerificationKeys, signedRuntimePolicyReceipt } from "./runtime-policy-attestation-test-support"
import { RUNTIME_REPORT_KEY_ID_HEADER, RUNTIME_REPORT_SIGNATURE_HEADER, verifyRuntimeReport } from "../../../runtimes/gateway/services/shared/runtime-report-attestation"

const principal = { tenant_id: "tenant-report", subject_id: "user", acting_client_id: "genio-one-bot", scopes: ["genioone-invocation"] }
const keys = generateKeyPairSync("ed25519")
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
const rotatedPrivateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString()

function receipt(body: Record<string, unknown>, tenantId = "tenant-report") {
  return {
    tenant_id: tenantId,
    correlation_id: body.correlation_id,
    audit_event_id: `${body.correlation_id}:authorize:report`,
    authorization_audit_event_id: `${body.correlation_id}:authorize`,
    phase: "REPORT",
    report_outcome: body.outcome,
    bot_id: body.bot_id,
    runtime_id: body.runtime_id,
    capability_id: body.capability_id,
    action: body.action,
    session_id: body.session_id ?? null,
    reason_code: body.reason_code ?? "RULE_ALLOW",
  }
}

describe("runtime policy report ledger", () => {
  test("a persisted report stays pending without a Platform verifier and replays after configuration", async () => {
    const db = new Database(":memory:")
    try {
      const ledger = new RuntimePolicyReportLedger(db)
      let reportPosts = 0
      const fetch = async (_url: URL, init?: RequestInit) => {
        reportPosts++
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return signedRuntimePolicyReceipt(body, receipt(body))
      }
      const input = { principal, botId: "bot", capabilityId: "model.invoke" as const, action: "invoke" as const, correlationId: "verifier-later", outcome: "COMPLETED" as const }
      const first = createRuntimePolicyClient({ environment: {}, reportKeyId: "bot-report", reportPrivateKeyPem: privateKey, reportLedger: ledger, fetch })
      await first.report(input)
      expect(ledger.pending()).toHaveLength(1)
      const restarted = createRuntimePolicyClient({ environment: {}, reportKeyId: "bot-report", reportPrivateKeyPem: privateKey, responseVerificationKeys: runtimePolicyResponseVerificationKeys, reportLedger: ledger, fetch })
      await restarted.replayPendingReports?.()
      expect(ledger.pending()).toHaveLength(0)
      expect(reportPosts).toBe(2)
    } finally { db.close() }
  })

  test("stores only a reason class when a caller supplies exception text", async () => {
    const db = new Database(":memory:")
    try {
      const ledger = new RuntimePolicyReportLedger(db)
      const client = createRuntimePolicyClient({
        origin: "http://platform.test",
        reportKeyId: "bot-report",
        reportPrivateKeyPem: privateKey,
        responseVerificationKeys: runtimePolicyResponseVerificationKeys,
        reportLedger: ledger,
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return signedRuntimePolicyReceipt(body, receipt(body))
        },
      })
      await client.report({ principal, botId: "bot", capabilityId: "model.invoke", action: "invoke", correlationId: "classified-error", outcome: "FAILED", reasonCode: "Secret transcript from an exception" })
      const stored = db.query("select body from runtime_policy_report_delivery where correlation_id = 'classified-error'").get() as { body: string }
      expect(stored.body).toContain('"reason_code":"RUNTIME_ERROR"')
      expect(stored.body).not.toContain("Secret transcript")
    } finally { db.close() }
  })

  test("persists signed bytes before the first send and replays after restart without a user token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-report-ledger-"))
    const path = join(directory, "reports.sqlite")
    const first = new Database(path)
    let firstClosed = false
    try {
      const ledger = new RuntimePolicyReportLedger(first)
      let attempts = 0
      const client = createRuntimePolicyClient({
        origin: "http://platform.test",
        reportKeyId: "bot-report",
        reportPrivateKeyPem: privateKey,
        responseVerificationKeys: runtimePolicyResponseVerificationKeys,
        reportLedger: ledger,
        fetch: async (_url, init) => {
          attempts++
          const row = first.query("select body, key_id, signature, delivered_at from runtime_policy_report_delivery where tenant_id = ? and correlation_id = ?").get("tenant-report", "report-restart") as { body: string; key_id: string; signature: string; delivered_at: number | null } | null
          expect(row?.body).toBe(String(init?.body))
          expect(row?.key_id).toBe("bot-report")
          expect(row?.signature).toBeTruthy()
          expect(row?.delivered_at).toBeNull()
          return Response.json({ error: "UNAVAILABLE" }, { status: 503 })
        },
      })
      await client.report({ principal, botId: "bot", capabilityId: "model.invoke", action: "invoke", correlationId: "report-restart", outcome: "COMPLETED", accessToken: "ephemeral-user-token" })
      expect(attempts).toBe(1)
      expect(ledger.pending()).toHaveLength(1)
      const saved = ledger.get("tenant-report", "report-restart")!
      expect(JSON.parse(saved.body).tenant_id).toBe("tenant-report")
      const savedHash = createHash("sha256").update(saved.body).digest("hex")
      first.close()
      firstClosed = true

      const second = new Database(path)
      try {
        const restartedLedger = new RuntimePolicyReportLedger(second)
        const sent: Array<{ authorization: string | null; body: string; keyId: string | null; signature: string | null }> = []
        let acknowledged = false
        const restarted = createRuntimePolicyClient({
          origin: "http://platform.test",
          reportKeyId: "rotated-key",
          reportPrivateKeyPem: rotatedPrivateKey,
          responseVerificationKeys: runtimePolicyResponseVerificationKeys,
          reportLedger: restartedLedger,
          fetch: async (_url, init) => {
            const headers = new Headers(init?.headers)
            const body = String(init?.body)
            sent.push({ authorization: headers.get("authorization"), body, keyId: headers.get(RUNTIME_REPORT_KEY_ID_HEADER), signature: headers.get(RUNTIME_REPORT_SIGNATURE_HEADER) })
            const parsed = JSON.parse(body) as Record<string, unknown>
            if (!acknowledged && sent.length === 1) return signedRuntimePolicyReceipt(parsed, receipt(parsed), 200)
            if (!acknowledged) return signedRuntimePolicyReceipt(parsed, { ...receipt(parsed), correlation_id: "wrong" })
            return signedRuntimePolicyReceipt(parsed, receipt(parsed))
          },
        })
        await restarted.replayPendingReports?.()
        expect(restartedLedger.pending()).toHaveLength(1)
        await restarted.report({ principal, botId: "bot", capabilityId: "model.invoke", action: "invoke", correlationId: "report-restart", outcome: "COMPLETED" })
        await expect(restarted.report({ principal, botId: "bot", capabilityId: "model.invoke", action: "invoke", correlationId: "report-restart", outcome: "FAILED" })).rejects.toThrow("RUNTIME_POLICY_REPORT_CORRELATION_CONFLICT")
        acknowledged = true
        await restarted.replayPendingReports?.()
        expect(restartedLedger.pending()).toHaveLength(0)
        await restarted.report({ principal, botId: "bot", capabilityId: "model.invoke", action: "invoke", correlationId: "report-restart", outcome: "COMPLETED" })
        await restarted.replayPendingReports?.()
        expect(sent).toHaveLength(3)
        expect(sent.every((request) => request.authorization === null)).toBe(true)
        expect(sent.every((request) => request.body === saved.body && createHash("sha256").update(request.body).digest("hex") === savedHash)).toBe(true)
        expect(sent.every((request) => request.keyId === saved.keyId && request.signature === saved.signature)).toBe(true)
        expect(sent.every((request) => verifyRuntimeReport(JSON.parse(request.body), request.signature!, publicKey))).toBe(true)
      } finally {
        second.close()
      }
    } finally {
      if (!firstClosed) first.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("without a durable ledger delivery errors still fail and no intent is accepted without a signer", async () => {
    const report = { principal, botId: "bot", capabilityId: "model.invoke" as const, action: "invoke" as const, correlationId: "no-ledger", outcome: "COMPLETED" as const }
    const noLedger = createRuntimePolicyClient({ origin: "http://platform.test", reportKeyId: "bot-report", reportPrivateKeyPem: privateKey, fetch: async () => Response.json({ code: "UNAVAILABLE" }, { status: 503 }) })
    await expect(noLedger.report(report)).rejects.toThrow("RUNTIME_POLICY_REPORT_HTTP_503")

    const db = new Database(":memory:")
    try {
      const ledger = new RuntimePolicyReportLedger(db)
      const unsigned = createRuntimePolicyClient({ origin: "http://platform.test", environment: {}, reportLedger: ledger, fetch: async () => { throw new Error("REPORT_SHOULD_NOT_SEND") } })
      await expect(unsigned.report({ ...report, correlationId: "unsigned" })).rejects.toThrow("RUNTIME_POLICY_REPORT_SIGNER_UNAVAILABLE")
      expect(ledger.pending()).toHaveLength(0)
    } finally { db.close() }
  })
})
