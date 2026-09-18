import { randomUUID } from "node:crypto"

import type { UsageCounterStore } from "./usage-governance"
import type { ExecutionGrantConsumer } from "./execution-grant"

export interface ValkeyEvalClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

const admissionScript = `
local previous = redis.call('GET', KEYS[1])
if previous then return previous end
local policies = cjson.decode(ARGV[1])
for index, policy in ipairs(policies) do
  local base = 2 + ((index - 1) * 5)
  if policy.quota_limit >= 0 and tonumber(redis.call('GET', KEYS[base]) or '0') >= policy.quota_limit then
    return cjson.encode({admitted=false, policy_index=index-1, reason='QUOTA_EXHAUSTED'})
  end
  if policy.concurrency_limit >= 0 and tonumber(redis.call('GET', KEYS[base+1]) or '0') >= policy.concurrency_limit then
    return cjson.encode({admitted=false, policy_index=index-1, reason='CONCURRENCY_EXHAUSTED'})
  end
  if policy.credit_limit >= 0 and tonumber(redis.call('GET', KEYS[base+2]) or '0') + policy.credit_amount > policy.credit_limit then
    return cjson.encode({admitted=false, policy_index=index-1, reason='CREDIT_EXHAUSTED'})
  end
  if policy.cost_limit >= 0 and tonumber(redis.call('GET', KEYS[base+3]) or '0') + policy.cost_amount > policy.cost_limit then
    return cjson.encode({admitted=false, policy_index=index-1, reason='COST_BUDGET_EXHAUSTED'})
  end
end
local leases = {}
for index, policy in ipairs(policies) do
  local base = 2 + ((index - 1) * 5)
  if policy.quota_limit >= 0 then redis.call('INCR', KEYS[base]); redis.call('EXPIRE', KEYS[base], policy.quota_window) end
  if policy.concurrency_limit >= 0 then
    redis.call('INCR', KEYS[base+1]); redis.call('EXPIRE', KEYS[base+1], policy.concurrency_ttl)
    redis.call('SET', KEYS[base+4], KEYS[base+1], 'EX', policy.concurrency_ttl)
    table.insert(leases, policy.lease_id)
  end
  if policy.credit_limit >= 0 then redis.call('INCRBY', KEYS[base+2], policy.credit_amount) end
  if policy.cost_limit >= 0 then redis.call('INCRBY', KEYS[base+3], policy.cost_amount); redis.call('EXPIRE', KEYS[base+3], policy.cost_window) end
end
local leases_json = #leases == 0 and '[]' or cjson.encode(leases)
local result = '{"admitted":true,"concurrency_lease_ids":' .. leases_json .. '}'
redis.call('SET', KEYS[1], result, 'EX', 86400)
return result
`

const releaseScript = `
local counter = redis.call('GET', KEYS[1])
if counter and redis.call('DEL', KEYS[1]) == 1 then
  local current = tonumber(redis.call('GET', counter) or '0')
  if current > 0 then redis.call('DECR', counter) end
end
return 1
`

const settlementScript = `
local previous = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
local delta = amount - previous
if delta ~= 0 then redis.call('INCRBY', KEYS[2], delta) end
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
redis.call('SET', KEYS[1], amount)
return delta
`

const executionGrantScript = `
local existing = redis.call('GET', KEYS[1])
if existing then
  if existing == ARGV[1] then return 'CONSUMED' end
  return 'ALREADY_CONSUMED'
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]), 'NX')
return 'CONSUMED'
`

function result(value: unknown): Awaited<ReturnType<UsageCounterStore["admitBatch"]>> {
  const parsed = JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : String(value)) as Record<string, unknown>
  if (parsed.admitted === true && Array.isArray(parsed.concurrency_lease_ids) && parsed.concurrency_lease_ids.every((entry) => typeof entry === "string")) {
    return { admitted: true, concurrency_lease_ids: parsed.concurrency_lease_ids as string[] }
  }
  const reasons = ["QUOTA_EXHAUSTED", "CONCURRENCY_EXHAUSTED", "CREDIT_EXHAUSTED", "COST_BUDGET_EXHAUSTED"] as const
  if (parsed.admitted === false && Number.isSafeInteger(parsed.policy_index) && Number(parsed.policy_index) >= 0 && reasons.includes(parsed.reason as typeof reasons[number])) {
    return {
      admitted: false,
      policy_index: Number(parsed.policy_index),
      reason: parsed.reason as typeof reasons[number],
    }
  }
  throw new Error("VALKEY_ADMISSION_RESPONSE_INVALID")
}

export function createValkeyExecutionGrantConsumer(client: ValkeyEvalClient): ExecutionGrantConsumer {
  return {
    async consume(input) {
      const ttl = Math.max(1, input.expires_at - input.now)
      const value = await client.eval(executionGrantScript, {
        keys: [`genio:execution-grant:${input.tenant_id}:${input.execution_grant_id}`],
        arguments: [input.correlation_id, String(ttl)],
      })
      const result = Buffer.isBuffer(value) ? value.toString("utf8") : String(value)
      if (result === "CONSUMED" || result === "ALREADY_CONSUMED") return result
      throw new Error("VALKEY_EXECUTION_GRANT_RESPONSE_INVALID")
    },
  }
}

export function createValkeyUsageCounterStore(client: ValkeyEvalClient): UsageCounterStore {
  return {
    async admitBatch(input) {
      const keys = [`genio:usage:operation:${input.operation_id}`]
      const policies = input.policies.map((policy) => {
        const quotaWindow = policy.request_quota?.window_seconds ?? 1
        const costWindow = policy.currency_budget?.window_seconds ?? 1
        const leaseId = policy.concurrency ? `usage-lease-${randomUUID()}` : ""
        const prefix = `genio:usage:${policy.accounting_key_id}`
        const scopedPrefix = `${prefix}:${policy.counter_namespace}`
        keys.push(
          `${scopedPrefix}:quota:${Math.floor(input.now / quotaWindow)}`,
          `${scopedPrefix}:concurrency`,
          `${prefix}:credit:${policy.credit_budget?.allocation_id ?? "none"}`,
          `${prefix}:cost:${policy.currency_budget?.allocation_id ?? "none"}:${Math.floor(input.now / costWindow)}`,
          `genio:usage:lease-index:${leaseId || "none"}`,
        )
        return {
          quota_limit: policy.request_quota?.limit ?? -1,
          quota_window: quotaWindow,
          concurrency_limit: policy.concurrency?.limit ?? -1,
          concurrency_ttl: policy.concurrency?.lease_ttl_seconds ?? 1,
          lease_id: leaseId,
          credit_limit: policy.credit_budget?.limit ?? -1,
          credit_amount: policy.credit_budget?.amount ?? 0,
          cost_limit: policy.currency_budget?.limit_micros ?? -1,
          cost_amount: policy.currency_budget?.reserve_micros ?? 0,
          cost_window: costWindow,
        }
      })
      return result(await client.eval(admissionScript, {
        keys,
        arguments: [JSON.stringify(policies)],
      }))
    },
    async releaseConcurrency(input) {
      await client.eval(releaseScript, {
        keys: [`genio:usage:lease-index:${input.lease_id}`],
        arguments: [],
      })
    },
    async settleCurrency(input) {
      const prefix = `genio:usage:${input.accounting_key_id}`
      await client.eval(settlementScript, {
        keys: [
          `${prefix}:settlement:${input.allocation_id}:${input.settlement_id}`,
          `${prefix}:cost:${input.allocation_id}:${input.window_bucket}`,
        ],
        arguments: [String(input.amount_micros), String(input.window_seconds)],
      })
    },
  }
}
