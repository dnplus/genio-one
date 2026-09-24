# Genio 標準 MCP Connector

ServiceNow CSM 與 Mail2000 是可先安裝、再由 GenioOne 管理介面設定的 MCP 執行程式。Mail2000 的 IMAP、SMTP、CalDAV、CardDAV 共用同一條 Connection 與使用者個人憑證。

## 安裝與站台設定分開

Helm 設定 `connectors.enabled=true` 並提供 `images.connectors` 映像。Chart 部署兩個 Connector、ClusterIP Service 與共用的設定簽章金鑰，並將內部端點交給 Platform API。部署不需要 ServiceNow 或 Mail2000 站台、OAuth client、使用者帳密。

映像從 workspace 根目錄建置：

```sh
docker build -f apps/connectors/Dockerfile -t genio-connectors:VERSION .
```

管理者登入後，開啟「連線」：

1. 按既有的「新增連線」，在連線類型的「Connector」分類選擇 ServiceNow CSM 或 Mail2000；只列出已安裝的項目，無法連線的項目不可選取。
2. 選擇擁有此連線的 MCP Resource，直接在同一個表單填寫站台設定。
3. 儲存草稿；在詳情頁測試 Connector MCP transport，再驗證並啟用。
4. 草稿資源可使用同一個「編輯連線」表單修改站台；修改後需重新驗證及個人授權。已發布資源更換站台時建立新 Connection，讓既有發布路徑與個人憑證仍綁定原站台。
5. 使用者透過平台的個人連線流程進行 OAuth 或輸入自己的帳密。

ServiceNow 表單包含 HTTPS 站台 origin、OAuth Client ID、scopes，並顯示 CP 回呼網址。Mail2000 表單包含 IMAP／SMTP 主機與 TLS port、HTTPS CalDAV／CardDAV URL；DAV 路徑可包含 `{username}`。

沒有 MCP Resource 時先在資源頁建立。Connector 安裝不自動建立 Resource、Entitlement 或 Publication，也不自動對外發布。

## 執行與信任邊界

兩個主程序仍可用 `pnpm --filter genio-connectors start:servicenow`／`start:mail2000` 啟動。程序只需要基礎設施設定：

- `GENIO_CONNECTOR_CONFIGURATION_KEY`：由部署產生並與 Platform 共用的金鑰，至少 32 個字元。
- `CONNECTOR_HOST`、`CONNECTOR_PORT`：監聽位置；預設 127.0.0.1，ServiceNow 58110、Mail2000 58111。

Platform 使用 `GENIO_CONNECTOR_SERVICENOW_ENDPOINT`、`GENIO_CONNECTOR_MAIL2000_ENDPOINT` 指向安裝好的 `/mcp`，並使用同一個 `GENIO_CONNECTOR_CONFIGURATION_KEY`。站台設定由管理 API 驗證與簽章，產生不可竄改的 Connection endpoint；Gateway 使用既有 Connection 投影路徑。原始設定保存在 Connection，執行程式不維護第二套可變站台資料庫。

`/health` 表示 Connector 程序可用；`/mcp` 在沒有站台或個人憑證時也可探索完整工具目錄。帶簽章的端點會逐請求建立所屬站台的 adapter，避免不同 Connection 共用站台或帳密。沒有有效設定簽章的請求會在取得使用者資料前被拒絕。

站台設定只含非機密連線資料。個人密碼與 OAuth token 不在環境變數、站台設定或 URL 裡，仍由 CP 的個人憑證系統保管及依授權投影。Connector 私有 Service 不對外建立 Ingress。

MCP transport 測試成功不代表 ServiceNow／Mail2000 使用者登入成功；實際資料操作需個人授權。測試與啟用也不等於 Resource 已發布或 Gateway 已套用。

## 自動化

`install:servicenow`／`install:mail2000` 是選用的 headless Resource／Publication 自動化，不是部署 Connector 的必要步驟。既有已設定外部 MCP endpoint 可沿用原輸入；使用內建多站台 Connector 時，JSON 的 `connectorConfiguration` 必須提供與 UI 相同的站台欄位，管理 API 會產生實際執行端點。ServiceNow 的 OAuth 欄位須與安裝器 definition 一致。

自動化發布仍需真實 Gateway 與 DNS proof；不會自動建立個人 Entitlement。一般使用者不需要 JSON 設定檔。

## 驗證

```sh
pnpm --filter genio-connectors typecheck
GENIO_CONNECTOR_HTTP_TEST=1 pnpm --filter genio-connectors test
```

ServiceNow 提供 5 個 CSM CRUD 工具，Mail2000 提供 21 個郵件與 DAV 工具。測試使用專用 fixture，驗證無設定時探索、設定簽章、跨站台與憑證隔離；不寄信或修改真實企業資料。正式站台登入與真實資料操作須另外驗證。

## Mail2000 plugin

`mail2000/package/` 是可納入 Bot package 的 Codex plugin（marketplace 在 `.agents/plugins/`）：`mail2000-local` skill 與 `hands/bin/m2k.mjs`。`m2k` 在 runtime workspace 內經 Bot relay 呼叫本 connector 的唯讀工具，把近期信件 envelope 快取在 sandbox 並在本機搜尋；它不持有任何憑證。存取模型與限制見 [`apps/bot/docs/hands-mcp-access.md`](../bot/docs/hands-mcp-access.md)。

`search_mail` 只以日期與未讀條件請伺服器 SEARCH，關鍵字在 envelope 上比對（Mail2000 SEARCH 對中文無結果，且大資料夾需 20 秒以上），envelope 以每批 200 個 UID 取回（一次列出數千個 UID 會被回 BAD）。`folders` 可一次搜多個資料夾，`limit` 最大 500。
