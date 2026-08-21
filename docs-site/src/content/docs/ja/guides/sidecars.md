---
title: "サイドカー: ウェブ検索とビジョン"
description: ネイティブ ChatGPT サイドカー経由でルーティングモデルに実際のウェブ検索を、テキスト専用モデルに画像理解を提供します。
---

ルーティングモデルごとにホスト型**ウェブ検索**やネイティブ**画像入力**のサポート範囲が異なります。opencodex は
ChatGPT ログイン(`forward`)プロバイダーまたは保存された Anthropic OAuth プロバイダーを使う 2 つの
サイドカーで不足機能を補い、ウェブ検索は明示的な `xai` バックエンドで保存済み Grok OAuth も利用できます。サイドカーエラーはターン全体を失敗させず、長さ制限付きのツール
結果や画像案内文に差し替わります。

:::note[バックエンド自動選択]
`backend` を明示するとその値が優先します。ウェブ検索は省略時に常に `openai`、Vision は利用可能な
Anthropic OAuth アカウントがあれば `anthropic`、なければ `openai` を使います。利用可能な認証情報なしに
`anthropic` または `xai` を明示するとフォールバックせず失敗します。`openai` は ChatGPT ログインと有効化された `forward`
プロバイダーが両方必要です。
:::

## ウェブ検索サイドカー

Codex がパススルーでないルーティングモデルにホスト型 `web_search` を要求すると opencodex は次の順序で
処理します。

1. ホスト型 `web_search` ツールを**削除し**、ルーティングモデルには合成 `web_search(query)` 関数ツールを
   公開します。元のホスト型ツールのオプションはサイドカー呼び出しにそのまま使います。
2. ルーティングモデルを小さな**エージェントループ**で実行します。モデルが `web_search` を呼ぶと選んだ
   バックエンドを使います。OpenAI はデフォルト `gpt-5.6-luna` でホスト型 `web_search` を実行し、
   Anthropic はデフォルト `claude-sonnet-5` で `web_search_20250305` を実行します。xAI はデフォルト
   `grok-4.6` で hosted `web_search` を実行し、`xSearch.enabled` が true の場合は同じリクエストに
   `x_search` を追加します。ストリーミング回答と引用をパースした結果をツール結果として返します。
3. モデルが答えるか実際の検索クエリの総数が `maxSearchesPerTurn`(デフォルト 3)に達するまで
   **反復**します。限度に達すると検索ツールを削除し最終回答を強制します。`apply_patch` や shell
   のような実際のクライアントツールが出たらターンを終了し該当呼び出しが Codex に渡るようにします。

ルーティングモデルのすべての反復は上流に `stream: true` を要求しますが、opencodex は検索可否や最終
回答を決める前に意味のある event を内部ですべてバッファリングします。最初の反復の最終
header/status と 429 キーローテーションのみ先行取得します。したがって合成検索呼び出しと中間出力はクライアントに
モデル出力として公開されません。

注入結果は信頼できないデータ境界で囲んで長さを制限し、ソース URL 基準で重複を除去します。構造化出力ターン(`json_schema` / `json_object`)では散文ではなく簡潔な JSON で
渡します。ルーティングモデルがテキスト専用なら検索モデルに関連画像を文字で説明しソース URL も
含めるよう指示します。

```json
{
  "webSearchSidecar": {
    "enabled": true,
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "reasoning": "low",
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 200000
  }
}
```

ホスト型バックエンドが `minimal` 強度でツール使用を拒否するためデフォルトは `low` です。検索が失敗すると
長さ制限付きのエラー結果をルーティングモデルに返し、モデルはすでに持っている文脈を基に答えられます。

互いに独立な 4 つの clock が適用されます。`stallTimeoutSec` はデフォルトの bridge event stall 予算です。
`connectTimeoutMs`(デフォルト `200000`)は DNS/TCP/TLS と最終応答 header までのみ制限します。設定
ファイルでのみ指定できる `webSearchSidecar.routedModelStallTimeoutMs`(デフォルト `200000`、整数
`1..2147483647`)はルーティングモデル反復で生応答 byte が連続で来ない時間を制限し、
空でない byte が来るたびに再開します。`webSearchSidecar.timeoutMs` はホスト型検索リクエスト
1 件を個別に制限します。実際の bridge watchdog は
`max(デフォルト stall, connect timeout, ルーティングモデル stall, サイドカー timeout) + 30秒` です。ルーティングモデル
stall は全体生成 timeout ではありません。SSE 開始前の失敗は 2xx でない JSON で返し、
応答 header 開始後の生成失敗は `response.failed` SSE で伝えます。

## ビジョンサイドカー

ルーティングモデルが該当プロバイダーの `noVisionModels` にありリクエストに画像が来る場合、opencodex は
メイン呼び出し**前に**各画像を説明したテキストに差し替えます。`visionSidecar.model` が未設定または空の場合、
OpenAI 実行経路、ダッシュボード、管理 API は `gpt-5.4-mini` をフォールバックとして使います。起動時には
明示的に保存された旧 `gpt-5.4-mini` 値を引き続き `gpt-5.6-luna` にマイグレーションしますが、この
マイグレーションは保存済みの値だけが対象で、モデルフィールドがない場合には適用されません。

- 画像はユーザー、developer、ツール結果メッセージから来ます。Codex の `view_image` 結果も
  含まれます。
- OpenAI パス（ChatGPT ログインパススルー）では、各画像は選択した `reasoning.effort`（デフォルト
  `low`）付きで Responses エンドポイント経由で設定済みのビジョンモデルに送信され、説明が画像部分
  をインラインで置き換えます。Anthropic パスは Messages エンドポイントを使い、独自の思考予算
  マッピングで動作し、この OpenAI 固有の設定を無視します。
- 信頼できる能力メタデータがあるネイティブモデルでは、未対応の推論レベルは要求値以下で最も高い
  対応レベルに正規化されます。該当するレベルがない場合は最も低い対応レベルを使います。能力情報を
  信頼できない不明モデルやカスタムモデルは制限せず、そのまま扱います。
- 説明は一度に 3 件並列処理し入力順序を維持します。説明モデルに渡すユーザー文脥は
  800 文字、注入する画像説明は 1 枚あたり 2,000 文字に制限します。ChatGPT バックエンドが拒否する
  `max_output_tokens` は送信しません。
- 画像 URL は転送前に検証します。data URL は `png` / `jpeg` / `jpg` / `webp` / `gif`
  形式で、base64 データは約 20 MB に制限します。`data:` と `https:` スキームのみ許可し、
  リモート `https` 画像はプロキシではなく OpenAI バックエンドが取得します。
- `noVisionModels` 比較は Ollama 式の `:size` 接尾辞を無視するため `gpt-oss` 項目 1 つで
  `gpt-oss:120b` も処理できます。
- 画像説明が失敗すると短い処理エラー案内文をモデルに渡します。サイドカー計画自体を作れない場合は
  テキスト専用バックエンドに元画像を送らず削除します。
- `maxDescriptionsPerTurn`(デフォルト 8)はメインモデル 1 ターンで新規実行する説明数を制限します。キャッシュ
  ヒットと同じターンの重複要求は限度を消費しません。成功した `data:` 画像説明はバックエンド、モデル、
  detail、画像バイト、メッセージ文脈を基準にキャッシュし、OpenAI のキーには推論負荷も含まれます
  (Anthropic のキーには含まれません。そこではこのフィールドは無視されるため)。変わり得る
  `https:` 画像はキャッシュしません。

```json
{
  "visionSidecar": {
    "enabled": true,
    "backend": "openai",
    "model": "gpt-5.6-luna",
    "reasoning": "medium",
    "maxDescriptionsPerTurn": 8,
    "timeoutMs": 45000
  }
}
```

テキスト専用モデルはプロバイダーごとに指定します。

```json
{
  "providers": {
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  }
}
```

## ダッシュボード設定とオフ

ダッシュボードのビジョンサイドカーカードでは、既存のモデル・バックエンド・推論コントロールに加えて、サイドカーのオン/オフ、`maxDescriptionsPerTurn`、`timeoutMs` を設定できます。オフにしても他の設定は削除されず、再びオンにすると以前のモデル、バックエンド、推論、タイムアウト、上限が残ります。

`PUT /api/sidecar-settings` は同じフィールドを受け付けます。部分更新では省略したキーをそのまま残します。`timeoutMs` はランタイムの整数範囲（1–2147483647 ms）を使います。

ファイルを直接編集したい場合は、これまでどおり `config.json` で `enabled` を `false` にできます。Anthropic OAuth 検索と画像説明は既存の Claude Code OAuth fingerprint 先例に従いますが、実際のアカウントと作業量で十分 soak test するのが無難です。全
フィールドは[設定リファレンス](/ja/reference/configuration/#sidecars)を参照してください。
