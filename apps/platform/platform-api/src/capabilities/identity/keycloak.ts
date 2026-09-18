import type { HttpFetch } from "../../../../../../runtimes/gateway/services/shared/http-fetch"
import {
  keycloakRequired as required,
  keycloakResponseJson as responseJson,
  keycloakString as stringValue,
  type KeycloakJsonRecord as JsonRecord,
} from "../../keycloak/http"

/**
 * Enforces a local suspension in the identity provider as well. Suspending in
 * GenioOne already blocks the Control Plane and the Bot on the next request,
 * but the Keycloak account stays enabled and its SSO session stays alive, so
 * anything that trusts Keycloak directly would still admit the person.
 */
export interface SubjectSessionControl {
  /**
   * Disables the account and revokes its sessions. Implementations report
   * whether the upstream account was actually reached, so a caller can tell an
   * operator that the local suspension applied but the provider did not.
   */
  disable(input: { externalSubjectId: string }): Promise<{ applied: boolean }>
  enable(input: { externalSubjectId: string }): Promise<{ applied: boolean }>
}

export function createKeycloakSubjectSessionControl(options: {
  origin: string
  realm: string
  adminUsername: string
  adminPassword: string
  fetch?: HttpFetch
}): SubjectSessionControl {
  const fetchImpl = options.fetch ?? fetch
  const origin = required(options.origin, "Keycloak origin").replace(/\/$/, "")
  const realm = required(options.realm, "Keycloak realm")
  const users = `${origin}/admin/realms/${encodeURIComponent(realm)}/users`

  async function adminToken(): Promise<string> {
    const body = await responseJson(await fetchImpl(`${origin}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: options.adminUsername,
        password: options.adminPassword,
      }),
    }), "Keycloak Admin token") as JsonRecord
    return stringValue(body.access_token, "Keycloak Admin token")
  }

  /**
   * The external subject id is Keycloak's own user id for a brokered or local
   * account, so it addresses the user directly. A lookup that does not resolve
   * is reported as not applied rather than raised: the account may live in a
   * provider GenioOne does not administer.
   */
  async function setEnabled(externalSubjectId: string, enabled: boolean): Promise<{ applied: boolean }> {
    const token = await adminToken()
    const userId = encodeURIComponent(externalSubjectId)
    const read = await fetchImpl(`${users}/${userId}`, { headers: { authorization: `Bearer ${token}` } })
    if (read.status === 404) return { applied: false }
    const user = await responseJson(read, "Keycloak user") as JsonRecord
    await responseJson(await fetchImpl(`${users}/${userId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...user, enabled }),
    }), "Keycloak user update")
    if (!enabled) {
      // Disabling alone leaves existing sessions usable until they expire, so
      // the sessions are ended explicitly.
      await responseJson(await fetchImpl(`${users}/${userId}/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }), "Keycloak user logout")
    }
    return { applied: true }
  }

  return {
    disable: ({ externalSubjectId }) => setEnabled(externalSubjectId, false),
    enable: ({ externalSubjectId }) => setEnabled(externalSubjectId, true),
  }
}

/** Resolves the Keycloak user ids bound to a Subject. */
export function externalSubjectIdsFor(
  bindings: ReadonlyArray<{ provider_id: string; external_subject_id: string; subject_id: string }>,
  subjectId: string,
): string[] {
  return [...new Set(
    bindings
      .filter((binding) => binding.subject_id === subjectId)
      .map((binding) => binding.external_subject_id),
  )]
}
