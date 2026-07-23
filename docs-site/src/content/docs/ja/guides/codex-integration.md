---
title: Codex 連携
description: opencodex が Codex に自身を注入し、モデルカタログを同期し、サブエージェントピッカーを駆動し、綺麗に復元する方式。
---

opencodex は Codex が読む 2 つ、設定(`$CODEX_HOME/config.toml`、デフォルト `~/.codex/config.toml`)とモデルカタログを編集して Codex が
プロキシ経由になるようにします。すべての編集は冪等で元に戻せます。

OpenAI は bare モデル用の単一 `openai` 経路と `openai-apikey/<model>` API 経路を提供します。
`openai` は Pool(デフォルト、メイン + 追加アカウント)または Direct(現在の caller/メイン bearer)モードでモデル ID は
同じです。経路間のフォールバックはありません。出荷版 v1 config は marker 2 に移行し、手動復元用に
`config.json.pre-openai-tiers-v2.bak` を保存します。

## 設定の注入

`ocx init`、`ocx start`、`ocx sync` はすべてインジェクターを呼び出します。デフォルトのループバックバインドでは Codex の
組み込み `openai` プロバイダー ID を維持したまま、そのプロバイダーが opencodex を見るようにします。

```toml
# 最初のテーブルより前に来るルートキー
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex
openai_base_url = "http://127.0.0.1:10100/v1"

[features]
fast_mode = true
```

プロキシのデフォルトポートは `10100` です。`POST /v1/responses`、`POST /v1/responses/compact`、
`POST /v1/images/generations`、`POST /v1/images/edits`、`GET /v1/models`、`GET /healthz`、
`/api/*` 管理 API を提供します。

### 組み込み画像生成(`image_gen`)

Codex の組み込み `image_gen` ツールは `/v1/responses` を経由しません。codex-rs 拡張が
`{base_url}/images/generations`(参照画像があれば `/images/edits`)をチャットと同じ
ChatGPT bearer 認証で直接 POST します。注入された `base_url` が opencodex を指すため、
プロキシがこの呼び出しを OpenAI 上流に中継します。

- **モード対応 forward 候補 1 つ:** Pool は適格メイン/追加アカウントを選び、Direct は caller OAuth
  bearer を使います。設定されたモードは画像リクエストにも同じく適用されます。
- **OpenAI API キー:** forward 候補が認証失敗を所有しないときのみ使います。壊れた Pool 認証を
  別課金 API 使用で隠しません。
- **両方なし:** 曖昧な 404 の代わりに明確なエラーを返します。ルーティングされる他のプロバイダー(Cursor、
  Gemini、Kiro など)は画像生成を提供できません。ツール自体をオフにしたい場合は Codex で
  `codex features disable image_generation`(`config.toml` の `[features] image_generation = false`)を
  使ってください。

`hostname` がループバックアドレスでない場合、Codex が自動生成した API 認証ヘッダーを送る必要があります。このとき専用
プロバイダーを注入します。

```toml
# ルートキー
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

# ファイル末尾に追加されるブロック
# Auto-injected by opencodex
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }
# supports_websockets = true   # config.websockets が true のときのみ
```

OpenCodex がルーティングを管理する場合、両モードとも `$CODEX_HOME/opencodex.config.toml` を
参考用フォールバック設定として書き出します。ループバックモードでは自動注入が漏れたときに直接統合できる
ルートキーが、非ループバックモードでは専用プロバイダー設定が含まれます。外部プロバイダーモードでは
このプロファイルを変更しません。

:::caution
`openai_base_url`、`model_provider`、`model_catalog_json` のようなルートキーは最初の `[table]` ヘッダーより
**必ず**前にある必要があります。インジェクターはこの位置を保証し、自身が残した古い値や重複を整理します。
ユーザーが直接作ったルート `openai_base_url` は上書きしません。そのような値があればカタログだけ同期し
ルーティングは注入しなかったと通知します。
:::

## 共有モデルカタログ

Codex CLI、TUI、App、SDK はすべて同じ Codex home を読みます。opencodex はこのディレクトリを
`CODEX_HOME` で解決し、なければ `~/.codex` にフォールバックし次のファイルを管理します:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

WSL では `CODEX_HOME` がなく Linux 側 `~/.codex/config.toml` もないとき
`/mnt/c/Users/*/.codex/config.toml` の Windows Codex Desktop home を確認します。候補が
ちょうど一つならそのディレクトリを使い、WSL app-server モードと Windows Codex Desktop が同じ config と
auth ファイルを共有します。この検出を上書きするには `CODEX_HOME` を明示してください。

専用プロバイダーモードの `requires_openai_auth = true` は Codex App/TUI のアカウントゲート UI がネイティブ
Codex と同じ条件で動作するようにします。opencodex は `/v1/responses` WebSocket も提供します。専用
プロバイダーは `"websockets": true` のときのみ `supports_websockets = true` を宣言します。ループバックでは
Codex の組み込みプロバイダーが先に WebSocket を試みる可能性があり、機能がオフならプロキシが `426` を
返して HTTP/SSE にフォールバックさせます。

## スレッド識別子と会話履歴

デフォルトのループバック方式は新規スレッドのプロバイダーをネイティブ `openai` に維持するので、一般的な会話再開履歴を
再マッピングする必要はありません。初回同期時は昔の opencodex ビルドがタグを変えたスレッドも `openai` に
戻します。非ループバック専用プロバイダーモードは実行中のみ履歴を `opencodex` 側に合わせ、
終了時にバックアップされたメタデータを復元します。履歴を触りたくない場合は `syncResumeHistory: false` に設定してください。

## モデルカタログの同期

Codex はディスクのカタログ(デフォルト `$CODEX_HOME/opencodex-catalog.json`)にあるモデルを表示します。起動時と
`ocx sync` 時、opencodex は:

1. オリジナルカタログを `~/.opencodex/catalog-backup.json` に一度**バックアップ**します(フィーチャリングを元に戻せるように)。
2. 対応プロバイダーのライブモデルカタログを**取得**します(約 5 分間キャッシュ; 最後の正常一覧、
   設定された `models[]` 順でフォールバック)。`forward` 認証にはモデルエンドポイントがなく、Cursor は `/models` の代わりに
   `GetUsableModels` RPC を使います。
3. ルーティングされたモデルを名前空間項目(`provider/model`)として**マージ**します。Codex の厳密パーサーが受け入れるようネイティブ
   Codex カタログテンプレートから複製します。
4. `config.disabledModels` と各プロバイダーの空でない `selectedModels` 許可リストを**適用**します。
5. フィーチャー済みモデルが先に並ぶよう**再整列**した後(下記参照)、マージされたカタログを書き戻します。

ルーティングされたカタログ項目の GPT-5 アイデンティティ文言も実際の上流モデル名に合わせます。推論選択肢は
プロバイダーとモデルメタデータに応じて Codex の `low | medium | high | xhigh | max | ultra` 段階を使い、
上流がサポートしない値はリクエスト送信前にマッピングまたはサポート範囲に下げます。

## サブエージェントピッカー

Codex の `spawn_agent` は優先度でソートした後**ピッカーに表示される最初の 5 つのカタログモデル**を送出します。
`subagentModels` には最大 5 つまで入れられ、名前空間なしのネイティブ GPT スラッグと
`provider/model` 経路を混在できます。選んだ順に優先度 0–4 が付与されます。

```json
{
  "subagentModels": [
    "gpt-5.5",
    "gpt-5.6-sol",
    "anthropic/claude-opus-4-8",
    "xai/grok-4.5",
    "cursor/gpt-5.6-terra"
  ]
}
```

優先度ランク: フィーチャー済み (0–4) < その他ルーティング (5) < ネイティブ (9)。これは
[ウェブダッシュボード](/opencodex/ja/guides/web-dashboard/)でも管理できます。

## Codex アカウントのウォームアップ

ChatGPT アカウントを Codex アカウントプールに追加すると、保存前に小さなストリーミングリクエストを Codex Responses バックエンドに
送って認証情報を確認します。入力は文字列ではなく実際の Responses item 配列
(`input: [{ type: "message", ... }]`)で送り、`response.completed` が来るまで待ちます。デフォルトモデルは
`gpt-5.4-mini` で、このモデルが HTTP 400 を返すと `gpt-5.5` で再試行します。構造化された上流エラーは
表示しますが生の応答 body は公開しません。バックグラウンド再検証は別機能でデフォルトはオフです。
Token Guardian が有効で、`chatgpt` の更新ポリシーが `proactive` で、
`tokenGuardian.codexWarmupEnabled` が true のときのみ実行されます。

## ネイティブ Codex への復元

opencodex は決してあなたを閉じ込めません。**`ocx stop` はネイティブ Codex に完全に戻す単一コマンドです** —
プロキシを停止し、インストールされたバックグラウンドサービスを停止した後、注入されたすべての行とルーティングされたカタログ項目を削除し
opencodex が最初からなかったかのように通常の `codex` が正確に動作します:

```bash
ocx stop       # プロキシ + サービス停止、ネイティブ Codex を復元
ocx restore    # 停止せずに復元  (エイリアス: ocx eject)
ocx restore back # 実行中のプロキシに通常 Codex を再接続
```

opencodex が管理対象[バックグラウンドサービス](/opencodex/ja/reference/cli/#ocx-service)として実行されるときは
`OCX_SERVICE=1` を設定するため、サービス主導の再起動が Codex 設定を揺るがすことは**ありません** — 明示的な
`ocx stop` / `ocx service stop` のみがネイティブ Codex を復元します。
