import { z } from "zod"
import { CommonInstallConfiguration, installStandardConnector, managementApi, type Api } from "../install"
import { serviceNowOrigin } from "./client"

export const InstallConfiguration = CommonInstallConfiguration.extend({ serviceNowOrigin: z.string().url(), oauthClientId: z.string().min(1), oauthScopes: z.array(z.string().min(1)).default([]) }).strict()
export function installServiceNow(configuration: z.infer<typeof InstallConfiguration>, request: Api) {
  const config = InstallConfiguration.parse(configuration)
  const origin = serviceNowOrigin(config.serviceNowOrigin)
  return installStandardConnector(config, {
    name: "ServiceNow CSM", namespace: "servicenow", capabilityLabel: "ServiceNow 客服案件",
    tools: ["list_cases", "get_case", "create_case", "update_case", "delete_case"],
    downstreamIdentity: { mode: "USER_OAUTH", oauth_client: { issuer: origin, authorization_endpoint: `${origin}/oauth_auth.do`, token_endpoint: `${origin}/oauth_token.do`, client_id: config.oauthClientId, scopes: config.oauthScopes } },
  }, request)
}
if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Configuration JSON path is required")
  const config = InstallConfiguration.parse(await Bun.file(process.argv[2]).json())
  const token = process.env.GENIO_ONE_MANAGEMENT_TOKEN
  if (!token) throw new Error("GENIO_ONE_MANAGEMENT_TOKEN_REQUIRED")
  console.info(JSON.stringify({ event: "standard.connector.installed", ...await installServiceNow(config, managementApi(config.platformOrigin, token)) }))
}
