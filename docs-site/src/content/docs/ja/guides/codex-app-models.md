---
title: Codex App モデルピッカー
description: 共有 Codex カタログ経由で opencodex モデルが Codex App、Codex CLI、Codex TUI に表示される方式。
---

opencodex は Codex App にパッチを当てません。Codex CLI/TUI が既に使う設定とモデルカタログを
同じ位置に書き込みます。Codex App もこの状態を共有するため、ルーティングモデルが通常の Codex カタログ
項目のように App のモデルピッカーに現れます。

OpenAI ID は 2 種類に固定されます。bare native ID は `codexAccountMode` で Pool(デフォルト)/Direct を
選ぶ単一 `openai` グループで、`openai-apikey/<model>` は API キーです。モードを変えてもモデル
ID は変わりません。API GPT-5.6 は context 1,050,000 / max input 922,000 で、
`*-pro` ピッカー ID は公開状態を維持しつつ wire でベースモデル + `reasoning.mode: "pro"` になります。

## 統合経路

`ocx init`、`ocx start`、`ocx sync` は解決された `CODEX_HOME` の下のファイルを合わせます。

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

デフォルトのループバックバインドでは Codex の組み込み `openai` プロバイダー ID をそのまま残します。代わりに次のルート
キーでプロバイダーとモデルカタログを opencodex につなぎます。

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
openai_base_url = "http://127.0.0.1:10100/v1"
```

ループバック以外の hostname を使うと Codex が生成された API 認証ヘッダーも送る必要があります。このときルートの
`model_provider = "opencodex"` と Responses 互換専用プロバイダーを使います。

```toml
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }
```

`websockets` はデフォルトでオフです。専用プロバイダーとカタログ項目は
`"websockets": true` のときのみ `supports_websockets = true` を宣言します。ループバックでは Codex の
組み込みプロバイダーが先に WebSocket を試みる可能性があり、機能オフのプロキシは `426` を返して
HTTP/SSE にフォールバックさせます。注入と復元の全体流は
[Codex 連携](/opencodex/ja/guides/codex-integration/)を参照してください。

## ルーティングモデルが表示される理由

Codex モデルピッカーは Codex 形式のカタログ項目を要求します。opencodex はネイティブ Codex モデル
テンプレートを複製した後、ルーティングモデルの識別情報を差し替えます。

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

複製には推論段階、shell 型、API サポートフラグ、base instructions のように厳密パーサーが
要求するフィールドが残ります。その後 OpenAI service tier メタデータのように該当ルートが処理できない
ネイティブ専用機能は削除します。

## v2.7.1 モデル範囲

ネイティブフォールバックリストには `gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、
`gpt-5.3-codex-spark`、GPT-5.6 Sol/Terra/Luna が含まれます。GPT-5.5/5.4 系はインストール済み
Codex カタログのより豊富なライブ項目を保ち、欠けている項目のみ合成します。バンドル上流
スナップショットは GPT-5.6 にのみ使います。古いテンプレートで近似するのではなく、モデル別の実際の識別情報と
メタデータを適用するためです。

| ルート | ピッカー ID とカタログメタデータ |
 --- | --- |
| Codex ログイン(Pool または Direct) | `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`(372,000 トークン) |
| OpenAI(API キー) | `openai-apikey/gpt-5.6-*` と `openai-apikey/gpt-5.6-*-pro`(1,050,000; max input 922,000) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`、`openrouter/openai/gpt-5.6-terra`、`openrouter/openai/gpt-5.6-luna`(1,050,000) |
| Cursor | 静的フォールバックに `cursor/gpt-5.6-sol`、`cursor/gpt-5.6-terra`、`cursor/gpt-5.6-luna`(1,000,000)と `cursor/grok-4.5`、`cursor/grok-4.5-fast`(500,000)が含まれます。実際の表示一覧はアカウント別ライブ探索結果で絞ります。 |
| xAI | ライブ探索結果が優先です。フォールバックカタログのデフォルトはコンテキスト 500,000 と `low` / `medium` / `high` 推論を持つ `xai/grok-4.5` です。 |

固定 GPT-5.6 項目は上流推論段階をそのまま保存します。Sol と Terra は `low` から
`ultra` まで、Luna は `max` まで公開します。デフォルトは Sol が `low`、Terra と Luna が `medium` です。
`ultra` は最大推論と能動的委任をまとめたクライアント選択肢でバックエンドには `max` として
渡されます。モデルがピッカーに見えても接続されたアカウントや API キーに実際の利用権が必要です。

## ネイティブとルーティングモデルの切り替え

ダッシュボード Models ページは両モデル系統とも `disabledModels` で管理します。

- ルーティング ID は `provider/model` 形式です。オフにすると同期カタログと `/v1/models` から除外されます。
- ネイティブ GPT ID は `/` のないスラッグです。オフにしても項目は残し `visibility` だけ `hide` に
  切り替えます。後でオンにしたとき元の項目をそのまま復元するためです。無効状態では OpenAI
  一覧形式からも外れます。
- ネイティブ行は対応する静的一覧から取るため、モデルをオフにした後もダッシュボードから再びオンにできます。

表示可否の処理はスナップショットアップグレードより後に実行されます。管理 API はトグル後にカタログを書き直し Codex モデルキャッシュを強制的に古い状態にします。

## マルチエージェントサーフェスモード

opencodex は全カタログ項目の `multi_agent_version` を制御する 3 段階 override を提供します。

| モード | 動作 |
 --- | --- |
| **v1** | 上流 pin より優先し全モデルを v1 マルチエージェントサーフェスに強制します(Sol/Terra 含む)。 |
| **base**(インストール時デフォルト) | 上流 pin を復元します。Sol/Terra は v2、Luna は v1 を使い、pin のないモデルは Codex `multi_agent_v2` フィーチャーフラグに従います。 |
| **v2** | 上流 pin より優先し全モデルを v2 マルチエージェントサーフェスに強制します(Luna 含む)。 |

ダッシュボードや Models ページ、`ocx v2 mode v1|default|v2`、または
`PUT /api/v2` と `{ "multiAgentMode": "v1" }` で設定できます。変更は新しい Codex
セッションから適用されます。

:::caution
v2(`multi_agent_v2`)サーフェスで生成されたサブエージェントは親セッションのモデルを継承します。ダッシュボードの
委任モデル/強度セレクターは v1 プロンプトガイダンスであり、プロキシがスポーンごとに別モデルにルーティングする機能では
ありません。正確な動作は[サブエージェントサーフェス](/opencodex/ja/guides/sub-agent-surface/)を
参照してください。
:::

## 最上位推論段階

カタログにどの推論段階を表示するかは v1/base/v2 サーフェスモードと無関係です。生成される
推論サポート項目にはサブエージェントが直接指定した強度を検証できるよう `max` が含まれます。
現在生成されるルーティング項目と以前の世代のネイティブ GPT 項目には `ultra` も含まれます。ただし GPT-5.6 の
正確な上流段階はそのまま維持するため Luna は `max` で終わります。

実際のリクエストではルーティングアダプターがサポートしない段階をマッピングまたは制限します。実際の最上位段階が
`xhigh` の以前のネイティブモデルは `nativeEffortClamp` が直接指定された `max` または `ultra` 選択を
`xhigh` に切り替えます(例: GPT-5.5)。Sol、Terra、Luna には実際の `max` 段階があります。

## Fast tier ルール

Codex 設定ファイルは fast モードを次のように保存します。

```toml
service_tier = "fast"

[features]
fast_mode = true
```

一方モデルカタログとランタイムリクエストの tier ID は `priority` です。opencodex はこの差を維持します。
ネイティブ OpenAI パススルーモデルは fast サポートを保存し、ルーティングされた非 OpenAI モデルでは service-tier
メタデータを消して処理できない fast オプションが表示されないようにします。

## サブエージェントの選択

Codex はピッカーに表示されるカタログ項目を `priority` 昇順でソートした後、最初の 5 つを
`spawn_agent` モデルオーバーライドとして公開します。`subagentModels` やダッシュボード Subagents ページで
ネイティブ ID または `provider/model` ID を最大 5 つ選ぶと opencodex が選択順に priority 0-4 を
付与します。残りのモデルも正確な ID で直接呼び出し可能です。

フィーチャー済みモデル一覧はダッシュボードの **Sub-agent delegation** ガイダンスとは別物です。特にフィーチャー済みモデル
オーバーライドで v2 の親モデル継承ルールをバイパスできません。

## モデル状態のリフレッシュ

ピッカーに古い項目が残っている場合はカタログを書き直し対象 Codex 画面を再度開いてください。

```bash
ocx sync
```

opencodex はカタログの表示可否、priority、メタデータが変わるたびに `models_cache.json` を意図的に
古いキャッシュラッパーで書き直します。次回の Codex モデルリフレッシュが新しいカタログを読むようにするためです。
