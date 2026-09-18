# Genio Bot 持續性與產品邊界決策

更新：2026-09-08。這份文件是目前可採用的決策與未決邊界索引，取代逐日實作日誌與重複研究筆記。可見驗收結果以 [Bot continuity 驗收狀態](bot-continuity-acceptance.md) 與 [2026-09-08 完整驗收](bot-continuity-completion-20260908.md) 為準。

文件中的「已採用」描述目前產品邊界；「已驗證」只描述本地測試範圍；「未決」表示不能從現有測試推論完成。

## 1. Canonical ownership

| 對象 | 擁有者 | 目前決策 |
|---|---|---|
| OIDC identity、tenant、Subject、acting client、entitlement、One Policy、Connection、audit | GenioOne | Bot 只驗證與傳遞已授權的產品語意，不複製權限資料庫。 |
| thread、turn、native history、原生 approval、MCP protocol、model directory | Codex app-server | Genio Bot 使用原生 protocol，不另造 thread、turn 或 approval 詞彙。 |
| Bot profile、binding、session pointer、產品 timeline、handoff、memory | Genio Bot registry | 這些是產品主體與跨段接續所需的 durable state。 |
| command、file、workspace、Desktop | E2B runtime | E2B 是隔離執行面；Bot host 不執行不受信任的 shell 或檔案工作。 |
| 部署 placement、quota、sandbox routing、Firecracker | self-host E2B control plane/data plane | Bot 只保留 opaque runtime/sandbox ID 與 correlation，不重做 E2B scheduler。 |

完整責任分界、版本鎖定與 native protocol 來源見 [app-server ownership boundary](app-server-boundary.md)；E2B 的 upstream 輸入與 deployment profile 見 [E2B source audit](e2b-source-audit.md)。

## 2. Product shape

- Bot 是具名且可持續的產品主體。`BotProfile`、能力 binding、memory、routine 與 runtime session 是不同資料責任；不要把長期 profile、技能、工具連線或一次工作全部塞進一個 `role` 欄位。
- `Add` 只代表建立 binding 或啟動 catalog entitlement／Connection／One Policy 狀態機。`AUTO_GRANT`、`REQUEST`、`NEEDS_CONNECTION`、`CONNECTED`、`DENIED` 必須可見，不把瀏覽器 checkbox 當成安全控制，也不在沒有 route 時靜默換 provider。
- Bot 預設 private。Duplicate 可複製 profile／binding 設定，但不複製 conversation history、learned memory、附件或其他 owner 的登入憑證；公開分享與 catalog import 另有明確授權邊界。
- Computer 是明確的第二工作面，對應 `personal_bot.computer_use` 與 user-scoped lease；純聊天不需要開 Desktop。Runtime tier 使用 `none`、`headless`、`desktop`，按需設置 remote execution。
- 第一次建立流程只需 one job、anti-jobs、voice、wake 與 read-back；routine、group、公開 marketplace、Bot-to-Bot 擴充不能被假裝成同一個 MVP 完成項目。

## 3. Continuity and message contract

- Native thread 是執行段，不是新的產品 conversation。server-owned Bot timeline 保存同一 Bot 的 user message、Bot reply、Bot update、execution activity、Bot exchange 與 legacy import；native item 保留為執行證據，reasoning 不直接投影成聊天訊息。
- 穩定關聯使用 Bot ID、native thread／turn／item ID、`handoffId`、`replyToMessageId`、`peerBotId` 與可驗證的 source message ID。`replyToMessageId` 表示回覆關係，provenance 表示來源，兩者不能互相取代；沒有 source ID 時顯示交接本身，不以文字相似度猜來源。
- server timeline 與 session pointer 是權威。browser storage 僅能作舊資料匯入來源；server pointer 清空或換段時，舊 browser cache 不得覆蓋 server 決定。跨 native segment 必須保留 lineage、Bot context、memory source 與使用者可見主線。
- Bot memory 與 working summary 要保留 revision、來源 message ID、使用者管理／忘記狀態與 conflict 行為。模型整理的摘要是有來源的工作 context，不是外部操作成功或完整證據鏈；中斷、工具不可用或模型未遵循契約時可以沒有最新摘要。
- `task` 是需要 target execution 與 caller continuation 的交接；`fyi` 是可靜默的資訊：忙碌時排隊，空閒後由 target turn 讀取，可不回覆，也不建立 caller continuation。「已送達」與「已讀取」分開呈現。兩者仍需同一個分享／owner policy boundary，不能以 silent 省略授權。

目前實作證據可從 `server/bot-handoff.ts`、`server/handoff-delivery.ts`、`server/bot-timeline.ts`、`shared/bot-timeline.ts`、`server/bot-continuations.ts` 與 `server/invocation-recovery.ts` 追溯；完整本地結果見 [完成驗收](bot-continuity-completion-20260908.md)。

## 4. Async question and approval boundary

原生 `agentMessage.delivery="async"`／`questions` 與 `requestUserInput`、approval 是不同生命週期；`requestUserInput` 是否阻塞依 `isBlocking` 判斷。產品若提供「先問、繼續工作、稍後回答」，仍應維持以下未決契約：

- 問題狀態是 `pending → answered | dismissed | superseded`；略過不是核准，也不會授予工具權限。
- 答案派送狀態是 `queued → sending → delivered`，失敗或送達不確定時可恢復；「答案已保存」與「模型已收到」必須分開顯示。
- 題目以 Bot、native item、question index／revision 與 `clientAnswerId` 去重；steer 與 turn completion 競態先對帳 native history，再決定是否 start，不直接重送。
- 題目、草稿與派送紀錄應與 timeline 共用同一 registry，但不能複製整份聊天，也不能把 Desktop 私有 reply envelope 當第三方契約。

先前 local Product E2E 的問題卡證據屬於 requestUserInput；不能推論非同步提問已完成。Genio 的 request_user_input_async MCP 保存問題後立即返回，native async agentMessage 也投影至同一份問題資料。一般澄清與核准確認共用可見互動元件，但答案不授予操作權限。晚到答案遇到新工作時先保存，待新工作完成後自動接續；驗收進度見 bot-interactions-implementation.md。

## 5. Research decisions retained

### Grok／Desktop 的可採用部分

- 可借用「先建立有名字與工作邊界的 teammate，再漸進加入能力」的心智模型，以及三欄工作台、可跳轉的跨 Bot 訊息、structured continuation、明確的 Computer 面板與可觀測 routine history。
- 不採用 Grok 或 Codex Desktop 的私有字串、內部 RPC、帳號 scope 或 UI metadata 作 Genio security／durability 契約。Genio 仍以自己的 Bot timeline、One Policy、handoff/outbox、memory 與 audit 為 authority。
- 公開 app-server 的 `thread/start`、`thread/resume`、`turn/start`、`turn/steer` 可以沿用；跨 owner routing、授權、去重、回程與 Bot-wide memory 仍由 Genio 擁有。

### celld

目前 walking skeleton 不加入 celld dependency。若未來需要大量 WebSocket、per-Bot mailbox 或 session actor，可做 adapter prototype，僅持有協調狀態；celld 不取代 Codex app-server、E2B、GenioOne CP／One Policy，也不執行 native process 或不受信任的 shell。

## 6. Evidence boundary

- 2026-09-08 本地 continuity suite 為 277 pass、0 fail、84 files、1698 expectations，並有雙真實 owner 的成功／拒絕 UI 證據；細節與 exact IDs 保留在 [完整驗收](bot-continuity-completion-20260908.md)。
- 受控 test、契約測試、HTTP 200、fixture transport、瀏覽器 demo 或只通過 typecheck，都不是完整 Product E2E。新 native segment 使用明確 pointer reset；OAuth refresh 使用隔離頁面時間；長工作使用受控 runtime；這些界線必須在報告中保留。
- `fixtures/corp-service-desk-bot` 是 ServiceNow 示範 fixture，不是已連接的企業 ServiceNow。Bot 不能用 fixture 成功替代真實 published Resource、Connection、One Policy、tool outcome 與 correlated audit。
- OTel 本地 debug exporter 的 ERROR 收件不代表 ClickHouse 持久化，也不代表所有 Codex native errors 都被收錄。公司 model route、部署、provider login、跨副本 recovery 另行驗證。

## 7. Current unresolved production decisions

1. **部署與 writer topology**：目前 registry SQLite、RuntimeBroker、pending interactions、in-process delivery map 與 runtime ownership 仍以 single writer／單副本為安全基線。要開多副本，先決定 durable runtime lease、outbox claim、fencing 與 shared artifact/session store；在此之前 production profile 應明確限制為單 writer。
2. **重啟恢復**：SQLite 的 APPROVED／RUNNING 等持久列不等於可恢復的 native process、access token 或 pending request。要定義 broker 啟動掃描、native history 對帳、不可恢復狀態、答案／handoff 去重與人工重試語意。
3. **artifact authority**：package bytes、runtime artifacts、Codex home、workspace snapshot 的 canonical store、backup、retention、tenant erasure 與 metadata/blob 原子關係尚未定案；目前不應宣稱 object storage 或跨節點恢復已完成。
4. **Provider 與 token**：短期 browser token 可啟動 MCP relay，但正式跨 owner 與長生命周期 session 需要 server-owned delegated refresh；公司 model route 必須有明確 catalog／policy，不可 fallback 到 subscription route。
5. **Async question lifecycle**：要把上述問題／答案 state machine 變成可恢復產品資料與 UI，並驗證 server restart、兩分頁、題目取代、steer/start race 及所有 approval 類型。

Runtime tier 與 E2B provisioning 的目前假設見 [runtime tiering design](runtime-tiering-and-on-demand-sandbox.md)。這些項目是 review agenda，不是已完成的 production claim。

## 8. Review questions

- 單 writer／單副本是否是目前要正式承諾的 deployment profile？若不是，哪個 component 先成為 lease／fencing authority？
- Bot timeline、native `CODEX_HOME`、runtime artifacts 與 package bytes 的備份及 tenant erasure 是否要同一個 lifecycle owner？
- 重啟時哪些 persisted states 可以自動對帳，哪些必須轉成 `UNRECOVERABLE`／`RETRY_REQUIRED` 並由使用者明確重試？
- `fyi` 與 `task` 是否都要在跨 owner 共享後保留同一套 revoke／audit semantics，並如何顯示 delivery-only 終態？
- async question 的答案保存、送達與工具 approval 是否要共用 correlation，還是維持兩個明確 state machine？
