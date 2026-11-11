---
title: Ollama 互換クライアント
description: Ollama API を話すツールを opencodex に向け、設定済みのプロバイダーモデルを使います。
---

opencodex は Ollama HTTP API の一部に応答します。Ollama としか通信できないツールでも、opencodex に
設定済みのモデルを使えます。リクエストは Chat Completions 経路に変換され、選択したプロバイダーに送られます。
opencodex はお使いのマシン上でモデルをダウンロード、保存、実行しません。

## クライアントの接続

プロキシのアドレスを Ollama ホストとして指定します。既定のローカルインストールでは次のとおりです。

```bash
export OLLAMA_HOST=http://127.0.0.1:10100
curl "$OLLAMA_HOST/api/tags"
```

プロキシが API キーを要求する場合(たとえば `0.0.0.0` バインド)は、`/v1/chat/completions` と同じ方法で
送ります。例: `Authorization: Bearer <opencodex key>`。モデル範囲付きのキーでは、許可されたモデルだけが表示・使用
されます。これらのエンドポイントはメインリスナーでのみ提供され、認証なしのループバックリスナー、Remote Link、
ハブ管理イングレスでは公開されません。

## エンドポイント

| エンドポイント | 動作 |
| --- | --- |
| `GET /api/version` | opencodex のバージョン。 |
| `GET /api/tags` | 設定済みのプロバイダーモデルを `provider/model` 名で返します。 |
| `POST /api/show` | `{ "model": "provider/model" }` は既知の情報のみを返します。ファイルサイズ、ダイジェスト、テンプレート、ライセンスは含みません。 |
| `POST /api/chat` | `system`、`user`、`assistant`、`tool` メッセージによるチャット。 |
| `POST /api/generate` | 任意の `system` を伴う単一プロンプト。 |

それ以外の `/api/*` パスはすべて opencodex 管理 API のままです。

## 対応するリクエストフィールド

- `model`: `/api/tags` に含まれる名前。
- `stream`: 既定値は `true`(改行区切り JSON)。JSON 応答を 1 つだけ受け取るには `false` にします。
- `images`: ユーザーメッセージ(chat)またはリクエスト(generate)に付ける base64 の PNG、JPEG、GIF、WebP。
- `tools`(chat のみ): 関数ツール。assistant メッセージは各呼び出しの `id` を含めてそのまま送り返します。
  `tool` の結果は `tool_call_id`、なければ `tool_name` で対応付けられます。
- `options`: `temperature`、`top_p`、`num_predict`、`stop`。
- `format`: `"json"` のみ。

各 `/api/chat` リクエストでは、すべての assistant メッセージを合わせて **ツール呼び出しは最大 1,024 件**です。
結果がすでに返された呼び出しも含みます。上限を超えると、プロバイダーに送信される前に HTTP 400 が返されます。
会話履歴を短くして再送してください。残すツール結果と、それに対応する assistant のツール呼び出しは必ず一緒に残します。

それ以外は無視されず、HTTP 400 で拒否されます。`think`、`keep_alive`、`suffix`、`raw`、`template`、
`context`、その他の `options`、JSON スキーマ形式の `format`、画像 URL が該当します。Ollama のモデル管理および
埋め込みエンドポイントは提供されません。

コンボ、ルーティングポリシー、`--fast` や effort のエイリアス、呼び出し元自身の認証情報を転送するプロバイダーは
ここでは選択できません。これらのリクエストは、上流に何も送信される前に失敗します。

## レスポンス

完了した応答には `done: true` と、`stop`、`tool_calls`、`length` のいずれかの `done_reason` が付きます。
`prompt_eval_count` と `eval_count` はプロバイダーが使用量を報告した場合に現れ、所要時間のフィールドは報告されません。
ストリームは、上流の応答が完全に終わった後に `done: true` の行をちょうど 1 回だけ送ります。

エラーは Ollama 形式の `{ "error": "message" }` を使い、HTTP ステータスを保ちます。レート制限と混雑による拒否では
`Retry-After` も含まれます。コンテンツフィルターや不明な理由で止まった応答は、通常の停止ではなくエラーとして返されます。
ストリームが開始後に失敗した場合、最後の行は `error` オブジェクトになり、`done: true` の行は続きません。

リクエストは他のトラフィックと同様にダッシュボードのリクエストログに表示され、レスポンスヘッダー
`x-opencodex-request-id` が対応する行を示します。
