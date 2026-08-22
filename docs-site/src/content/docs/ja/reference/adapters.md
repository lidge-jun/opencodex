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
`parseResponse` はプロバイダーのレスポンスを内部 `AdapterEvent` に持ち上げます。`fetchResponse` があると、アダプターがリトライとタイムアウトを直接担います。`runTurn` は 1 回の HTTP fetch とその後のレスポンスストリームでは表現できない伝送方式をサポートします。その後 [`bridge.ts`](/ja/reference/architecture/#ブリッジ) がイベントを Responses SSE に変えます。

## `openai-chat`

**対象:** OpenAI **Chat Completions**（`POST {baseUrl}/chat/completions`）および互換プロバイダー
— xAI、Kimi、DeepSeek、GLM、Groq、OpenRouter、Ollama（ローカルとクラウド）など。
**認証:** `key`（Bearer）。

- 内部メッセージを OpenAI role に変換し、ツールは `{type:"function", function:{…}}` と
  `tool_choice`（`auto`/`none`/`required` または指定関数）にマッピングします。
- **ツール結果内の画像**は、`role:"tool"` がテキスト専用のため、ツールラウンドが閉じた後に後続の
  user vision メッセージ（`image_url` パート）として送られます。ツールメッセージ側には `[image]`
  マーカーがアンカーとして残ります。
- **Codex の GPT-5 アイデンティティプロンプトを書き直し**、モデル中立な紹介に変えます。そのためルーティングされたモデルが自分を OpenAI だと主張しません。
- 正確な段階がないときは **`reasoning_effort` をモデルが公表したサブセットに合わせて調整**します。
  プロバイダーが明示的に alias を設定しない限り、`xhigh` と `max` は異なるラベルのまま保ちます。`provider.noReasoningModels` に含まれる id には値を **一切送りません**。
- `delta.content`（テキスト）、`delta.reasoning_content`（thinking）、`delta.tool_calls[]` を
  ストリーミングし、`usage` を収集します。
- ClinePass は、ライブ検証済みのゲートウェイ形式 `reasoning: { enabled: true, effort }`
  （reasoning を無効にする場合は `{ enabled: false }`）を使用します。公開 API ドキュメントには
  現在このリクエスト形式が明記されていません。アダプターは要求された `low`、`medium`、`high`、
  `xhigh`、`max` tier をそのまま保持し、`delta.reasoning_content` または `delta.reasoning` を
  reasoning delta として扱い、`stream_options.include_usage` でストリーム usage を要求し、非ストリームのレスポンス envelope からも usage を読み取ります。

## `openai-responses`

**対象:** OpenAI **Responses API**。**`passthrough: true`** — 通常は元のリクエストとレスポンスをそのまま渡し、ルーティング先ゲートウェイに必要な限定的な互換変換だけを適用します。
**認証:** canonical OpenAI `forward` は安全な呼び出し元ヘッダー許可リストだけを中継します。非 canonical な `forward` は呼び出し元の authorization を中継せず、設定済みの静的ヘッダーだけを使用します。`key` は設定済み provider key を使用します。

非 canonical な Responses ゲートウェイには、Codex のクライアント実行型 `tool_search`
宣言を既存の公開 function tool と衝突しない名前で送り、対応するリクエスト履歴と JSON/SSE
function call をクライアント向けの非公開 `tool_search` ライフサイクルに復元します。
canonical OpenAI forward はネイティブな非公開型を維持します。

`key` 認証では、[`retryOn429`](/ja/reference/configuration/) もここに適用されます: プリストリームの
429 は、翻訳された `openai-chat` / Anthropic リクエスト経路と同様に、他の処理やフェイルオーバーに
先立って、同じキーで同一リクエストを待機して再送します。カスタム `runTurn` トランスポートは
HTTP リトライ ループの対象外です。

- DeepSeek のステートレス Responses パーサーは、プロバイダーにスコープされた履歴正規化を受けます: フックで
  注入されたコンテキストは、あいまいさのない tool-call/result バッチの後に移動します。並列呼び出しは、
  それぞれの出力の前にグループ化されたままなので、すべての呼び出しが推論を含むアシスタントターンにとどまり
  ます。寛容なプロバイダーと、重複・欠落・順序不正の call ID は元の入力順を保持します。

- `forward` URL → `{baseUrl}/responses`。`key` provider はデフォルトで従来の `{baseUrl}/v1/responses` 構築を使います。
- `key` provider は検証済みの相対 `responsesPath` を設定できます。adapter は `baseUrl` 末尾の `/` を 1 つ除き、`{trimmedBaseUrl}{responsesPath}` に送信します。Ark Agent Plan では `baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"` と `responsesPath: "/responses"` を使います。
- `forward` モードでは安全なヘッダー許可リスト（`FORWARD_HEADERS`）だけを中継します。authorization、ChatGPT account id、OpenAI beta/originator/session ヘッダーが対象です。この ChatGPT ログイン経路は [サイドカー](/ja/guides/sidecars/) にも使われます。

## `anthropic`

**対象:** Anthropic **Messages**（`/v1/messages`）。
**認証:** `key`（デフォルトは `x-api-key`、または `apiKeyTransport: "bearer"` による `Authorization: Bearer`）または `oauth`（Bearer + `anthropic-beta`、Claude Pro/Max 用）。

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
- Gemini が tool-call id を省略すると合成します。Vertex と Antigravity では不透明な `thoughtSignature` 値を保存・再利用し、tool-result の継続ターンでも reasoning の連続性を保ちます。
  署名キャッシュは設定ディレクトリにスナップショットされるため、プロキシ再起動後も継続ターンを維持できます。

## `kiro`

**対象:** Kiro が使う Amazon CodeWhisperer Streaming `GenerateAssistantResponse` サービス
（`https://runtime.{region}.kiro.dev/`）。
**認証:** Kiro 認証情報の region/profile メタデータと Kiro OAuth access token（Bearer）。

- Kiro の `conversationState` を作り、Codex ツールとツール結果をマッピングし、Kiro wire が対応する画像
  block を送ります。
- `application/vnd.amazon.eventstream` をデコードして text/thinking/tool イベントを復元し、途切れたツール JSON を検出します。上流がトークン数を返さないため使用量は推定します。
- `fetchResponse` で限られた回数だけリトライし、エラーを分類/マスクします。非ストリーミングパーサーはウェブ検索ループのために同じイベントストリームを最後まで消費します。
### 完了とネイティブ stop reason

Kiro のアシスタントテキストには、それ自体で end-turn を示す信頼できる区別がありません。ただし終端の
`metadataEvent` がネイティブの `stopReason` を運ぶことがあります。`END_TURN` または `STOP_SEQUENCE` は
終了した推論であることは示しますが、進捗文にも付く場合があるため、ツール有効ターンではそのテキストだけを最終回答にしません。
通常テキストは commentary のまま、非公開の完了ツールを一度検証します。

`END_TURN`、`STOP_SEQUENCE`、または stop reason が無い場合は一度だけ完了互換パスに入れます。それ以外の明示的な理由はすでに上流で推論を終了させて
いるため、もう一度モデルに投げ直すのではなくそのまま報告します。出力トークン上限は継続可能な incomplete、
コンテキストウィンドウの枯渇は再試行不可の context-length エラー、フィルタリングやガードレールによる停止は
filtered incomplete になります。実際のツール呼び出しを伴わない `TOOL_USE` は進捗ではなく矛盾として扱います。

ツール有効ターンでは非公開の `codex_kiro_final_answer` を追加します。再試行は空の assistant/user ターンを
生成せず、元の user/tool-result を保持し、送信前にロール交互性、空の構造メッセージ、tool use/result の対応を検証します。
完了ツールの回答は以前の commentary と同じでも `final_answer` として送出します。

### Reasoning effort

`gpt-5.6-sol` と `claude-opus-5` はネイティブ effort をサポートし、リクエストフィールド名が異なります。
`low` / `medium` / `high` / `xhigh` / `max` は、前者では
`additionalModelRequestFields.reasoning.effort`、後者では `output_config.effort` として送信されます。


## `cursor`

**対象:** `api2.cursor.sh` の HTTP/2 Connect ストリーミング
`agent.v1.AgentService/Run`。
**認証:** `provider.apiKey` または転送された authorization ヘッダーの Cursor OAuth/access token。

- 通常の fetch/parse 経路の代わりに `runTurn` を使います。リクエスト、サーバーイベント、ツール引数、使用量 checkpoint、クライアントレスポンスは `cursor/gen/agent_pb.ts` の `@bufbuild/protobuf` スキーマでエンコードしたのち Connect メッセージとして framing します。
- content-addressed blob で対話状態を再生し、サーバーツール呼び出しを Codex に再マッピングします。protobuf の `GetUsableModels` RPC でリアルタイム Cursor モデルを探し、run リクエストが wire に commit される前だけリトライします。
- `cursor/grok-4.5-fast` は選択可能なモデルとして維持しつつ、Cursor には正規の `grok-4.5`
  モデルを送信し、個別の `effort` および `fast=true` 値は `requested_model.parameters` に格納します。
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
