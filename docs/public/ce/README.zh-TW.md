# GenioOne Community Edition

[English](README.md)

GenioOne 社群版（CE）讓你在自有基礎設施上執行 Platform 控制平面、Gateway Runtime 與 Genio Bot，管理 AI 代理的工具存取權，並查看可追溯的操作紀錄。本專案提供原始碼與文件，由你自行建置及執行服務。

CE 文件預設為英文，本頁提供對應的繁體中文說明。英文 Bot 展示畫面使用 `?lang=en`；範例輸入與產出也使用英文。

## 範圍與前置條件

CE 包含 Platform 控制平面、本機管理的 Gateway Runtime 與 Genio Bot。你需要準備主機、支援服務容器，以及所選模型供應者或外部 MCP 服務需要的憑證與連線權限。專案不包含供應者金鑰，也未提供代管服務或預先發布的映像檔。

開始前請使用具備 Docker Engine、Docker Compose、Git、Node.js、pnpm `10.32.1` 與 Bun `1.4.0` 的 Linux 或 macOS 主機。完整前置條件與服務入口請看[本機快速入門](quickstart.md)。

## 第一條可驗證路徑

CE 的主要展示情境是受治理的「文件研究到產品規格」流程：

1. 依照[本機快速入門](quickstart.md)啟動服務。
2. 依照[產品初始設定](../product/zh-TW/initial-setup.md#local-gateway-runtime)註冊並啟動本機 Gateway Runtime。
3. 從 Management 為指定組織安裝 CE 示範專案。
4. 使用受管理的 Discovery 找到 Context7 資源，確認已發布的工具及目前帳號的存取權。
5. 請內建的 Product Management Bot 使用 Context7 工具，產出附有來源連結的產品需求摘要。
6. 回到 Management 的 Activity 查看對應操作紀錄。

完整流程以虛構的 Stellar Freight Claims Portal 為案例，請看 [CE 首次展示指南](demo.md)。主要展示使用 Context7 與 Product Management；Archify 與 Gemini 是選用功能。

若要錄製個人 Notion OAuth 設定，請閱讀英文版的 [Notion OAuth 與 Bot 設定](demo.md#optional-notion-oauth-and-bot-setup)。指南涵蓋已發布的 Resource、使用者授權、三項唯讀 entitlement、Bot 綁定、英文介面與乾淨的 Bot 副本。完成設定後，仍須由 Bot 結果與 Management 對應紀錄證明工具呼叫。

## 證據邊界

完成展示時，Bot 應回傳真實工具結果，Management 也應能對上相同操作人員、組織、Connection、Gateway 版本及 correlation ID 的活動或稽核紀錄。只有連線健康、資源已發布，或直接呼叫上游成功，都不足以證明整條 CE 操作流程已完成。

## 其他文件

- [第一筆受控 MCP 請求](first-mcp-request.md)：說明如何發布並經由 Gateway 呼叫公開的 DeepWiki `read_wiki_structure` 工具。
- [Helm](helm.md)：說明自行建置並發布映像檔後的 Kubernetes 部署方式。
- [疑難排解](troubleshooting.md)：列出本機常見問題與診斷指令。
- [已知問題與後續修復](known-issues.md)：記錄 CE 安裝與展示驗證期間觀察到的問題。

詳細 CE 操作文件目前以英文為主；產品初始設定另提供繁體中文版本。

目前限制與修復狀態請看[已知問題](known-issues.md)。
