<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/brand/assets/logos/genioone-horizontal-color-dark.svg">
    <img src="packages/brand/assets/logos/genioone-horizontal-color-light.svg" alt="GenioOne" width="300">
  </picture>
</p>

<h3 align="center">讓 AI 代理用團隊的工具，完成工作。</h3>

<p align="center">共用工具與模型，成員依自己的權限使用，追蹤每次請求。</p>

<p align="center">
  <a href="https://genio.sh">官方網站</a> ·
  <a href="#快速開始">快速開始</a> ·
  <a href="docs/public/ce/README.zh-TW.md">使用文件</a> ·
  <a href="https://www.producthunt.com/products/genioone?embed=true&amp;utm_source=embed&amp;utm_medium=post_embed">Product Hunt</a> ·
  <a href="README.md">English</a>
</p>

GenioOne 協助團隊將 AI 代理連上工作中使用的工具與模型。你可以發布共用資源，讓成員依各自權限使用，並集中管理連線與請求紀錄。

社群版適合能部署服務、並接入自己管理或已獲准資源的開發者與技術推動者。先從一個專案或小型團隊開始。

![GenioOne 資源管理](docs/public/ce/assets/resource-management.png)

## 從 Genio Bot 和一個工作流程開始

使用內建的 Genio Bot，先試一個工作流程：

**文件研究 → 產品需求摘要。** 協助虛構的 Stellar Freight 團隊規劃貨運理賠入口，先用 Context7 查詢框架文件，再用內建 Product Management 技能整理需求與驗收條件。

依照[展示指南](docs/public/ce/demo.md)操作，或從[第一筆 MCP 請求](docs/public/ce/first-mcp-request.md)開始。指南也包含[以 OAuth 連接 Notion](docs/public/ce/demo.md#optional-notion-oauth-and-bot-setup) 的步驟。

## 快速開始

準備 macOS 或 Linux、Docker 與 Compose、Git、Node.js、pnpm **12.4.2** 及 Bun **1.4.2**。

```sh
curl -fsSL https://genio.sh/install.sh | sh
```

這個指令會 clone repo、安裝依賴並準備 `.env.local`，不會啟動服務；最後請自行執行 `pnpm dev`。可用 `install.sh --help` 查看安裝選項，或手動安裝：

```sh
git clone https://github.com/dnplus/genio-one.git
cd genio-one
pnpm install --frozen-lockfile
cp apps/platform/.env.example apps/platform/.env.local
cp apps/bot/.env.example apps/bot/.env.local
pnpm dev
```

開啟 [Management](http://127.0.0.1:5173/management)，使用本機開發帳號 `admin`／`admin` 登入，再依照[首次設定](docs/public/product/zh-TW/initial-setup.md)連接 Gateway Runtime。

開啟 [Genio Bot](http://127.0.0.1:5180/) 使用工具。開始對話前，請先設定模型帳號或供應者憑證。

完整前置條件、服務位址與重啟方式請看[安裝指南](docs/public/ce/quickstart.md)。上述預設值供本機開發使用，對外部署前請設定正式環境憑證。

## 讓團隊共用工作資源

- **發布共用的工具與模型**：讓需要的專案或團隊能使用資源。
- **讓成員依各自權限使用**：授予指定工具的權限，並在 Gateway 執行政策。
- **讓多個 Bot 沿用已發布的資源**：集中維護連線設定；需要個人帳號的服務仍由各使用者授權。
- **追蹤請求**：查看操作身分、政策判定、使用的連線與對應活動。
- **選擇合適的用戶端**：從 Genio Bot 開始，或使用支援已發布端點傳輸與驗證流程的 MCP 用戶端。操作方式請看 [MCP 請求指南](docs/public/ce/first-mcp-request.md)。

## 文件與架構

社群版以 Apache-2.0 授權提供 Platform 管理介面與 API、Gateway Runtime，以及 Genio Bot。

| 指南 | 內容 |
| --- | --- |
| [CE 總覽](docs/public/ce/README.zh-TW.md) | 了解包含的元件與部署範圍 |
| [本機安裝](docs/public/ce/quickstart.md) | 啟動服務與管理本機環境 |
| [首次設定](docs/public/product/zh-TW/initial-setup.md) | 設定身分、資源與 Gateway |
| [Kubernetes 部署](docs/public/ce/helm.md) | 建置映像檔並使用 Helm 部署 |
| [疑難排解](docs/public/ce/troubleshooting.md) | 排查啟動及連線問題 |
| [已知問題](docs/public/ce/known-issues.md) | 查看目前限制與修復狀態 |

文件預設為英文，本頁與產品首次設定提供繁體中文版本。

## 回饋與貢獻

歡迎透過 [GitHub Issues](https://github.com/dnplus/genio-one/issues) 回報問題或提出建議。回報時請附上重現步驟與環境資訊，並移除紀錄中的憑證與私人資料。

提交程式碼前，請執行 `pnpm check`、`pnpm test` 與 `pnpm build`。

## 授權

[Apache License 2.0](LICENSE)。
