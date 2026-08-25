---
title: 貢獻指南
description: opencodex 的開發環境、結構、約定，以及新增 provider 或 adapter 的方法。
---

## 環境搭建

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy    # 開發模式代理 API
bun run dev:gui      # 儀表板 dev 伺服器（另一個終端）
bun run typecheck    # bun x tsc --noEmit
bun run test:changed              # routine import-graph test selection
bun test tests/router.test.ts     # routine focused test
bun run test                      # complete suite (PR-ready / explicit ask)
```

`bun run dev` 繼續作為 `bun run dev:proxy` 的別名。儀表板 dev 伺服器使用 `bun run dev:gui`；
`GET /` 提供的打包儀表板由 `bun run build:gui` 建置到 `gui/dist`。

## 建置與測試命令

根 package 是 Bun-native TypeScript，沒有單獨的 server compile 步驟。請使用儲存庫內的 script，
確保本機命令與 CI 一致：

```bash
bun run typecheck                 # 嚴格 TypeScript 檢查
bun run test                      # 完整 tests/ suite
bun test tests/router.test.ts     # 聚焦單個測試檔案
bun run build:gui                 # Vite GUI 建置 + package 準備
bun run privacy:scan              # CI 使用的 credential/privacy 掃描
bun run prepare:package           # 重新整理 package launcher/asset
```

大多數測試是平鋪在 `tests/*.test.ts` 下的 Bun test。`tests/helpers/` 存放共享 fixture，
`tests/e2e-style/` 存放範圍更廣的原生一致性場景。請在對應 subsystem 的現有測試附近加入聚焦的
迴歸測試；若改動涉及共享 routing、adapter、config 或 server 行為，還應執行完整 suite。

你正在閱讀的文件站點位於 `docs-site/`（Astro + Starlight）：

```bash
cd docs-site && bun install && bun dev
```

## 文件釋出

公開文件釋出到 GitHub Pages：<https://opencodex.me/zh-tw/>。
`.github/workflows/deploy-docs.yml` 會在 `main` push 中 `docs-site/**` 或 workflow 本身發生變化時
執行，建置 `docs-site` 並部署生成的網站。推送文件變更前請執行：

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

## CI 與釋出

GitHub Actions 有意只保留必要步驟：

- **Cross-platform CI**（`.github/workflows/ci.yml`）會在改動 runtime、test、package、script、
  TypeScript 或 workflow 檔案的 pull request 與 `main` push 上執行。Bun matrix 覆蓋 Linux、
  Windows 和 macOS，執行 install、typecheck、test、privacy scan、release-helper build smoke、GUI
  build 和 `ocx help`。另一個三系統 lane 使用 package 內建 runtime，驗證無需單獨安裝 Bun 也能
  完成 npm global install。
- **Release**（`.github/workflows/release.yml`）只能手動執行。它不是第二套完整 CI；dry-run 或
  publish 前，精確的 release commit（`GITHUB_SHA`）必須已有成功的 Cross-platform CI run。

釋出請使用 helper：

```bash
bun run release <version>           # commit/push 版本 bump；publish workflow 預設 dry-run
bun run release <version> --publish # 確認 CI-gated dry-run 後真正 publish
bun run release:watch               # 觀察最新的 Release workflow run
```

## 分支

- `dev` — 唯一的整合目標。請在此開啟 pull request。
- `main` — 僅供釋出。它只能由維護者從 `dev` 提升；請勿對它開啟功能 pull request。
- `preview` — prerelease train。

承載 Go 原生版本的 `dev2-go` 分支線已經退役，雙軌 carry 政策也隨之結束。其歷史以唯讀方式發佈在
[lidge-jun/opencodex-go-archive](https://github.com/lidge-jun/opencodex-go-archive)。
`dev` 上的 Bun-native TypeScript 是唯一的 runtime 線。

歡迎 rebase pull request。把過時分支帶到目前 head 是一般貢獻而非噪音 —— 請在描述中註明來源 commit。

## Pull request

- 目標為 **`dev`**。請勿對 **`main`** 開啟功能或修復 pull request。
- 從目前 **`dev`** tip 建立分支，而不是從 **`main`**。必填的 **`enforce-target`** 檢查會拒絕
  head merge base 位於 **`main`** tip 且分支遠落後於 pull request base 的請求（#644 中出現的
  失敗模式）。
- 撰寫真實的描述：說明變更內容與原因的 **Summary**，加上 **Test plan**（或同等實質內容）。空的
  內文、只有佔位符的文字，以及使用跳脫 `\n` 而非真實換行的描述都會無法通過檢查。
- 若標題或描述提到 `gui`，請在描述中附上 UI 變更的螢幕截圖；`enforce-target` 會在描述編輯時
  重新執行，直到出現截圖為止。
- 此 repository 的 workflow 變更使用 **`pull_request_target`**。更新的 enforcement 邏輯只有在
  workflow 提升到 repository 預設分支後才會生效——與 #631 記錄的相同營運注意事項。

## 專案維護者

目前維護者、其職責，以及 review 與 merge 政策記錄在
[`MAINTAINERS.md`](https://github.com/lidge-jun/opencodex/blob/main/MAINTAINERS.md)。repository 與
安全敏感路徑的 GitHub review 所有權宣告在 `.github/CODEOWNERS`。

## 約定

- **僅使用 ES Modules**（`import`/`export`）、TypeScript 和 `strict` mode。保持
  `bun x tsc --noEmit` 無報錯。
- **每個檔案最多約 500 行** —— 按職責拆分。`web-search/` 和 `vision/` sidecar 是很好的例子：
  小而專注的 module 位於單一 `index.ts` 之後。
- **在邊界處理非同步錯誤** —— sidecar 不會把例外拋進請求路徑，而會降級成合適的 marker。
- **Structure SOT** —— 目前維護者不變數放在 `structure/`；公開使用者流程放在 `docs-site/`；
  歷史調查/診斷記錄放在 `docs/`。
- **保留 export** —— 其他 module 可能依賴它們。

## 向目錄中新增 provider

所有 provider picker 與 seed 都來自 canonical registry（`src/providers/registry.ts`）：

```ts
{
  id: "my-provider",
  label: "My Provider",
  baseUrl: "https://api.example.com/v1",
  adapter: "openai-chat",
  authKind: "key",
  dashboardUrl: "https://example.com/keys",
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
  noVisionModels: ["model-a"],   // text-only models → vision sidecar describes images
},
```

`src/providers/derive.ts` 會把該條目提供給 `ocx init`、`ocx provider`、儀表板 preset、API-key
登入和 OAuth config seed。`enrichProviderFromCatalog()` 會把模型 metadata 與 capability 分類複製到
儲存的 provider 設定。OAuth protocol 實作仍位於 `src/oauth/`；只有 registry metadata 並不會
自動形成 OAuth flow。

### 權威 preset 所需的證據

registry 條目是一項被維護的承諾：opencodex 會把使用者的 API key 送到這個目的地。因此 preset
需要一手來源證據，而不只是可運作的程式碼路徑。新增或提升 provider 的 pull request 必須在描述中
提供以下全部內容：

- **已文件化的 OpenAI 相容端點。** 附上供應商自己的 chat endpoint API 參考連結；當條目設定
  `liveModels: true` 時，也要附上其認證模型探索端點（通常是 `GET /v1/models`）的連結。通過的
  fixture 測試不能取代它：那只證明我們的程式碼結構，不能證明上游契約。
- **服務條款與營運法人。** 空白或佔位符的法律頁面無法證明誰在營運該端點，或使用者流量依什麼
  條款處理。
- **aggregator 的轉售或路由授權。** 販售 Claude、GPT、Gemini 或其他第三方模型存取的 gateway
  應出示其路由授權。使用者把內建 preset 視為一條受維護的路線，而不是未經驗證的轉售商。
- **具名的維護負責人。** 說明 base URL、認證或目錄契約變更時由誰更新該 preset，以及故障如何
  回報。
- **可引用的驗證日期。** 記錄一手來源與檢查日期，方式與 `src/providers/free-directory.ts` 中的
  `lastVerified` 相同。未經驗證的列卻加上了日期，等於宣稱一份誰都沒產生的 provenance。

歡迎貢獻者新增自己的服務，目前多個 preset 就是這樣來的。請在 pull request 描述中揭露關聯，讓
reviewer 可以衡量；有關聯不代表會被拒絕，也不會降低證據門檻。

當證據不完整時，誠實的歸屬是 `src/providers/free-directory.ts` 的 reference row，而不是
canonical registry。Directory row 帶有明確的 `verification` 等級（`official`、`primary`、
`unverified`）且是惰性的：使用者仍可透過自訂 OpenAI-compatible flow 使用該服務，而 opencodex
不會宣傳一個無法背書的 preset。證據齊全後再把該 row 提升到 registry。

## 新增 adapter

在 `src/adapters/` 中實作 `ProviderAdapter`（參見
[Adapters](/zh-tw/reference/adapters/)），在 `src/server/adapter-resolve.ts` 註冊其名稱，
並把輸出橋接成內部 `AdapterEvent`。圖像處理請複用 `image.ts`；普通 streaming/tool call 以
`openai-chat.ts` 為參考。只有 adapter 自己負責 transport retry 時才使用 `fetchResponse`；Cursor
這類真正的雙向 transport 應使用 `runTurn`。在 `tests/` 中新增聚焦測試；如果 factory 屬於 public
package API，還要從 `src/index.ts` export。

## 在聲稱完成前先驗證

先執行能證明改動的最小命令：型別檢查用 `bun run typecheck`，行為檢查用聚焦的
`bun test tests/<name>.test.ts` 或 runtime probe，然後再執行適合影響範圍的更寬 gate。
opencodex 傾向於小而可驗證的 commit，而不是大批次改動。
