# OAuth 授權與 Application API key

GenioOne 使用 OAuth access token 或 Application API key 識別呼叫者。SSO 登入不會增加 Resource 權限；每次操作仍須通過目前的角色、組織範圍、Entitlement 與 One Policy。

一般應用程式使用 `genioone:read`、`genioone:write`、`genioone:invoke`。管理 API 使用 `management:<領域>:<操作>`；發布政策、核准存取與匯出稽核紀錄各有獨立 scope。寫入 scope 不包含讀取或管理權限，請只要求整合實際需要的範圍。

## 第三方 OAuth

使用 Authorization Code 與 S256 PKCE。第三方應用程式第一次要求授權時，由 Keycloak 顯示要求的 scope；擴大範圍時再次取得同意。已存在的 SSO session 可省去重新輸入帳密，仍須取得應用程式所需的授權。

API 請求使用 access token；ID token 用於登入身分資訊。一般使用者與管理員都須持有適合目標服務的 token，管理員也不能以唯讀 token 執行寫入。

個人設定中的「已連接的應用程式」連至設定的身分供應者管理頁面。撤銷 OAuth 同意與已發行 access token 的有效期間由身分供應者管理；請依供應者設定處理現有 session 與 token，勿將移除 consent 等同於所有離線驗證 token 立刻失效。

## Application API key

在應用程式憑證面板選擇 API key、名稱、到期日與 scopes，並選擇其中一種目標：

- **Platform**：使用 Application 本身的身分呼叫已授權的 Platform 操作。以 `Authorization: Bearer <API_KEY>` 傳送。
- **Resource**：綁定一個已有有效 Entitlement 的 API／LLM Resource Capability。以 `x-api-key: <API_KEY>` 傳送至已發布的 Gateway 入口。MCP 與 A2A 不提供這種 API key 入口。

兩種 key 的目標不能互換，也不能同時附帶 OAuth bearer 與 Resource API key。Application 不繼承建立金鑰者的管理員權限。

秘密值只在發行或輪替時顯示一次，請存入整合工具的秘密管理服務。清單保留名稱、前綴、scope 與有效期限。輪替保留原有範圍與到期日，並可設定前一代金鑰的短暫重疊期間；撤銷不會撤銷 Application 的 Entitlement。

Platform 會在每次請求重新檢查金鑰狀態。Resource 金鑰的發行、輪替與撤銷會產生新的 Gateway 設定，須待 Runtime 套用對應版本後才生效；驗收時請同時核對 Runtime 狀態與真實請求結果。

## 從舊 scope 升級

`genioone-management` 與 `genioone-invocation` 不再授予本版操作權限。請安排授權設定切換，避免把既有 token 當成新 scope 的授權證據。

1. 套用本版 Keycloak client scopes、client 設定、Platform 與 Gateway 程式。保留安裝環境自己的 issuer、client secret 與 redirect URI 設定。
2. 更新整合工具要求的 scopes，重新登入或授權。原本使用密碼授權的本機 `codex`／`grok` 參考 client，改用既有的 `codex-mcp`／`grok-mcp` OAuth client。
3. 檢查 API Resource 的 OAuth scope，將舊值改成該已發布操作需要的 `genioone:read`、`genioone:write` 或代理呼叫的 `genioone:invoke`。為已發布的 Gateway Resource 提出新的發布申請並核准，產生使用新 renderer 的後繼版本。僅重新整理政策或發行金鑰，不會重建既有的不可變發布快照。
4. 舊 Application OAuth 憑證仍保有原本的 scope。更新 Resource 後，以原有憑證輪替流程取得新 client credential，並更新整合工具；不會自動替舊憑證增加授權。
5. 確認簽署的 release 已由目標 Runtime 套用並回報 `READY`，再測試讀取、拒絕未授權寫入、有效金鑰與撤銷後拒絕。

缺少 scope 的 token 會被拒絕。切換期間請使用上述正式重新授權與發布路徑，不依賴舊 token 或手動注入 Gateway 設定。
