import { PlatformApiError } from "../errors"
import type { BootstrapSubjectInput, CreateSelfServiceAgentInput, CreateSubjectInput, Subject } from "./contract"
import type { IdentityDirectory } from "./module"

export function createInMemoryIdentityDirectory(): IdentityDirectory {
  const subjects = new Map<string, Subject>()
  const administrators = new Set<string>()
  const bindings: Array<{
    tenant_id: string
    provider_id: string
    external_subject_id: string
    subject_id: string
  }> = []
  const key = (tenantId: string, subjectId: string) => `${tenantId}\u0000${subjectId}`
  const put = (tenantId: string, subject: BootstrapSubjectInput) => {
    // Re-running bootstrap, or a repeated brokered sign-in, refreshes the
    // profile but must never lift a suspension an administrator applied.
    const existing = subjects.get(key(tenantId, subject.subject_id))
    subjects.set(key(tenantId, subject.subject_id), {
      subject_id: subject.subject_id,
      kind: subject.kind,
      profile: {
        display_name: subject.display_name ?? null,
        email: subject.email ?? null,
        department: subject.department ?? null,
      },
      suspended: existing?.suspended ?? false,
      suspended_at: existing?.suspended_at ?? null,
      suspended_by: existing?.suspended_by ?? null,
      suspension_reason: existing?.suspension_reason ?? null,
    })
    if (subject.role === "TENANT_ADMINISTRATOR") administrators.add(key(tenantId, subject.subject_id))
    for (const binding of subject.external_identities ?? []) {
      if (!bindings.some((value) => value.tenant_id === tenantId && value.provider_id === binding.provider_id && value.external_subject_id === binding.external_subject_id)) {
        bindings.push({ tenant_id: tenantId, ...binding, subject_id: subject.subject_id })
      }
    }
  }
  const create = async ({ tenantId, value }: { tenantId: string; value: CreateSubjectInput }) => {
    const subjectId = value.subject_id?.trim() || `agent-${crypto.randomUUID()}`
    if (subjects.has(key(tenantId, subjectId))) throw new PlatformApiError("SUBJECT_EXISTS", 409)
    put(tenantId, { ...value, subject_id: subjectId, role: "USER" })
    return structuredClone(subjects.get(key(tenantId, subjectId))!)
  }
  const createSelfServiceAgent = async ({ tenantId, value, subjectId }: { tenantId: string; value: CreateSelfServiceAgentInput; subjectId?: string }) => {
    const displayName = value.display_name.trim()
    if (!displayName) throw new PlatformApiError("SUBJECT_DISPLAY_NAME_REQUIRED", 422)
    if (subjectId) {
      const existing = subjects.get(key(tenantId, subjectId))
      if (existing) {
        if (existing.kind === "AGENT" && existing.profile.display_name === displayName) return structuredClone(existing)
        throw new PlatformApiError("SELF_SERVICE_AGENT_REQUEST_CONFLICT", 409)
      }
    }
    return create({
      tenantId,
      value: {
        subject_id: subjectId || `agent-${crypto.randomUUID()}`,
        kind: "AGENT",
        display_name: displayName,
      },
    })
  }
  return {
    async inventory({ tenantId }) {
      const values = [...subjects.entries()].filter(([entry]) => entry.startsWith(`${tenantId}\u0000`))
      return {
        tenant_id: tenantId,
        subjects: values.map(([, value]) => structuredClone(value)),
        external_identity_bindings: bindings
          .filter((value) => value.tenant_id === tenantId)
          .map(({ tenant_id: _tenantId, ...value }) => structuredClone(value)),
        tenant_administrators: values
          .filter(([entry]) => administrators.has(entry))
          .map(([, value]) => value.subject_id),
      }
    },
    create,
    createSelfServiceAgent,
    async bootstrap({ tenantId, subjects: values }) {
      for (const subject of values) put(tenantId, subject)
    },
    async suspend({ tenantId, subjectId, suspendedBy, value }) {
      const subject = subjects.get(key(tenantId, subjectId))
      if (!subject) throw new PlatformApiError("SUBJECT_NOT_FOUND", 404)
      const suspended = {
        ...subject,
        suspended: true,
        suspended_at: subject.suspended_at ?? Date.now(),
        suspended_by: subject.suspended_by ?? suspendedBy,
        suspension_reason: subject.suspension_reason ?? value.reason?.trim() ?? null,
      }
      subjects.set(key(tenantId, subjectId), suspended)
      return structuredClone(suspended)
    },
    async restore({ tenantId, subjectId }) {
      const subject = subjects.get(key(tenantId, subjectId))
      if (!subject) throw new PlatformApiError("SUBJECT_NOT_FOUND", 404)
      const restored = {
        ...subject,
        suspended: false,
        suspended_at: null,
        suspended_by: null,
        suspension_reason: null,
      }
      subjects.set(key(tenantId, subjectId), restored)
      return structuredClone(restored)
    },
    async authorizationForSubject({ tenantId, subjectId }) {
      const subjectKey = key(tenantId, subjectId)
      return {
        registered: subjects.has(subjectKey),
        tenant_administrator: administrators.has(subjectKey),
        suspended: subjects.get(subjectKey)?.suspended === true,
      }
    },
    async subjectForExternalIdentity({ tenantId, providerId, externalSubjectId }) {
      return bindings.find((binding) =>
        binding.tenant_id === tenantId &&
        binding.provider_id === providerId &&
        binding.external_subject_id === externalSubjectId
      )?.subject_id ?? null
    },
    async canonicalSubjectId({ tenantId, subjectId }) {
      if (subjects.has(key(tenantId, subjectId))) return subjectId
      const matches = [...new Set(bindings
        .filter((binding) =>
          binding.tenant_id === tenantId && binding.external_subject_id === subjectId
        )
        .map((binding) => binding.subject_id))]
      if (matches.length > 1) throw new PlatformApiError("SUBJECT_IDENTITY_AMBIGUOUS", 409)
      return matches[0] ?? null
    },
  }
}
