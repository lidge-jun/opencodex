---
title: Replit 閘道夥伴
description: 將 opencodex 與您自建的 Replit 部署配對，該部署透過 Replit AI Integrations 中繼 OpenAI Chat 與 Anthropic Messages——這是可選的自訂工作流程，而非正式註冊表預設。
---

**Replit 閘道夥伴**是位於
[`integrations/replit-gateway`](https://github.com/lidge-jun/opencodex/tree/dev/integrations/replit-gateway)
的使用者自有 Bun 服務，執行於**您的 Replit 部署內**。它從 Repl 環境讀取 Replit 託管的 AI Integrations
憑證，並向 opencodex 公開兩個原生協定端點：

```text
opencodex（本機）
  -> HTTPS + 閘道金鑰
  -> 您的 Replit 部署（integrations/replit-gateway）
  -> Replit AI Integrations 上游（OpenAI Chat / Anthropic Messages）
```

opencodex 永遠不會收到 `AI_INTEGRATIONS_*` 密鑰。您需另行提供 **閘道金鑰**
（`REPLIT_GATEWAY_KEY`），由 opencodex 本機保存，並在每次請求中以 `Authorization: Bearer …` 傳送。

> **僅限自訂工作流程。** `replit` 與 `replit-anthropic` **不是**正式註冊表預設。opencodex 不宣稱
> 官方 Replit 供應商；在取得 Replit 書面授權之前，註冊表推廣仍被阻擋（見下方[證據門檻](#證據門檻)）。

> **實驗性 — 部署未驗證。** 程式與 v1 合約為 `experimental-pending-canary`，**尚未針對 Replit 實際注入環境完成 live 部署驗證。**

## 所需條件

- 帳戶或組織可用的**付費 Replit 方案**及
  [Replit AI Integrations](https://docs.replit.com/features/integrations/replit-ai-integrations)。
- Replit Agent 要求為 Repl 附加 OpenAI 與 Anthropic 託管整合時的**手動核准**。opencodex 不會自動
  執行 Replit 登入、計費或整合對話方塊。
- 閘道套件已部署且可透過公開 **HTTPS** 來源存取（通常為 `https://<repl>.replit.app`）。
- 執行中的 opencodex 代理（`ocx start`），供儀表板精靈或 CLI 安裝使用。

部署與設定請參閱
[套件 README](https://github.com/lidge-jun/opencodex/blob/dev/integrations/replit-gateway/README.md)。

## 部署閘道（摘要）

1. 將 `integrations/replit-gateway/` 複製到 Bun Repl（或從存放庫執行）。
2. 新增 `server.ts`：呼叫 `loadGatewayConfigFromEnv()` 與 `createGatewayServer()`，再
   `Bun.serve({ fetch: gateway.fetch, port, hostname: "0.0.0.0" })`。
3. 在 Replit 介面中核准 **OpenAI** 與 **Anthropic** 託管整合。
4. **在不列印值的情況下確認觀察到的 `AI_INTEGRATIONS_*` 名稱**（見下）。
5. 設定密鑰：`REPLIT_GATEWAY_KEY`（**32–512** 可列印 ASCII）、`REPLIT_GATEWAY_PUBLIC_ORIGIN`、模型允許清單及四個精確整合變數名。
6. 確認 `GET /healthz` 與帶驗證的 `GET /v1/models` 成功。

### Replit 環境變數名（未驗證的觀察慣例）

必需名稱：`AI_INTEGRATIONS_OPENAI_BASE_URL`、`AI_INTEGRATIONS_OPENAI_API_KEY`、`AI_INTEGRATIONS_ANTHROPIC_BASE_URL`、`AI_INTEGRATIONS_ANTHROPIC_API_KEY`。**非 Replit 官方平台外合約**；**canary 驗證待定**。

```bash
printenv | grep '^AI_INTEGRATIONS_' | cut -d= -f1 | sort -u
```

閘道金鑰 **32–512** 可列印 ASCII：

```bash
openssl rand -base64 48 | tr -d '\n'
```

僅存入 Replit Secrets 與 opencodex 配對步驟，切勿提交到 git。

## 與 opencodex 配對

安裝會寫入由部署來源派生的**兩個**自訂供應商：

| 供應商 id | 介面卡 | 基礎 URL | 說明 |
| --- | --- | --- | --- |
| `replit` | `openai-chat` | `<origin>/v1` | 透過 `GET /v1/models` 即時探索模型 |
| `replit-anthropic` | `anthropic` | `<origin>` | Bearer 傳輸；`liveModels: false` |

兩者共用同一閘道金鑰。替換配對時，保留您已設定的非衍生欄位（所選模型、限速、非憑證自訂標頭）。

### CLI — `ocx provider install-replit`

```bash
export REPLIT_GATEWAY_KEY='your-gateway-key'
ocx provider install-replit --origin https://my-app.replit.app
```

金鑰來源（三選一）：`REPLIT_GATEWAY_KEY` 環境變數、`--stdin`、`--gateway-key-file <path>`。**不得**
寫在命令列參數中。

常用旗標：`--allow-custom-domain`、`--replace`、`--set-default`、`--json`。

寫入設定前，opencodex 僅探測**不計費**端點：`GET <origin>/healthz`、`GET <origin>/v1/models`（Bearer）。

### 儀表板精靈

在 **Providers** 頁點選 **Replit gateway…**：

1. 輸入 **HTTPS 來源**與**閘道金鑰**。
2. 若不在 `.replit.app` 上，可啟用 **Allow custom domain**。
3. 可選將 **replit** 設為預設供應商。
4. 成功後顯示 health 與 models 探測耗時。

若配對已存在，**Replace pair** 前需明確確認。精靈註明這**不是**正式註冊表預設。

## 自訂網域選擇加入

預設僅接受以 `.replit.app` 結尾的 HTTPS 來源。opt-in **不證明**主機名稱所有權，**不排除**安裝後 DNS 重新繫結/TLS **維運責任**。opencodex **會**執行 HTTPS 語法、安裝前 destination/DNS 評估與 HTTPS 探測，但均為**時點檢查**。

## 冷啟動

Replit 部署閒置後可能休眠。喚醒後首個請求可能較慢或回傳 `upstream_error`/`upstream_timeout`。安裝
探測逾時 8 秒；閘道不會自動重試計費上游請求。

## 閘道限制（v1）

| 限制 | 預設值 |
| --- | --- |
| 最大請求本文 | 32 MiB |
| 最大請求標頭 | 32 KiB |
| 最大並行 | 10 |
| 上游逾時 | 300 秒 |
| 用戶端逾時 | 310 秒 |

上游 HTTP 重新導向會被拒絕。允許範圍見套件 README。

## 錯誤類別

閘道會回傳穩定的 JSON 錯誤類別（絕不回顯密鑰或請求本文）：

`auth_failed`, `config_invalid`, `request_too_large`, `headers_too_large`,
`unsupported_content_encoding`, `model_not_allowed`, `concurrency_limited`, `upstream_timeout`,
`client_timeout`, `client_aborted`, `redirect_rejected`, `upstream_error`, `internal`。

常見 HTTP 對應：`401` 驗證、`400` 不允許的模型、`413` 請求本文過大、`415` 編碼請求本文、`429` 並行限制、`408` 用戶端逾時、`504` 上游逾時、`502` 上游/重新導向失敗。

## 原生能力（v1）

**支援** — OpenAI Chat 與 Anthropic Messages 位元組流中繼。SSE `: heartbeat\n\n` 僅在**完整行邊界**注入。

**延遲 LF 策略：** CRLF 跨 chunk 分割且 `\n` 延遲時，可能將 `\r` 視為行邊界以決定 heartbeat 時機。**負載位元組不被修改**；罕見 split-CRLF 下**行結束時機**可能不同。

## v1 不支援

- 正式 Replit 註冊表預設或選擇器方塊
- 經此閘道的 Google Gemini、OpenRouter 等
- OpenAI Responses、影像、音訊、轉寫
- OpenAI 與 Anthropic 之間的協定轉換
- 自動上游重試、快取或正規化
- 瀏覽器 CORS
- 非 identity 的 `Content-Encoding`
- `replit-anthropic` 的即時模型探索
- 任何 Replit 帳戶、核准或部署自動化

## 隱私、額度與條款

- **憑證邊界：** 僅閘道金鑰存入 `~/.opencodex/config.json`。
- **計費：** Replit AI Integrations 依公開 API 價格從 Replit 額度扣款。
- **條款：** 適用您方案的 **Replit 條款**。[服務條款](https://replit.com/terms-of-service)（**Replit, Inc.**）；ToS 說明 **Pro/Enterprise** 受 [Commercial Agreement](https://replit.com/commercial-agreement) 約束。**平台外路由授權未取得。**
- **記錄：** 閘道僅記錄中繼資料；管理 API 回應不記錄閘道金鑰。

## 證據門檻

opencodex 僅在具備一手證據時維護供應商預設（見[貢獻 — 正式預設所需證據](/contributing/#evidence-required-for-a-canonical-preset)）。
Replit 夥伴**目前未達標**。

| 證據項 | 狀態（2026-08-22 查核） |
| --- | --- |
| **平台外** OpenAI Chat + Anthropic Messages | **未確立** |
| `AI_INTEGRATIONS_*` 名稱 | **未驗證觀察慣例**；canary 待定 |
| 條款與法律實體 | 服務條款 — **Replit, Inc.**；Pro/Enterprise：Commercial Agreement |
| 平台外路由授權 | **未取得** |
| 具名維護負責人 | **opencodex：** [@lidge-jun](https://github.com/lidge-jun)、[@Ingwannu](https://github.com/Ingwannu)（[`MAINTAINERS.md`](https://github.com/lidge-jun/opencodex/blob/main/MAINTAINERS.md)）。**Replit：** 未作為此工作流程的合作夥伴。 |
| 可引用查核日期 | **2026-08-22** |

**註冊表推廣被阻擋。** `replit`/`replit-anthropic` 不在 `src/providers/registry.ts` 中。

## 另見

- [套件 README](https://github.com/lidge-jun/opencodex/blob/dev/integrations/replit-gateway/README.md)
- [設計規格](https://github.com/lidge-jun/opencodex/blob/dev/docs/superpowers/specs/2026-08-22-replit-gateway-design.md)
- [供應商](/guides/providers/)
- [Web 儀表板](/guides/web-dashboard/)
