---
title: 為什麼 v1 是預設子代理介面
description: v2 加密任務限制會造成什麼問題、OpenCodex 為何改以 v1 發布，以及仍想使用 v2 時的選擇。
---

OpenCodex 安裝後，子代理介面預設為 **v1**。Dashboard、Models 與 Subagents 頁面在切換至 **base** 或 **v2** 前都會要求確認，並連結至本頁說明。CLI 不會提示。

原因很明確：在 v2 上，由 ChatGPT 原生模型交給路由模型的任務，路由模型無法讀取。這恰好是最常見的委派方式，即 GPT 父代理啟動 Grok、Claude 或 GLM 子代理，而在 v2 上每次都會失敗。

## 發生時會看到什麼

系統會拒絕啟動，而非悄悄產生空白的子任務：

```json
{
  "error": {
    "code": "unreadable_encrypted_agent_task",
    "message": "Routed V2 worker task is encrypted for the native ChatGPT backend and cannot be read by the selected provider. Use plaintext V2 agent-message delivery or select a native ChatGPT model."
  }
}
```

結果是 HTTP 400，而且密文絕不回顯。刻意採取失敗關閉：轉送無法讀取的內容，會讓子代理收到空白指令，卻給出看似肯定的錯誤答案。

## 原因

![兩條路徑比較相同的委派。v1 中 ChatGPT 父代理透過 OpenCodex 傳送明文任務，跨過供應商邊界後，路由子代理能讀取。v2 中父代理傳送由 ChatGPT 後端產生的 encrypted_content；OpenCodex 無法解密，任務停在供應商邊界，請求以 unreadable_encrypted_agent_task 失敗。](../../../../assets/subagent-v2-encrypted-task.svg)

在 v1 上，父代理會以純文字送出子代理任務。OpenCodex 能讀取並路由，子代理也能收到可執行的內容。

在 v2 上，父代理送出的任務是由 ChatGPT 後端產生的 `encrypted_content`。金鑰留在該後端；OpenCodex 從未持有，所以代理無從解密或重寫。這個值是真正的密文，而非旗標掩蓋下的明文。因此這是結構性限制，不是設定錯誤，也無法靠代理端設定修復。

有三種拓撲不受影響；了解它們有助於釐清失敗範圍：

| 拓撲 | v1 | v2 |
| --- | --- | --- |
| ChatGPT 父代理到路由子代理 | 可運作 | **失敗** |
| 路由父代理到路由子代理 | 可運作 | 可運作 |
| ChatGPT 父代理到 ChatGPT 子代理 | 可運作 | 可運作，後端能解密自己產生的內容 |

後端始終能讀取自己產生的密文。只有跨越邊界時會失敗。

## 上游修復了嗎？

還沒有，至少關鍵的一半尚未修復。上游已合併 [openai/codex#35845](https://github.com/openai/codex/pull/35845)，加入明文協作訊息支援，但那是*接收端*：它能處理已產生的明文，卻不會讓 OpenAI 父代理送出明文。

傳送端問題仍未解決：[＃36376](https://github.com/openai/codex/issues/36376) 已在 Windows、macOS 與 Linux 的 CLI 0.146 至 0.151 版本重現；[＃37197](https://github.com/openai/codex/issues/37197) 直接指出缺少的部分是傳送端的交付政策。維護者尚未承諾修復，也沒有預計完成時間。

OpenCodex 將影響記錄於 [＃92](https://github.com/lidge-jun/opencodex/issues/92)，並以不規劃處理結案：這個儲存庫無法修復，因此該 issue 用來指向上游工作，而非等待本專案維護者處理的任務。

## 三種模式目前的行為

| 模式 | 介面 | 適用情況 |
| --- | --- | --- |
| **v1**（預設） | 每個模型都宣告傳統的具名稱空間 spawn 工具。啟動子代理時可直接指定其他模型。 | 需要跨供應商委派的使用者。這是目前發布的預設值。 |
| **base** | 上游模型釘選：Sol 與 Terra 使用 v2，Luna 使用 v1；未釘選的模型遵循 Codex 自身旗標。 | 想使用 Codex 預期的各模型介面，而且只在同一供應商內委派。 |
| **v2** | 每個模型都宣告扁平化的並行工具。 | 想使用較新的並行工作階段模型，且父子代理位於邊界同一側。 |

base 排在第二而非第一，因為其釘選讓大多數人用來*發起*委派的 Sol 與 Terra 採用 v2。對這個問題而言，base 不是折衷設定；從 ChatGPT 啟動路由子代理時，它的行為與 v2 相同。

## 如果你已選擇 base 或 v2

你的設定不會被改動。升級至採用此預設值的版本，不會重寫現有設定；儀表板只會顯示一次通知，等待你的選擇。

- **Continue** 保留目前模式，並停止詢問。
- **Switch to v1** 套用 v1，並停止詢問。

兩種選擇都會被記錄，通知不會再出現。若未回答就關閉通知，下次開啟儀表板時仍會顯示。

模式變更只適用於**新的** Codex 工作階段。選擇後請啟動新工作階段；若長時間執行的 App host 仍顯示舊介面，請執行 `ocx sync` 並重新啟動該介面。

## 如果仍想使用 v2

以下四種方式依一般使用者建議嘗試的順序排列：

1. **讓 ChatGPT 維持 v1。** 在 v2 模式下，`keepNativeChatGptOnV1` 開關讓 Sol 與 Terra 保持 v1 介面，仍可啟動 Grok 或 Claude；路由父代理則使用 v2。這最接近同時擁有兩者。
2. **在同一供應商內委派。** 路由父代理在 v2 上啟動路由子代理時會使用明文，能正常運作。
3. **信任使用金鑰直接驗證的 Responses relay。** 若明確將供應商標記為 `allowEncryptedV2AgentTasks: true`，它就會收到不透明的內容，而非 400。只在確定目的地能處理時才這麼做。
4. **啟用 `agentTaskRecovery`。** 這是預設關閉的實驗功能。它透過 ChatGPT 後端救回多數新啟動的子任務，但會消耗配額、增加延遲，並依賴未記載的行為；訊息型別的後續互動與 multipart envelope 仍會遺失。

各方式的完整機制請見[子代理介面](/zh-tw/guides/sub-agent-surface/)，設定項目請見[代理設定](/zh-tw/reference/configuration/agents/)。

## 本頁何時不再需要

當上游版本讓 ChatGPT 原生父代理以明文送出路由子代理的任務，此預設值的理由就會消失。屆時預設值會改回 base、確認提示不再出現，本頁則從建議轉為歷史紀錄。

## 變更模式

Dashboard、Models 與 Subagents 都提供同一個 v1/base/v2 開關，三個頁面在選擇 base 或 v2 前都會詢問。CLI 指令如下：

```bash
ocx v2 status
ocx v2 mode v1
```

CLI 不會提示。這是同一項設定；選擇前請理解本頁所述的影響。
