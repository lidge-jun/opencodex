---
title: 桌面應用程式
description: 在 macOS、Windows 與 Linux 上安裝及使用 OpenCodex 桌面應用程式。
---

OpenCodex 桌面應用程式結合原生系統匣與網頁儀表板。內附的 CLI 會尋找既有本機代理；只有確定沒有代理執行時，應用程式才會啟動內附的執行環境。

儀表板由找到的本機代理端點提供服務（預設連接埠 `10100`）。桌面應用程式是包裝該儀表板及內附執行環境的本機外殼。

## 安裝

### macOS

從[最新版本](https://github.com/lidge-jun/opencodex/releases)下載 `OpenCodex-<version>-macos.dmg`。開啟 DMG，將 `OpenCodex.app` 拖到 Applications。應用程式需要 macOS 13 或更新版本。

正式版 `OpenCodex.app` 使用 Developer ID 簽署並經 Apple 公證，因此第一次啟動時，macOS 通常只會要求確認開啟從網路下載的應用程式。如果 macOS 仍封鎖它，請使用 **System Settings → Privacy & Security → Open Anyway**。

### Windows

下載 `OpenCodex-<version>-windows-x64.msi` 並執行安裝程式。由於安裝程式尚未經過程式碼簽署，Windows SmartScreen 可能顯示警告；確認檔案來自版本發布頁面後，選擇 **More info → Run anyway**。

### Linux

從版本發布頁面下載 `OpenCodex-<version>-linux-x86_64.AppImage` 或 `OpenCodex-<version>-linux-amd64.deb`。

使用 AppImage：

```bash
chmod +x OpenCodex-<version>-linux-x86_64.AppImage
./OpenCodex-<version>-linux-x86_64.AppImage
```

使用 Debian 系發行版：

```bash
sudo apt install ./OpenCodex-<version>-linux-amd64.deb
```

系統匣圖示需要支援 AppIndicator 的桌面環境。

## 首次啟動

應用程式會要求內附的 CLI 執行 `ocx resolve --json`；若既有本機代理可連線，就會附著其上。只有 CLI 證實代理不存在時，才會啟動內附執行環境；結果不確定時會顯示啟動失敗。接著儀表板會在應用程式的 webview 中，以找到的 loopback 端點開啟。登入時隱藏在系統匣中啟動的應用程式會保留輕量的啟動頁，直到你第一次從系統匣開啟或再次啟動應用程式時才載入儀表板。

透過系統匣的 **Open dashboard** 或 **Open in browser**，可以在內嵌儀表板與一般瀏覽器間切換。系統匣也提供更新檢查。

## 系統匣中的用量資訊

在 macOS 與 Windows 上，點擊系統匣圖示可開啟精簡用量視窗。系統匣的 **Show usage** 也能開啟它，包括不會轉送點擊事件的 Linux 桌面環境。Linux 會在啟動時開啟儀表板，即使桌面環境不顯示系統匣圖示也一樣。

用量視窗顯示 Today 與 30 天總量、設定的用量圖表、精簡模型清單，以及 provider／帳號限制。配額重設倒數顯示在進度條旁；滑鼠停留可查看確切重設時間。既有的 **Menu bar & widget** 設定控制可見區塊與圖表。隱藏的 provider 不計入標題、總量、配額或圖表。圖表包含目前時間區間的活動。部分資料指示標記表示某些圖表資料無法可靠地歸屬。缺少的測量值不會顯示成用量為零。在 Windows 與 Linux 上，若帳號清單很長，請在用量視窗中捲動至底部，找到 Refresh 與 Dashboard。

在 macOS 上，此視窗使用原生 SwiftUI 控制項與可捲動的 AppKit 面板。macOS 26 及更新版本使用 Apple Liquid Glass；較舊系統使用原生 popover 材質。捲動長帳號清單時，標題及 Refresh、Dashboard 按鈕仍保持可見。也可以透過 **View → Show Usage** (Command-Shift-U) 開啟。按 Escape 或點擊面板外即可關閉。

系統匣選單顯示今日請求數與 token 數；啟用時也會顯示估計費用。它使用與 widget 相同的本機日期用量。選擇 **Refresh now** 可立即更新；應用程式也會每 60 秒更新一次。顯示偏好仍位於儀表板的 **Menu bar & widget** 區塊。關閉 **Today** 會隱藏摘要，關閉 **Cost** 則會移除其中的費用。

無法取得或明確未測量的用量會顯示為 `—`，而不是測得的零值。選擇只顯示圖示的標題會清除先前的計數。縮寫會保留整數中的零：一千萬 token 顯示為 `10M`，不是 `1M`。

## 更新

選擇系統匣選單中的 **Check for Updates…** 可立即檢查。正式版也會在啟動後及每六小時自動檢查。安裝前，更新會使用專案簽署的 updater 公鑰驗證。在 macOS 上，應用程式內更新會下載 `OpenCodex-<version>-macos.app.tar.gz`；DMG 用於首次安裝。只有設定 updater 金鑰祕密時才會產生版本 manifest，屆時四個平台都必須完成簽署。

## Widget

macOS 應用程式包含 OpenCodex WidgetKit 擴充功能。widget 設定及本機快照細節請參閱 [macOS 選單列應用程式指南](/zh-tw/guides/macos-menu-bar/)。

## 解除安裝

在 macOS 上，將 `OpenCodex.app` 從 Applications 拖到垃圾桶。在 Windows 上，從 **Installed apps** 移除 OpenCodex。在 Debian 系 Linux 上執行：

```bash
sudo apt remove opencodex
```

若使用 AppImage，請刪除下載的檔案。

若無法讀取已儲存的選單列設定，為保護檔案，系統會拒絕局部編輯。請先還原檔案，或明確重設 companion 設定後再編輯。
