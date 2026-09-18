import { createRoot } from "react-dom/client"
import { ResourcePublicModelsCard } from "../../platform-web/src/features/resources/resource-public-models-card"
import type { ConnectionSummary, ResourceRegistration } from "../../platform-web/src/domain/contracts"
import "../../platform-web/src/i18n"
import "../../platform-web/src/styles/globals.css"

const resource = { resource_id: "asr-test", kind: "LLM" } as ResourceRegistration
const connection = { connection_id: "connection-test", display_name: "Breeze 本機測試", lifecycle: "ENABLED", llm: { models: [{ upstream_model_id: "breeze-asr" }] } } as ConnectionSummary
createRoot(document.getElementById("root")!).render(<main className="mx-auto max-w-3xl p-8"><h1 className="mb-4 text-xl">ASR 模型註冊分段驗證</h1><p className="mb-4">隔離的測試 API；非正式發布。</p><ResourcePublicModelsCard canEdit connections={[connection]} resource={resource} tenantId="tenant-test" /></main>)
