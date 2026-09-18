import type { BotBinding } from "../bots-storage"

export function primaryMcpServer(bindings?: BotBinding[]): "genio_one" | "genio_discovery" {
  return bindings?.some((binding) => binding.state === "INSTALLED" && binding.kind === "MCP" && binding.resourceId !== "genio-one-discovery")
    ? "genio_one"
    : "genio_discovery"
}
