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
