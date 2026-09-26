---
title: ChatGPT 桌面版傳送鍵解鎖
description: 帳號用量額度用完時，讓 ChatGPT 桌面版的輸入框保持可用（macOS，需手動開啟）。
---

登入的 ChatGPT 帳號用完用量額度後，ChatGPT 桌面版會把傳送按鈕變灰，即使該對話的模型呼叫由
opencodex 路由到其他供應商。這個需手動開啟的 macOS 整合可以讓輸入框保持可用，預設關閉。

## 它改變了什麼

opencodex 為 `chatgpt.com` 執行一個本機 TLS 監聽器。app 啟動時會帶上一個 Chromium 參數，
把 `chatgpt.com` 指向這個監聽器；其他所有網域（包括它的子網域）都維持原本的路徑。請求會帶著
app 自己的憑證轉發到真正的 `chatgpt.com`，WebSocket（例如語音聽寫）也會一併轉發。不記錄、
不儲存任何內容。

除以下兩個端點外，所有回應都原樣透傳：

- 對話中繼資料（`/backend-api/conversation/init` 與對話串流）：移除由用量額度造成的傳送鎖；
- 用量快照（`/backend-api/wham/usage`）：打開「已達上限」的開關。

其他原因的傳送鎖（例如需要訂閱）會保留，並在 `ocx chatgpt status` 中列出。顯示的用量
（百分比、重置時間、橫幅）不會被修改，OpenAI 伺服器仍會對其自身的請求執行所有限制。

## 設定

1. 在 `~/.opencodex/config.json` 中開啟此功能，然後重新啟動 opencodex：

   ```json
   { "chatgptDesktop": { "unblockSend": true } }
   ```

   監聽器使用代理連接埠加 200（預設 `10300`）。設定 `chatgptDesktop.port` 可改用其他連接埠。

2. 信任本機憑證授權單位（只需一次）。此指令會要求輸入登入密碼，請自行執行：

   ```bash
   security add-trusted-cert -r trustRoot -p ssl \
     -k ~/Library/Keychains/login.keychain-db ~/.opencodex/claude-intercept/ca.pem
   ```

   沒有這項信任，app 無法載入帳戶、用量和設定頁面。如果你使用自訂的 opencodex 目錄，
   `ocx chatgpt status` 會列出適合你環境的準確指令。

3. 透過 opencodex 啟動 app：

   ```bash
   ocx chatgpt launch
   ```

4. 選用：讓一般的 Dock 與 Spotlight 啟動也使用該路徑：

   ```bash
   ocx chatgpt install-watcher
   ```

   watcher 在 app 每次啟動時執行。如果 opencodex 正在執行而 app 是以一般方式開啟的，它會在
   啟動後立即結束 app 並帶上路徑重新開啟。它不會對正在使用中的 app 做任何操作，opencodex
   未執行時也什麼都不做。此指令會要求確認；`--yes` 可以非互動式確認。

## 網路環境

不需要設定任何 VPN 或代理規則。預設模式下，每次 app 啟動時，都會依系統代理選擇啟動參數：

| 環境 | app 的啟動參數 |
|---|---|
| 無代理 | 只有 `chatgpt.com` 路徑。 |
| VPN 系統代理模式 | 路徑、帶直連備援的系統代理，以及只針對 `chatgpt.com` 的略過。 |
| VPN TUN 模式 | 只有路徑；本機回送流量不會進入通道。 |
| PAC 檔案 | 只有路徑。PAC 檔案可能讓 `chatgpt.com` 繼續走代理，輸入框因此可能仍被鎖定，但其他功能不受影響。 |

opencodex 透過自己的 `proxy` 設定連到真正的 `chatgpt.com`，與它的其他對外流量一致。

## opencodex 停止後仍能使用 app

預設模式下，已接管的 app 依賴監聽器：opencodex 停止期間，它對 `chatgpt.com` 的請求都會失敗。PAC 備援
改為用產生的 PAC 檔案啟動 app，讓 app 自行切換回原本的路由：

```json
{ "chatgptDesktop": { "unblockSend": true, "pacFallback": true } }
```

`pacFallback` 只有與 `unblockSend` 同時開啟才生效。此時 opencodex 還會在監聽器連接埠加一（預設 `10301`）
上監聽，並在每次啟動時重寫主目錄下的 `chatgpt-unblock.pac`。PAC 先把 `chatgpt.com` 送給 opencodex，
其他主機則依系統的路由走：

| 環境 | 其他主機，以及 opencodex 停止期間的 `chatgpt.com` |
|---|---|
| 無代理，或 VPN TUN 模式 | 直連。 |
| VPN 系統代理模式 | 系統代理，然後直連。 |
| PAC 檔案 | 系統 PAC（嵌入產生的檔案中）。 |

opencodex 停止後，app 不需重新啟動就會沿這條路由繼續運作；只有傳送解鎖會暫停，直到 opencodex 恢復。路由
在 opencodex 啟動時讀取：切換 VPN 模式後，請重新啟動 opencodex 並執行 `ocx chatgpt launch`。如果當時設定了
系統 PAC 卻讀取不到，其他主機會直連，opencodex 會印出警告。

開啟或關閉 `pacFallback` 後，請重新啟動 opencodex、執行 `ocx chatgpt launch`；如果在用 watcher，還要重新
執行 `ocx chatgpt install-watcher`。

## 查看狀態

```bash
ocx chatgpt status
```

它會回報：功能是否開啟、連接埠上的監聽器是否屬於 opencodex、憑證是否受信任、watcher 狀態、
執行中的 app 是否帶有路徑，以及被刻意保留的傳送鎖。

## 關閉

```bash
ocx chatgpt uninstall-watcher
ocx chatgpt restore
```

`restore` 會以原生網路重新開啟已接管的 app。之後把 `chatgptDesktop.unblockSend` 設為
`false` 並重新啟動 opencodex。此憑證授權單位與 opencodex 的 Claude 整合共用；只有兩者都不使用時
才移除它的信任。

## 疑難排解

- **帳戶、用量或設定頁面載入不出來：** 憑證未受信任。重新執行第 2 步；`ocx chatgpt status`
  會顯示信任狀態。
- **傳送按鈕仍是灰色：** 查看 `ocx chatgpt status`。app 可能沒有帶著路徑執行（執行
  `ocx chatgpt launch`），或者鎖的原因不是用量額度，會列在「send blocks kept」下。
- **opencodex 停止後 app 什麼都載入不出來：** 預設模式下，已接管的 app 依賴監聽器。重新啟動 opencodex，
  或執行 `ocx chatgpt restore`；開啟 PAC 備援後，app 會自行切換回原本的路由。
