# 架構圖與產品介面檢查

Current model revision: `2026-09-08-documentation-consolidation`.

## 架構圖

`docs/architecture/current-architecture.json` 是生成來源，`current.html` 由 `bun run docs:architecture` 產生。圖描述責任與實作邊界；局部測試、舊部署截圖與某次 live contract 不代表目前所有路徑或 production 已通過。

- Product API／PostgreSQL 的 canonical state 與 Gateway／Endpoint 的 applied／observed state 分開。
- Company AI／MCP、API consumer 與 official-provider Egress 為不同資料路徑；可選 Secure Access 不取代應用層授權。
- Bot 的獨立儲存與 runtime 詳見資料模型；不把所有請求畫成同一 Gateway route。
- Valkey 的 usage／grant／lease／vault 各有恢復語意；ClickHouse 為分析資料，不能標示為不可竄改 canonical Audit。
- 所有顯示為已實作的節點仍需對照 source、部署與必要驗收；尚未交付的 adapter 保持明確標記。

## 產品 UI

以 [管理介面互動契約](docs/design/admin-governance-refactor.md) 定義任務、狀態、可見完成條件與失敗恢復。產品內載入的 [使用指南](docs/product/README.md) 與實際 API 一起維護。

## 檢查

```sh
bun run docs:architecture:check
bun test scripts/terminology-contract.test.mjs
```

目前正式交付的資料可靠性與恢復缺口以 [production 評估](docs/architecture/data-model-2026-09-08/production-assessment.md) 為準。
