# 核心概念

> 草稿佔位：產品模型定案後會補上更多實例。

## 授權路徑

`Subject → Access Group → Access relationship → Access Package → Resource Capability → Entitlement`

| 概念 | 用途 |
| --- | --- |
| Subject | Person、Application，或產品已驗證的 Agent 身分。 |
| Access Group | 由組織或身分證據支撐、可重用的授權範圍。 |
| Access Package | 經整理的一組 Resource Capability。 |
| Entitlement | 由已發佈政策關係產生的有效授權。 |
| One Policy | Tenant 擁有的授權模型與已發佈修訂版。 |

## Product API

互動式 OpenAPI 契約請使用 **產品 API 文件**。產品文件負責說明流程與概念；請求與回應格式仍以 API 文件為準。

## 應用程式授權

SSO 確認使用者身分，OAuth scope 限制應用程式可代為執行的操作。第三方應用程式首次要求授權時，授權頁會列出要求的範圍；擴大範圍時需要再次同意。個人設定中的「已連接的應用程式」可開啟身分供應者提供的授權管理入口。

| 授權範圍 | 允許的操作 |
| --- | --- |
| `genioone:read` | 讀取自己的資料，以及已獲授權資源的唯讀操作。 |
| `genioone:write` | 修改自己的資料、提出申請，以及已獲授權資源的寫入操作。 |
| `genioone:invoke` | 呼叫已獲授權的模型與代理。 |
| `management:<領域>:<操作>` | 在既有管理權限內執行指定操作；政策發布、存取核准及稽核匯出分別授權。 |

每次操作仍須通過目前角色、組織範圍、Entitlement 與 One Policy。一般讀寫 scope 不包含管理權限，管理角色也不會自動取得 Resource 使用權。MCP 工具的讀寫分類採用已發布的能力與工具審核結果，不以 HTTP 方法或未審核的上游提示取代授權。

組織管理員可以在應用程式的憑證入口發行 API key，選擇 Platform 操作或一個具體 API／LLM Resource Capability、scope 與到期日。金鑰代表 Application 自己的身分；秘密只顯示一次，之後可輪替或撤銷。Platform key 不能用於 Resource 入口，Resource key 不能用於 Platform API；MCP 使用 OAuth。Gateway 的憑證變更須等新設定套用後才生效。
