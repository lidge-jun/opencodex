---
title: Codex 無法登入或載入
description: 套用 opencodex 後，Codex 無法登入或所有請求都出錯時的處理方式，以及如何在不啟動代理的情況下恢復使用 Codex 自身帳號。
---

若設定 opencodex 後，Codex 停在登入畫面、表示無法載入登入需求，或所有模型請求都失敗，最可能的原因是 Codex 仍指向 opencodex 代理，但代理沒有執行。這個情況見於 [#5261](https://github.com/lidge-jun/opencodex/issues/5261)。

## 原因

在預設的 loopback 設定中，opencodex 不會為 Codex 新增獨立供應商。它會在 `$CODEX_HOME/config.toml`（Windows 上為 `%USERPROFILE%\.codex`）寫入根層覆寫，將 Codex 內建的 `openai` 供應商指向代理：

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex (undo: ocx restore)
openai_base_url = "http://127.0.0.1:10100/v1"
# Auto-injected by opencodex (undo: ocx restore)
experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"
```

這些設定寫在磁碟上，因此重新開機後仍在。如果 Codex 啟動時代理沒有執行，該位址就不會回應，而 Codex 也沒有第二個端點可供回退。畫面不會提及 opencodex，因此容易誤判為 Codex 本身的問題。

代理可能因一般原因而未執行。套用 Codex 整合並不會安裝背景服務；那是另外的 `ocx service install` 步驟。因此重新啟動後，可能沒有程序會重新啟動代理。已登記的 Windows 排程工作是在登入時而非開機時啟動，也可能遭停用、啟動失敗，或讓其他程序占用連接埠。

## 讓 Codex 恢復運作

選擇你想要的結果。代理停止時，兩種方式都能安全執行。

**讓 Codex 恢復使用自己的帳號與端點：**

```bash
ocx restore
```

這會移除注入的路由、realtime 覆寫及 opencodex 目錄指標，不需要正在執行的代理、儀表板工作階段或網路。之後 Codex 即可正常登入與執行。若日後要再次使用 opencodex，`ocx restore back` 會重新把 Codex 指向代理。

**或重新啟動代理：**

```bash
ocx start
ocx service install   # keep it running across restarts
```

`ocx status` 會回報代理是否有回應，以及 Codex 目前是否透過代理路由。`ocx doctor` 會更詳細地說明相同狀態，並指出建議的修復方式。

## 如果 ocx 無法使用

可以手動撤銷路由。開啟 `$CODEX_HOME/config.toml`，刪除三項內容：`openai_base_url` 行、`experimental_realtime_ws_base_url` 行，以及任何以 `opencodex-catalog.json` 結尾的 `model_catalog_json` 行。前兩項正上方的 `# Auto-injected by opencodex` 註解也請一併移除。

請依設定鍵名稱判斷，不要只看註解。opencodex 在其他受管理的設定鍵上方也使用相同的擁有權註解，例如注入的 `developer_instructions`；刪除這些設定無助於登入，還可能讓你失去想保留的設定。

刪除路由時，**同時**刪除 `model_catalog_json` 行，不要只刪除其中一項。若 `model_catalog_json` 指向已不存在的檔案，Codex 會完全無法載入設定，看起來也像被鎖在外面，但原因不同。

## 無法新增或顯示的帳號

即使發生在同一工作階段，無法將帳號加入 Pool，或已新增的帳號未顯示，仍與上述登入受阻問題不同。帳號 Pool 由代理的管理 API 提供，因此 `ocx account login openai` 流程和儀表板清單都需要代理先執行。瀏覽器登入也會返回固定的 `http://localhost:1455/auth/callback`，無法改用其他連接埠。若其他程序占用 1455 埠，或無法啟動瀏覽器，請改用裝置流程：

```bash
ocx account login openai --device
```

注入內容及路由選擇方式請見 [Codex 整合](/zh-tw/guides/codex-integration/)。
