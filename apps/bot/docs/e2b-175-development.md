# 175 E2B 開發驗收 Runbook

本文件記錄 192.168.1.175 上的隔離 E2B Runtime Embed pilot。它供 Bot/Platform 產品驗收重建使用，所有路徑與 Compose project 都限定在 `e2b-embed-175`；不得停止或覆寫未知 Kind service、其他 checkout、其他 Compose project 或外部付費資源。

目前責任邊界如下：E2B control plane 負責 API、client proxy、Orchestrator、Firecracker、模板與 sandbox 生命週期；Genio Bot 負責 runtime provider、Subject/session、Codex bootstrap 與 governed tool UAT。這份 pilot 已驗證 E2B Desktop base 與 SDK GUI 操作，尚未宣稱 Bot governed UAT 完成。

## 固定版本與來源

目前 workspace 的 SDK/CLI 版本以 `apps/bot/package.json` 與 `pnpm-lock.yaml` 為準：`@e2b/desktop@2.4.0`、`e2b@2.50.0`、`@openai/codex@0.155.0`。Codex 0.155.0 是產品模板 bootstrap 目標；本 pilot 的 GUI base template smoke 不包含產品 Bot bootstrap。

175 實際採用的 Embed compose provenance 是 `e2b-dev/runtime` commit
`7ec416d183c9e8357fb9208a5527c677bf6b35a9`；該 commit 的 raw compose
SHA-256 為 `0ef4902dc0d8e9aa1f16603d2201ddeab3e21456e2d2c50a6663388788b66666`，
與 `/home/dnplus/e2b-embed-175/evidence/image-digests.txt` 第一行一致。乾淨主機可用
這個 pinned source 取得官方檔案，再以 hash 驗證；175 的 `.env` 是本機持久設定，含有機密，
不能從主機直接複製或把內容寫入文件：

```bash
E2B_RUNTIME_COMMIT=7ec416d183c9e8357fb9208a5527c677bf6b35a9
curl -fsSL "https://raw.githubusercontent.com/e2b-dev/runtime/$E2B_RUNTIME_COMMIT/embed/compose/compose.yaml" -o compose.yaml
curl -fsSL "https://raw.githubusercontent.com/e2b-dev/runtime/$E2B_RUNTIME_COMMIT/embed/compose/.env" -o .env
sha256sum compose.yaml
```

`compose.yaml` 應得到上述 hash；`.env` 只作為官方版本的起點，須由部署者在受控檔案中填入本機
設定並保留 `chmod 600`。175 的 image tags、registry digests 與這份 compose hash 以遠端
`evidence/image-digests.txt` 為準。

現有 source audit 記錄的官方來源為：

- E2B infrastructure：`e2b-dev/infra`，audit commit `16bd4e3ccec5b9d1f4e8fb9b5c79c92ea49e193f`。
- E2B Desktop template：`e2b-dev/desktop`，audit commit `89a545e22343aa1c40f28338bf3281a6c04b1d4a`。
- 本 pilot 預取的 noVNC `e2b-desktop` commit 是 `461b7f1ccb20755037d8995612e5fb08ed16f9e4`；websockify `v0.12.0` commit 是 `99f83ca08390dc876b1b3580c210abea5b9f4edd`。
- 官方 source links：[E2B Runtime Embed pinned compose](https://github.com/e2b-dev/runtime/tree/7ec416d183c9e8357fb9208a5527c677bf6b35a9/embed/compose)、[E2B self-hosting](https://github.com/e2b-dev/infra/blob/main/self-host.md)、[E2B Desktop template](https://github.com/e2b-dev/desktop/tree/main/template)。

175 使用上述 pinned Runtime Embed compose 與官方 Runtime Embed images；主要版本如下：

| 元件 | image tag | digest（完整值見 evidence） |
| --- | --- | --- |
| API / DB migrator | `v0.14.202609170000-908833e4c12` | `e131ee5...` / `5237676...` |
| ClickHouse migrator / client proxy | `v0.4.202609130627-59497eb9134` / `v0.3.202609130627-59497eb9134` | `3e1c9ea...` / `f9ca123...` |
| Dashboard API | `v0.7.202609170000-908833e4c12` | `d7a865e...` |
| Dashboard | `v0.2.1` | `1bce1ba...` |
| Embed node / seed / tools | `v0.3.202609120109-ad1cddd091b` | `22d6271...` / `866acff...` / `c565bc6...` |
| PostgreSQL / Redis / ClickHouse / Vector | `18.6-alpine` / `7.4.6` / `25.8.30.16` / `0.51.1-alpine` | 完整值見 `image-digests.txt` |

省略號只用於文件可讀性；重建前必須核對 digest 檔，不得只依賴 mutable tag。

## Pilot 位置與連線

遠端固定工作目錄與 project：

```text
host:    dnplus@192.168.1.175
root:    /home/dnplus/e2b-embed-175
compose: /home/dnplus/e2b-embed-175/compose.yaml
project: e2b-embed-175
```

服務只綁 175 的 loopback。Mac 端要使用 SDK 或 Bot 時，先建立不暴露服務的 SSH tunnel：

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 3000:127.0.0.1:3000 \
  -L 3001:127.0.0.1:3001 \
  -L 3002:127.0.0.1:3002 \
  -L 3003:127.0.0.1:3003 \
  -L 3010:127.0.0.1:3010 \
  dnplus@192.168.1.175
```

服務用途是：API `3000`、Dashboard `3001`、sandbox proxy `3002`、proxy health `3003`、Dashboard API `3010`。完整 SDK connection env 只存在 ready container 的 `/run/e2b/sdk.env`。確認檔案存在而不讀出值：

```bash
docker compose -p e2b-embed-175 -f /home/dnplus/e2b-embed-175/compose.yaml \
  exec -T ready test -s /run/e2b/sdk.env
```

若確實需要在受控的本機檔案中使用，將 stdout 直接導向 0600 檔案，不要印到 terminal 或留言：

```bash
umask 077
docker compose -p e2b-embed-175 -f /home/dnplus/e2b-embed-175/compose.yaml \
  exec -T ready cat /run/e2b/sdk.env > /path/to/owned/e2b-sdk.env
chmod 600 /path/to/owned/e2b-sdk.env
```

## 建立、重啟與健康檢查

官方 Embed compose 已放在上述工作目錄的 `compose.yaml`。重建或啟動只使用這個 project：

```bash
PILOT=/home/dnplus/e2b-embed-175
docker compose -p e2b-embed-175 -f "$PILOT/compose.yaml" config --quiet
docker compose -p e2b-embed-175 -f "$PILOT/compose.yaml" up -d --wait
docker compose -p e2b-embed-175 -f "$PILOT/compose.yaml" ps
```

若是乾淨主機，先在專用目錄下載 pinned `compose.yaml` 與官方 `.env`，完成受控的本機設定後，
再使用同一組 `-p e2b-embed-175 -f ...` 指令；不要把 175 的 secret-bearing `.env` 或 ready
volume 複製到其他環境。

若第一次 `up --wait` 仍在建立依賴容器，等待後重跑同一條 `up --wait` 即可；不要建立第二個 Compose project。健康基線是 API、client-proxy、dashboard、dashboard-api、orchestrator、postgres、redis、clickhouse、vector 顯示 running/healthy，ready container 存在且 SDK env presence check 通過。

停止並保留模板與 volumes 的可逆流程：

```bash
docker compose -p e2b-embed-175 -f /home/dnplus/e2b-embed-175/compose.yaml down --timeout 5
```

不要加 `--volumes`，不要使用全機 `docker compose down`，不要重開機，也不要操作未知 Kind service。

## HugePages、tier 與防火牆

目前可重建 baseline 是 `.env` 中持久 `HUGEPAGES=768`。它是依 1024 MiB Desktop build 的實際 snapshot 需求取得：640 頁在 step 7 仍觸發 `mmap memfd: cannot allocate memory`，768 頁後 Desktop build PASS。當前實測約為 `HugePages_Total=768`、`HugePages_Free=755`、`HugePages_Rsvd=62`；175 host 可用記憶體約 12.2 GiB，沒有 OOM 記錄。

只在停止本 pilot 後調整持久值，並保留 before evidence：

```bash
PILOT=/home/dnplus/e2b-embed-175
docker compose -p e2b-embed-175 -f "$PILOT/compose.yaml" down --timeout 5
sed -i 's/^HUGEPAGES=.*/HUGEPAGES=768/' "$PILOT/.env"
docker compose -p e2b-embed-175 -f "$PILOT/compose.yaml" up -d --wait
```

`base_v1` tier 已依官方 self-host 流程調為 `disk_mb=4096`、`default_free_disk_size_mb=4096`、`max_disk_size_mb=25600`，讓 Xfce/noVNC layer 不受原 512 MiB tier 限制。只可在此 pilot 的 Postgres 執行：

```sql
update public.tiers
set disk_mb = 4096,
    default_free_disk_size_mb = 4096,
    max_disk_size_mb = 25600
where id = 'base_v1';
```

精確 rollback 是：

```sql
update public.tiers
set disk_mb = 512,
    default_free_disk_size_mb = 512,
    max_disk_size_mb = 25600
where id = 'base_v1';
```

E2B sandbox egress 需要狹窄的 `10.11.0.0/16` 與 `10.12.0.0/16` 規則，外部介面是已核對的 `wlp0s20f3`。sandbox 的 HTTP/HTTPS 會由既有 veth PREROUTING 分別導向 netd `5016`/TLS `5017`；因此 INPUT 同時允許兩個 port，FORWARD/NAT 只允許這兩個 sandbox 網段經 `wlp0s20f3` 出站與回程。規則不是全機 flush，也不改 Kind chains。

可重建腳本是 [`apps/bot/scripts/e2b-175-firewall.sh`](../scripts/e2b-175-firewall.sh)。它預設 `apply`，也接受 `rollback` 與 `check`；每條規則先以 `iptables -C` 查詢，再新增或刪除，因此重跑不會產生 duplicate。175 沒有 passwordless sudo，腳本使用已驗證的 privileged Docker host namespace 方法，以官方 tools image、host `iptables` binary/library、`--network host` 執行：

```bash
PILOT=/home/dnplus/e2b-embed-175
scp apps/bot/scripts/e2b-175-firewall.sh dnplus@192.168.1.175:$PILOT/e2b-175-firewall.sh
ssh dnplus@192.168.1.175 "chmod 750 $PILOT/e2b-175-firewall.sh && bash -n $PILOT/e2b-175-firewall.sh && $PILOT/e2b-175-firewall.sh apply && $PILOT/e2b-175-firewall.sh apply"
ssh dnplus@192.168.1.175 "$PILOT/e2b-175-firewall.sh check | grep -E '5016|5017|e2b-embed-175-(outer|netd|forward|return|masq)'"
```

腳本只管理下列已核對的 10 條規則：`INPUT` 的 5016/5017 各兩條、`FORWARD` 的 outer/inner 出站與回程各兩條，以及 `POSTROUTING` 的 outer/inner MASQUERADE 各一條。它不管理既有每個 veth 的 PREROUTING redirect，也不會刪除其他規則。腳本 rollback 會以同樣的精確規則逐條 `iptables -D`，找不到的規則會略過；執行方式為：

```bash
ssh dnplus@192.168.1.175 "$PILOT/e2b-175-firewall.sh rollback"
```

完整 before/after、5017 live counter 與 rollback 指令在 `evidence/iptables-before-*.txt`、`evidence/iptables-after-*.txt`、`evidence/iptables-after-5017-input-live.txt`、`evidence/firewall-rollback.txt`。本次 5017 root cause 是 redirect 後封包命中 host INPUT DROP；加入兩條狹窄 5017 INPUT allow 後，fresh Desktop sandbox 的 Node `v22.18.0` archive HTTP 200、Codex registry HTTP 200，5017 counter 有命中，並完成實際 bootstrap、Desktop stream 與 exec-server cold probe。`orchestrator` 重啟後規則仍存在，Compose services 維持 healthy/running。

## Template 與 SDK smoke

已完成的官方 base template alias 是 `base`，template ID `9uugwokd3nudxqboj6bq`。GUI pilot template 是 `desktop-self-hosted`，template ID `siqeue89jbvxi4o6amf5`，ready build ID `86d3af61-3e13-4e8c-91f7-ec8594f98e49`，規格為 2 CPU、1024 MiB。它使用 Xvfb、最小 Xfce session/window manager/panel/settings、Mousepad、x11vnc、noVNC/websockify 與 input 工具；不包含 Chrome 或產品 Codex bootstrap。

模板 build 的非機密結果可由 remote `desktop-template-status.json` 重查。175 pilot 的實際 build script 是 `/home/dnplus/e2b-embed-175/desktop-build.mjs`，配置了 `ubuntu:22.04`、2 CPU、1024 MiB、Xvfb/最小 Xfce/Mousepad、x11vnc、noVNC 與 websockify；build log 與 ready metadata 在 `evidence/desktop-build-8.log`、`evidence/desktop-template-status.json`。在已啟動且 SDK 依賴已備妥的 pilot 上，可用下列命令重跑同一個 build script；這會建立新的 Desktop build，應先確認 template 名稱與資源狀態：

```bash
PILOT=/home/dnplus/e2b-embed-175
docker run --rm --network=host \
  --volumes-from e2b-embed-175-ready-1 \
  -v "$PILOT/desktop-build.mjs:/app/desktop-build.mjs:ro" \
  -v "$PILOT/assets:/app/assets:ro" \
  -v "$PILOT/sdk/desktop:/app/node_modules/@e2b/desktop:ro" \
  -v "$PILOT/sdk/e2b:/app/node_modules/e2b:ro" \
  -w /app \
  us-docker.pkg.dev/e2b-artifacts/embed/node-e2b:v0.3.202609120109-ad1cddd091b \
  node /app/desktop-build.mjs
```

產品模板仍應使用 repo 內的 `apps/bot/scripts/build-e2b-desktop-base.ts` 與 `apps/bot/scripts/build-e2b-template.ts`，把 `@openai/codex@0.155.0` 安裝與版本檢查放在產品 build；不得把這個 pilot custom base 當成 governed Bot 完成證據。

在已啟動的 pilot 上，SDK smoke 使用 2.4.0/2.50.0 建立 `desktop-self-hosted` sandbox，啟動 Mousepad，執行 SDK click、type、Enter、screenshot 與 authenticated stream：

```bash
PILOT=/home/dnplus/e2b-embed-175
docker run --rm --network=host \
  --volumes-from e2b-embed-175-ready-1 \
  -v "$PILOT/desktop-smoke.mjs:/app/desktop-smoke.mjs:ro" \
  -v "$PILOT/evidence:/app/evidence" \
  -v "$PILOT/sdk/desktop:/app/node_modules/@e2b/desktop:ro" \
  -v "$PILOT/sdk/e2b:/app/node_modules/e2b:ro" \
  us-docker.pkg.dev/e2b-artifacts/embed/node-e2b:v0.3.202609120109-ad1cddd091b \
  node /app/desktop-smoke.mjs
```

結果為 PASS：`appVisible=true`、`clicked=true`、`typed=true`、`keyAction=enter`、`screenshot=true`、`stream=true`。可視證據是 `evidence/desktop-smoke.png`；JSON 結果是 `evidence/desktop-smoke.json`。這是 E2B SDK/GUI smoke，不等於 Bot route、policy decision、model relay 或 audit correlation。

## 證據與交付狀態

175 evidence 根目錄：`/home/dnplus/e2b-embed-175/evidence/`。

- `rebuild-summary.txt`：目前持久設定、template/build ID、SDK 版本與 artifact 索引。
- `image-digests.txt`：compose hash 與所有官方 image digest。
- `desktop-template-status.json`：Desktop build `ready` 的非機密狀態。
- `desktop-smoke.json`、`desktop-smoke.png`、`desktop-stream-url.txt`：SDK GUI smoke 結果與畫面；stream URL 不含 auth password。
- `firewall-before-*.txt`、`firewall-after-*.txt`、`firewall-rollback.txt`：狹窄 egress/NAT/netd 規則的稽核與回滾。
- `tier-before-4096.txt`、`tier-after-4096.txt`、`tier-rollback.sql`：`base_v1` disk tier 變更與回滾。
- `memory-before-*.txt`：調整 hugepages 前的記憶體與 reservation 證據。

目前狀態：E2B control plane、base/Desktop template、SDK 與 Genio Bot 治理路徑已驗證。Bot 使用本機 app-server 執行模型／MCP 回合，175 承載 E2B exec-server 與桌面，無需另建 Bot LAN ingress。實際 GUI 輸入／讀回、noVNC 重連、invoke-only screenshot 拒絕與恢復均通過；完整來源、政策稽核及限制見 [交付紀錄](default-tools-delivery.md) 與 [桌面證據](../../../internal/evidence/bot/uat-default-tools-20260921/c3-allow-deny-restore.json)。

閒置桌面可能變黑。先比較 noVNC 與新的工具截圖；本次兩者均為黑畫面，經允許的 `computer_use` 以目前 observation revision 送出 `key`、`keys: ["shift"]` 後恢復，再以新截圖確認內容。鍵名須小寫；失敗的大小寫鍵名回覆 `COMPUTER_KEY_INVALID`，不執行桌面動作。不要以舊 screenshot revision 接續變更，也不要把黑圖當成政策拒絕。
