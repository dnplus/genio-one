import { createHash } from "node:crypto"

import type { Turn } from "../generated/v2/Turn"

export function sourceRevision(turnId: string, revision: number): string {
  return createHash("sha256").update(`${turnId}\n${revision}`).digest("hex")
}

export function contentDigest(bodyJson: string): string {
  return createHash("sha256").update(bodyJson).digest("hex")
}

export function markerContentDigest(bodies: readonly string[]): string {
  if (bodies.length === 1) return contentDigest(bodies[0] ?? "")
  const hash = createHash("sha256")
  for (const body of bodies) hash.update(contentDigest(body))
  return hash.digest("hex")
}

export function turnReady(turn: Pick<Turn, "status" | "itemsView" | "items"> | null): boolean {
  if (!turn) return false
  if (turn.status !== "completed" && turn.status !== "failed" && turn.status !== "interrupted") return false
  if (turn.itemsView === "summary" || turn.itemsView === "notLoaded") return false
  if (turn.status === "completed" && turn.items.length === 0) return false
  return true
}
