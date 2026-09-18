# 首次設定

## Community Edition 路徑

首次在本機安裝 CE，請從 [CE quickstart](../../ce/quickstart.md) 開始；其中包含前置工具檢查、啟動、本機入口、log、重啟與資料保留方式。接著可依 [第一個受治理 MCP 請求](../../ce/first-mcp-request.md) 完成可驗證的流程。Kubernetes 部署請參考 [CE Helm 指南](../../ce/helm.md)，先自行建置並推送映像到可控的 registry，再進行安裝。

請依 Management Console 的首次設定引導，依序建立可持久驗證的 Tenant 證據：

1. 確認企業登入與救援用 Tenant Administrator。
2. 串接目錄，或維護本地帳戶。
3. 定義 Organization 邊界與委派角色。
4. 註冊所需的 Gateway 部署。
5. 建立受治理 Resource 並接上可用的 Connection。
6. 發佈基準 One Policy。
7. 驗證一筆可在 Activity 與 Audit 對應的請求。

## 本機 Gateway Runtime

本機 Runtime 會執行產品既有的 Gateway Runtime controller 與原生 Envoy AI Gateway binary，適合本機開發及設定驗證。正式部署仍以 Kubernetes 與 Gateway API 為準。

1. 在 repository 根目錄，若尚未建立，先把 `apps/platform/.env.example` 複製為 `apps/platform/.env.local`。若要發佈至 `localhost` 或 `*.localhost` hostname，請在啟動 Platform 前加入以下僅限本機的 publication 設定：

   ```dotenv
   GENIO_ONE_PUBLICATION_DNS_ALLOW_LOCALHOST=1
   ```

   此本機驗證器只接受 `localhost`／`*.localhost` 與 loopback DNS target。發布至其他 hostname 時請停用此設定，使用標準 DNS 驗證器。接著啟動本機平台：

   ```bash
   pnpm dev
   ```

   若已有較早啟動的 `pnpm dev`，先完整停止該 supervisor 再重新啟動。啟動時會依設定的 service endpoint seed 本機 Bot Resource 與 Connection；已在執行的 Platform API 不會重複此 bootstrap。

2. 開啟 [Management Console](http://127.0.0.1:5173/management)，以 `admin`／`admin` 登入。在 **Runtimes** 選擇 **Register Gateway**，填入本機顯示名稱、site 與 region，並在關閉面板前保存一次性 bootstrap 設定。內容含有專屬 Runtime OIDC client credential，關閉後無法再從 UI 取得。

3. 將複製的 JSON 存到 ignored 本機目錄，檔案權限設為 `0600`。請以可辨識的 runtime 名稱替換預留字。

   ```bash
   mkdir -p apps/platform/.local/gateway-bootstrap
   umask 077
   $EDITOR apps/platform/.local/gateway-bootstrap/<runtime-name>.json
   chmod 600 apps/platform/.local/gateway-bootstrap/<runtime-name>.json
   ```

4. 安裝 `apps/platform/config/ai-mcp-gateway/provider-versions.env` 所釘選的 Envoy AI Gateway binary。安裝程式僅在需要時下載官方 release，會驗證公告的 SHA-256 digest，並儲存在 ignored 本機狀態。

   ```bash
   pnpm --filter genio-one gateway:install:local
   ```

5. 使用保存的 OIDC bootstrap 啟動 Gateway Runtime：

   ```bash
   pnpm --filter genio-one gateway:start:local -- \
     --bootstrap apps/platform/.local/gateway-bootstrap/<runtime-name>.json
   ```

   啟動器只接受 ignored 目錄中的一般檔案且權限必須為 `0600`，使用 `apps/platform/.local/aigw/current/aigw`，並在 `apps/platform/.local/gateway-runtime/<runtime-id>` 建立各 Runtime 獨立的 absolute state。第一個 release 會透過原生 AIGW CLI 在該 Runtime 專屬且可跨 release 重用的快取準備 Envoy；後續 release 會重用已驗證的快取。準備階段有獨立的 10 分鐘時限，可用 `GENIO_ONE_AIGW_DOWNLOAD_TIMEOUT_SECONDS` 設為 `1` 到 `3600` 秒，不受一般 Gateway readiness 時限限制。失敗或中斷的 staged download 不會被採用。每個原生 AIGW child 都會取得 checkout 之外、擁有且為 `0700` 的短暫 runtime 目錄作為 Unix socket，並在 child 結束後移除。它會把既有本機 `GENIO_ONE_VALKEY_URL` 映射成 Gateway sidecar 使用的 `GENIO_ONE_VALKEY_ORIGIN`，並在 `apps/platform/.local/gateway-runtime/keys/token-vault.key` 以 `0600` 保留自動生成的 32-byte token-vault key，讓加密的本機 token entry 在重啟後可讀取。若由 secret manager 覆寫 `GENIO_ONE_TOKEN_VAULT_KEY`，必須是 base64 編碼的 32-byte key。它不會自行建立 Control Plane、建立 static runtime token 或安裝 fixture principal；Platform API origin 與 Runtime OIDC client credential 都來自 bootstrap。

6. 回到 Management Console 的 **Runtimes**。已註冊 Runtime 應同步 capability 與目前 release 狀態。發佈 release 後，先確認 revision 到達 `READY`，再發出受治理請求。

若已發佈的本機 release 參照 credential material，僅透過本機 secret manager 或終端環境的 `GENIO_ONE_LOCAL_CREDENTIALS_JSON` 提供需要的 secret value。不要把 provider credential 或 bootstrap JSON 寫入 tracked 檔案。release 需要時，controller 會在 loopback port 啟動本機 authorizer 與 processor child；不需設定另一個 Control Plane host 或 static identity variable。Runtime 預設使用 admin port `1064`、listener port `1975`、observation port `9090`；只有本機 port 已被使用時，才在啟動前設定 `GENIO_ONE_AIGW_ADMIN_PORT`、`GENIO_ONE_AIGW_LISTENER_PORT` 或 `GENIO_ONE_GATEWAY_OBSERVATION_PORT`。需要本機 telemetry 時，再設定 `GENIO_ONE_GATEWAY_OTEL_HOST` 及其 ports。

## 正式使用前

正式環境的安裝、升級、rollback、fleet readiness 與 Gateway API reconciliation 必須走 Kubernetes 安裝及 post-install 流程。本機 standalone Gateway health check 不能作為 Kubernetes 部署證據。

- 替換所有佔位 Endpoint 與憑證。
- 確認 Runtime 健康狀態與設定修訂版。
- 強制企業登入前，先驗證救援存取路徑。
