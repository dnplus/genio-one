# Breeze ASR Connector

Genio Bot 的第一版語音輸入：點麥克風、錄音、停止後辨識，文字加到目前草稿，由使用者確認送出。最長 60 秒，Bot 接受 3.5 MB 內的音訊。可取消、重試；切換對話後不回填舊結果。

Connector 將 `MediaTek-Research/Breeze-ASR-25` 常駐於本機，提供 OpenAI-compatible `POST /v1/audio/transcriptions` 與 `GET /v1/models`。它是 LLM Resource 下的 `TRANSCRIPTION` 模型能力，不需要 OpenAI API key。Codex 只接收確認送出的文字。

## 啟動

需要 Python 3.11–3.13、uv、ffmpeg。預設使用 whisper.cpp 的 Breeze **Q8_0 權重量化**，不再載入 PyTorch FP32。Apple Silicon wheel 提供 Metal；其他平台的 GPU 支援取決於 pywhispercpp 的建置，未支援時使用 CPU。CUDA 部署需依 pywhispercpp 官方建置方式安裝並另行驗收。

權重採用社群轉換的 `shdennlin/breeze-asr-25-ggml`，固定 revision `36c726093efe1760d1dd39c3cfe8b6a7282437d1` 的 `ggml-breeze-asr-25-q8_0.bin`。來源模型仍為 MediaTek Breeze ASR 25。檔案 1,656,129,691 bytes；啟動時驗證 Q8_0 標頭與 SHA-256 `d4b187c40ffbf1f620734b77821e2ca8a97c8ecf5754d02b2a175069348cafcf`，不符就拒絕 ready。Q8_0 表示主要矩陣權重為 8-bit，並不表示所有張量、運算與快取都是 8-bit。

```sh
pnpm --filter genio-connectors start:breeze-asr
```

首次啟動會依 `uv.lock` 安裝依賴，並下載固定 revision 的模型權重到 Hugging Face cache。`GET http://127.0.0.1:5192/health` 只在模型載入後回報 ready。啟動命令使用 `--no-proxy-headers`，以 TCP peer 判定 loopback，避免把 Gateway 的 X-Forwarded-For 當成 Connector 的連線來源。預設綁定 loopback、單一推論併發，忙碌回傳 429；暫存音檔在解碼後刪除。操作日誌保留模型、裝置、correlation、音訊時長與耗時。設定 OTLP 後另送完整觀測資料，包含原始音訊及辨識文字。

服務支援 `BREEZE_ASR_API_KEY`，設置後每個端點都要求 Bearer token。第一版安裝程式適用於 Gateway 與 Connector 同機、loopback 無憑證部署；跨機部署需先完成 CP 的服務憑證設定與網路驗證。容器的 localhost 指容器本身。

## 註冊為預設 ASR

從目標 Control Plane 取得真實 tenant、organization、environment、Gateway、issuer 與 audience，填入 `install.example.json` 的對應欄位；確認 hostname、DNS 與發布範圍。不要把範例 ID 當成可用環境。

```sh
export GENIO_ONE_ACCESS_TOKEN='<target tenant administrator token>'
pnpm --filter genio-connectors install:breeze-asr /absolute/path/install.json
```

安裝程式先檢查本機模型，再建立或沿用 Resource、Connection、Public Model、模型 mapping、認證與授權鏈，並送出及核准 PUBLIC 發布。Catalog 可見性與 Gateway 的實際模型 entitlement 必須分別確認；PUBLIC/AUTO_GRANT 本身不代表目前使用者已有可編譯的使用權。重跑會沿用一致設定；遇到 scope、端點、routing 或 enforcement 衝突會停止。

輸出的 `publicationState` 必須經 Gateway 真正套用確認；`PUBLISHED` 本身不等於 runtime Ready。完成發布後，在 Bot 的 `.env.local` 設定實際 Gateway base URL：

```dotenv
GENIO_BOT_ASR_GATEWAY_BASE_URL=http://breeze-asr.localhost:1976/v1
GENIO_BOT_ASR_MODEL=breeze-asr
```

Bot 透過已登入使用者的 CP session、模型清單及 Catalog 判定可用性，再將 Bearer token 與新的 correlation ID 送到 Gateway。前端不能指定上游位址、憑證或模型。`breeze-asr` 是預設 alias，也可將 `GENIO_BOT_ASR_MODEL` 指向已發布且有使用權的其他 TRANSCRIPTION 模型。

## 政策與協定範圍

Gateway 讀取 multipart 的 model metadata 進行既有授權與路由，保留原始音訊 bytes。第一版只接受 JSON 轉錄回應；Breeze 接受 file、model、response_format，不默默忽略其他參數。配置文字 request processor、要求 multipart metadata 改寫，或以 execution grant 呼叫音訊時，會明確拒絕，避免略過內容政策或不正確的二進位 digest。轉錄後的 JSON response 仍走既有 response processor。

這版提供錄音後辨識，不含串流雙向通話、VAD、TTS 或自動送出。

## 驗證

```sh
pnpm --filter genio-connectors test:breeze-asr
bun test apps/platform/platform-api/test/breeze-asr-install.test.ts runtimes/gateway/services/shared/audio-transcription.test.ts apps/bot/server/routes/transcription.test.ts
pnpm --filter genio-one-bot test:voice-ui
```

Python 測試使用真實 ffmpeg 與測試 recognizer；CP 測試使用記憶體 store；瀏覽器測試使用真實 MediaRecorder、合成麥克風來源及隔離的 HTTP fixture。它們是分段驗證，不代表 Product E2E。

本次另以 MPS 上的真實 Breeze 權重辨識台灣中文合成語音，WAV 與 WebM/Opus 均取得相符文字。156 專用開發機的 AIGW v1.1.0 透過 SSH loopback 轉送到 Mac 的 Breeze，也成功完成 4.65 秒 WebM 的辨識，模型推論約 8.8 秒；這是單次功能驗證，非效能或辨識品質基準。

真實 Gateway 測試發現預設連線緩衝區會拒絕 42 KB 音訊，因此正式 CP Gateway projection 已配置 `connection.bufferLimit: 4Mi`，與既有授權 body 上限對齊。Breeze 啟動命令停用 proxy headers，避免把轉送來的使用者 IP 當成直接連線來源。Gateway ext-auth 轉送 Content-Type，TRANSCRIPTION 路由允許 120 秒推論；共享 Gateway 設定使用明確版本選擇，支援既有不可變發布內容。

2026-09-08 本機實測：沿用已授權的 Gateway 憑證恢復 runtime，並透過正式 CP 發布與 admin 使用者的 ASR 專屬 entitlement，完成 Bot API → 已發布 AIGW → 真實 Breeze Q8_0。4.65 秒 WebM 回傳「這是一段語音辨識測試 請幫我整理今天的工作」，Bot 請求 5,268 ms，correlation `f1630e98-f64b-41e0-9b78-f16c196af5ed`。M5 的 `vmmap -summary` 在推論後量到 physical footprint 約 2.0 GB、峰值 2.1 GB。單一合成短句只能證明功能，不是品質或效能基準。實際 Bot 頁面已確認麥克風可見、可點；真人麥克風錄音到草稿的完整操作仍待使用者測試。

來源：[Q8 轉換與來源說明](https://huggingface.co/shdennlin/breeze-asr-25-ggml)、[whisper.cpp 量化支援](https://github.com/ggml-org/whisper.cpp)、[pywhispercpp 建置與 API](https://github.com/absadiki/pywhispercpp)。

## Codex 語音調查

Bot 所固定的 Codex app-server 0.153.4 生成協定已包含 `audio`／`localAudio` 輸入，以及 EXPERIMENTAL 的 thread realtime API。這代表有音訊協定接點，不代表可把本機 Breeze 直接插成 Codex 內建語音供應者。本版由 Bot 與 GenioOne 管理 ASR，避免將實驗中的 Codex realtime API 變成語音輸入的必要依賴。

來源：[Breeze ASR 25 模型與官方範例](https://huggingface.co/MediaTek-Research/Breeze-ASR-25)、[Envoy AI Gateway 音訊轉錄](https://aigateway.envoyproxy.io/docs/capabilities/llm-integrations/supported-endpoints/)、本 repo 的 `apps/bot/server/generated/v2/UserInput.ts` 與 `ThreadRealtimeStartParams.ts`。

## 完整遙測與斷線保存

設定 `OTEL_EXPORTER_OTLP_ENDPOINT` 為實際 Collector HTTP origin，`GENIO_ONE_TENANT_ID` 為服務所屬租戶，`GENIO_ONE_OTEL_SPOOL_DIR` 為服務可寫的專用持久目錄。未設定 endpoint 時 health 明示 configured=false，不冒充已交付；容器部署須將 spool 目錄掛到持久卷。

HTTP、解碼、排程等待與模型執行保留 traces／logs／metrics；原始音訊以 base64 保存一份並以 SHA-256 關聯，後續節點保留音訊參考與辨識文字。SQLite WAL+FULL 由背景執行緒處理，網路重試不佔用模型推論鎖；兩小時／256 MiB 上限、成功後刪除、定期清理與 incremental vacuum。等候落盤的記憶體上限 16 MiB；超限或儲存失敗有明示丟棄紀錄，儲存暫時不可用會重試。這些容量及程序中止窗口不是零遺失保證。

`/health` 同時回傳模型 ready 與 telemetry 狀態；每 30 秒的 `telemetry.delivery.health` 可在 Admin Portal 原始紀錄查詢，計數範圍為目前程序。
