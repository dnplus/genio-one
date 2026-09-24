# Genio Bot Hands 提供者

Genio Bot 的 Brain 留在 Genio：Bot server 的 Codex app-server、CP／AIGW 模型路由、身分驗證、One Policy 授權、工具決策、稽核與記憶都不移到 Hands。Hands 提供隔離的執行租約與工作區。瀏覽器只接收 runtime 狀態，以及授權後由 Bot 代理的桌面網址；提供者憑證不會交給瀏覽器。

這裡的 Brain 指執行中的 Bot runtime；切換模型或 Bot profile 不等於替換 Brain。Brain runtime 的可替換設計另由 [#79](https://github.com/dnplus/genioone-private/issues/79) 追蹤，本次不實作。

| 遠端提供者 | 執行環境 | 持久狀態 |
| --- | --- | --- |
| `e2b-self-hosted` | 客戶自架 E2B sandbox | Bot 的 `GENIO_BOT_WORKSPACE_STORE` 內的工作區檢查點 |
| `cloudflare-hands` | Cloudflare Worker、Durable Object、Sandbox container 與 Dynamic Worker Loader | Durable Object 工作區中繼資料、R2 工作區備份 |

`GENIO_BOT_RUNTIME=local` 仍是不能執行遠端命令的本地協定開發模式。另行配對的原生 Endpoint 屬於 Local Hands，不會被標成 E2B 或 Cloudflare Hands。

目前能力分層如下：L1 的地端唯讀／MCP 工作仍走 Genio 既有路徑；Cloudflare Hands 另提供同一工作區上的 JavaScript isolate。L2 是 E2B 或 Cloudflare Sandbox container 的原生命令與檔案執行。L3 是兩者的桌面租約。isolate 目前只執行 JavaScript，不支援 Python。Browser Run 是獨立的瀏覽器能力，本實作未提供；桌面串流與操作不等於 Browser Run。

## Bot 設定

`GENIO_BOT_RUNTIME` 選擇新工作區的預設提供者：`local` 不啟動遠端執行，`e2b-self-hosted` 使用自架 E2B，`cloudflare-hands` 使用 Cloudflare Hands。server 未明確設定時仍預設 `e2b-self-hosted`；此 repo 的 `.env.example` 與 Helm chart 為本地開發而設定成 `local`。明確建立工作區時可以要求特定提供者，但設定了對應憑證不等於取得使用權。變更預設值不會悄悄改變既有工作區的提供者。

自架 E2B 沿用 `E2B_DOMAIN`、`E2B_API_KEY`、`GENIO_BOT_E2B_DESKTOP_BASE_TEMPLATE`、`GENIO_BOT_E2B_DESKTOP_TEMPLATE` 與 `GENIO_BOT_E2B_HEADLESS_TEMPLATE`。部署若分開提供 API 與 sandbox 入口，再設定 `E2B_API_URL`、`E2B_SANDBOX_URL`。這些入口須指向客戶操作的 E2B 環境。

Cloudflare Hands 在 Bot server 設定：

```dotenv
GENIO_BOT_RUNTIME=cloudflare-hands
GENIO_CF_HANDS_ORIGIN=https://hands.example.com
GENIO_CF_HANDS_TOKEN=<與 Worker 的 HANDS_SERVER_TOKEN 相同的機密>
```

`GENIO_CF_HANDS_ORIGIN` 只填 Worker origin，不含路徑、查詢或內嵌帳密。Token 由 server 的機密設定提供，不得放進 `VITE_` 變數或瀏覽器包。

將 `GENIO_BOT_REGISTRY_DB` 與 `GENIO_BOT_WORKSPACE_STORE` 放在持久磁碟。前者記錄 Bot 工作區的身分、擁有人、選定提供者與修訂；後者保存 E2B 檢查點。Helm Bot volume 將它們掛在 `/var/lib/genio-one-bot`。若使用暫存 volume，Pod 重建後無法保留這些資料。

## One Policy 執行位置

建立／啟用工作區、開始新的 Hands 執行、JavaScript isolate，以及跨工作區產物匯入前，都須取得 `remote_hands.use` 的 `use` 動作 `ALLOW`。命令、檔案及桌面本身的能力仍各自受政策檢查。原本只允許 `shell.exec` 或 `computer.use` 的政策須新增這條 rule；缺少時會依 `DEFAULT_DENY` 拒絕，不會以部署設定或其他能力的允許結果代替。

One Policy 可在這條 `ALLOW` rule 放入 `execution_placement` constraint。對遠端工作區，`ON_PREM` 對應 `e2b-self-hosted`，`MANAGED_CLOUD` 對應 `cloudflare-hands`。既有 Local Endpoint 也是 `ON_PREM` 執行目標，但不是 E2B 工作區提供者；`MANAGED_CLOUD` 會拒絕它。沒有此 constraint 時，遠端工作區只使用 `GENIO_BOT_RUNTIME` 指定的預設提供者；Endpoint 在預設為 `local` 或 `e2b-self-hosted` 時可用，預設為 `cloudflare-hands` 時會被拒絕。以下是政策 draft 的 `rules` 陣列內一條 Cloudflare Hands rule 範例；若要限定地端，將 `execution_domain` 改成 `ON_PREM`：

```json
{
  "rule_id": "hands-managed-cloud",
  "target": { "runtime_id": "codex", "capability_id": "remote_hands.use" },
  "actions": ["use"],
  "effect": "ALLOW",
  "constraints": [
    { "kind": "execution_placement", "parameters": { "execution_domain": "MANAGED_CLOUD" } }
  ],
  "obligations": [
    { "kind": "audit", "enforcement_point_id": "AGENT_RUNTIME", "parameters": {} }
  ]
}
```

用戶端要求的提供者必須符合政策選定位置，不能覆蓋它。若政策後來改域，既有工作區仍留在原提供者；對它發起新執行會回 `POLICY_PLACEMENT_CHANGED`，不會改用另一提供者，也不會暗中搬移資料。畸形或互相衝突的 placement constraint 會拒絕執行。

## Cloudflare Hands 服務

`@genioone/cloudflare-hands` 位於 `runtimes/cloudflare-hands`。其 `wrangler.jsonc` 宣告 `Sandbox`、`WORKSPACES` Durable Object bindings、`BACKUP_BUCKET` R2 binding，以及 `ISOLATE_LOADER` Dynamic Worker Loader binding。部署前須建立設定檔指定的 R2 bucket，並在 Worker 設定 `HANDS_SERVER_TOKEN`。Sandbox 備份另需 `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`CLOUDFLARE_ACCOUNT_ID`、`BACKUP_BUCKET_NAME`。Worker token 須與 Bot server 的 `GENIO_CF_HANDS_TOKEN` 相同。

Worker 只提供執行與儲存。使用者 OIDC token、Codex 模型憑證、One Policy 授權權威和 Bot 記憶仍在 Brain。Bot server 將 tenant、Bot、擁有人與 acting client 綁定到工作區。isolate 工作使用 Loader；headless 與 desktop 租約使用 Sandbox container。此路徑不依賴 Cloudflare Computer 預覽 API。

Sandbox 設定使用 `standard-2` instance，`max_instances` 為 10。R2 除了保存 Sandbox backup，還保存帶版本的常規檔案鏡像及 manifest，供不啟動 container 的 isolate 讀寫；因此 isolate 與 native 租約使用同一個工作區。isolate 只支援常規檔案讀寫，每次最多 4 MiB；租約檔案 API 每個檔案最多 10 MiB。Sandbox backup 另外保留空目錄、符號連結及檔案模式，不能把 R2 常規檔案鏡像當成完整的 native backup。

本地 Worker 開發可設 `HANDS_LOCAL_BACKUP=1` 使用本地備份。local run 或 deploy dry-run 只能檢查開發路徑，不能證明 Cloudflare 部署、R2 持久性、桌面可用或受治理的 Bot Product UAT。

## 工作區生命週期

遠端工作區歸屬單一 Bot 與擁有人。Bot server 為該 Bot 選定一個目前使用的工作區。若首次要求執行時尚無工作區，server 依 `GENIO_BOT_RUNTIME` 建立。經驗證的 `GET /api/hands/providers` 回報兩個提供者的 L1／L2／L3 描述、預設選擇與必要設定是否存在；`configured` 不是遠端服務健康檢查。

`GET /api/bots/:botId/workspaces` 列出該 Bot 的工作區及 `activeWorkspaceId`。`POST /api/bots/:botId/workspaces` 可用 `{ "provider": "cloudflare-hands" }` 要求建立並選定 Cloudflare 工作區，或改用 `e2b-self-hosted` 要求 E2B 工作區。每個工作區的提供者在建立後固定；選取另一個工作區不會複製、移轉或回退檔案。`POST /api/bots/:botId/workspaces/:workspaceId/activate` 可重新選定既有工作區，執行中的租約不得切換。Cloudflare 的 JavaScript isolate 使用同一工作區上的 `POST /api/bots/:botId/workspaces/:workspaceId/isolate`，不需啟動 Sandbox container。

同一工作區的執行與儲存都維持在它的提供者邊界：E2B 工作區使用自架 E2B，Cloudflare 工作區的 isolate、native 與 desktop 使用同一個 CF 工作區。提供者連線失敗或政策拒絕時，不會自動改到另一個提供者執行，也不會暗中搬移資料。產物跨提供者匯入目前直接拒絕；同一提供者的擷取與匯入仍須對工作區 provider 重新檢查政策。

目前單一 Brain session 一次只掛一個 native workspace。若同一 session 的第二個 Bot 要求另一個 native workspace，會回 `WORKSPACE_BUSY`，且不會停止第一個 Bot 的租約。這是該 session 的限制，不是跨 principal、其他 workspace 或 isolate 的全域鎖。

Cloudflare JavaScript isolate 產生的已保存檔案，可用 `POST /api/bots/:botId/artifacts/from-runtime` 的 `{ "sourceTier": "isolate", "sourceWorkspaceId": "<工作區 ID>", "path": "/workspace/<檔名>" }` 明確擷取。回傳產物標記 `sourceTier: isolate`、儲存提供者、來源工作區與已保存修訂；桌面清單以這些來源資訊顯示產物，來源與目標提供者不同時不提供匯入操作。

Headless 與 desktop 是選定工作區上的執行租約。結束租約不等於刪除工作區。E2B sandbox 啟動時還原 Bot 保存的最新檢查點，結束 sandbox 前寫入新檢查點。Cloudflare Hands 在新 Sandbox 租約還原 R2 備份；釋放租約時關閉連線、停止程序、建立備份、推進修訂，然後銷毀 container。檢查點若失敗，應視為釋放失敗，不可宣稱檔案已保存。Cloudflare Worker 有獨立的工作區刪除操作，但 Bot server 未對使用者開放 purge API；一般租約釋放及 Bot 刪除均不呼叫該操作。

刪除 Bot 時，server 會先拒絕仍有執行中租約或 isolate 的刪除要求；刪除完成後，工作區紀錄改成 tombstone，既有 E2B 檢查點或 Cloudflare R2 備份繼續保留。原擁有人可用 `GET /api/hands/recoverable-workspaces` 找到這些工作區，並用 `GET /api/hands/recoverable-workspaces/:workspaceId/export` 下載已保存的封存檔：E2B 為 `.tar.gz`，Cloudflare Hands 為未壓縮 `.tar`。從未保存檢查點的 E2B 工作區可能沒有可下載內容。這次沒有自動永久清除、工作區複製或還原到新 Bot 的 API；後續若需 purge，須另設明確流程。

修訂號代表已保存的工作區版本，並不代表每個仍在執行中的檔案寫入。Bot UI 顯示 server 回報的提供者、工作區 ID 與修訂。工作區可維持選定狀態，而暫時沒有執行中的 sandbox 或桌面。

本次只固定工作區的提供者，並在政策改變執行位置時以 `POLICY_PLACEMENT_CHANGED` 阻止新執行；沒有遷移選擇畫面，也不會輸出 `BLOCKED_MIGRATION_REQUIRED` 背景狀態。[#80](https://github.com/dnplus/genioone-private/issues/80) 追蹤後續的延後遷移：到下一次執行才讓使用者選擇遷移或建立新工作區，保留舊狀態，並在切換前驗證新工作區。這些流程尚未在本次提供。

## Helm 設定

Chart 預設 `bot.runtime: local`。啟用遠端提供者時，設為 `bot.runtime: e2b-self-hosted` 或 `bot.runtime: cloudflare-hands`，再提供該提供者的值：

| 提供者 | 必填 chart values | Kubernetes Secret key |
| --- | --- | --- |
| E2B | `bot.e2b.domain`、`bot.e2b.apiKeySecretName` | `bot.e2b.apiKeySecretKey`，預設 `api-key` |
| Cloudflare Hands | `bot.cfHands.origin`、`bot.cfHands.tokenSecretName` | `bot.cfHands.tokenSecretKey`，預設 `token` |

引用的 Secret 須預先存在。Chart 要求預設提供者的設定完整；若兩組設定都完整，會把兩組憑證都只傳給 Bot container，使後端具備連接兩個提供者的條件。這只代表後端可用性，不授權使用者任選執行位置。`bot.runtime: local` 不會傳入遠端提供者憑證。CF 的 R2、Durable Object、Loader 與 Sandbox bindings 設在 Worker，不設在 Bot Helm chart。

`max_instances: 10` 是目前 Cloudflare Hands container 設定，不是已驗證的 production 無上限自動擴縮能力；容量、併發與故障恢復仍須在目標部署環境驗證。

## 驗證界線

先檢查所選提供者的 Helm render，再讓 Bot 連到實際 Hands 服務。經驗證的使用者須選取 Bot、要求工作區或執行、在狀態面板看到同一個提供者與工作區、執行檔案或命令、結束租約，並在新租約還原工作區。對應的授權與稽核結果須能以同一請求關聯。若需要桌面能力，再另外驗證桌面授權與操作。型別檢查、chart render 或個別提供者測試都不足以宣稱完成這段產品操作。
