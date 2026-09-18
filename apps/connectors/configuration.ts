import { createHmac, timingSafeEqual } from "node:crypto"
import { Type, type Static } from "typebox"
import { Value } from "typebox/value"

const HttpsUrl = Type.String({ minLength: 1, maxLength: 512, pattern: "^https://" })
const Host = Type.String({ minLength: 1, maxLength: 253, pattern: "^[A-Za-z0-9][A-Za-z0-9.-]*$" })
const Port = Type.Integer({ minimum: 1, maximum: 65535 })

export const ConnectorConfigurationSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("servicenow-csm"),
    instance_url: HttpsUrl,
    oauth_client_id: Type.String({ minLength: 1, maxLength: 256 }),
    oauth_scopes: Type.Array(Type.String({ minLength: 1, maxLength: 128, pattern: "^\\S+$" }), { maxItems: 16 }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("mail2000"),
    imap_host: Host,
    imap_port: Port,
    smtp_host: Host,
    smtp_port: Port,
    caldav_url: Type.Optional(HttpsUrl),
    carddav_url: Type.Optional(HttpsUrl),
  }, { additionalProperties: false }),
])

export type ConnectorConfiguration = Static<typeof ConnectorConfigurationSchema>
export type ConnectorKind = ConnectorConfiguration["kind"]

export function validateConnectorConfiguration(value: unknown): ConnectorConfiguration {
  if (!Value.Check(ConnectorConfigurationSchema, value)) throw new Error("CONNECTOR_CONFIGURATION_INVALID")
  for (const target of value.kind === "servicenow-csm" ? [value.instance_url] : [value.caldav_url, value.carddav_url]) {
    if (!target) continue
    const url = new URL(target)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("CONNECTOR_CONFIGURATION_URL_INVALID")
    if (value.kind === "servicenow-csm" && url.pathname !== "/") throw new Error("CONNECTOR_CONFIGURATION_ORIGIN_REQUIRED")
  }
  return value
}

export function connectorConfigurationToken(configuration: ConnectorConfiguration, key: string): string {
  if (key.length < 32) throw new Error("CONNECTOR_CONFIGURATION_KEY_REQUIRED")
  const payload = Buffer.from(JSON.stringify(validateConnectorConfiguration(configuration))).toString("base64url")
  const signature = createHmac("sha256", key).update(payload).digest("base64url")
  return `${payload}.${signature}`
}

export function readConnectorConfigurationToken(token: string, key: string): ConnectorConfiguration {
  if (key.length < 32 || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error("CONNECTOR_CONFIGURATION_UNTRUSTED")
  const [payload, signature] = token.split(".") as [string, string]
  const expected = createHmac("sha256", key).update(payload).digest()
  const actual = Buffer.from(signature, "base64url")
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("CONNECTOR_CONFIGURATION_UNTRUSTED")
  return validateConnectorConfiguration(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
}
