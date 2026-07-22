---
title: アダプター
description: 7つのプロバイダーアダプターの対象、リクエスト構成方式、固有の動作。
---

**アダプター**は opencodex の内部リクエスト/レスポンスモデルとプロバイダーの wire 形式の間を変換します。すべてのアダプターは `ProviderAdapter` インターフェース（`src/adapters/base.ts`）を実装します。

```ts
interface ProviderAdapter {
  name: string;
  buildRequest(parsed, incoming?): AdapterRequest | Promise<AdapterRequest>;
  fetchResponse?(request, context): Promise<Response>;   // custom retry/transport
  parseStream(response): AsyncGenerator<AdapterEvent>;
  parseResponse?(response): Promise<AdapterEvent[]>;   // non-streaming
  runTurn?(parsed, incoming, emit): Promise<void>;      // bidirectional transport
}
```

`buildRequest` は `OcxParsedRequest` を上流の HTTP リクエストに落とし、`parseStream` /
`parseResponse` はプロバイダーのレスポンスを内部 `AdapterEvent` に持ち上げます。`fetchResponse` があると、アダプターがリトライとタイムアウトを直接担います。`runTurn` は 1 回の HTTP fetch とその後のレスポンスストリームでは表現できない伝送方式をサポートします。その後 [`bridge.ts`](/opencodex/ja/reference/architecture/#ブリッジ) がイベントを Responses SSE に変えます。

## `openai-chat`

**対象:** OpenAI **Chat Completions**（`POST {baseUrl}/chat/completions`）および互換プロバイダー
— xAI、Kimi、DeepSeek、GLM、Groq、OpenRouter、Ollama（ローカルとクラウド）など。
**認証:** `key`（Bearer）。

- 内部メッセージを OpenAI role に変換し、ツールは `{type:"function", function:{…}}` と
  `tool_choice`（`auto`/`none`/`required` または指定関数）にマッピングします。
- **Codex の GPT-5 アイデンティティプロンプトを書き直し**、モデル中立な紹介に変えます。そのためルーティングされたモデルが自分を OpenAI だと主張しません。
- 正確な段階がないときは **`reasoning_effort` をモデルが公表したサブセットに合わせて調整**します。
  プロバイダーが明示的に alias を設定しない限り、`xhigh` と `max` は異なるラベルのまま保ちます。`provider.noReasoningModels` に含まれる id には値を **一切送りません**。
- `delta.content`（テキスト）、`delta.reasoning_content`（thinking）、`delta.tool_calls[]` を
  ストリーミングし、`usage` を収集します。

## `openai-responses`

**対象:** OpenAI **Responses API**。**`passthrough: true`** — 元のリクエスト本文をそのまま渡し、レスポンスを **変換せずに** ストリーミングします。
**認証:** `forward`（呼び出し元ヘッダー中継）または `key`。

- `forward` URL → `{baseUrl}/responses`; `key` URL → `{baseUrl}/v1/responses`。
- `forward` モードでは安全なヘッダー許可リスト（`FORWARD_HEADERS`）だけを中継します。authorization、ChatGPT account id、OpenAI beta/originator/session ヘッダーが対象です。この ChatGPT ログイン経路は [サイドカー](/opencodex/ja/guides/sidecars/) にも使われます。

## `anthropic`

**対象:** Anthropic **Messages**（`/v1/messages`）。
**認証:** `key`（`x-api-key`）または `oauth`（Bearer + `anthropic-beta`、Claude Pro/Max 用）。

- メッセージを Anthropic content block（text、base64 image、`tool_use`、`thinking`）に変換します。
- **Extended thinking の計算:** Anthropic は `max_tokens > thinking.budget_tokens` を要求します。
  アダプターは reasoning effort を budget にマッピングし（minimal 1024 … max 32000）、出力余裕を取った安全な `max_tokens` を計算します。thinking がオンのときは Anthropic が禁止する **`temperature`/`top_p` を削除**します。
- 常に `anthropic-version: 2023-06-01` を送ります。`content_block_delta`（`text_delta`、
  `thinking_delta`、`input_json_delta`）をストリーミングします。

## `google`

**対象:** Google **Gemini**、**Vertex AI**、Antigravity **Cloud Code Assist**。AI Studio は
`/v1beta/models/{model}:streamGenerateContent`、それ以外のモードはそれぞれ Google ネイティブエンドポイントを使います。
**認証:** `googleMode` に応じて API キー、Vertex ADC、Google Antigravity OAuth のいずれかを選びます。

- システムプロンプト → `systemInstruction`；メッセージ → `contents[]`（assistant → `model`）；ツール →
  `functionDeclarations`。data URL 画像 → `inline_data`。
- Gemini が tool-call id を省略すると合成します。Antigravity では実際の `thoughtSignature` 値を保存・再利用し、次のターンでも reasoning の連続性を保ちます。

## `kiro`

**対象:** Kiro が使う Amazon CodeWhisperer Streaming `GenerateAssistantResponse` サービス
（`https://runtime.{region}.kiro.dev/`）。
**認証:** Kiro 認証情報の region/profile メタデータと Kiro OAuth access token（Bearer）。

- Kiro の `conversationState` を作り、Codex ツールとツール結果をマッピングし、Kiro wire が対応する画像
  block を送ります。
- `application/vnd.amazon.eventstream` をデコードして text/thinking/tool イベントを復元し、途切れたツール JSON を検出します。上流がトークン数を返さないため使用量は推定します。
- `fetchResponse` で限られた回数だけリトライし、エラーを分類/マスクします。非ストリーミングパーサーはウェブ検索ループのために同じイベントストリームを最後まで消費します。

## `cursor`

**対象:** `api2.cursor.sh` の HTTP/2 Connect ストリーミング
`agent.v1.AgentService/Run`。
**認証:** `provider.apiKey` または転送された authorization ヘッダーの Cursor OAuth/access token。

- 通常の fetch/parse 経路の代わりに `runTurn` を使います。リクエスト、サーバーイベント、ツール引数、使用量 checkpoint、クライアントレスポンスは `cursor/gen/agent_pb.ts` の `@bufbuild/protobuf` スキーマでエンコードしたのち Connect メッセージとして framing します。
- content-addressed blob で対話状態を再生し、サーバーツール呼び出しを Codex に再マッピングします。protobuf の `GetUsableModels` RPC でリアルタイム Cursor モデルを探し、run リクエストが wire に commit される前だけリトライします。
- Cursor ネイティブのローカルファイルシステム/shell/network 実行はデフォルトで拒否します。明示的な `mcpServers` と `desktopExecutor` 統合はそれぞれ別の opt-in です。`unsafeAllowNativeLocalExec` はより広い組み込み executor を有効にし、Codex の承認/サンドボックスルールを迂回します。

## `azure-openai`（別名: `azure`）

**対象:** **Azure OpenAI**。`openai-responses` を包むため、同じく `passthrough: true` です。
**認証:** `api-key` ヘッダーの `key`（Bearer ではない）。

- リクエスト構成は Responses passthrough に任せます。`baseUrl` に未解釈のテンプレート placeholder がないか検証し、`Authorization` を `api-key` に差し替えます。設定 URL が Azure v1 Responses API を直接指すため、`api-version` は追加しません。

## 画像ユーティリティ（`image.ts`）

画像を扱うアダプターが一緒に使うヘルパーです。

- `parseDataUrl(url)` — `data:<type>;base64,<data>` URL を `{ mediaType, base64 }` に分け、Anthropic/Google の画像 block に使います。
- `contentPartsToText(content)` — テキスト専用ツールメッセージのために content part をテキストに
  平坦化します。説明のない画像はトークンを増やす base64 blob の代わりに短い `[image]` marker になります。
