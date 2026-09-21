# Local Hands：本機命令與檔案修改

這是 macOS／Linux 的互動配對先行版。Bot server 保留 Codex app-server、對話與模型；`runtimes/endpoint` 的 `genio-endpoint-hands` 啟動本機 `codex exec-server`，透過主動建立的 WebSocket 連回 Bot。Endpoint 不需要模型登入，也不需要開放本機 TCP listener。

## 使用方式

1. Bot 與 Platform 必須已完成正常登入、`personal_bot.computer_use` 與 runtime capability 授權，並配置既有 runtime report 簽章。先停止同一個使用者的 Headless lease，等目前 Bot 工作結束。
2. 從 repository 建置 Endpoint：

   ```sh
   cargo build -p genio-one-endpoint --bin genio-endpoint-hands
   ```

3. 登入 Bot，在對話標題旁點「連接本機」，填入本機資料夾並產生一次性配對碼。
4. 在該電腦執行視窗中的指令；開發 checkout 可直接使用建置輸出：

   ```sh
   ./target/debug/genio-endpoint-hands \
     --bot-url http://127.0.0.1:5180 \
     --workspace /absolute/path/to/workspace \
     --codex ./apps/bot/node_modules/.bin/codex
   ```

5. 終端機提示後貼上配對碼。CLI 核對 Codex 0.153.4，Bot 完成原生 environment 註冊後，即可在同一段對話要求執行命令或修改檔案。部署環境使用 Bot 的 HTTPS origin。
6. 點「停止本機連線」或在 Endpoint 終端機按 Ctrl-C。連線中斷後需清除舊連線，再產生新的配對碼；不重送先前的執行請求。

`GENIO_ONE_LOCAL_HANDS_TOKEN` 可供非互動啟動傳入一次性配對碼。Endpoint 不會把此變數傳給執行子程序。`--codex` 未指定時使用 PATH 中的 `codex`，版本不符會拒絕連線。

## 已實作的邊界

- 配對碼為 256-bit、有效 5 分鐘且只可使用一次，綁定已登入的 runtime session 與選定 Bot。配對及連線時核對 Bot ownership；每個 process／filesystem RPC 都重新查 One Policy。
- Runtime capability registry 目前是固定清單，未知或 adapter 動態回報的 capability 一律不授權。`remote_hands.use/expose` 只建立一次性配對，Endpoint 接受時以 `remote_hands.use/use` 重驗；實際命令與檔案 RPC 仍各自重新授權。
- 同一使用者一次只接一個 Headless lease。Endpoint lease 最長 1 小時；WebSocket 每 15 秒探測存活，超過 30 秒沒有 Pong 時關閉。停止、斷線或拒絕授權後停止本機 executor；尚未確認的工作不會換到雲端執行。
- Browser 無法選擇內部 executor secret；Bot server 才將私有連線 URL 送給 app-server。內部 bridge 拒絕帶 Origin 或來自非 loopback 的請求。
- `environment/add`、environment ownership 與 native sandbox params 沿用既有 Bot 路徑。Endpoint 的實際 cwd 由本機 canonical path 回報，server 將它固定為 runtime workspace root。工作資料夾是 native sandbox 的寫入根目錄；額外權限仍走原生核准流程。
- 命令的 accepted response 不代表完成。`process/exited` 或 filesystem response 對應同一筆 One Policy authorization，送出單一 signed runtime report。斷線中的命令標為 `LOCAL_HANDS_RESULT_UNCONFIRMED`。稽核服務無法確認時，不把執行結果當成已確認成功。
- 本機 executor 使用獨立、暫時的 CODEX_HOME，僅繼承基本 OS environment。stdio 關閉時先讓原生 executor 清理子程序，超時才終止程序群組。

## 驗證與限制

```sh
pnpm --filter genio-one-bot test:local-hands
pnpm --filter genio-one-bot typecheck
cargo test -p genio-one-endpoint --bin genio-endpoint-hands
```

`test:local-hands` 使用真正的 Rust Endpoint、Codex exec-server 與 app-server：驗證建立／修改檔案、原生 filesystem 寫入、environment 註冊、重複配對拒絕、錯誤 bridge secret 拒絕、撤銷政策後無副作用、斷線停止長時間程序與不回退到雲端。授權及 receipt receiver 是隔離的測試替身；測試固定每個 correlation 只能有一個 outcome，以符合現行 Platform 契約。

2026-09-10 已驗證上述原生整合、Bot 298 個測試（含 Endpoint ownership 回歸）、Bot 型別檢查及前後端 build。CUA 在實際 Bot demo 頁面操作配對入口、資料夾輸入與未登入錯誤；這是 UI 分段證據。

目前 checkout 沒有 Bot／Platform `.env.local`，且 5181／58082 沒有服務，因此本輪未執行真實 OIDC → 模型呼叫本機工具 → Platform signed audit 查詢的 Product E2E；也未驗收原生提權核准、跨主機 HTTPS、睡眠／喚醒與完整 lease timeout。

此配對是使用中的 Bot execution lease，尚未整合 Platform 的永久 Endpoint device enrollment、裝置憑證輪替、MDM／常駐安裝、簽署發佈、重啟後重新連線或 durable receipt outbox。Bot server 重啟會撤銷配對及連線。常駐受管理 Endpoint 不應以這個一次性配對流程作為完整替代。
