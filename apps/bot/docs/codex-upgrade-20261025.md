# Codex 0.164.0 與 Bot 持續性升級評估

這次升級讓 Genio Bot 使用同一個 Codex release 產生協定與啟動原生 runtime，並把現有單 writer 部署限制寫成 Helm 可檢查的設定。完整工作恢復與多副本執行另行設計。

## 版本與來源

評估基準是 GenioOne `0f891046df8900d1881de92fff558a28092a9c2d`。當時 package、upstream manifest、Local Hands 與生成協定使用 `0.162.0`。2026-09-08 的 `0.153.4` 文件保留作歷史紀錄。

本次目標是官方穩定版 `0.164.0`。已核對 [npm package metadata](https://registry.npmjs.org/@openai/codex/0.164.0)、[官方 release](https://github.com/openai/codex/releases/tag/rust-v0.164.0) 與 [tag object](https://api.github.com/repos/openai/codex/git/tags/fe3b29455488c2e189e43ad5526a107900c5e1b7)。Tag 指向 commit `6aaac694803004a63c6f393d153c96d22521a6b9`，不是 prerelease。套件授權仍為 Apache-2.0，Node.js 要求仍為 `>=16`。

[0.163.0 release](https://github.com/openai/codex/releases/tag/rust-v0.163.0) 涉及儲存中的權限與 network approval 恢復，也移除舊的 patched zsh backend。[0.164.0 release](https://github.com/openai/codex/releases/tag/rust-v0.164.0) 涉及 session 設定恢復、壓縮 history、MCP 與 sandbox 修正。這些變更需要原生協定與既有權限回歸，不能只改 package 字串。

本任務使用的 Mac 全域 CLI 為 `0.163.0`，Bun 為 `1.4.2`，Node.js 為 `26.7.0`，專案 pnpm 為 `12.10.1`。測試選擇 package 內的 Codex executable。未更新全域 CLI、切換模型名稱或重啟其他任務。

## 從現碼選擇範圍

Genio 已有 Bot profile、timeline、handoff、memory、schedule、非同步問題、workspace checkpoint 與多種 Hands provider。`BotWorkspaceStore` 也已保存 Cloudflare lease attempt 的 request key 與 generation。這些不是本次要重新建立的功能。

| 候選切片 | 現碼證據 | 決策 |
| --- | --- | --- |
| Codex release 一致性與相容回歸 | Package、Local Hands literal、upstream manifest、lockfile 與生成協定需要一起移動。 | 本次交付。版本由 package authority 提供，協定由實際 binary 重新生成。 |
| 單 writer 部署設定 | `RuntimeBroker` 的 session、turn claim 與 provisioning maps 是 process-local。`bot.yaml` 原本直接 render 任意 replica count。 | 本次交付。Helm schema 允許維護用 `0` 或單 writer 的 `1`。 |
| 主動工作的 crash reconciliation | `invocation-recovery.ts` 已會對帳 native history，但需要已初始化且有 access token 的 owner session。 | 後續獨立切片。先定義 native execution ID、權限恢復、對帳期限與不確定結果。 |
| 跨 host 的 canonical workspace/blob store | 已有 E2B checkpoint 與 Cloudflare request identity。 | 後續決定 blob authority、revision compare-and-swap、orphan 清理與刪除契約。 |

`handoff-delivery.ts` 的 in-process 去重不是完整跨副本 ownership。Provider lease identity 也不能替代 Bot app-server、pending interaction 或 outbox 的 owner fencing。這次不新增另一套 auth、policy、thread 或 Hands abstraction。

## Rakazo 可借用的設計

研究固定在 Rakazo `01744dd87d83298a448c353885775bea9df68416`。只讀取公開 source，未執行其 installer 或傳送 Genio 私有程式到外部服務。

- [run-wakeup.ts](https://github.com/elie222/rakazo/blob/01744dd87d83298a448c353885775bea9df68416/packages/adapters/src/run-wakeup.ts#L14-L80) 把待執行時間保存在 Postgres row。Notification 用來減少延遲，漏訊後由 scan 找回。Genio 後續的 recovery trigger 可採同樣的權威分離。
- [computer-lifecycle.ts](https://github.com/elie222/rakazo/blob/01744dd87d83298a448c353885775bea9df68416/packages/adapters/src/computer-lifecycle.ts#L522-L595) 以 transaction 檢查 run owner、fence 與到期時間，再遞增 execution fence。Genio 若要多 writer，必須決定每個可變狀態與 provider 動作如何拒絕舊 owner。
- [home-object-store.ts](https://github.com/elie222/rakazo/blob/01744dd87d83298a448c353885775bea9df68416/packages/adapters/src/home-object-store.ts#L196-L240) 先上傳，再用預期 base revision 推進 pointer。結果不確定時保留可能已提交的物件。這比單純替換存放位置更適合作為 workspace 後續設計參考。

這些是 source review 的設計證據，沒有在本任務執行 Rakazo 測試。保留 Codex 原生 thread、turn、approval、MCP 與 model directory。保留 GenioOne identity、One Policy 與 audit。Bot registry 繼續擁有 profile、timeline、handoff 與 memory。

## 設計比較與執行流程

完成條件是專案版本來源一致、原生 binary 相容檢查可重跑、既有權限與恢復回歸通過，而且 PR 的遠端 SHA 與 CI 狀態可核對。執行強度採高標準，因為 generated protocol 與 executor 是執行邊界。

比較了 template guard 與 Helm schema 兩種結構。採用 schema 作為唯一 replica 設定驗證，避免在 template 重複規則。採納另一候選的 package-derived version，使 E2B、Local Hands 與畫面提示共用版本 authority，沒有新增 branded version type 或通用 RPC library。

流程依序為基準擷取、雙設計比較、原生檢查先跑舊版、專案版本與協定更新、chart 失敗案例修正、完整回歸及獨立 diff review。Runtime 修改只有一個 writer；chart 與文件使用不重疊檔案。各單元驗證後才進入提交與 Draft PR。

`pstack` 設定中的 Claude 與 Grok 模型在本執行環境不可用，因此使用可用的 GPT 模型進行獨立探索、設計與審查。同模型家族的審查不能宣稱具備跨模型家族多樣性。未安裝的 `cursor-team-kit` deslop 與 control-cli 技能也不列為已執行的檢查。

## 部署契約與限制

啟用或停用 Bot 的 values 都必須將 `bot.replicas` 設為整數 `0` 或 `1`。`0` 保留維護停機，`1` 是目前支援的執行拓撲。其他 component 的 replica 設定不受此規則影響。

正常 Helm render 會拒絕不支援的 Bot replica count。`--skip-schema-validation`、直接修改 Kubernetes 物件、手動啟動另一個 Bot process 或另一個 release，都能繞過 chart 設定檢查。此規則不是 runtime fencing，也不能證明全環境只有一個 writer。交付流程必須保留 schema validation。

`GENIO_BOT_CODEX_VERSION` 仍是既有 E2B deployment override。指定與 package 不同的版本需要另外驗證相容性。Local Hands 維持精確版本 handshake，不會在失配後自動改用雲端執行。

## 驗證與後續 gate

基準 `0.162.0` 的 Bot typecheck 通過，859 個 Bot 測試全部通過。以相同版本在空目錄重新生成協定，與 checked-in generated tree 完全相同。原 chart 確實可 render 出兩個 Bot replicas，作為部署限制測試的失敗基準。

本次實際命令與結果記錄在 [verification.json](codex-upgrade-20261025/verification.json)。決策紀錄在 [decisions.tsv](codex-upgrade-20261025/decisions.tsv)。

原生 smoke 使用隔離的 app-server 與 exec-server。Thread metadata、environment registration、檔案讀寫、程序結果、錯誤、中止與重新啟動，均只涵蓋測試實際觀察的範圍。保留 workspace bytes 後啟動新程序，不等於恢復進行中的模型 turn、broker session 或原生 approval。

獨立 migration 檢查先由 `0.162.0` app-server 透過原生 config RPC 保存設定，再由 `0.164.0` 開啟同一個隔離 `CODEX_HOME`。設定 bytes 保持一致，新 thread 的 `on-request` 與 `read-only` defaults 仍生效。既有 rollout history 與 pending approval 的跨版本恢復尚未在此檢查驗收。

重跑 `test:codex-native` 驗證目前 package pair。`test:codex-migration` 另要求 `GENIO_CODEX_MIGRATION_BASELINE_BINARY` 指向經版本檢查的 `0.162.0` native executable。缺少 baseline 時命令會失敗，不會略過測試。`check:codex-protocol` 在空目錄生成並比對完整檔名與 bytes。

App-server 以關閉 stdin 結束。Standalone WebSocket exec-server 的 `--exit-on-stdin-close` 在舊版與本次版本都要求 remote registration，不能與 standalone listen 同時使用。見 [0.164.0 CLI 參數約束](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/cli/src/exec_server_command.rs#L160-L168)。該程序以已觀察的支援流程關閉，測試等待程序退出；不宣稱 stdin 本身能結束 standalone executor。

Public CE checkout 沒有 Rust Endpoint workspace 與 Cloudflare Worker source。正式升級 Local Hands 前，必須在正確的 Endpoint source 更新版本要求、建置 binary，並執行既有 real Endpoint native integration。此 PR 的 direct-binary smoke 不能替代該驗收。真實 E2B、Cloudflare、登入、模型呼叫及企業工具 audit 路徑仍需在授權部署環境驗證。

後續 crash reconciliation 應先驗證 enqueue 後斷線、native start 後遺失 acknowledgement、舊 worker 在 takeover 後回寫、恢復時失去權限，以及兩個 writer 競爭。先對帳 native history，再決定人工重試。不能因 persisted row 存在就重播結果不明的外部寫入。
