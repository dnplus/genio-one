import type { BotBinding } from "../bots-storage"
import type { GenioCatalogCapability } from "./genio-one"
import { resolveCatalogAddState, type CatalogAddState } from "../../server/bot-binding-add"

const LAB_NAME = /walking skeleton|e2e|canonical|fixture|pilot|token vault|session routing|ep1[23]|observab|tokenization|correlation v1|classifier routing|gcp vertex|oauth application api|otel native|estimated cost|usage facts|session lease|native (stream|metrics|trace)|ui walking/i
const LAB_DATE_STAMP = /20\d{6}/
const INVOKE_MODEL = /invoke model|model\.invoke|^model$/i

export type CatalogLane = "tool" | "model" | "hidden"

export interface CatalogResourceGroup {
  resourceId: string
  title: string
  lane: "tool" | "model"
  lab: boolean
  capabilities: GenioCatalogCapability[]
  addState: CatalogAddState
  bound: boolean
}

export function isLabCatalogName(name: string): boolean {
  const text = name.trim()
  if (!text) return false
  if (LAB_NAME.test(text)) return true
  if (LAB_DATE_STAMP.test(text) && /e2e|skeleton|canonical|pilot/i.test(text)) return true
  return Boolean(LAB_DATE_STAMP.test(text) && text.split(/\s+/).length >= 3)
}

export function isInvokeModelCapability(cap: GenioCatalogCapability): boolean {
  const capability = `${cap.capability_id} ${cap.capability_display_name}`
  if (INVOKE_MODEL.test(capability)) return true
  return cap.resource_kind === "LLM" || cap.resource_kind === "AI"
}

export function catalogLaneFor(cap: GenioCatalogCapability): CatalogLane {
  if (cap.resource_kind === "EXTENSION") return "hidden"
  if (isInvokeModelCapability(cap)) return "model"
  const decision = resolveCatalogAddState(cap)
  if (decision.state === "DENIED") return "hidden"
  return "tool"
}

export function isBoundCapability(cap: GenioCatalogCapability, bindings: BotBinding[] | undefined): boolean {
  return cap.builtin_service === "DISCOVERY" || Boolean(bindings?.some((binding) =>
    binding.state === "INSTALLED" &&
    binding.resourceId === cap.resource_id))
}

export function replaceResourceBindings(
  bindings: readonly BotBinding[],
  resourceId: string,
  nextBinding: BotBinding | null,
): BotBinding[] {
  const retained = bindings.filter((binding) => binding.resourceId !== resourceId)
  return nextBinding ? [...retained, nextBinding] : retained
}

export function groupCatalogResources(
  capabilities: GenioCatalogCapability[],
  bindings?: BotBinding[],
): CatalogResourceGroup[] {
  const byResource = new Map<string, CatalogResourceGroup>()
  for (const cap of capabilities) {
    const lane = catalogLaneFor(cap)
    if (lane === "hidden") continue
    const existing = byResource.get(cap.resource_id)
    if (existing) {
      existing.capabilities.push(cap)
      existing.bound = existing.bound || isBoundCapability(cap, bindings)
      continue
    }
    const decision = resolveCatalogAddState(cap)
    byResource.set(cap.resource_id, {
      resourceId: cap.resource_id,
      title: cap.resource_display_name || cap.resource_id,
      lane,
      lab: isLabCatalogName(cap.resource_display_name || cap.resource_id),
      capabilities: [cap],
      addState: decision.state,
      bound: isBoundCapability(cap, bindings),
    })
  }
  return [...byResource.values()]
}

export function enterpriseToolGroups(
  capabilities: GenioCatalogCapability[],
  bindings?: BotBinding[],
  includeLab = false,
): CatalogResourceGroup[] {
  return groupCatalogResources(capabilities, bindings).filter((group) => {
    if (group.lane !== "tool") return false
    if (group.lab && !includeLab && !group.bound) return false
    return true
  })
}

export function companyModelGroups(
  capabilities: GenioCatalogCapability[],
  includeLab = false,
): CatalogResourceGroup[] {
  return groupCatalogResources(capabilities).filter((group) => {
    if (group.lane !== "model") return false
    if (group.lab && !includeLab) return false
    const decision = resolveCatalogAddState(group.capabilities[0]!)
    return decision.state === "CONNECTED" || decision.state === "ENTITLED" || decision.state === "AUTO_GRANT"
  })
}

export function boundEnterpriseToolCount(bindings: BotBinding[] | undefined, capabilities: GenioCatalogCapability[]): number {
  const toolIds = new Set(
    capabilities.filter((cap) => catalogLaneFor(cap) === "tool").map((cap) => cap.resource_id),
  )
  const capabilityIds = new Set(
    capabilities.filter((cap) => catalogLaneFor(cap) === "tool").map((cap) => cap.capability_id),
  )
  const builtinIds = new Set(capabilities.filter((cap) => cap.builtin_service === "DISCOVERY").map((cap) => cap.resource_id))
  return builtinIds.size + (bindings ?? []).filter((binding) =>
    !builtinIds.has(binding.resourceId) &&
    binding.state === "INSTALLED" &&
    (toolIds.has(binding.resourceId) || capabilityIds.has(binding.capabilityId) || (!capabilities.length && binding.kind !== "CONNECTION")),
  ).length
}

export function humanAddLabel(state: CatalogAddState): string {
  switch (state) {
    case "ENTITLED":
      return "可以使用"
    case "AUTO_GRANT":
      return "可以加入"
    case "REQUEST":
      return "需申請"
    case "NEEDS_CONNECTION":
      return "需連線"
    case "CONNECTED":
      return "可以加入"
    default:
      return "無法使用"
  }
}
