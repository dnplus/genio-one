import { lookup } from "node:dns/promises"
import { PlatformApiError } from "./capabilities/errors"
import type { PublicationDnsVerifier } from "./capabilities/resources/module"

export function createPublicationDnsVerifier(
  targets: Record<string, string>,
  resolveAddresses: (hostname: string) => Promise<string[]> = async (hostname) => (await lookup(hostname, { all: true })).map((answer) => answer.address),
): PublicationDnsVerifier {
  const targetForGateway = (gatewayId: string) => targets[gatewayId]?.trim().toLowerCase() || null
  return {
    targetForGateway,
    async verify({ hostname, gatewayId, dnsTarget }) {
      const expected = targetForGateway(gatewayId)
      if (!expected) throw new PlatformApiError("PUBLICATION_DNS_GATEWAY_NOT_CONFIGURED", 422, "Configure the Gateway DNS target in the deployment before verifying publication DNS")
      if (dnsTarget !== expected) return false
      try {
        const [actual, trusted] = await Promise.all([resolveAddresses(hostname), resolveAddresses(expected)])
        return actual.length > 0 && trusted.length > 0 && actual.every((address) => trusted.includes(address))
      } catch {
        return false
      }
    },
  }
}
