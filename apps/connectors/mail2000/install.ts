import { mail2000DavSettings } from "./site"
import { CommonInstallConfiguration, installStandardConnector, managementApi, type CommonInstallConfig, type Api } from "../install"

export const MAIL2000_TOOLS = [
  "list_mailboxes", "search_mail", "read_mail", "set_mail_flags", "move_mail", "delete_mail", "append_mail",
  "create_mailbox", "rename_mailbox", "delete_mailbox", "send_mail",
  ...["caldav", "carddav"].flatMap((prefix) => ["list_collections", "read_objects", "create_object", "update_object", "delete_object"].map((operation) => `${prefix}_${operation}`)),
]
export function installMail2000(configuration: CommonInstallConfig, request: Api) {
  const site = configuration.connectorConfiguration?.kind === "mail2000" ? configuration.connectorConfiguration : undefined
  const dav = site ? mail2000DavSettings(site) : null
  const tools = MAIL2000_TOOLS.filter((name) => !site || (!name.startsWith("caldav_") || Boolean(dav?.caldav_url)) && (!name.startsWith("carddav_") || Boolean(dav?.carddav_url)))
  return installStandardConnector(configuration, {
    name: "Mail2000", namespace: "mail2000", capabilityLabel: "郵件、寄信、行事曆與聯絡人",
    tools, downstreamIdentity: { mode: "USER_PASSWORD" },
  }, request)
}
if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Configuration JSON path is required")
  const config = CommonInstallConfiguration.strict().parse(await Bun.file(process.argv[2]).json())
  const token = process.env.GENIO_ONE_MANAGEMENT_TOKEN
  if (!token) throw new Error("GENIO_ONE_MANAGEMENT_TOKEN_REQUIRED")
  console.info(JSON.stringify({ event: "standard.connector.installed", ...await installMail2000(config, managementApi(config.platformOrigin, token)) }))
}
