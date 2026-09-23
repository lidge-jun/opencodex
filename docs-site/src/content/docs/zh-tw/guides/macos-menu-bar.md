---
title: macOS 選單列應用程式
description: 使用 OpenCodex 桌面應用程式的 macOS 系統匣、原生用量面板與 widget。
---

macOS 選單列項目是 OpenCodex 桌面應用程式的一部分。它顯示本機代理的用量，並開啟原生用量面板。同一應用程式也包含儀表板與 WidgetKit 擴充功能。其他平台的安裝方式請參閱[桌面應用程式指南](/zh-tw/guides/desktop-app/)。

## 安裝

從[最新版本](https://github.com/lidge-jun/opencodex/releases)下載 `OpenCodex-<version>-macos.dmg`。開啟 DMG 並將 `OpenCodex.app` 拖到 Applications。桌面應用程式需要 macOS 13 或更新版本；widget 需要 macOS 14 或更新版本。

## 首次啟動

正式版 `OpenCodex.app` 使用 Developer ID 簽署、啟用 hardened runtime，並經 Apple 公證且將票據附加至應用程式。第一次啟動時，macOS 通常只會顯示網路下載應用程式的標準確認。如果 macOS 仍封鎖，請開啟 **System Settings → Privacy & Security**，並為 OpenCodex 選擇 **Open Anyway**。自行建置的應用程式使用 ad-hoc 簽署；請參閱[從原始碼建置](#從原始碼建置)。

開啟時，應用程式會在視窗中顯示啟動進度。首次啟動會啟用一次 **Start at Login**；你可以從系統匣選單將它關閉。日後透過登入項目啟動時，視窗預設隱藏，但系統匣仍可使用。

## 選單列與用量面板

選單列標題預設顯示今日 token 總數。在儀表板的 **Menu bar & widget** 設定中，可以選擇請求數、token 數、估計費用、配額或只顯示圖示。

使用系統匣選單中的 **Show Usage** 開啟原生面板。面板依顯示設定呈現今日與 30 天總量、用量圖表、模型清單及 provider／帳號限制。總量包含 token 與請求數；啟用時也包含估計費用。配額列顯示時間窗、百分比與重設時間。缺少的測量值顯示為 `—`，部分用量則標示為不完整。

面板提供 **Refresh**、**Dashboard** 與 **Settings** 控制項。**Dashboard** 會在桌面視窗開啟用量檢視；**Settings** 會在其中開啟 companion 設定。系統匣選單也提供 **Open Dashboard**、**Open in Browser**、**Start at Login**、**Stop proxy**、**Check for Updates…**，有更新時提供 **Install update**，並有 **Quit**。**Stop proxy** 一律列出，但只有應用程式自行啟動代理時才可使用；你另外啟動的代理會繼續執行。系統匣可用時，關閉視窗或使用 Command-Q 只會隱藏應用程式；要退出請使用系統匣的 **Quit**。

系統匣標題每 60 秒更新一次。原生面板開啟期間，資料每 60 秒更新；**Refresh** 可要求立即更新。

## Widget

在 macOS 14 或更新版本上，先開啟 OpenCodex.app 一次，再按住 Control 點擊桌面空白處，選擇 **Edit Widgets**，搜尋 **OpenCodex** 並新增想要的尺寸。不同尺寸會顯示代理狀態、今日 token 與請求數、估計費用、配額及用量圖表的不同組合。擴充功能讀取桌面應用程式寫入的本機快照；其中包含顯示資料，不包含 API 金鑰或原始帳號資料。代理連線期間，應用程式每五次 60 秒的系統匣更新就刷新一次 widget 快照，約每五分鐘一次。WidgetKit 也會在五分鐘後要求新的時間軸。

## 連線至代理

桌面應用程式要求內附的 CLI 執行 `ocx resolve --json`。若既有本機代理可連線，就會附著其上；只有 CLI 證實沒有執行環境正在監聽，才會啟動內附執行環境。若探索結果不確定，啟動時會回報問題，不會啟動第二個代理。應用程式透過 `127.0.0.1` 與找到的連接埠通訊。

管理請求會先不帶 token 嘗試。如果代理回傳 HTTP 401，應用程式會從自身環境的 `OPENCODEX_ADMIN_AUTH_TOKEN` 或找到的設定 home 中的 `admin-api-token` 檔案取得 token 並重試。此 token 不存於 macOS Keychain。若代理只綁定在桌面外殼無法透過 loopback 連到的位址，就無法附著。

## 從原始碼建置

在 macOS 13 或更新版本上，備妥 Bun、Rust 與 macOS Swift/Xcode 工具後，先從儲存庫根目錄建置儀表板，再從 `desktop/` 執行桌面命令：

```bash
bun install
bun run build:gui
cd desktop
bun install
bun run prepare-sidecar
bun run prepare-widget
bun run build:local
```

`build:local` 無須 Tauri updater 簽署金鑰即可產生本機應用程式及 DMG。直接執行 `bunx tauri build` 則需要 `TAURI_SIGNING_PRIVATE_KEY`，因為它也會產生 updater 成品。除非設定了 `MACOS_SIGN_IDENTITY`，widget 建置使用 ad-hoc 簽署；本機桌面套件也使用 ad-hoc 簽署。應用程式可執行，但 macOS 不會註冊 ad-hoc 簽署的 widget 擴充功能，因此本機建置通常不會顯示 OpenCodex widget。`build:local` 一律以 ad-hoc 方式簽署應用程式，所以只設定 `MACOS_SIGN_IDENTITY` 並無幫助：只有應用程式與擴充功能同由相同 Developer ID 團隊簽署，widget 才會註冊，正式版即如此。需要 widget 時請使用正式版。

## 解除安裝

若曾啟用，先在系統匣選單關閉 **Start at Login**，再將 `OpenCodex.app` 從 Applications 移到垃圾桶。這會移除內附 CLI 與 widget 擴充功能，但不會移除代理的 `$OPENCODEX_HOME` 狀態或另外安裝的 `ocx` 服務。桌面應用程式也會在自身設定目錄寫入安裝 ID 與登入項目標記，並在 `~/Library/Containers/com.opencodex.desktop.widget/Data/Library/Application Support/OpenCodex/snapshot.json` 寫入 widget 快照；把應用程式移到垃圾桶不會刪除這些檔案。
