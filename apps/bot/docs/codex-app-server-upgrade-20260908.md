# Genio Bot app-server 0.151.0 → 0.153.4

2026-09-08：更新 Bot 擁有的 Codex app-server 與遠端 exec-server 版本，不是升級使用者的全域 Codex CLI。曾誤將全域 CLI 從 0.153.2 更新到 0.153.4，已還原並確認全域版本為 0.153.2。

## 升級範圍

- Dockerfile runtime：`@openai/codex@0.153.4`。
- E2B 設定預設與範本版本：0.153.4；既有 bootstrap 會依配置檢查 exec-server 版本。
- Bot package 新增精確版本的開發相依 `@openai/codex`，本機 pnpm script 與協定生成使用套件內執行檔。
- 本機 `.env.local` 的 command 指向套件內執行檔，version 改為 0.153.4；此檔不提交。
- `codex-upstream.json`：tag `rust-v0.153.4`，peeled commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`，由 upstream git tag 確認。

原本 generated types 已與 0.153.4 完全一致，但 Docker／E2B／manifest 仍鎖 0.151.0。本次把執行檔版本補齊，避免協定與 runtime 不一致。使用新版重生協定沒有檔案差異，也沒有多餘的舊 generated files。

## 兩版主要差異

跨過 0.152.0、0.152.1、0.153.0–0.153.4，共 7 次發行。以兩個實際 npm 執行檔分別生成 experimental TypeScript schema，比較結果為新增 7 個檔案、變更 14 個檔案、刪除 0 個檔案。

| 能力 | 對 Bot 的意義 | 此次是否增加 UI |
| --- | --- | --- |
| Thread 新增 model、reasoningEffort | 可讀取 thread 目前設定，不需由最後訊息猜測；不是每次推論的 telemetry | 否 |
| agentMessage 新增結構化 questions | 可承載非同步詢問與選項，對話不必只依賴純文字問題 | 否 |
| modelProvider/authRecoveryStarted、Completed | 可呈現 provider 認證恢復進度 | 否 |
| thread/shellCommand.timeoutMs | 可指定命令執行期限，包括超過一小時；0 是立即逾時，不是無限等待 | RPC 已驗證 |
| 每個 MCP tool 的 output_token_limit | 可限制單工具輸出，減少 context 被過長回應占滿 | 未新增設定 |
| MCP account approval 與 cache／認證修正 | approval 記憶依 app account 區分，改善重連、工具可用性與認證刷新 | 沿用上游 |
| GPT-6 Astra catalog | 新版內建模型目錄支援 Astra；未明確指定模型時上游 default 改變 | Bot 既有模型選擇未改 |
| plugin/reconcile、project 排序等協定 | 更多 plugin 狀態同步與專案中繼資料能力 | 否 |

生成差異直接來源：`v2/Thread.ts`、`v2/ThreadItem.ts`、`v2/ThreadShellCommandParams.ts`、`v2/AuthRecoveryNotification.ts`、`v2/PluginReconcileParams.ts` 等。新增型別不代表 Bot 已實作對應產品功能。

上游 0.152 預設關閉 planning tool；需要時可明確配置 `tools.update_plan.enabled=true`。0.153 調整 Full Access／Guardian review 行為。Bot 本次未新增寬鬆權限設定，也未改既有模型預設。

## 驗證

- `pnpm --filter genio-one-bot exec codex --version`：0.153.4。
- 全域 `codex --version`：0.153.2，還原成功。
- TypeScript typecheck 通過。
- Bot 測試：278 pass、0 fail、1708 assertions，85 個測試檔。
- Vite 前端與 Bun server bundle 均成功。
- 使用產品 `appServerArguments({})`、獨立暫存 CODEX_HOME 啟動真實 0.153.4 app-server：initialize、model/list、thread/start、thread/shellCommand（10000ms timeout、實際寫入暫存 marker）、thread/read、thread/resume、thread/archive 全部通過。
- 同版原生 exec-server 在本機另一個 process 啟動，app-server 的 environment/add 與 environment/info 通過。
- 沒有執行模型推論，沒有使用使用者 Codex 登入資料。

以上不是完整 Bot UI E2E，也不是 E2B／156 部署驗收。既有 app-server process 不會因 binary／設定更新而熱切換；需在原 session 結束、Bot server 重啟或新部署後啟用新版。未中斷正在使用的 Bot session，未重建遠端 E2B template。

## 官方更新紀錄

[OpenAI changelog](https://learn.chatgpt.com/docs/changelog)：2026-09-01 的 0.152.0／0.152.1、2026-09-03 的 0.153.0–0.153.2、2026-09-04 的 0.153.3／0.153.4。TUI Vim、recap 等變更不列為 Genio Bot Web 新功能。
