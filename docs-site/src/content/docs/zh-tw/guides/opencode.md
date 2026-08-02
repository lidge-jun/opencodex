---
title: opencode
description: 在 opencode 使用任何由 opencodex 路由的模型——執行時注入 provider 區塊，不更動你自己的 opencode 設定。
---

opencode 從合併的 JSON 設定層讀取供應商，而不是環境變數，因此沒有可注入的 `ANTHROPIC_BASE_URL` 這類插槽。`ocx opencode` 補上這個缺口：它會確保代理程式正在執行、依可見目錄組出 provider 區塊，並透過 OpenCode 的內嵌 runtime 層（`OPENCODE_CONFIG_CONTENT`）注入。

## 快速入門

```bash
ocx opencode
```

這會確保代理程式正在執行，並僅以產生的 `provider.opencodex` 區塊啟動該次 opencode 程序。額外引數會原樣傳遞：`ocx opencode run "hello"`。

路由模型會出現在選擇器的 `opencodex` 供應商底下：

```text
opencodex/kiro/glm-5
opencodex/gpt-5.6-sol      # native slugs stay unprefixed
```

## 你自己的設定絕不會被修改

啟動器不會複製或改寫 `~/.config/opencode/opencode.json`、專案的 `opencode.json` / `opencode.jsonc`，或任何其他磁碟上的設定層。它可能會讀取全域或專案設定以偵測 `provider.opencodex` 覆寫，而你既有的供應商、agents、keybinds、MCP 項目，以及相對路徑的 `{file:…}` 參考，仍會從原本的檔案解析。

僅就此啟動，opencodex 會透過 OpenCode 的內嵌 runtime 層加入產生的 `provider.opencodex` 區塊。該層在全域／自訂／專案設定之後合併，且只覆寫子程序中衝突的鍵。

| 層 | 搭配 `ocx opencode` 的行為 |
| --- | --- |
| 全域／自訂／專案設定 | 磁碟上維持你寫下的原樣 |
| 內嵌 runtime（`OPENCODE_CONFIG_CONTENT`） | 只接收產生的 `provider.opencodex` 區塊 |
| 相對 `{file:…}` 路徑 | 仍相對於原本定義它們的設定檔解析 |

若全域或專案設定也定義了 `provider.opencodex`，啟動器會印出資訊提示：該次啟動由 `ocx opencode` 提供的 runtime 層會覆寫它。

## Admission key 不會寫入磁碟

當代理程式要求 API 金鑰時，內嵌 runtime 設定承載的是 opencode 的 `{env:…}` 參考，而不是密鑰本身。Loopback 綁定把該參考用作 `apiKey`；非 loopback 綁定則只透過 `x-opencodex-api-key` 傳送，讓代理 admission 與任何上游 `Authorization` 標頭保持分離。

Loopback 範例：

```json
"options": {
  "baseURL": "http://127.0.0.1:10100/v1",
  "apiKey": "{env:OPENCODEX_OPENCODE_API_KEY}"
}
```

非 loopback 範例：

```json
"options": {
  "baseURL": "http://192.168.1.10:10100/v1",
  "headers": {
    "x-opencodex-api-key": "{env:OPENCODEX_OPENCODE_API_KEY}"
  }
}
```

真實值只會經由子程序環境傳遞。優先順序為 `OPENCODEX_API_AUTH_TOKEN`，再來是 hardened service token 檔，然後才是已設定的 API 金鑰——非 loopback 綁定需要後者。

## 還原

沒有需要還原的東西——`~/.opencodex` 下不會寫入產生的設定檔。直接執行 `opencode`，就會完全照你自己的設定讀取。

## 模型限制

只有在目錄回報具權威性的 context window 時，才會寫入 `limit.context`；若沒有，會省略整個 `limit` 區塊，opencode 沿用自己的預設值。

opencode 的 schema 會拒絕只有 `context`、沒有 `output` 的 `limit` 區塊，而目錄又沒有具權威性的 per-model output 欄位，因此會一併發出 `output` 預算 `32000`，並向下 clamp 到 context window，避免小 context 模型出現 `output > context`。這個數字是為了滿足 schema——並非宣稱任何特定模型的真實上限。

`opencodex` provider 區塊每次啟動都會重新產生，因此在裡面做的 per-model 調整不會保留。請把自訂項目放在你自己的 provider 鍵底下。

## 需求

opencode 必須已安裝並位於 `PATH`：

```bash
npm install -g opencode-ai
```
