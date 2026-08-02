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
bun run test         # bun test ./tests/
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
儲存的 provider 設定。OAuth protocol 實現仍位於 `src/oauth/`；只有 registry metadata 並不會
自動形成 OAuth flow。

## 新增 adapter

在 `src/adapters/` 中實現 `ProviderAdapter`（參見
[Adapters](/zh-tw/reference/adapters/)），在 `src/server/adapter-resolve.ts` 註冊其名稱，
並把輸出橋接成內部 `AdapterEvent`。圖像處理請複用 `image.ts`；普通 streaming/tool call 以
`openai-chat.ts` 為參考。只有 adapter 自己負責 transport retry 時才使用 `fetchResponse`；Cursor
這類真正的雙向 transport 應使用 `runTurn`。在 `tests/` 中新增聚焦測試；如果 factory 屬於 public
package API，還要從 `src/index.ts` export。

## 在聲稱完成前先驗證

先執行能證明改動的最小命令：型別檢查用 `bun run typecheck`，行為檢查用聚焦的
`bun test tests/<name>.test.ts` 或 runtime probe，然後再執行適合影響範圍的更寬 gate。
opencodex 傾向於小而可驗證的 commit，而不是大批次改動。
