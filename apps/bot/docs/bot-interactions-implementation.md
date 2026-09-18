# Bot 訊息與非同步互動實作

基準：652a06506244ee248881c1e134c5aedea3b4f59d，保存開始前的 Bot 工作目錄。使用者已核准本地測試、政策調整與此方案實作。此文件記錄目前範圍；驗收未完成前不得以定向測試替代產品驗收。

## 產品契約

- Bot owner 從既有 composer 選取 @Bot，原訊息與交接一起保存；同一請求重試回傳同一筆交接，變更內容則衝突。交接詳細資料依目前 server timeline 更新。
- 使用者可查看來源訊息或接收 Bot 記錄，返回原閱讀位置；完整記錄沿用 owner 權限，無權限時仍可保留可見交接內容。
- FYI 忙時排隊、空閒讀取、可保持靜默；送達不等於模型讀取，不產生 caller continuation。分享政策仍適用。
- 非同步問題保存後工具立即返回。選項或草稿不等於回答；問題、回答與送達分開保存。原提問 turn 仍在執行時 steer；新的 turn 執行中則排隊，完成後於目前 Bot 段接續。
- 送達不確定時先核對 native client ID，沒有證據不得盲目重送。略過問題不是工具核准。核准決定仍由既有原生與 One Policy 流程管理。

## 本地前置狀態

固定入口沿用 5180／5181、5173、58080／58082。初次驗證發現新 installed-services 邊界下，本機缺少 Genio Bot Resource；在 Platform .env.local 加入 GENIO_BOT_SERVICE_ENDPOINT=http://127.0.0.1:5181，由既有 bootstrap 建立 genio.personal-bot Resource／Connection。

本地新增 Runtime Policy local-bot-interaction-validation revision 1，限 person-platform-admin、genio-one-bot client、三個既有測試 Bot（Policy Bot、收斂驗證0907、交接驗證）的 codex.subscription use/expose。透過正式 draft/publish 建立。既有 Bot access policy 不變。模型工具／檔案／電腦權限未擴充。

本地 Bot 與 Platform .env.local 配置配對的 Runtime report 簽章／驗章金鑰；只記錄 key ID genio-bot-local-runtime，機密不進版控。這是新 Runtime 政策稽核要求的前置條件。

## 本地驗收結果

- 來源重試、交易 rollback、跨 owner 拒絕與 silent 歷史保留：定向測試通過。
- 問題去重、雙分頁衝突、略過、送達對帳：定向測試通過。
- 原 turn steer、新工作等待後 start、未知送達不自動重送：定向測試通過。
- 真實 admin UI：來源訊息與接收 Bot 都以精確 message ID 取得焦點，並返回原 Bot；FYI 詳細資料正確顯示讀取後不必回覆。
- 真實模型先經 Genio MCP 保存問題，未回答前完成獨立工作；選項草稿 reload 保留且沒有自動送出。
- 晚到答案在另一個 native turn 等待時保持 queued，原工作完成後才另開 turn；原提問 turn 仍在執行時，答案以 steer 送入同一 turn，最終回覆採用所選代號。
- 接收 Bot 忙碌時 FYI 維持 APPROVED；工作結束後完成讀取。兩次真實 FYI 的 caller continuation 數量均為 0。silent 成功不新增未讀提醒。
- 真正停止並重啟 Bot server 後，未回答問題仍可操作；略過後 reload 保持 dismissed。兩筆已送達答案在 native history 中各只有一筆，沒有重送。
- TypeScript 檢查、349 個測試／98 個檔案／2032 assertions 全部通過；Vite 前端與 Bun server bundle 成功。HTTP 測試涵蓋跨 owner 拒絕及同時回答的 200／409 分流。
- 完整 metadata 與回合關聯見 [acceptance.json](evidence/interactions/acceptance.json)。

## 實作邊界與觀察

- Genio MCP 是本次實測的非同步提問 producer；native async agentMessage 的匯入去重由契約測試覆蓋，不宣稱 Codex 原生 producer 已實測。
- 首次模型誤用 blocking question 的參數格式，工具明確拒絕且沒有建立假問題；補強了 schema 說明與錯誤回饋，再以正確參數完成實測。
- 送達不確定時保留答案並停止自動重送，使用者可先核對 native history 再重試。跨副本租約與分散式排程不在此單 writer 範圍。
- 清單初次載入失敗改為顯示重試，不再誤導使用者建立第一個 Bot。完整 Platform 暫時不可用時的登入刷新策略仍沿用既有流程。
- 本地 Platform 在其他並行修改重載期間曾無法啟動；修正 permission-preview.ts 一個相對 import 路徑後，以相同入口暫時固定程序完成 UI 驗證。語音輸入及其他並行修改均保留。
- 正式 HEAD 與使用者 staging 不變。private checkpoint refs 用於還原共享工作目錄狀態，不代表已整理成獨立發行提交。
