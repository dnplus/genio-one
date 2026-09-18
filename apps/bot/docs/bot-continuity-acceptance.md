# Bot continuity 驗收狀態

原始目標保留：mention／handoff／reply back、Bot-owned context／memory、一 Bot 一條主線、流暢 session 接續與完整可見歷史恢復。本地原始範圍已完成驗收，最終證據見 [2026-09-08 完整驗收](bot-continuity-completion-20260908.md)。

## 已取得的主線證據

| 要求 | 目前實作與驗證 |
|---|---|
| mention 對到正確 Bot | 共用 parser、Bot ID／文字範圍持久化；同名與編輯情境有測試，實際同 owner 交接回程通過。 |
| 模型委派及原 Bot 接續 | 原生 Bot MCP→server handoff→target→caller continuation；成功、路線失敗、原生程序中斷均有實際結果及原生 turn 關聯。 |
| 忙碌時排隊、不混答 | 真實原生問題等待時保持 APPROVED，原工作完成後才派送；QUEUE 回覆及 reload 通過。 |
| 長工作與中斷 | 121008ms 受控 runtime 保持 RUNNING；真實 SIGKILL 後自動 FAILED／interrupted／stopped，caller 說明失敗，原任務只有一份。 |
| 單一 Bot 時間線 | 舊 native segments 與 Genio 事件以來源 ID 投影；不靠 UI conversation 分支保存主線。 |
| 無既有瀏覽器快取恢復 | 空 cookies／origins 的新 context 登入，恢復早期文字、圖片、交接結果；能繼續聊天並 reload 保存。 |
| 新 native segment 的 context | 專用 Bot 透過明確 pointer reset 測試，新的 thread 未重述答案仍讀到舊代號、下一步及 Bot 偏好；舊 lineage 保留。 |
| Bot 記憶管理 | 偏好、事實、決策、工作摘要；revision 衝突、forget／restore、Bot 隔離有測試。實際修正下一輪採用新版，測試值已恢復。 |
| 記憶來源 | 模型 recall／search／read／remember 保存同 Bot message ID；UI 查回原文及時間，reload 保留，專用記錄已忘記。 |
| 目前工作可見 | 工作頁顯示要求、明確保存的摘要、待處理及最近交接；主標題／工作頁待回答一致，回答後就緒。 |
| 模型與登入接續 | Luna→Sol 原生請求、同 thread、記憶保留；原模型已還原。以隔離頁面時間觸發真實 Keycloak refresh，草稿／thread／後續回答保留。 |
| 拒絕與錯誤回饋 | Bot 功能未授權不登出；模型路線不可用不假裝連線中，保留歷史且可切換至可用 Bot。 |
| 多 client 與來源隔離 | RPC ID 分流、初始化去重、pending request 與 thread 歸屬、stale snapshot／late event 防護由相關測試覆蓋。 |

最新整合檢查：`bun run typecheck` 與 `bun test ./src ./server` 通過，277 tests／84 files／1698 expectations，0 fail。完整結果與 exact IDs 見 [2026-09-08 完整驗收](bot-continuity-completion-20260908.md)；產品邊界、決策與未決 hardening 見 [持續性與產品邊界決策](bot-continuity-decisions.md)。不能把受控測試當作所有環境的 Product E2E。

## 跨 owner 驗收與政策恢復

2026-09-08 使用者已明確核准臨時政策變更。正式 draft/publish 將本地 One Policy revision 2 → 3，僅加入 person-organization-admin；測試結束後 revision 3 → 4 移除該 subject，規則恢復 allowed_roles=[TENANT_ADMINISTRATOR]、allowed_subject_ids=[]，沒有 draft。

雙真實身分的拒絕路徑已由 UI 驗證：admin 的收斂驗證 Bot 提出交接，organization admin 的跨Owner驗證 Bot 收到 PENDING；owner 按拒絕後為 DENIED，caller continuation 完成並在 reload 保留。分享已恢復 PRIVATE，頁面錯誤 0。Invocation `bot-invocation-803cb445-1f9f-4117-a422-554e22bedd22`，caller turn `01a07e48-7831-71d1-8c0d-426d3e8d70fa`，回覆關聯經持久資料核對匹配該 handoff。

成功路徑已於使用者一併核准模型連接後完成：正常裝置登入成功，target invocation COMPLETED、原 Bot continuation completed、reply 關聯與 reload 可見均通過。第二輪臨時政策已恢復於 revision 6，draft 清空；分享恢復 PRIVATE。完整 IDs 與測試範圍見最終驗收文件。目前沒有原始本地範圍內的待完成項目。

## 已知環境界線

目前 One Policy 的 Bot 路線是 Codex subscription；Nova 的公司路線不可用已驗證拒絕回饋，並未擴充平台模型政策。OTel 本地 collector 目前為 debug exporter，Bot synthetic ERROR 收件已驗證；未宣稱 ClickHouse 持久化或所有原生錯誤皆已收錄。新段測試使用明確 API pointer reset，OAuth 測試使用隔離頁面時間；這些注入方法已記錄，沒有修改系統時間或假造 JWT。

## 最終結論（2026-09-08）

本地原始 continuity 範圍已由明確授權、模型登入、跨 owner 成功／拒絕閉環及政策恢復完成。保留上述環境界線，不宣稱所有部署、重啟、provider 或故障變體均測過；後續 review agenda 集中記錄於 [持續性與產品邊界決策](bot-continuity-decisions.md)。
