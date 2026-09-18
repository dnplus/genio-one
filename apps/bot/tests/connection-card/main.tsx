import { createRoot } from "react-dom/client"
import { ToolCatalogModal } from "../../src/components/modals/ToolCatalogModal"
import "../../src/styles.css"

createRoot(document.getElementById("root")!).render(<ToolCatalogModal
  catalog={{ tenant_id: "component-test", subject_id: "test-user", subject_display_name: "分段驗證使用者", catalog_revision: "test", capabilities: [{
    resource_id: "servicenow-csm", resource_display_name: "ServiceNow CSM", resource_kind: "MCP",
    capability_id: "mcp.invoke", capability_display_name: "查詢客服案件",
    access: "AUTO_GRANT", hub_status: "AVAILABLE", connection_status: "READY",
  }, { resource_id: "mail2000", resource_display_name: "Mail2000", resource_kind: "MCP", capability_id: "mcp.invoke", capability_display_name: "郵件、寄信、行事曆、聯絡人", access: "AUTO_GRANT", hub_status: "AVAILABLE", connection_status: "READY" }] }}
  accessToken="component-test"
  toolStatusText="卡片分段驗證，非真實登入"
  mcpStatus="已連線"
  onClose={() => {}}
  onRetryMcp={() => {}}
/>)
