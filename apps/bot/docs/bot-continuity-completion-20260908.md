# Bot UX 完整範圍驗收 — 2026-09-08

原始需求：mention／handoff／reply back、Bot-wide context/memory、一 Bot 一條主線、session adapt/resume，以及聊天歷史重建。以下是本地測試範圍的完成證據，不延伸為所有部署與故障組合保證。

| 要求 | 已完成行為與證據 |
|---|---|
| mention、handoff、reply back | 穩定 Bot ID 提及、同 owner 忙碌排隊、模型 MCP 委派、成功／拒絕／失敗均回到原 Bot。雙真實 owner 的成功和拒絕路徑已於本日 UI 驗證；回覆依 handoff ID 關聯，不能只比對相同文字。 |
| Bot-wide context／memory | 同 Bot 保存偏好、事實、決策及滾動工作摘要，revision／forget／使用者管理／同 Bot 來源保護。自然工作更新保存摘要 revision 1→2→3。五輪短確認後，原始工作代號不在最近四輪摘錄，新段不用工具仍回覆原目標與新增條件。 |
| 單一主線及歷史重建 | server timeline 保留原生段、交接與舊匯入來源；空瀏覽器恢復文字／圖片並可接續，reload 保留。Bot-owned reply 關聯與執行活動分開，原生 reasoning 不當成聊天訊息。 |
| session adapt／resume | server pointer 為權威，空值不再被 browser cache 覆蓋。草稿／圖片／閱讀位置與問題等待恢復已有 UI 證據；模型切換、真實 Identity refresh、server restart／native interruption 接續均有原生 turn 證據。 |

## 本日雙真實身分成功閉環

- caller：person-platform-admin／bot-6448bc48-ebc。
- target owner：person-organization-admin／bot-d67a038c-ce3。
- 經正常 OpenAI 裝置登入連接測試模型帳戶，畫面顯示已登入，Bot 回到就緒。沒有複製其他 owner 的模型憑證。
- invocation：bot-invocation-c0586d9d-eda8-4f83-924d-21634d57444d，狀態 COMPLETED。
- handoff：bot-handoff-05db2f7d-9ad1-4e77-bf41-c29c1f94507f。
- target turn：01a07e62-481c-7673-a710-545f019f5f56，completed。
- caller continuation turn：01a07e62-6114-7342-b793-779e65a88e65，completed。
- caller reply：01a07c55-05d3-7e91-b786-4ad0c8da212e:msg_0221355bf8b0fa8c016a9f5498c95487d0b5a3bbb7fb9d67aa，replyToMessageId 精確對到上述 handoff；reload 後可見、就緒，page error 0。
- 拒絕 invocation：bot-invocation-803cb445-1f9f-4117-a422-554e22bedd22，DENIED；caller turn 01a07e48-7831-71d1-8c0d-426d3e8d70fa completed。目標未執行。

首版測試曾以結果代號搜尋，誤匹配較早拒絕回覆。已改用本次 handoff ID 精確驗證並重取 UI 證據；較早誤匹配不作成功證明。

## 環境恢復與最終檢查

使用者已明確核准本地政策變更與模型連接等本測試環境必要操作。政策 2→3→4 完成第一輪拒絕測試，第二輪 4→5→6 完成成功測試。最終 revision 6，allowed_roles=[TENANT_ADMINISTRATOR]、allowed_subject_ids=[]、enabled=true、draft=null。測試 Bot 分享恢復 PRIVATE／不可搜尋／不可呼叫／ALWAYS_ASK。

本日 typecheck 與完整 Bot suite：277 pass、0 fail、84 files、1698 expectations。沒有本日產品程式修改；原生持久資料亦重新核對 server restart、refresh、空白瀏覽器、runtime interruption 的代表 turn 仍為 completed。

## 證據範圍

- 換段以明確 pointer reset 注入；OAuth 以隔離頁面時間觸發真實 refresh，不是所有自然過期條件。
- 長工作超過 120 秒由真實等待的受控 runtime 測試驗證；不宣稱長模型推論 E2E。
- 摘要由模型依工具契約維護，可能在中斷或工具不可用時未更新；UI 以已保存內容與時間為準，來源集有上限。
- OTel 已驗證本地 collector 收到錯誤事件；debug exporter 不代表 ClickHouse 持久化或所有原生錯誤都已涵蓋。
- 舊階段紀錄中的未完成敘述已收斂為當時的驗證界線；以本文件和最新驗收表為最終本地結論。

產品決策、持續性契約與未決 hardening 見 [持續性與產品邊界決策](bot-continuity-decisions.md)；本文件與驗收表保留可追溯的最新結果。
