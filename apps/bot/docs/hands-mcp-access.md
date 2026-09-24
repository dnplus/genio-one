# Hands MCP 存取：Plugin CLI 在 Runtime Workspace 呼叫受管 MCP

Plugin 的 skill 由 Bot server 上的 Codex app-server 載入，指令則在 hands（E2B sandbox）裡執行。本功能讓 plugin 附帶的 CLI 在 sandbox 內呼叫該 Bot 已綁定的 MCP resource，並把短期資料留在 runtime workspace；connector 本身仍保持 stateless。Mail2000 的 `m2k` 是第一個使用者。

## 流程

```
Bot 選定 ─> plugin/install（既有）
lease 佈建（RuntimeBroker.provisionTier）
  ├─ 簽發 hands grant：綁定 runtime session、Bot 與 lease tier，1 小時
  ├─ E2B network.rules：對 relay host 的出站請求注入 Authorization: Bearer <grant>
  ├─ 寫入 /home/user/.genio/mcp.json：resource 與 relay URL，不含憑證
  └─ 複製 plugin 的 hands/ 檔案到 /home/user/.genio/plugins/<plugin>/
sandbox 內 CLI ─> relay URL（無憑證）─ netd 注入 grant ─> Bot relay
  └─ relay：grant → 既有 Bot ownership、mount、catalog、One Policy mcp.invoke 與 report
       └─ 以使用者 access token 呼叫 Gateway → connector
```

## 安全性質

- **Hands 內沒有憑證。** Grant 由 sandbox 外的 egress 注入；sandbox 只看到 manifest 的 URL。被 prompt injection 操控的指令只能在 sandbox 內、在 grant 範圍內使用這個身分，無法把 token 帶到其他地方重放。
- **Bot server 只保存 grant 的 SHA-256。** Session 結束、lease 停止或退出、佈建失敗時撤銷；過期即失效。
- **只在所屬 Bot 被選取時有效。** 同一使用者的 Bot 共用 sandbox（Bot 不是隔離邊界，見 `runtime-tiering-and-on-demand-sandbox.md`）；選取其他 Bot 時 relay 以 `HANDS_MCP_BOT_MISMATCH` 拒絕，切回後恢復。已寫入 sandbox 的快取與 plugin 檔案不會因切換 Bot 而刪除。背景 invocation 若不是目前選取的 Bot，hands 呼叫同樣被拒。
- **Grant 不是使用者 token，也不是 session relay secret。** Relay secret 仍只給 app-server；grant 無法使用 Discovery 或 model relay。
- **唯讀。** Grant 只接受 POST 單一 JSON-RPC 的 `initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`。`tools/list` 回應只保留 connector 宣告 `readOnlyHint: true` 的工具並記錄名稱；`tools/call` 只接受已記錄的工具。寫入類操作仍由 model 經 app-server 的原生核准流程呼叫。
- **每次呼叫照常授權。** Hands 呼叫與 app-server 呼叫走同一條 relay：Bot ownership、INSTALLED binding、catalog ENTITLED、`mcp.invoke/invoke` authorize 與 report；另記 `mcp.relay.hands` 操作日誌（resource、method、tool、correlation）。
- **Plugin 資產有界。** 只複製 plugin 目錄下的 `hands/`，路徑限制在 package root 內，拒絕 symlink，最多 64 個檔案、2 MiB，並沿用 package digest 驗證後的 materialized root。

`readOnlyHint` 由 connector 宣告；已安裝的 connector 被信任會如實標示。

## 設定

- `GENIO_BOT_HANDS_RELAY_ORIGIN`：sandbox 內可路由到的 Bot relay origin。未設定時不簽發 grant、不加 network rule、不寫 manifest，行為與既有版本相同。
- Plugin hands 資產只在 hands MCP 啟用時複製；寫入 manifest 或資產失敗只記 `runtime.e2b.hands.write_failed`，不影響 lease 佈建。

## 驗證

```sh
pnpm --filter genio-one-bot test            # 含 hands grant、relay、broker lifecycle、資產收集
pnpm --filter genio-one-bot test:hands-mcp  # m2k 端到端（fixture IMAP）
M2K_LIVE=1 MAIL2000_USERNAME=… MAIL2000_PASSWORD=… pnpm --filter genio-one-bot test:hands-mcp
```

`test:hands-mcp` 以子程序執行真正的 `m2k`（只有 HOME 與 PATH），經過注入 grant 的 egress 替身、真正的 relay 與 hands grant、把使用者 token 換成 Mail2000 憑證的 gateway 替身，到真正的 Mail2000 connector。驗證：manifest 與 CLI 不含憑證；跨資料夾同步與切分、中文搜尋、讀信；upstream 只看到使用者 token；每次 relay 呼叫都經 One Policy；寫入工具被拒且未到 upstream；沒有注入時 relay 回 401。

2026-09-24 以 `M2K_LIVE=1` 對 mail.gss.com.tw 執行通過：7 天 260 封、0 gap、5 次 relay 呼叫。

## 尚未涵蓋

- **E2B `network.rules` 在自架 `e2b-dev/runtime` 的支援度未驗證。** SDK 只標明 `egressProxy` 不支援開源 runtime。上線前須在 175 驗證注入確實發生；若不支援，本功能不可啟用（不要改成把 grant 放進 sandbox 環境變數）。
- **Local Hands**：需要由 `genio-endpoint-hands` 提供 loopback 注入代理，本版不簽發 grant。
- **Egress 收斂**：sandbox 目前未設 `allowOut`，出站不受 One Policy 管控；需要新的 network capability 與 `updateNetwork`。
- **委派憑證**：relay 仍以使用者 access token 呼叫 upstream；改用 delegated agent credential 待 token exchange 上線。
- **MCP body DLP**：Gateway ext_proc 目前不處理 MCP 欄位，需另行確認。
- **Connector 安裝即註冊 plugin**：`apps/connectors/mail2000/package/` 已是可納入 Bot package 的 plugin 目錄，但 connector 安裝流程尚未自動把它加入 Bot package。
