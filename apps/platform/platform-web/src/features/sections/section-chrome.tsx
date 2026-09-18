import type { OverviewSnapshot } from "@/domain/contracts"

export function managementRelationHref(
  view: string,
  parameters: Record<string, string>,
  hash?: string,
) {
  const query = new URLSearchParams({ view, ...parameters }).toString()
  return `/management?${query}${hash ? `#${hash}` : ""}`
}

export function subjectDisplayName(data: OverviewSnapshot, subjectId: string) {
  return data.identity?.subjects.find((subject) => subject.subject_id === subjectId)?.profile.display_name ?? subjectId
}
