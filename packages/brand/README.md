# GenioOne 共用品牌素材

開啟 [Logo 素材預覽](logo-preview.html)，可直接下載各版本 SVG。預覽頁內嵌素材，能離線分享。

## 模組責任

- `foundations.css`：Platform 與 Bot 共用的品牌色、字型堆疊、圓角及基礎尺寸。
- `assets/logo-02.svg`、`assets/logo-03.svg`：設計包提供的原始淺底／深底直式 Logo，原檔保留。
- `assets/logos/`：由原始向量拆分與排列的 16 個常用素材，全部透明背景；字標已轉向量，不依賴字型。
- Platform 的字級密度與共用 React 元件留在 `apps/platform/platform-web/src/styles/globals.css` 及 `components/`；Bot 保留自己的產品元件和對話閱讀字級。

## 素材選擇

檔名為 `genioone-{版型}-{配色}.svg`。

| 版型 | 用途 | 建議數位尺寸 |
| --- | --- | --- |
| `horizontal` | 網站頁首、文件頁眉、簡報署名 | 寬度至少 160px |
| `stacked` | 品牌封面、登入頁、方形展示區 | 寬度至少 96px |
| `icon` | 收合側欄、捷徑、圖示 | 建議 24px 以上；16px 優先選單色版 |
| `wordmark` | 已有圖示時的品牌名稱、頁尾 | 寬度至少 120px |

| 配色 | 背景情境 |
| --- | --- |
| `color-light` | 白色或淺色背景，黑色主圖形搭配品牌藍 |
| `color-dark` | 深色背景，白色主圖形搭配原始品牌藍 |
| `mono-black` | 單色印刷、淺底浮水印 |
| `mono-white` | 深底浮水印、單色反白 |

素材本身不包含背景。保留原始長寬比例，周圍另留至少圖示高度四分之一的空間。橫式與純圖示只改組合位置及等比例尺寸；單色版將原色與漸層統一為一種顏色。

```tsx
import logo from "../../packages/brand/assets/logos/genioone-horizontal-color-light.svg"

<img src={logo} alt="GenioOne" style={{ width: 180, height: "auto" }} />
```

匯入路徑依使用檔案所在目錄調整。以 `<img>` 引用時，淺底／深底版本由產品主題選擇。

## 重建與檢查

從 repo 根目錄執行：

```sh
python3 packages/brand/scripts/build-logo-kit.py
node internal/evidence/platform/design-system-20260917/logo-kit/verify-logos.mjs
```

產生器使用 Python 標準函式庫。驗證使用 repo 已安裝的 Playwright，Chromium 可透過 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定。檢查包含原始 path 保留、viewBox 無裁切、16 張預覽載入及桌面／手機版面；另輸出 16–64px 圖示預覽供目視檢查。
