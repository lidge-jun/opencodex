---
title: プロキシ API 形式
description: 応答、チャット完了、人為的メッセージ、モデル カタログ、WebSocket、リアルタイム、および圧縮サーフェスのワイヤ レベルのリファレンス。
---

opencodex は、複数のクライアント方言で 1 つのローカル プロキシを表示します。 Codex クライアントは Responses API を話すことができ、OpenAI 互換アプリは Chat Completions を話すことができ、Claude Code は Anthropic Messages を話すことができます。すべての上流プロバイダーがあらゆる形式を実装する必要はありません。

通常の変換パスは次のとおりです。

```text
client dialect → internal Responses model → provider adapter → provider wire format
provider events → internal adapter events → client dialect
```

応答表現はブリッジの中心です。ネイティブ互換ルートは、変換の一部をスキップしてリクエストを通過させる可能性がありますが、認証、ルーティング、アドミッション コントロール、および応答の安全性は依然としてプロキシ境界で発生します。 [構成](/reference/configuration/) でリスナーとアドミッション キーを構成します。 1 つのパブリック モデル ID を複数のターゲットから選択する必要がある場合は、[コンボ](/guides/combos/) を使用します。

## エンドポイントの概要

|クライアントサーフェス |エンドポイント |非ストリームの結果が成功 |成功したストリームまたはソケットの結果 |
| --- | --- | --- | --- |
| OpenAI の応答 | `POST /v1/responses` |応答 JSON |応答 SSE、または WebSocket 上の応答 JSON テキスト フレーム |
| OpenAI チャットの完了 | `POST /v1/chat/completions` | JSON | `chat.completion` `chat.completion.chunk` SSE で終わる `[DONE]` |
|人間的なメッセージ | `POST /v1/messages` |人類 `message` JSON |人間的メッセージ SSE |
|人間トークン数 | `POST /v1/messages/count_tokens` | `{ "input_tokens": number }` |該当なし |
|モデルの発見 | `GET /v1/models` | 3 つのカタログ契約のうちの 1 つ |該当なし |
|音声とリアルタイム | `POST /v1/live`、`POST /v1/realtime/calls` |中継されたコール作成応答 |別のサイドバンド WebSocket がフレームを両方向に中継します。
|応答の圧縮 | `POST /v1/responses/compact` |置換履歴 JSON |該当なし |

## `POST /v1/responses`

これは、ネイティブの opencodex データプレーン形状です。リクエスト本文は、空ではない `model` を持つ JSON オブジェクトである必要があります。 `input` は文字列または応答項目の配列です。

### 受け入れられたリクエストフィールド

|エリア |許容される形状 |
| --- | --- |
|モデルと入力 |空ではない必須の `model`。オプションの文字列 `input` または項目配列 |
|メッセージ項目 | `user`、`developer`、`system`、および `assistant` メッセージ。役割に適した文字列コンテンツまたは型付きコンテンツ ブロック |
|コンテンツブロック |テキスト、入力画像、入力ファイル、出力テキスト、拒否、および親項目で許可されている推論の概要/テキスト ブロック |
|ツールの歴史 | `function_call`、`function_call_output`、`custom_tool_call`、および `custom_tool_call_output` アイテム |
|ツール |関数ツールに加えて、緩い組み込みまたはホストされたツール エントリ。 `tool_choice` は、`auto`、`none`、`required`、名前付き関数/カスタム選択肢、ホストされた選択肢、または `allowed_tools` を受け入れます。
|推論 | `reasoning.effort` および `reasoning.summary` (`auto`、`concise`、`detailed`、または `none`) |
|継続とキャッシュ | `previous_response_id`、`store`、および `prompt_cache_key` |
|生成制御 | `max_output_tokens`、`temperature`、`top_p`、`stop`、`presence_penalty`、および `frequency_penalty` |
|サービスと実行 | `stream`、`service_tier`、`parallel_tool_calls`、`instructions`、`metadata`、および `user` |
|拡張応答フィールド | `background`、`include`、`prompt`、`text`、および `truncation` は互換性のあるルートとして受け入れられます。

未知の項目タイプは、前方互換性のためにルーズタイプの項目として受け入れられます。変換されたアダプターは、認識する項目タイプのみを処理し、プロバイダーが表現できない機能を拒否する場合があります。

### JSON および SSE 出力

`stream: true` の場合、応答は `text/event-stream` となります。ブリッジは、`response.created`、出力項目およびテキスト/ツール デルタ、および 1 つの端末 `response.completed`、`response.failed`、または `response.incomplete` イベントなどの応答イベントを発行します。通常のストリームは `data: [DONE]` で終了します。

`stream: false` を指定するか、`stream` を指定しないと、同じアダプター イベントが 1 つの Responses JSON オブジェクトに収集されます。どちらの形式でも、選択したモデル、出力項目、端末の状態、使用状況が保存されます。

クライアント向け Responses SSE フレームは、SSE ブロック区切りの前の生バイトで測って 1 フレームあたり 4 MiB に制限されます。HTTP では、区切りなしでこの上限を超えたアップストリーム フレームは、合成 `response.failed` イベントと続く `data: [DONE]` でフェイルクローズします。Responses WebSocket ブリッジでは、同じ条件で 502 `websocket_protocol_error` を送信し、アップストリーム リーダーをキャンセルします。完全な Responses 終端フレームがすでに到着している場合はそれが優先され、その後のサイズ超過または不正なバイトは、完了したターンをトランスポート障害に置き換えず破棄されます。

:::note
ネイティブ パススルーでは、Responses の終端イベントが優先されます。早すぎる `data: [DONE]` は、そのイベントが届くまで保留されます。通常のネイティブ パスで、解析済みの終端がないまま正常な HTTP 200 EOF に達した場合、プロキシは `incomplete_details.reason: "adapter_eof"` を持つ `response.incomplete` を 1 件、その後に `data: [DONE]` を 1 件送信します。区切りのない終端 JSON が構文的に有効なら 1 回だけ受け入れられ、不正または切り詰められた JSON は incomplete のままです。モデル単位の終端修復を有効にしたプロバイダーでは、フレーム化されていない終端らしい接尾部と EOF 時の早すぎる `data: [DONE]` は、昇格可能な完全なライフサイクル候補がなければ `missing_terminal_event` としてフェイルクローズし、候補が完全なら `response.completed` に昇格します。高信頼度の `cyber_policy` 終端は、セマンティックなログおよび課金集計上は `error.code: "cyber_policy"` を持つ `response.failed`（status 400）に正規化されますが、すでに開始済みのストリーミング HTTP 応答は 200 のままです。このコミット済みリクエストの境界では、再試行も再送も行いません。
:::

すべての端末応答使用状況オブジェクトには、プロバイダーが詳細を報告しなかった場合でも、両方の詳細オブジェクトが含まれます。

```json
{
  "input_tokens": 0,
  "output_tokens": 0,
  "total_tokens": 0,
  "input_tokens_details": { "cached_tokens": 0 },
  "output_tokens_details": { "reasoning_tokens": 0 }
}
```

利用可能な場合、`input_tokens_details` には `cache_write_tokens` も含めることができます。常に存在する詳細オブジェクトは、厳密な応答クライアントに対する互換性を保証します。ゼロは「報告されていない」ことを意味する場合がありますが、必ずしも「プロバイダーがそのような作業を実行していない」とは限りません。

### 応答とリクエストログの関連付け

アドミッションを通過したすべての HTTP Responses 応答には、プロキシが生成した `ocx-<32 hex>` 形式の ID を格納する `x-opencodex-request-id` ヘッダーが付与されます。この値は、応答をリクエストログおよび使用状況レポート内の対応する行に結び付けるキーです。

プロキシは常にこの値を生成し、呼び出し元が指定した ID やアップストリームが返した ID を上書きします。そのため、このプロキシに固有であり、相関キーとして安全に信頼できます。このヘッダーは `Access-Control-Expose-Headers` に列挙されているため、ブラウザーの JavaScript からクロスオリジンで読み取れます。カスタムの `x-` ヘッダーは、実際にワイヤ上に存在していても、そうしなければ `response.headers.get()` からは見えません。

認証またはオリジンのアドミッションで拒否されたリクエストはこのラッパーに到達せず、ID も付与されません。そのため、ヘッダーがない場合は、リクエストがログに記録される前に拒否されたことを意味します。

### 同じパスでの WebSocket のアップグレード

`websockets` が有効な場合、クライアントは HTTP POST を開く代わりに `/v1/responses` をアップグレードできます。認証とオリジンの許可は、WebSocket ハンドシェイク中に行われます。それらは各フレーム内で繰り返されません。

クライアントは JSON テキスト フレームを送信します。

```json
{
  "type": "response.create",
  "model": "provider/model",
  "input": "Hello",
  "tools": [],
  "generate": true
}
```

`type` を除くすべてが応答リクエストの本文となり、プロキシはそのターンのストリーミングを強制します。新しい `response.create` が優先され、そのソケットに対する以前のターンがキャンセルされます。 `response.processed` は no-op 確認応答として受け入れられます。解析できないフレームタイプまたは関連性のないフレームタイプは無視されます。

サーバーフレームはJSONテキストフレームです。ストリーミング出力が成功すると、SSE エンベロープや `[DONE]` を使用せずに、SSE `data:` 行に表示されるものと同じ JSON ペイロードが使用されます。非ストリーミングの内部結果は、`response.created`、0 個以上の `response.output_item.done` フレーム、そして終端フレームとして再フレーム化されます。エラーでは次のエンベロープが使用されます。

```json
{
  "type": "error",
  "status": 502,
  "error": {
    "type": "upstream_error",
    "message": "..."
  },
  "headers": {}
}
```

`generate: false` のウォームアップ フレームはアップストリームを呼び出しません。これは、合成 `response.created` に続いて `response.completed` を返します。両方とも空の応答 ID を持ち、出力はありません。

:::note
WebSocket が無効になっている場合、アップグレード試行ではコード `upgrade_required` の HTTP 426 を受信します。 Codex は、そのハンドシェイクの結果を、セッションの HTTP にフォールバックする信号として扱います。失敗したモデルターンではありません。
:::

## `POST /v1/chat/completions`

このエンドポイントは、必須の `model` および空ではない `messages` 配列を含む OpenAI 互換の Chat Completions リクエストを受け入れます。システム、ユーザー、アシスタント、ツールのメッセージを内部の応答アイテムに変換します。機能ツール、ツールの選択、画像、推論負荷、およびサポートされている応答形式を翻訳します。通常の応答ルーティング パイプラインを実行します。次に、結果を変換して戻します。

非ストリーミング出力には `object: "chat.completion"` があります。ストリーミング出力では、`object: "chat.completion.chunk"` の SSE オブジェクト、選択デルタ、`finish_reason`、および `data: [DONE]` の端末選択を使用します。ツール呼び出しと使用情報は、ソース イベントが伝達する場所に変換されて戻されます。

内部実行パスは応答ベースであるため、プロバイダー アダプターはより狭い機能セットを課すことができます。たとえば、選択したアダプタで表現できないリクエスト機能は、その意味を黙って変更するのではなく、エラーとして返されます。

## `POST /v1/messages` および `count_tokens`

これらのエンドポイントは、Claude Code および互換性のあるクライアントによって使用される Anthropic Messages 言語を話します。ほとんどのリクエストはレスポンスに変換され、通常どおりルーティングされてから、Anthropic JSON または Anthropic SSE に変換されます。

ネイティブ Anthropic パススルーは、次のすべてが当てはまる場合にのみ適格です。

- ネイティブ パススルーはクロード コード設定で無効になっていません。
- 要求されたモデルは `claude` または `anthropic` で始まります。
- リクエストにはネイティブ Anthropic Bearer または `x-api-key` 資格情報が含まれます。
- 非ループバック listener では、有効なプロキシ admission を `x-opencodex-api-key` だけで送ります。そして
- 構成されたエイリアスまたはモデル マップが、ルーティングされたターゲットのモデル ID を主張しません。

適格なリクエストは Anthropic 方言で転送されるため、ネイティブ ベータ ヘッダー、思考署名、およびサブスクリプション ID がエンドツーエンドで残ります。それ以外の場合は、応答が往復してかかります。

専用 admission ヘッダーは転送されません。`Authorization` または `x-api-key` にあるプロキシ
admission secret も削除され、別の実際の Anthropic 認証情報は維持されます。カンマで結合された
曖昧な認証ヘッダーは fail closed します。

`POST /v1/messages/count_tokens` は、同じモデルの解像度とパススルーの決定に従います。ネイティブ適格なリクエストは、Anthropic のカウント エンドポイントに転送されます。他のリクエストは、システム コンテンツ、メッセージ、ツールに対してローカルに文書化された見積もりを使用し、次を返します。

```json
{ "input_tokens": 123 }
```

## `GET /v1/models`

同じルートは、互換性のないカタログ エンベロープを予期する 3 つのクライアントにサービスを提供します。 `client_version` も存在しない限り、人間味が優先されます。

|契約 |トリガー |トップレベルの形状 |モデル ID の動作 |
| --- | --- | --- | --- |
|人類モデルのリスト | `anthropic-version` ヘッダーまたは `?flavor=anthropic`、`client_version` なし | Anthropic モデル情報エントリのある `{ "data": [...] }` |クロード コードは読み取り可能な ID を受け取ります。デスクトップはプロファイル固有のエイリアス ファミリを受け取ることができます。
|Codexカタログ | `client_version` クエリパラメータ | `{ "models": [...] }` |ネイティブおよびルーティングされたエントリには、より豊富な Codex カタログ フィールド、可視性、労力、WebSocket、およびマルチエージェント メタデータが含まれています。
|プレーンな OpenAI リスト |どちらのトリガーもありません | `{ "object": "list", "data": [...] }` |表示されるネイティブ ID は裸です。ルーティング ID はエイリアスまたは `provider/model` |

## `POST /v1/live` とRealtime サイドバンド

`POST /v1/live` は、ChatGPT/Codex アプリのフレームレス通話作成サーフェスを受け入れます。 `POST /v1/realtime/calls` は、OpenAI Realtime 呼び出し作成サーフェスを受け入れます。 opencodex は、適格な OpenAI ファミリ ルートを選択し、アップストリーム認証モードのコール作成リクエストを正規化し、制限付き応答を中継します。

コールの作成後、クライアントはサポートされている受信フォームを使用してサイドバンド WebSocket に参加できます。

- `/v1/live/{callId}`
- `/v1/realtime/calls/{callId}`
- `/v1/realtime?call_id={callId}`

プロキシはアップストリームの参加 URL を正規化し、テキストとバイナリ フレームを両方向に透過的に中継します。クライアント プロトコル ヘッダーは保持されますが、アップストリーム認証はプロキシが所有したままになります。

## `POST /v1/responses/compact`

圧縮により、長い応答会話を短縮する必要があるクライアントの置換履歴が返されます。

|ルートの種類 |行動 |
| --- | --- |
| Canonical ChatGPT または公式 OpenAI ルート |解決されたアカウントとモデル認証を使用して、リクエストをネイティブ `/responses/compact` エンドポイントに転送します。
|その他の配線モデル | `compaction_trigger` を使用して内部、非ストリーミング、ツール不要の圧縮ターンを実行します。 `encrypted_content` が `ocx1:` エンベロープである合成 `compaction` アイテムが 1 つだけ必要です。その概要を v1 置換履歴にデコードします。

ネイティブ コンパクト応答は、宣言された `Content-Length` がすでに制限を超えている応答を含め、最大 32 MiB でバッファリングされます。コンパクト固有の障害には次のようなものがあります。

|ステータス |タイプまたはコード |意味 |
| --- | --- | --- |
| 400 | `invalid_request_error` |無効な JSON/ボディ形状または欠落しているモデル |
| 404 | `invalid_request_error` |要求されたモデルはルーティングできません。
| 499 | `client_cancelled` | | 転送またはバッファリング中にクライアントがキャンセルされました。
| 502 | `compact_response_too_large` |ネイティブ コンパクト出力が 32 MiB を超えました |
| 502 | `upstream_error` |接続、読み取り、または合成圧縮ターンの失敗 |
| 502 | `invalid_response_error` |合成ターンでは、有効な空でない `ocx1:` 圧縮項目が 1 つだけ生成されませんでした。

## 認証マトリックス

ループバックのみのバインドでは、データ プレーンのアドミッションに設定されたキーは必要ありません。リモート バインドでは、以下のマトリックスを使用します。 「専用」とは `X-OpenCodex-API-Key` を意味します。他の列は `Authorization: Bearer ...` と `x-api-key` を意味します。

|表面 |専用 |ベアラー | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` HTTP と WebSocket |必須 |代理入場を拒否されました |拒否されました |
| `/v1/responses/compact` |必須 |代理入場を拒否されました |拒否されました |
| `/v1/chat/completions` |必須 |代理入場を拒否されました |拒否されました |
| `/v1/messages` および `/v1/messages/count_tokens` |承認済み |承認済み |承認済み |
| `/v1/models` |承認済み |承認済み |承認済み |
| `/v1/live`、`/v1/realtime/calls`、および側波帯結合 |承認済み |承認済み |承認済み |

Responses-family および Chat リクエストは、プロバイダーまたは Codex Direct パススルー用に `Authorization` を予約するため、リモート プロキシ キーは専用ヘッダーを使用する必要があります。メッセージとリアルタイム サーフェスは、より広範なクライアント互換性を必要とするため、3 つの形式すべてを受け入れます。

:::caution
データプレーン キーは管理資格情報ではありません。管理 API は別の管理シークレットを使用します。 [管理 API](/reference/management-api/)を参照してください。 1 つのシークレットを両方のプレーンに再利用しないでください。
:::

## よくあるエラーの語彙

エラーでは、必要に応じてクライアントダイアレクトのエンベロープが使用されますが、次のステータス/コードの意味は安定しています。

|ステータス |タイプまたはコード |意味 |
| --- | --- | --- |
| 401 | `authentication_error` |必要なプロキシ アドミッション資格情報が見つからないか無効です。
| 403 | `origin_rejected` | Responses/OpenAI データプレーン リクエストまたは WebSocket アップグレードが、許可されていないオリジンから送信されました。
| 503 | `combo_unavailable` |選択したコンボ内のすべてのターゲットは使用不可、クールダウン中、無効、またはその他の理由で不適格です。
| 400 | `unreadable_encrypted_agent_task` |暗号化された v2 ワーカー タスクには、それを使用できる適格なネイティブ ChatGPT ターゲットがありません。
| 426 | `upgrade_required` |応答 WebSocket トランスポートが無効になっているか、アップグレードが失敗しました。 HTTP を使用する |

Anthropic オリジンの失敗は Anthropic のエラー エンベロープでレンダリングされるため、オリジンの拒否は OpenAI スタイルの `origin_rejected` 本体ではなく、その方言上の 403 `permission_error` になります。

## 暗号化されたコンテンツの健全性

プロキシは、本物のバックエンド暗号文を不透明なものとして扱います。構造的に有効な暗号文はバイト単位で保存されます。opencodex は暗号文を復号したり、その内容を変換したり、別のプロバイダー用に再暗号化したりしません。

一部のエージェント フックはこれまで、プレーンテキストの制御テキストを `encrypted_content` スロットに配置していました。互換性を確保するために、プロキシは、構造的に有効な Fernet の実行を変更せずに保持しながら、プレーンテキストをテキスト部分に分割します。 `agent_message` が修復中にすべての暗号化された部分を失った場合、それは通常のユーザー メッセージになります。現在の v2 タスクが完全に暗号化されたままであるが、選択したルーティングされたターゲットがネイティブ ChatGPT 暗号文を読み取ることができない場合、opencodex は読み取り不能なバイトをそのプロバイダーに送信する代わりに `unreadable_encrypted_agent_task` で失敗します。ワーカー タスクに関するクライアントの動作については、[サブエージェントサーフェス](/guides/sub-agent-surface/) を参照してください。
