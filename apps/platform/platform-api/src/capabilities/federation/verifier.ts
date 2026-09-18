import { createRemoteJWKSet, jwtVerify } from "jose"

import { PlatformApiError } from "../errors"
import type { WorkloadAssertionVerifier } from "./module"

function claim(value: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = value
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export function createOidcWorkloadAssertionVerifier(): WorkloadAssertionVerifier {
  const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
  return {
    async verify({ token, trust, now }) {
      let keySet = keySets.get(trust.jwks_uri)
      if (!keySet) {
        keySet = createRemoteJWKSet(new URL(trust.jwks_uri))
        keySets.set(trust.jwks_uri, keySet)
      }
      let payload
      try {
        payload = (await jwtVerify(token, keySet, {
          issuer: trust.issuer,
          audience: trust.audiences,
          algorithms: trust.algorithms,
          currentDate: new Date(now * 1000),
        })).payload
      } catch {
        throw new PlatformApiError("FEDERATION_ASSERTION_INVALID", 401)
      }
      if (
        typeof payload.sub !== "string" ||
        payload.sub !== trust.external_subject_id ||
        typeof payload.iat !== "number" ||
        typeof payload.exp !== "number" ||
        typeof payload.jti !== "string" ||
        !payload.jti ||
        payload.exp <= now ||
        payload.iat > now ||
        payload.exp - payload.iat > trust.max_assertion_ttl_seconds ||
        trust.required_claims.some((required) => claim(payload, required.name) !== required.value)
      ) {
        throw new PlatformApiError("FEDERATION_ASSERTION_TRUST_MISMATCH", 401)
      }
      return {
        issuer: trust.issuer,
        subject: payload.sub,
        issued_at: payload.iat,
        expires_at: payload.exp,
        jti: payload.jti,
        claims: payload,
      }
    },
  }
}
