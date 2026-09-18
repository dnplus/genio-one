# Genio Bot Runtime Tiering & On-Demand E2B Execution Design

> 本文件描述目前展示階段的執行邊界。server-side Codex app-server、延後 E2B lease、Headless／Desktop 雙 template、Desktop capability gate 與 UI on-demand trigger 已接通；正式多副本 lease、物件儲存與跨節點調度仍是後續 production hardening。

## 1. 背景與現狀痛點 (Background & Problem)

切片 1 起，WebSocket 連線只驗證 Personal Bot Entitlement 並啟動 server-side app-server，**不再**於連線當下開 E2B execution lease。遠端執行環境由 `RuntimeBroker.ensureExec()` / `genio/runtime/ensureExec` 在明確的執行意圖下按需啟動。

先前痛點（目前仍用作 sizing 基線）：
- **資源規格過重**：現有模板（`scripts/build-e2b-template.ts`）配置為 `cpuCount: 8, memoryMB: 8192`。
- **無差別啟動**：舊流程即使使用者僅進行純文字對話、或透過 GenioOne MCP 調用 ServiceNow Case 查詢，後端仍會即時開出一台完整虛擬機，並常駐啟動 X11/Xvfb 與 noVNC（port 6080）串流；目前連線先保持 `none`，只在明確執行意圖時開 `headless` 或 `desktop`。
- **並發瓶頸**：在多用戶環境下，10 個並發用戶即需消耗 80 vCPU 與 80GB 記憶體，且絕大多數圖形計算資源處於閒置浪費狀態。
- **冷啟動延遲過長**：因為 Desktop 包含視窗管理員、noVNC 與桌面環境，冷啟動需 3～8 秒，導致目前架構無法做到順暢的「按需即開即用」。

---

## 2. 邊界與必要性分析 (Core Boundaries)

### 2.1 為什麼需要隔離的 Remote Execution Runtime？
`genio-one-bot` 底層依託 server-side `codex-rs app-server`。Codex 具備終端機指令（`command/exec`）、檔案讀寫（`fs/*`）、Python/腳本執行等能力；這些工作不能落在 Bot host 上：
1. **防止跨租戶資料外洩與越權**：若在伺服器 Host 裸跑，惡意 Prompt 或失控腳本可直接窺探其他用戶的檔案、記憶體、或竊取環境變數。
2. **防範內網穿透 (SSRF)**：裸跑進程可存取本機 Loopback 服務（如 Redis、PostgreSQL、雲端 Metadata 169.254.169.254）。
3. **噪聲鄰居 (Noisy Neighbor) 隔離**：死循環、記憶體洩漏與 Fork Bomb 必須被硬體級（KVM/Firecracker）限制在微虛擬機內。

### 2.2 為什麼 Desktop「不是每次都必要」？
- **執行邊界**：Codex 執行任何代碼與 Shell 指令的核心是 **`codex exec-server` (Port 4512)**。
- **視覺邊界**：Desktop（X11 + noVNC）僅是使用者觀察畫面的「呈現層」。純代碼編寫、數據計算、終端機執行、檔案操作及 MCP 呼叫完全不依賴桌面 GUI。

---

## 3. 分層執行架構 (Tiered Architecture)

將「是否需要 E2B」與「是否需要可視化桌面」拆開，執行環境目標拆解為三層。下列規格與延遲是待實測的 sizing hypothesis，不是目前的保證值：

```
[ 用戶請求 User Request ]
       │
       ├─► Tier 0: 無 E2B Execution Lease
       │    │  • 純文字對話 / 摘要 / 邏輯推理
       │    │  • GenioOne MCP 工具呼叫 (ServiceNow, Jira, API)
       │    └─► 不建立 E2B VM；仍由 server-side app-server 處理對話與 MCP
       │
       ├─► Tier 1: 輕量無頭沙盒 (Headless Sandbox - 預設動態層)
       │    │  • 終端機執行 (Bash, Git, Node, Python)
       │    │  • 工作區檔案讀寫 (fs/*, 專案編譯, 數據分析)
       │    │  • 僅運行 codex exec-server (ws 4512)
       │    └─► 目標規格: 1~2 vCPU, 1~2GB RAM；延遲待 Linux provider 實測
       │
       └─► Tier 2: 視覺/桌面沙盒 (Visual & Desktop Sandbox - 真正按需)
            │  • [選項 A] Headless Chrome + CDP Screencast (瀏覽器自動化，極省資源)
            │  • [選項 B] 完整 X11 + noVNC Desktop (需要人類透過滑鼠鍵盤接管)
            └─► 目標規格: 4~8 vCPU, 4~8GB RAM；延遲待 Desktop provider 實測
```

Tier 0 不是把 command/file execution 放到 Bot host。若該輪沒有 remote environment，Codex app-server 必須以原生 permission/tool configuration 拒絕或不暴露 execution；`baseInstructions` 只能說明行為，不能當作安全控制。

---

## 4. 按需啟動與可觀測延遲 (On-demand Provisioning)

為避免用戶感受到「冷啟動等待」，後端採用**可觀測的按需啟動（On-demand provisioning）**；不解析 LLM 原始 token 來猜測工具意圖：

1. **連線建立時**：
   - 用戶進入聊天室，驗證 OIDC Token 完成，此時**不建立 E2B lease**（維持 Tier 0）。
2. **明確執行意圖時**：
   - 使用者開啟 Desktop、前端送出 `genio/runtime/ensureExec`，或 Codex adapter 判定需要 remote environment 時，才發出 provision intent。
   - Broker 以 idempotent／coalesced operation 啟動對應的 Headless 或 Desktop provider，並把 `environment/add` 與 thread/turn environment selection 交給 Codex app-server。
   - UI 立即顯示 provisioning/activity state；不能以「已收到第一個 token」宣稱 execution 已 ready。
3. **閒置釋放 (Auto Hibernation/Kill)**：
   - 閒置超時先以 provider 實測與租戶 policy 決定，預設候選範圍為 **5～10 分鐘**。
   - 超時未操作則呼叫 `sandbox.kill()` 或 E2B pause，記憶體立刻交還主機。

---

## 5. 接續實作步驟 (Implementation Tasks)

接續工作可依照以下步驟分階段進行：

### 階段一：新增 Headless E2B 模板 (Template Preparation)
- [x] `scripts/build-e2b-template.ts` 同時建置獨立 headless template：
  - 基礎映像檔改用官方極簡 Debian/Ubuntu 映像（無需 X11 / noVNC / Desktop 相關依賴）。
  - 僅安裝 Node.js、Codex CLI (`@openai/codex`) 與基礎工具（curl, git, jq）。
  - headless template 構建規格預設為：`cpuCount: 2, memoryMB: 2048`。
- [x] 在 `.env.example` 與 `server/e2b-self-host.ts` 中新增 `GENIO_BOT_E2B_HEADLESS_TEMPLATE` 配置項。

### 階段二：後端 RuntimeBroker 改為延遲／多模態掛載 (Lazy & Dynamic Provisioning)
- [x] **解耦初始連線與沙盒綁定**：
  - 在 `server/index.ts` 中，建立 WebSocket 時先註冊 Session，但不立即呼叫 `runtimeBroker.start()` 開 VM。
  - 當 Codex app-server 發出第一個需要 remote environment 的請求（或收到前端顯式啟用請求）時，才觸發 provision。
- [x] **支援模板切換**：
  - `RuntimeProvisionRequest` 實際支援 `none | headless | desktop`；`none` 不建立 E2B，`headless` 與 `desktop` 由不同 template 和 lease 管理。
  - 預設維持 None；只有在用戶手動打開 Desktop 面板或觸發檔案／指令執行時，才按需啟動對應 tier。
  - Desktop provisioning 前必須檢查 `personal_bot.computer_use`，不能只驗證 `personal_bot.use`。

### 階段三：前端 UI 視覺與面板按需載入 (Frontend Optimization)
- [x] 修改 `src/app.tsx` 的右側面板邏輯：
  - 點擊 `/desktop` 或右側「受控電腦」分頁時，若目前無 Desktop 實例，顯示「點擊啟用電腦桌面」或「正在為您準備專屬受控桌面...」。
  - 在無桌面狀態下，一般聊天與代碼分析正常運作，右側可切換為「活動日誌 (Activities)」或「代碼檢視」，不強制要求 VNC iframe。

### 階段四：瀏覽器自動化輕量化 (可選進階)
- [ ] 若需自動化瀏覽器操作，評估在 Headless 沙盒中引入 `playwright` + Chrome DevTools Protocol (`Page.startScreencast`)，直接取代肥大的 noVNC，達成兼具畫面觀看與極致節省資源的最佳解。

## 6. 與目前實作的對照

- 已完成：server-side Codex app-server、無 E2B lease 的初始連線、`RuntimeBroker.ensure()` 的 headless/desktop 分 lease、E2B `codex exec-server` 與 app-server 的 `environment/add` bridge。
- 已完成：前端與 Codex adapter 的 `genio/runtime/ensure` trigger；`/desktop` 明確啟動 desktop，檔案／指令意圖先啟動 headless。
- 已完成：Headless 與 Desktop 的獨立 template／provider；Headless 不啟動 Desktop stream，Desktop 才啟動 noVNC。
- 已完成：Desktop provisioning 的 `personal_bot.computer_use` enforcement 與 none-tier host command fail-closed gate。
- 已完成：headless 產物可由 Broker 讀入 server-owned Artifact Store；Desktop 只能透過明確 ArtifactRef import，並可在 Desktop sandbox 內啟動 Chrome 開啟產物。
- 共享語意：E2B lease 目前以 tenant／subject／acting-client scope 共用，Bot identity 應透過 `botId`、thread 與 activity correlation 記錄；不同 Bot 不應被當成安全隔離邊界。
