---
title: Claude Code の使い方
description: Claude Code でルーティングされたすべてのモデルを使います。opencodex は同じポートで Anthropic Messages API とゲートウェイモデル検索を提供します。
---

opencodex は `/v1/responses` と共に `POST /v1/messages`(`count_tokens` も)を提供します。そのため Claude
Code から OAuth ログイン、アカウントプール、キーフェイルオーバー、サイドカーを含むすべてのルーティングプロバイダーを別途の
認証作業なしで使えます。

## クイックスタート

```bash
ocx claude
```

`ocx claude` はプロキシが実行中か確認した後、環境を接続して Claude Code を実行します。

| 変数 | 値 |
 --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>` |
| `ANTHROPIC_AUTH_TOKEN` | プロキシに API キーが必要なときのみ設定します。それ以外は設定せず、claude.ai ログイン(サブスクリプション + コネクター)を維持します |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` (デフォルトの `/model` ピッカーのモデル検索) |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 自動コンテキスト圧縮のしきい値(デフォルト `350000`)。自動コンテキストがオンのときのみ注入します |
| `ANTHROPIC_MODEL` | `claudeCode.model` (任意) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claudeCode.tierModels.haiku ?? claudeCode.smallFastModel` (任意、従来の `ANTHROPIC_SMALL_FAST_MODEL` もサポート) |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE}_MODEL` | `claudeCode.tierModels.*` (任意) |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | `alwaysEnableEffort` がオンなら `1` (条件付き) |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `DISABLE_COMPACT` | `maxContextTokens` が設定された場合の従来コンテキスト上書き値 (条件付き) |
直接 export した変数が常に優先します。追加引数はそのまま渡されます: `ocx claude -p "hello"`。

## システム環境統合(macOS)

`claudeCode.systemEnv` を `true` に設定すると(デフォルト: **オフ`)`ocx start` が `launchctl setenv` を
使い `ANTHROPIC_BASE_URL` と関連 Claude Code 環境変数をシステム全体に注入します。そのため新規
ターミナルのウィンドウとタブでは `ocx claude` ラッパーなしでも通常の `claude` コマンドがプロキシを経由します。すでに開いている
シェルには適用されないので開き直す必要があります。

`ocx stop` とプロキシ終了は**注入されたキーを解除します**。以前の値を復元せず、opencodex が
注入したキーのみ削除します。プロキシは `~/.opencodex/claude-env.sh` も書き出し、`ocx start` はこのファイルを
自動で読み込む `.zshrc` source hook をインストールします。

設定で `claudeCode.systemEnv: false` に指定するか GUI トグルでオフにできます。この機能は macOS
専用で、他のプラットフォームでは `ocx claude` を使ってください。

## ネイティブ Claude パススルー(サブスクリプション直接接続)

認証上書きがない場合、Claude Code は claude.ai OAuth ログインを維持したままプロキシに送られます。エイリアスや
モデルマップが占有していない実際の `claude*`/`anthropic*` モデルリクエストはユーザー認証情報と共に
`api.anthropic.com` に**そのまま**転送されます。ベータ、thinking シグネチャ、プロンプトキャッシュ、請求 ID はすべて
ネイティブ状態で維持され、同じセッションでピッカーエイリアスを使ってルーティングモデルも引き続き使えます。

**ヘッダー処理:** hop-by-hop ヘッダーと `host`、`content-length`、`accept-encoding`、
`x-opencodex-api-key`、`origin` は転送前に削除します。それ以外のヘッダー(`anthropic-beta`、
`anthropic-version` を含む)はそのまま転送します。

次の 4 つの条件を**すべて**満たすとパススルーが動作します。`nativePassthrough` が `false` でなく、
モデル名が `claude` または `anthropic` で始まり、bearer または `x-api-key` が `sk-ant-` で
始まり、エイリアス/モデルマップ解決結果が変更されていない同じモデルであること。そのため `ocx claude` を
使うとき "claude.ai connectors are disabled" 警告ももう表示されません。

`claudeCode.nativePassthrough: false` でオフにでき、`claudeCode.anthropicBaseUrl` で別のアドレスを
指定できます。

## /model ピッカー("From gateway")

Claude Code 2.1.129 以降は `GET /v1/models?limit=1000` でゲートウェイモデルを探し、デフォルトの `/model`
ピッカーの "From gateway" 項目に表示します。ピッカーは `claude` または `anthropic` で始まる ID のみ
受け付けるため、opencodex はルーティングモデルを安定で元に戻せるエイリアスとして公開します。

| 画面 | 形式 | 例 |
 --- | --- | --- |
| Claude Code CLI | `claude-ocx-<provider>--<model>` | `claude-ocx-native--gpt-5.6-sol` |
| Claude Desktop 3P | `claude-opus-4-8-<code>` (3 桁の base36 ハッシュ) | `claude-opus-4-8-ncb` |

プロキシはリクエストごとに系列を選びます。`?ids=cli` または `?ids=desktop` が優先し、指定しないと
`claude-code/*` user-agent には読みやすい CLI 形式を、他のクライアントには Desktop ハッシュを
提供します。両系列は継続してデコードできるため、どちらの形式でも `settings.json` に保存したモデルは
引き続き動作します。

**エイリアス構文ルール:** provider には `/` や `--` を含められず `native` と同じでもいけません。model には
`/` を含められません。読みやすい形式で表現できないルートはハッシュエイリアスに置き換えます。モデル
ID には `--` を含め**られます**(解析時は最初の `--` だけを基準に分割します)。`--` を含む
ネイティブスラッグはハッシュ形式に置き換えます。

**モデル解決順序:** `[1m]` 標識の削除 → 読みやすいエイリアスのデコード → Desktop ハッシュエイリアスのデコード →
`modelMap` の完全一致 → 日付を削除した値との一致(`-20250514` 削除) → パススルー順です。

各項目には `gemini-3-pro (gemini)` のような表示名と公式 `ModelInfo` 形式の完全なモデル能力
(推論負荷段階、thinking 型)が含まれます。実際の Anthropic モデルは両画面で正式 ID を維持します。

### コンテキスト変種 `[1m]` 標識

公式コンテキストウィンドウが 1M のモデルには `…[1m]` ピッカー行がもう一つできます。自動コンテキスト使用時は
コンテキストが 200k を超え、圧縮しきい値以上のモデルも該当します。この行を選ぶと Claude Code が
全体 1M コンテキストを計算します。プロキシはエイリアス解決とルーティング前に大文字小文字を区別せず `[1m]`
接尾辞を削除します。

## 自動コンテキスト(200k 制限なしで大型コンテキストモデルを使用)

Claude Code は未知モデルのコンテキストを 200k トークンとして計算します。デフォルトでオンの**自動
コンテキスト**がこの問題を解決します。

1. 実際のコンテキストウィンドウが 200k より大きく自動圧縮しきい値以上のモデルのピッカー行と環境スロットに
   `[1m]` 標識が付きます。
2. `CLAUDE_CODE_AUTO_COMPACT_WINDOW`(デフォルト `350000`、範囲 `100000`–`1000000`)を注入し、該当
   地点で会話を自動要約します。

設定状態は 3 つです。

- **なし / `true`:** 使用(デフォルト)
- **`false`:** 使用不可。標識も付かず圧縮ウィンドウも注入しません
- **従来の `maxContextTokens` 設定:** 自動コンテキストを自動でオフにします

Claude ページで圧縮値を調整できます。**警告:** モデルの実際のコンテキストウィンドウより大きく上げると
要約を開始する前にチャットエラーが発生します。

1M 未満のネイティブ Anthropic モデルには自動で標識を付けません。直接 export した値が常に優先し、プロキシは**ユーザーが指定した**値を基準にどのモデルに安全に標識を付けるか決定します。
直接編集した設定値が不正な場合は 350k に戻ります。

### 実モデル環境

`effectiveModelEnv` は `ocx claude` / システム環境 / シェルファイルが注入するスロット 6 つを計算します。
`ANTHROPIC_MODEL`、4 つの `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`、従来
`ANTHROPIC_SMALL_FAST_MODEL` です。実際の Haiku 値は `tierModels.haiku ?? smallFastModel` で、
両 Haiku 変数に入ります。

`tierModels.haiku` と `smallFastModel` の両方がない場合、OpenCodex は 2 つのヘルパーモデル変数を未設定のままにします。その後 Claude Code がネイティブのヘルパーモデル（現在は Sonnet）を選択し、ネイティブプロバイダーで料金が発生する可能性があります。

## ロスターエージェント(injectAgents)

`ocx claude` とシステム環境デーモンは推奨サブエージェントロスター(Subagents タブ、最大 5 モデル)と
`ocx-self` を `~/.claude/agents/ocx-*.md` に同期します。

- **`ocx-self`** は `/model` ピッカーのデフォルトを固定し、値がない場合は `claudeCode.model` を使います。
  両方ない場合は作成しません。モデル継承は使いません。
- 各エージェント本文には `<!-- ocx-route: <model> -->` ディレクティブが含まれます。プロキシはこのディレクティブで
  実際のルートを固定します。そのため Agent ツールの `model` 引数は機能せず、プレースホルダとして
  `"haiku"` を渡してください。
- frontmatter にはエイリアスが入り、ルーティングはディレクティブに従います。
- `generated-by: opencodex` が含まれる標識検証済み `ocx-*.md` ファイルのみ上書きまたは整理します。
  ユーザー作成のエージェントは触りません。
- ファイルごとに原子的に同期します(write + rename)。
- `enabled: false` または `injectAgents: false` を設定すると所有権確認済みの定義をすべて整理します。
- GUI PUT とロスター変更は即座に再同期し、launcher/system-env は実行時に同期します。

ディスパッチ例: `subagent_type: "ocx-gpt-5-6-sol"`。1M をサポートする対象には `[1m]` が自動で
付きます。

## バンドルスキルの省略(blockedSkills)

Claude Code のバンドル `claude-api` スキルは Anthropic ドキュメント約 840KB(約 136k トークン)を注入し、
Claude モデルに言及すると自動実行されます。ルーティングモデルはこのバンドルで学習されていないため、
opencodex はデフォルトで**ルーティングされた**リクエストのスキル内容を短いスタブに差し替えます。ネイティブ
Anthropic パススルーはそのまま維持します。

**2 つの配信形式を処理します。**

1. **ツール結果配信:** assistant の `Skill(...)` 呼び出しの小文字化した JSON 入力にブロック名が
   含まれる場合、対になる `tool_result` 本体をスタブに差し替えます。
2. **テキストブロック配信:** `Base directory for this skill: ` で始まる 10,000 文字以上のユーザー
   テキストブロックでディレクトリ basename がブロック名と一致するか確認します(大文字小文字区別なし)。

`claudeCode.blockedSkills` で設定できます(デフォルト `["claude-api"]`、`[]` で省略機能を完全に
オフ)。スタブはツール呼び出しと結果の対を維持します。

## モデルマップ(傍受)

`claudeCode.modelMap` はルーティング前の受信 Anthropic モデル ID を書き換えます。

```json
{
  "claudeCode": {
    "modelMap": {
      "claude-sonnet-4-5": "gemini/gemini-3-pro",
      "claude-haiku-4-5": "gemini/gemini-3-flash"
    }
  }
}
```

照合順序: 検索エイリアス → 完全一致 ID → 日付接尾辞を削除した ID(`-20250514`) → パススルー順です。

## サイドカーマトリクス: ウェブ検索と画像理解

ルーティングモデルごとに使えるホスト型ツールと画像サポート範囲が異なります。opencodex はメインモデルが
応答する前に不足機能を次の 2 つのサイドカーで補います。

- **ウェブ検索サイドカー**は実際のホスト型検索を実行した後、回答と出典をツール結果としてルーティングモデルに
  渡します。
- **ビジョンサイドカー**は `noVisionModels` に登録されたモデルを呼ぶ前に添付画像を説明し、
  元の画像をその説明に差し替えます。

両サイドカーとも次のいずれかのバックエンドを使えます。

| バックエンド | 実行方式 | 必要な条件 |
 --- | --- | --- |
| `openai` | ChatGPT `forward` プロバイダー経由で小さな GPT モデルを呼び出し | ChatGPT ログインと有効化された `authMode: "forward"` プロバイダー |
| `anthropic` | 保存された Anthropic OAuth で Claude を呼び出し。ウェブ検索は `web_search_20250305` を使い、ビジョンは Claude が画像を説明 | アクティブアカウントが `needsReauth` 状態でない `adapter: "anthropic"`、`authMode: "oauth"` プロバイダー |

`backend` を直接指定するとその値が常に優先します。省略すると使える Anthropic OAuth アカウントが
あるとき `anthropic`、ないとき `openai` を選びます。使える認証情報なしに
`anthropic` を明示すると**失敗後停止(fail closed)**します。ChatGPT 認証情報を借りたり別
バックエンドに黙って切り替えたりしません。OpenAI バックエンドも ChatGPT ログインと forward プロバイダーが両方
ないと起動しません。

Claude Code から入ってきたルーティングリクエストを内部で再実行する際はメイン ChatGPT ログインを添えます。
そのため Claude Code の bearer がプロキシ認証用の値でも OpenAI サイドカーに接続できます。この
ChatGPT bearer はメインルーティングプロバイダーには転送しません。

```json
{
  "webSearchSidecar": {
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxSearchesPerTurn": 3
  },
  "visionSidecar": {
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxDescriptionsPerTurn": 8
  }
}
```

`maxDescriptionsPerTurn` はメインモデルの 1 ターンあたりの新規画像説明数を制限します。キャッシュ
ヒットや同じターンでの重複説明要求は限度を消費しません。成功した `data:` 画像説明はバックエンド、
モデル、detail、画像バイト、リクエストコンテキストを基準にキャッシュし、同じ画像とコンテキストを毎回再説明
しません。内容が変わり得るリモート `https:` 画像はキャッシュしません。

全設定キーは[設定リファレンス](/ja/reference/configuration/#sidecars)で確認できます。
Anthropic OAuth のウェブ検索と画像説明は保存所ですでに使っている Claude Code OAuth
fingerprint 方式をそのまま踏襲しますが、長時間の無人作業に使う前に自身のアカウントと実際の作業で
十分 soak test するのが無難です。

<!-- TODO(WP5 GUI): GUI コントロールが完成したらサイドカー設定画面の案内を追加してください。 -->

## 推論負荷

Claude Code の `/effort` 設定はアダプターでも維持されます。

| 転送形式 | マッピング |
 --- | --- |
| `thinking.type: "adaptive"` + `output_config.effort` | Effort をそのまま渡します(`minimal`\|`low`\|`medium`\|`high`\|`xhigh`\|`max`\|`ultra`) |
| `thinking.type: "enabled"` + `budget_tokens` | ≤4096→`low`、≤16384→`medium`、それより大→`high` |
| `thinking.type: "disabled"` | 推論パラメータをすべて省略します |

解釈された値はリクエストログの **Reasoning effort** 列に表示されます。

## 入力変換(Messages → Responses)

プロキシはすべての Anthropic Messages API リクエストを Codex Responses API 形式に変換します。

| Messages 入力 | Responses 出力 |
 --- | --- |
| 最上位 `system` | `instructions`(テキストブロックを `\n\n` で連結) |
| `messages[].role: "system"` | `instructions` にもマージ |
| ユーザーテキスト / 画像 | `input_text` / `input_image`(base64 → data URL) |
| Assistant テキスト | `output_text` |
| Assistant `tool_use` | `function_call`(`input` → JSON 文字列に変換した `arguments`) |
| ユーザー `tool_result` | `function_call_output`(`is_error` → `[tool error]` 接頭辞) |
| `thinking` / `redacted_thinking` 再生 | 破棄 |
| Function ツール | `{type: "function"}`(`web_search*` → `{type: "web_search"}`) |
| `tool_choice` | `auto`→`auto`、`none`→`none`、`any`→`required`、名前指定→`{type:"function",name}` |
| `max_tokens` | `max_output_tokens` |
| `stop_sequences` | `stop` |

**エラー条件(400):** 不正な JSON、欠落または空の `model`、欠落または空の `messages`、未サポートの
role、`tool_use_id` のない `tool_result`、id/name のない `tool_use`、name のない名前指定 `tool_choice` です。

## 出力変換(Responses → Messages SSE)

| Responses イベント | Messages SSE |
 --- | --- |
| `response.created` | `message_start` + `ping` |
| Heartbeat | `ping` |
| テキスト delta | `content_block_start` → `content_block_delta`(text) → `content_block_stop` |
| 推論要約/テキスト | 合成シグネチャ付きの `thinking` ブロック |
| Function-call フレーム | `input_json_delta` を持つ `tool_use` ブロック |
| 終了イベント | `message_delta` → `message_stop` |
| 終了前に EOF | 502 形式 `api_error` |

**中断理由マッピング:** `completed` → `tool_use`(ツール呼び出しがあるとき)または `end_turn`、
`incomplete/max_output_tokens` → `max_tokens`、`incomplete/content_filter` → `refusal` です。

**エラー分類:** 400 `invalid_request_error`、401 `authentication_error`、
402 `billing_error`、403 `permission_error`、404 `not_found_error`、409 `conflict_error`、
413 `request_too_large`、429 `rate_limit_error`、504 `timeout_error`、529 `overloaded_error`、
それ以外の 5xx は `api_error` です。`Retry-After` はそのまま維持します。

## プロンプトキャッシュとトークン使用量

**Anthropic ルーティングリクエスト:** アダプターがツール、システム内容、最後から 2 番目のユーザーメッセージのキャッシュ
分岐点と最上位自動 `cache_control` を管理します。安定した会話では通常キャッシュヒット率が約
99.9% です。

**ネイティブ OpenAI/ChatGPT ルーティング:** セッションスコープ `prompt_cache_key`(`metadata.user_id` があれば
使用、なければシステム内容ハッシュ使用)とキャッシュ選好のための `session_id` ヘッダーを作ります。
キャッシュキーにはモデルと全体ツールスキーマが含まれます。

**トークン計算:** Anthropic 出力は `input_tokens` から `cached_tokens` と `cache_write_tokens` を引き、
それぞれ `cache_read_input_tokens` と `cache_creation_input_tokens` として公開します。リクエストログはこれを再び
包括的な `inputTokens` にマッピングし、読み取りは `cachedInputTokens` と `cacheReadInputTokens` の両方に、
書き込みは `cacheCreationInputTokens` に記録します。Usage ページはキャッシュヒットとキャッシュ作成を別々に表示します。

**count_tokens:** ルーティングモデルは直列化した system + messages + tools に基づく近似値を使います。
`sk-ant-` 認証情報を持つネイティブ Anthropic モデルはリクエストを実際の Anthropic
`/v1/messages/count_tokens` エンドポイントに転送します。

## デバッグキャプチャ

`ocx debug claude on|off|status|reset`、`OCX_CLAUDE_DEBUG=1` または
`PUT /api/debug {"claude": true}` で入力キャプチャを制御します。`GET /api/claude/inbound-debug` は
`{enabled, entries}` を返します(最新項目から、20 件の循環バッファ)。

各項目には `at`、`endpoint`、`model`、`resolvedModel`、`stream`、`maxTokens`、
`thinkingType`、`thinkingBudgetTokens`、`outputConfigEffort`、`metadataKeys`、
`hasMetadataUserId`、`hasSystem`、元の `anthropicBeta`、ユーザー ID / system の 8 桁 HMAC 同等性
タグが記録されます。**プロンプトテキスト、元のオブジェクト、実行間で持続するハッシュは保存しません。** Claude
デバッグをオフにすると循環バッファは即座に空になります。

## GUI(Claude ページ)

ダッシュボードサイドバーには API の下に専用 **Claude** ページと **Claude ON** トグルがあります。トグル
ラベルはすべての言語で意図的に同じです。ページには次の項目が表示されます。

- 入力遮断スイッチ(使用トグル)
- クイックスタート(`ocx claude`)と手動環境ブロック
- Fast Mode セレクター(Auto / ON / OFF)
- 自動コンテキストトグルと圧縮しきい値ドロップダウン
- サブエージェント自動登録トグル
- モデル傍受(modelMap)エディタ
- ピッカーエイリアスのリアルタイムプレビュー

`GET /api/claude-code` は実際のデフォルト、設定、コンテキストウィンドウレジストリ、実行環境、利用可能なルート
ID、エイリアス、ポートを返します。`PUT /api/claude-code` は部分更新で省略したフィールドを維持します。
`null` は context/blocklist/compact-window 値を初期化します。

## トラブルシューティング

**Claude Code に "Did 0 searches" と表示される** — 現在バージョンは完了した Responses
`web_search_call` を Anthropic の `server_tool_use` と `web_search_tool_result` ブロック対に変換し、
`usage.server_tool_use.web_search_requests` も同時に記録します。検索は行われたのに 0 回と表示される古い
バージョンを使っている場合は opencodex を更新してください。

**サイドカーが起動しない** — `backend: "openai"` の場合 ChatGPT ログインと有効化された
`authMode: "forward"` プロバイダーが両方あるか確認してください。`backend: "anthropic"` の場合保存された
Anthropic OAuth アクティブアカウントが `needsReauth` 状態でないか確認してください。使える認証情報なしに
Anthropic バックエンドを明示すると意図的に失敗後停止します。

**"claude.ai connectors are disabled"** — シェルに `ANTHROPIC_API_KEY` または
`ANTHROPIC_AUTH_TOKEN` が設定されています。`ocx claude` は意図的に `ANTHROPIC_API_KEY` を
設定しないため、直接 export していれば解除してください。`ocx claude` 使用時は
`ANTHROPIC_BASE_URL`、検索、自動コンテキスト、設定されたモデルスロットを注入しますが
`ANTHROPIC_API_KEY` は絶対に注入しません。

**/model ピッカーにモデルが表示されない** — `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` が
設定されているか確認してください(`ocx claude` では自動)。`ocx claude` を実行して
`~/.claude/cache/gateway-models.json` のゲートウェイモデルキャッシュを更新してください。
`claudeCode.enabled` が `false` でないかも確認してください。

**ポート変更後に古い環境が残る** — プロキシポートが変わった場合、既存シェルの
`ANTHROPIC_BASE_URL` が古い値の可能性があります。新規ターミナルを開くか `ocx claude` を再実行してください。

**大型モデルなのにコンテキストが 200k に制限される** — ピッカーで `[1m]` 変種を選ぶか、デフォルトでオンの
自動コンテキストを使ってください。ピッカーに `[1m]` 行がない場合はモデルの公式コンテキストウィンドウが
自動圧縮しきい値より小さい可能性があります。

**スキル呼び出し時のトークン数が多い** — バンドル `claude-api` スキル(約 136k トークン)は Claude モデルに
言及すると自動で読み込まれます。ネイティブパススルーでは正常で、ルーティングモデルでは opencodex が
デフォルトでスタブに差し替えます(`blockedSkills: ["claude-api"]`)。

**サブエージェントが誤ったモデルにディスパッチされる** — ロスターエージェント(`ocx-*`)は Agent ツールの `model`
引数ではなく `<!-- ocx-route: ... -->` ディレクティブを使います。ディレクティブが希望ルートと一致するか確認し、
モデルプレースホルダとして `"haiku"` を渡してください。
