---
title: 模型路由
description: opencodex 如何決定由哪個供應商來服務給定的模型 id。
---

當 Codex 請求某個模型時，`router.ts` 會將其解析為唯一一個已設定的供應商。規則**按順序**檢查；第一個匹配者勝出。

OpenAI 的 bare `gpt-*` 使用單一 `openai` provider。`codexAccountMode` 在 Pool（預設，主帳號加
新增帳號）和 Direct（目前 caller/主登入 bearer）之間選擇，模型 id 不變。
`openai-apikey/<model>` 顯式使用 API key transport；兩條憑證路徑互不 fallback。

## 優先順序

1. **顯式 `provider/model`** —— 如果 id 包含 `/`，且斜槓前的部分是某個已設定供應商的名稱，則使用該供應商，並將 id 擷取為斜槓之後的部分。

   ```text
   anthropic/claude-opus-5     →  provider "anthropic",   model "claude-opus-5"
   ollama-cloud/glm-5.2        →  provider "ollama-cloud", model "glm-5.2"
   openrouter/openai/gpt-5.6-sol → provider "openrouter",  model "openai/gpt-5.6-sol"
   ```

   這是無歧義的寫法，也是 Codex 的模型選擇器對路由模型所使用的寫法。如果指定的供應商已停用，
   這種顯式寫法會直接丟擲錯誤。

2. **某個供應商的 `defaultModel`** —— 如果任一供應商的 `defaultModel` 等於該 id，則使用該供應商（id 原樣傳遞）。

3. **內建字首模式** —— 將 id 與已知的模型系列字首進行匹配，然後路由到名稱（或名稱字首）與之相符的已設定供應商：

   | 字首 | 供應商 |
   | --- | --- |
   | `claude-`、`claude-sonnet-`、`claude-opus-`、`claude-haiku-` | `anthropic` |
   | `gpt-`、`o1-`、`o3-`、`o4-` | bare id 使用已設定的 `openai` 帳號模式；API key 顯式使用 `openai-apikey/` |
   | `llama-`、`mixtral-`、`gemma-` | `groq` |

   該匹配器只檢查名稱。與 `defaultModel` / `models[]` 掃描不同，目前即使匹配供應商的 `disabled`
   為 true，它也不會跳過該供應商。

4. **某個供應商的 `models[]`** —— 如果字首規則沒有命中，而某個啟用的供應商在 `models[]` 中列出
   該 id，則使用該供應商。這個順序很重要：只要設定了 OpenAI 名稱的供應商，裸 `gpt-*` id 就會在
   其他供應商的 `models[]` 宣告之前路由到 OpenAI。

5. **預設供應商** —— 如果沒有任何匹配，id 將原樣傳送給 `config.defaultProvider`。（如果未設定預設供應商，或預設供應商已停用，路由會丟擲例外。）

## API 金鑰與環境變數

無論選擇哪條路由，供應商的 `apiKey` 都會透過 `resolveEnvValue()` 解析：值為 `${OPENAI_API_KEY}` 或 `$OPENAI_API_KEY` 時會在請求時從環境中展開，因此金鑰永遠無需存放在 `config.json` 中。

## 目錄可見性與上下文上限

請求路由和模型目錄可見性由不同設定控制：

- `disabledModels` 會從 Codex 目錄和 `/v1/models` 中隱藏帶名稱空間的路由 id。裸原生 GPT slug
  仍保留在目錄中，但會改為 `visibility: "hide"`。它**不會**拒絕對該模型的直接請求。
- 供應商的非空 `selectedModels` 是另一層目錄 allowlist。即時發現和直接路由仍然有效；它只會縮小
  目錄和 `/v1/models` 輸出的模型範圍。
- `provider.disabled: true` 會把該供應商排除在目錄發現之外。顯式 `provider/model` 請求會失敗，
  `defaultModel` / `models[]` 掃描也會跳過它。
- `providerContextCaps` 為各供應商設定 Codex 可見的上下文上限。`contextCapValue` 是儀表板共用的值，
  預設為 350,000；但只有 `providerContextCaps` 中列出了供應商時才會生效。上限只能降低已知上下文，
  不會把它調高，也不會改變上游模型的實際限制。

```json
{
  "contextCapValue": 350000,
  "providerContextCaps": {
    "anthropic": 350000,
    "cursor": 350000
  }
}
```

## 提示

- **對路由模型使用顯式寫法。** 優先使用 `provider/model`（規則 1）——它無歧義，並且與目錄同步後 Codex 在其選擇器中顯示的內容一致。
- **為供應商預置 `models[]` 或 `defaultModel`**，這樣短 id（規則 2/4）無需 `provider/` 字首即可解析。
- **字首模式只是一種便利**，而非保證：只有當確實設定了同名（例如 `anthropic`、`openai`、`groq`）的供應商時，它們才會解析成功。

這些規則讀取的供應商欄位請參見 [設定](/zh-tw/reference/configuration/)。
