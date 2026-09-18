import type { ResourceKind } from "@/domain/contracts"

import type { ResourceFamily } from "@/features/resources/resource-administration"

export type ControlAccessAuthority = "ONE_POLICY" | "GATEWAY_NATIVE" | "UPSTREAM"
export type ControlInboundAuthentication = "PLATFORM_OAUTH" | "EXTERNAL_OAUTH" | "API_KEY" | "MTLS" | "GATEWAY_NATIVE"

export function controlOptionFamily(kind: ResourceKind | "A2A" | "SITE" | "SKILL" | "PLUGIN" | "BOT", a2a = false): ResourceFamily {
  if (kind === "LLM" || kind === "MCP" || kind === "A2A" || a2a) return "AI"
  if (kind === "SAAS" || kind === "SITE") return "ACCESS"
  if (kind === "EXTENSION" || kind === "SKILL" || kind === "PLUGIN" || kind === "BOT") return "EXTENSION"
  return "API"
}

export function allowedAuthorizationAuthorities(family: ResourceFamily): ControlAccessAuthority[] {
  if (family === "AI") return ["ONE_POLICY", "GATEWAY_NATIVE", "UPSTREAM"]
  if (family === "API") return ["ONE_POLICY", "UPSTREAM"]
  return ["ONE_POLICY"]
}

export function allowedInboundAuthentications(family: ResourceFamily, authority: ControlAccessAuthority): ControlInboundAuthentication[] {
  if (family === "AI") {
    if (authority !== "ONE_POLICY") return []
    return ["PLATFORM_OAUTH", "API_KEY", "GATEWAY_NATIVE"]
  }
  if (family === "API") return ["EXTERNAL_OAUTH", "API_KEY", "MTLS"]
  if (family === "ACCESS") return ["PLATFORM_OAUTH", "API_KEY"]
  return []
}

export function inboundAuthenticationOptionLabel(value: ControlInboundAuthentication, family: ResourceFamily) {
  if (family === "AI") {
    if (value === "PLATFORM_OAUTH") return "OS"
    if (value === "GATEWAY_NATIVE") return "Pass through"
  }
  if (value === "PLATFORM_OAUTH") return "Platform OAuth"
  if (value === "EXTERNAL_OAUTH") return "External OAuth"
  if (value === "API_KEY") return "API key"
  if (value === "MTLS") return "mTLS"
  return "Gateway native authentication"
}

export function coerceControlSelections(
  family: ResourceFamily,
  authority: ControlAccessAuthority,
  inbound: ControlInboundAuthentication,
): { authority: ControlAccessAuthority; inbound: ControlInboundAuthentication } {
  const authorities = allowedAuthorizationAuthorities(family)
  const nextAuthority = authorities.includes(authority) ? authority : authorities[0] ?? "ONE_POLICY"
  const inbounds = allowedInboundAuthentications(family, nextAuthority)
  const nextInbound = inbounds.includes(inbound) ? inbound : inbounds[0] ?? inbound
  return { authority: nextAuthority, inbound: nextInbound }
}
