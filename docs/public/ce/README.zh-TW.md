# GenioOne Community Edition

[English](README.md)

GenioOne 社群版（CE）讓團隊使用共用工具與模型完成工作，並集中管理存取權與請求紀錄。它適合能部署服務、並接入自己管理或已獲准資源的開發者、小型團隊與技術推動者。

CE 提供 Platform 控制平面、Gateway Runtime 與 Genio Bot 的原始碼，由你在自有基礎設施上建置及執行服務。

## 從第一個團隊工作流程開始

1. 依照[本機快速入門](quickstart.md)啟動 CE 並進入 Management。
2. 完成[本機 Gateway Runtime 設定](../product/zh-TW/initial-setup.md#本機-gateway-runtime)。剛註冊的 Runtime 會等待第一個發布版本；示範資源發布後，才可進入 `READY` 狀態。
3. 依照[第一個團隊工作流程](demo.md)為組織安裝示範專案，執行 Context7 文件研究任務，再把已驗證的來源整理成產品需求摘要。
4. 確認 Bot 產出與對應的 Activity 或 Audit 紀錄。若要直接使用 MCP 用戶端，請另看[第一筆受控 MCP 請求](first-mcp-request.md)。

流程使用虛構的 Stellar Freight 貨運理賠入口，讓你在接入團隊專案資料前，先試用完整工作流程。

## 團隊如何使用

技術推動者可為團隊發布資源，讓多個 Bot 沿用，並集中維護連線設定。每個呼叫者依各自的存取權使用；需要個人帳號的服務，仍由各使用者授權。Resource 與存取模型請見[產品總覽](../product/zh-TW/overview.md)。

你可以從內建的 Genio Bot 開始，或依照 [MCP 請求指南](first-mcp-request.md)，設定支援已發布端點傳輸與驗證方式的用戶端。

## 範圍與前置條件

你需要準備主機、支援服務容器，以及所選供應者與外部服務需要的憑證及存取權。CE 不包含供應者金鑰。

本機流程需使用具備 Docker Engine、Docker Compose、Git、Node.js、pnpm `12.4.2` 與 Bun `1.4.2` 的 Linux 或 macOS 主機。完整前置條件、服務位址與重啟方式請看[本機快速入門](quickstart.md)。Kubernetes 部署則請先建置並發布叢集可拉取的映像檔，再依照 [Helm](helm.md) 操作。

## 文件導覽

- [第一個團隊工作流程](demo.md)：為組織安裝 CE 示範專案，並在 Genio Bot 完成文件研究到產品需求摘要的範例。
- [第一筆受控 MCP 請求](first-mcp-request.md)：發布並經由 Gateway 呼叫公開 DeepWiki 的 `read_wiki_structure` 工具。
- [Helm](helm.md)：說明自行建置並發布映像檔後的 Kubernetes 部署方式。
- [疑難排解](troubleshooting.md)：列出本機常見問題與診斷指令。
- [已知問題與後續修復](known-issues.md)：記錄 CE 安裝與示範驗證期間觀察到的目前限制。

產品初始設定另提供[繁體中文版本](../product/zh-TW/initial-setup.md)。
