import type { OverviewSnapshot } from "@/domain/contracts"

export interface ActivityEntityDisplay {
  label: string
  kind: "Subject" | "Person" | "Application" | "Agent" | "Acting Client" | "Resource" | "Connection" | "Capability" | "Provider"
  supporting?: string
  resolved: boolean
}

export interface ActivityDisplayDirectory {
  application(value: string | null | undefined): ActivityEntityDisplay
  capability(resourceId: string, capabilityId: string | null | undefined): ActivityEntityDisplay
  connection(value: string | null | undefined): ActivityEntityDisplay
  provider(value: string | null | undefined): ActivityEntityDisplay
  resource(value: string | null | undefined): ActivityEntityDisplay
  subject(
    value: string | null | undefined,
    projected?: { display_name: string; kind: "PERSON" | "APPLICATION" | "AGENT" } | null,
  ): ActivityEntityDisplay
}

function readableIdentifier(value: string): string {
  const normalized = value
    .replace(/^genio-one(?=$|[-_.])/i, "GenioOne")
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => {
      const upper = part.toUpperCase()
      if (["AI", "API", "MCP", "OAUTH", "OIDC", "LLM"].includes(upper)) return upper === "OAUTH" ? "OAuth" : upper
      if (/^[0-9a-f]{8,}$/i.test(part)) return ""
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .filter(Boolean)
    .join(" ")
  return normalized || "Unknown"
}

function unknown(kind: ActivityEntityDisplay["kind"]): ActivityEntityDisplay {
  return { label: "Unknown", kind, resolved: false }
}

const builtInApplicationLabels = new Map([
  ["genio-one-management-console", "GenioOne Management Console"],
  ["genio-one-product-api", "GenioOne Management Console"],
])

export function createActivityDisplayDirectory(
  data: Pick<OverviewSnapshot, "applications" | "connections" | "identity" | "resources">,
): ActivityDisplayDirectory {
  const resources = new Map(data.resources.map((resource) => [resource.resource_id, resource]))
  const connections = new Map(data.connections.map((connection) => [connection.connection_id, connection]))
  const subjects = new Map((data.identity?.subjects ?? []).map((subject) => [subject.subject_id, subject]))
  const aliases = new Map((data.identity?.external_identity_bindings ?? []).map((binding) => [binding.external_subject_id, binding.subject_id]))
  const applications = new Map<string, OverviewSnapshot["applications"][number]>()
  for (const application of data.applications) {
    applications.set(application.application_id, application)
    applications.set(application.subject_id, application)
  }

  return {
    application(value) {
      if (!value) return unknown("Acting Client")
      const application = applications.get(value)
      if (application) return {
        label: application.display_name,
        kind: "Application",
        resolved: true,
      }
      const subject = subjects.get(value)
      if (subject?.kind === "APPLICATION") return {
        label: subject.profile.display_name ?? subject.profile.email ?? readableIdentifier(value),
        kind: "Application",
        supporting: subject.profile.email ?? undefined,
        resolved: true,
      }
      const builtInLabel = builtInApplicationLabels.get(value)
      if (builtInLabel) return {
        label: builtInLabel,
        kind: "Application",
        resolved: true,
      }
      return {
        label: readableIdentifier(value),
        kind: "Acting Client",
        resolved: false,
      }
    },
    capability(resourceId, capabilityId) {
      if (!capabilityId) return unknown("Capability")
      const capability = resources.get(resourceId)?.capabilities.find((candidate) => candidate.capability_id === capabilityId)
      return {
        label: capability?.display_name ?? readableIdentifier(capabilityId),
        kind: "Capability",
        resolved: Boolean(capability),
      }
    },
    connection(value) {
      if (!value) return unknown("Connection")
      const connection = connections.get(value)
      return connection
        ? { label: connection.display_name, kind: "Connection", resolved: true }
        : unknown("Connection")
    },
    provider(value) {
      if (!value) return { label: "—", kind: "Provider", resolved: false }
      return { label: readableIdentifier(value), kind: "Provider", resolved: false }
    },
    resource(value) {
      if (!value) return unknown("Resource")
      const resource = resources.get(value)
      return resource
        ? { label: resource.display_name, kind: "Resource", resolved: true }
        : unknown("Resource")
    },
    subject(value, projected) {
      if (projected) return {
        label: projected.display_name,
        kind: projected.kind === "PERSON" ? "Person" : projected.kind === "APPLICATION" ? "Application" : "Agent",
        resolved: true,
      }
      if (!value) return unknown("Subject")
      const canonical = aliases.get(value) ?? value
      const subject = subjects.get(canonical)
      if (!subject) return unknown("Subject")
      const kind = subject.kind === "PERSON" ? "Person" : subject.kind === "APPLICATION" ? "Application" : "Agent"
      return {
        label: subject.profile.display_name ?? subject.profile.email ?? readableIdentifier(canonical),
        kind,
        supporting: subject.profile.email ?? subject.profile.department ?? undefined,
        resolved: true,
      }
    },
  }
}
