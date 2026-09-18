import assert from "node:assert/strict"
import test from "node:test"

import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"
import { INSTALLED_SERVICE_RESOURCE_IDS, seedInstalledServices } from "../src/capabilities/installed-services/seed"

type SeedResource = {
  installation_owned: boolean
  service_kind: string
  display_name: string
}

type SeedConnection = {
  endpoint: string
  connector_configuration: unknown
  lifecycle: string
  health_state: string
  health_observed_at: unknown
  health_source_revision: number | null
}

class SeedSql implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []
  readonly resources = new Map<string, SeedResource>()
  readonly connections = new Map<string, SeedConnection>()

  async query<Result extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    const normalized = text.toLowerCase()
    const tenantId = String(parameters[0] ?? "")
    if (normalized.includes("insert into genio_one_organizations")) return { rows: [], rowCount: 0 }
    if (normalized.includes("insert into genio_one_resources")) {
      const discovery = normalized.includes("'genio-one-discovery'")
      const resourceId = discovery ? "genio-one-discovery" : String(parameters[1])
      const serviceKind = discovery ? "DISCOVERY" : String(parameters[7])
      if (this.resources.has(`${tenantId}:${resourceId}`)) return { rows: [], rowCount: 0 }
      this.resources.set(`${tenantId}:${resourceId}`, {
        installation_owned: true,
        service_kind: serviceKind,
        display_name: discovery ? "GenioOne Discovery" : String(parameters[2]),
      })
      return { rows: [{ resource_id: resourceId } as unknown as Result], rowCount: 1 }
    }
    if (normalized.includes("select installation_owned, service_kind")) {
      const resourceId = String(parameters[1])
      const resource = this.resources.get(`${tenantId}:${resourceId}`)
      return { rows: resource ? [resource as unknown as Result] : [], rowCount: resource ? 1 : 0 }
    }
    if (normalized.includes("select builtin_service")) {
      const resource = this.resources.get(`${tenantId}:genio-one-discovery`)
      return { rows: resource ? [{ builtin_service: "DISCOVERY" } as unknown as Result] : [], rowCount: resource ? 1 : 0 }
    }
    if (normalized.includes("insert into genio_one_resource_connections")) {
      const discovery = normalized.includes("'genio-one-discovery'")
      const resourceId = discovery ? "genio-one-discovery" : String(parameters[1])
      const connectionId = discovery ? "genio-one-discovery" : String(parameters[2])
      const key = `${tenantId}:${resourceId}:${connectionId}`
      if (this.connections.has(key)) return { rows: [], rowCount: 0 }
      this.connections.set(key, {
        endpoint: discovery ? String(parameters[1]) : String(parameters[5]),
        connector_configuration: null,
        lifecycle: discovery ? "ENABLED" : String(parameters[10]),
        health_state: discovery ? "HEALTHY" : String(parameters[12]),
        health_observed_at: discovery ? "seeded" : String(parameters[12]) === "HEALTHY" ? "seeded" : null,
        health_source_revision: discovery ? 1 : String(parameters[12]) === "HEALTHY" ? 1 : null,
      })
      return { rows: [], rowCount: 0 }
    }
    if (normalized.includes("select connection_id, endpoint, connector_configuration")) {
      const resourceId = String(parameters[1])
      const connectionId = String(parameters[2])
      const connection = this.connections.get(`${tenantId}:${resourceId}:${connectionId}`)
      return { rows: connection ? [{ connection_id: connectionId, ...connection } as unknown as Result] : [], rowCount: connection ? 1 : 0 }
    }
    if (normalized.includes("update genio_one_resource_connections")) {
      const resourceId = String(parameters[1])
      const connectionId = String(parameters[2])
      const connection = this.connections.get(`${tenantId}:${resourceId}:${connectionId}`)
      if (connection) connection.endpoint = String(parameters[3])
      return { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 0 }
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

test("installed service seed is fixed-idempotent and preserves configured disabled Connections", async () => {
  const sql = new SeedSql()
  const connectorDeployment = {
    configurationKey: "connector-key-00000000000000000000000000000000",
    endpoints: {
      "servicenow-csm": "http://servicenow.internal/mcp",
      mail2000: "http://mail2000.internal/mcp",
    },
  } as const
  const first = await seedInstalledServices(sql, "tenant-acme", {
    publicOrigin: "https://one.example.test",
    connectorDeployment,
    genioBotEndpoint: "http://bot.internal:5181",
    botHealthCheck: async () => true,
  })
  assert.deepEqual(first.map((value) => value.resource_id), [
    INSTALLED_SERVICE_RESOURCE_IDS.DISCOVERY,
    INSTALLED_SERVICE_RESOURCE_IDS.SERVICENOW_CSM,
    INSTALLED_SERVICE_RESOURCE_IDS.MAIL2000,
    INSTALLED_SERVICE_RESOURCE_IDS.GENIO_BOT,
  ])
  assert.equal(sql.resources.size, 4)
  assert.equal(sql.connections.size, 4)
  const serviceNow = sql.connections.get("tenant-acme:servicenow-csm:servicenow-csm")!
  serviceNow.connector_configuration = { kind: "servicenow-csm", instance_url: "https://galaxysoftwareservicescorpdemo3.service-now.com" }
  serviceNow.lifecycle = "DISABLED"
  const before = sql.calls.length
  await seedInstalledServices(sql, "tenant-acme", {
    publicOrigin: "https://one.example.test",
    connectorDeployment,
    genioBotEndpoint: "http://bot.internal:5181",
    botHealthCheck: async () => false,
  })
  assert.equal(sql.resources.size, 4)
  assert.equal(sql.connections.size, 4)
  assert.deepEqual(serviceNow.connector_configuration, { kind: "servicenow-csm", instance_url: "https://galaxysoftwareservicescorpdemo3.service-now.com" })
  assert.equal(serviceNow.lifecycle, "DISABLED")
  assert.equal(sql.calls.slice(before).filter((call) => call.text.toLowerCase().includes("update genio_one_resource_connections")).length, 0)
  const bot = sql.connections.get("tenant-acme:genio.personal-bot:genio.personal-bot")!
  assert.equal(bot.lifecycle, "ENABLED")
  assert.equal(bot.health_state, "HEALTHY")
  assert.equal(bot.health_observed_at, "seeded")
  assert.equal(bot.health_source_revision, 1)
  const botInsert = sql.calls.find((call) => call.text.toLowerCase().includes("insert into genio_one_resource_connections") && call.parameters.includes("genio.personal-bot"))
  assert.ok(botInsert)
  assert.match(botInsert.text, /health_observed_at/i)
  assert.match(botInsert.text, /health_source_revision/i)
  assert.match(botInsert.text, /case when \$13 = 'healthy' then now\(\)/i)
})
