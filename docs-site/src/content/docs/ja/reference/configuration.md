---
title: 設定リファレンス
description: ~/.opencodex/config.json のすべてのフィールド — 最上位オプション、プロバイダー、サイドカー。
---

opencodex は `~/.opencodex/config.json` から設定を読みます。`ocx init` とダッシュボードがこのファイルを
書きますが、直接編集しても構いません。プロキシは起動時に再読み込みします。途切れた、または正しい JSON でないなど
ファイルをパースできない場合は `config.json.invalid-<timestamp>` にバックアップし、コンソールに警告したのちデフォルト値で
起動します。ファイルがなくてもデフォルト設定（単一の `openai` forward プロバイダー）を使います。

## 予約された OpenAI プロバイダー

`openai` と `openai-apikey` は固定の予約 id です。`openai.codexAccountMode` はデフォルト `"pool"` で
メインと追加アカウントを選択し、`"direct"` は現在の Codex caller/メインログインだけを使います。API は
設定された API key/key pool だけを使います。bare モデルまたは `openai-apikey/<model>` で選択し、認証情報経路間の fallback はありません。
API GPT-5.6 メタデータは context 1,050,000 / max input 922,000 で、Pro virtual id は wire で base
モデルと `reasoning.mode: "pro"` に変換されます。

`openaiProviderTierVersion: 2` は現在の単一プロバイダー projection マーカーです。shipped v1 config を
移行する前に `config.json.pre-openai-tiers-v2.bak` を no-replace で作成し、既知のレガシー
namespaced selected id を bare id に変えます。

## 最上位（`OcxConfig`）

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | プロキシがリッスンするポート。 |
| `hostname?` | `string` | `"127.0.0.1"` | バインドアドレス。LAN に公開するには `"0.0.0.0"` に設定します（`OPENCODEX_API_AUTH_TOKEN` が必要、下記 [リモートアクセス](#リモートアクセス) 参照）。 |
| `proxy?` | `string` | — | 外向きの HTTP(S) プロキシ URL または `${ENV_VAR}` 参照。該当環境変数が空のとき `HTTP_PROXY` / `HTTPS_PROXY` に適用し、loopback は `NO_PROXY` に維持します。 |
| `providers` | `Record<string, OcxProviderConfig>` | — | プロバイダー名 → 設定 map。 |
| `openaiProviderTierVersion?` | `2` | 移行設定 | 単一の省略可能 OpenAI projection 完了マーカー。 |
| `defaultProvider` | `string` | `"openai"` | ルーティングでより良い match が見つからなかったときに使うプロバイダー。 |
| `subagentModels?` | `string[]` | `gpt-5.5`、GPT-5.6 3種、`gpt-5.4-mini` | Codex サブエージェントセレクターの先頭に表示するネイティブ slug または `provider/model` id。最大 5 つで、明示的な空配列もそのまま保存します。v2 ガイダンスのロスターは、Codex の picker-visible・v2 互換・priority 順の先頭 5 件との設定済みモデルの共通部分で、正規カタログ slug と利用可能な effort ラダーを使います。除外された項目も設定には残ります。 |
| `injectionModel?` | `string` | — | 注入される multi-agent 案内（v2 surface）に入るネイティブ/ルーティングモデル。委任案内でこのモデルを `fork_turns: "none"` とともに `spawn_agent` に渡します。 |
| `injectionEffort?` | `string` | — | 希望する `spawn_agent` reasoning effort（`low` から `ultra`）。`injectionModel` と一緒に使うときだけ意味を持ちます。 |
| `effortCap?` | `string` | — | reasoning effort にリクエストごとに適用する強制上限。マルチエージェント V2 専用機能で、自身のツールリストに V2 協調 surface を持つメインターンと、`x-openai-subagent: collab_spawn` ヘッダーまたは `x-codex-turn-metadata` の `"subagent_kind": "thread_spawn"` 標識が正確に一致する spawn された子ターンに適用されます（標識のついた子は自身のツール surface と無関係に適用対象です）。通常のメインターンと V1 surface メインターンは触れず、コンパクションターンは常に上限をバイパスし、`multiAgentMode: "v1"` は上限機能全体を無効化します（ダッシュボードもパネルを隠します）。`low` から `ultra` を許可し、値を上げずに下げるだけです。上限以下でモデルがサポートする最も高い段階に下げます。モデルが effort 制御を公開しない、または上限以下にサポート段階がない場合は effort フィールドを削除しプロバイダーのデフォルトを適用します。`max` と `ultra` も許可しますが、より低いランク上限を作りません（クライアントが `ultra` を `max` に変換するためリクエストは `low` から `max` で入ります）。ただし、既知のモデル effort ラダーに従い段階が下がるかフィールドが削除される可能性があります。ダッシュボードセレクターは `low` から `xhigh` まで提供します。`GET /api/effort-caps` と `PUT /api/effort-caps` で管理します。 |
| `subagentEffortCap?` | `string` | — | 同じ強制上限を codex-rs 標識が正確に一致する spawn された子ターンにだけ適用します: `x-openai-subagent: collab_spawn` または `x-codex-turn-metadata` の `"subagent_kind": "thread_spawn"`。それ以外の内部サブエージェントカテゴリ（レビュー、コンパクション、メモリ整理）はこの上限にかからず、`multiAgentMode: "v1"` は機能全体を無効化します。`low` から `ultra` を許可し両方の上限が設定されていればより低い値を適用し、値を上げずに下げるだけです。上限以下でモデルがサポートする最も高い段階に下げます。モデルが effort 制御を公開しない、または上限以下にサポート段階がない場合は effort フィールドを削除しプロバイダーのデフォルトを適用します。`max` と `ultra` も許可しますが、より低いランク上限を作りません（クライアントが `ultra` を `max` に変換するためリクエストは `low` から `max` で入ります）。ただし、既知のモデル effort ラダーに従い段階が下がるかフィールドが削除される可能性があります。ダッシュボードセレクターは `low` から `xhigh` まで提供します。`GET /api/effort-caps` と `PUT /api/effort-caps` で管理します。 |
| `injectionPrompt?` | `string` | — | 注入される v2 案内本文を丸ごと差し替えるカスタムテキスト。`{{model}}`、`{{effort}}`、`{{roster}}` placeholder が置換され、発火条件はそのままです。`PUT /api/injection-model` の `prompt` キーでも設定できます。 |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | OpenCodex が作成する multi-agent developer ガイダンスだけを制御します。未設定/`true` は v1/v2 ガイダンスを維持し、`false` は collaboration surface、`subagentModels`、routing、effort cap を変えずに両方を抑止します。`GET/PUT /api/injection-model` は有効値を返し、PUT は部分更新です。 |
| `disabledModels?` | `string[]` | — | Codex で隠すモデル。ルーティングされた `provider/model` id はカタログと `/v1/models` から除外します。`gpt-5.4` のような通常のネイティブ GPT slug はカタログ項目を `visibility: "hide"` に変え、通常の `/v1/models` 一覧から外します。ダッシュボードの Models ページでモデルごとに切り替えできます。 |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | 3 段階 multi-agent surface override。`"v1"` は上流 pin より優先してすべてのモデルを v1 に、`"default"` は上流 model pin（sol/terra=v2、luna=v1）に従い、`"v2"` はすべてを v2 に強制します。ダッシュボードの Models ページまたは `ocx v2 mode` で設定します。 |
| `providerContextCaps?` | `Record<string,number>` | `{}` | プロバイダー別の Codex 表示 context cap。既知の context window を下げるだけです。 |
| `contextCapValue?` | `number` | `350000` | ダッシュボード context-cap control で使う値。変えると `providerContextCaps` で有効化されたすべての項目を更新します。 |
| `stallTimeoutSec?` | `number` | `300` | 上流データが来ないとき bridge が中断し `response.incomplete` を送るまでの秒数。最小 1。 |
| `connectTimeoutMs?` | `number` | `200000` | DNS/TCP/TLS と最終レスポンスヘッダーだけを待つ試行ごとの deadline。レスポンス body 生成前に終了します。 |
| `shutdownTimeoutMs?` | `number` | `5000` | 進行中のターンを中断する前の graceful drain deadline。 |
| `websockets?` | `boolean` | `false` | `supports_websockets` を知らせ Codex が Responses WebSocket 経路を使うようにします。省略または `false` なら HTTP/SSE を維持します。 |
| `apiKeys?` | `OcxApiKey[]` | `[]` | 非 loopback バインドで管理 API とデータプレーン認証に追加で許可する生成型 `ocx_…` 認証情報。ダッシュボードが管理し、項目フィールドは下で説明します。 |
| `codexAutoStart?` | `boolean` | `true` | Codex shim が Codex 実行前に `ocx ensure` を実行するようにします。`false` なら `ocx ensure` は何もしません。 |
| `syncResumeHistory?` | `boolean` | `true` | 戻せる Codex App 履歴互換モード。opencodex は元の Codex thread metadata をバックアップし、旧 OpenAI interactive row を `opencodex` に再マッピングし、opencodex が作成した `exec` row を App に見えるソースとして一時的に昇格します。`ocx stop` / `ocx restore` はバックアップした OpenAI row を復元し、残った opencodex user thread を OpenAI に戻し、ネイティブ Codex が `config.toml` からプロキシを削除した後でも開き続けられるようにします。オフにするには `false` に設定します。 |
| `codexAccounts?` | `CodexAccount[]` | `[]` | Codex Auth ダッシュボードが管理する ChatGPT/Codex pool アカウント metadata。secret は `codex-accounts.json` に別途置きます。 |
| `activeCodexAccountId?` | `string` | — | 次の新しい Codex thread に使う pool アカウント。既存 thread affinity は元のアカウントを維持します。 |
| `autoSwitchThreshold?` | `number` | `80` | 新しいセッション自動切替用の使用量百分率 threshold。既知の 5 時間、週次、30 日 quota window のうち最も高いスコアを使います。`0` なら quota 自動切替をオフにします。 |
| `upstreamFailoverThreshold?` | `number` | `3` | 一時的な上流失敗が連続して起きたのち、以降の新しいセッションを別の適合 pool アカウントに failover する回数。`0` なら失敗ベースの failover をオフにします。 |
| `modelCacheTtlMs?` | `number` | `300000` | プロバイダー別 `/models` キャッシュの有効期間（5 分）。 |
| `cacheRetention?` | `"none" \| "short" \| "long"` | `"short"` | Anthropic prompt cache ポリシー。オフ、5 分 ephemeral、1 時間 extended のいずれか。 |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | on | ウェブ検索サイドカーオプション（下記参照）。 |
| `visionSidecar?` | `OcxVisionSidecarConfig` | on | ビジョンサイドカーオプション（下記参照）。 |
| `tokenGuardian?` | `OcxTokenGuardianConfig` | off | 選択型の proactive OAuth 更新と Codex アカウント warmup ポリシー。フィールドは下で説明します。 |
| `corsAllowOrigins?` | `string[]` | `[]` | CORS で追加で許可する正確な origin。loopback origin は常に許可します。 |

`maxConcurrentThreadsPerSession` は `config.json` キーではなく `PUT /api/v2` で使う camel-case
フィールドです。`ocx v2 threads <n>` は対応する `max_concurrent_threads_per_session` 値を Codex の
`$CODEX_HOME/config.toml` 内 `[features.multi_agent_v2]` に保存します。その table ができるように v2 を先にオンにしてください。

バックアップ対応より前の開発ビルドで既に `syncResumeHistory` を実行していた場合は
`ocx recover-history --legacy-openai` で同じ native-provider 復元を強制できます。

:::note[Codex アカウントプール]
pool アカウントの追加と quota 更新はダッシュボードの **Codex Auth** ページで処理してください。設定には secret で
ないアカウント metadata だけを保存し、access/refresh token は強化された Codex アカウント credential store に別途
保管します。既存 thread id はアカウント affinity を維持し、新しいセッションは quota、cooldown、health に
応じて自動ルーティングされる場合があります。
:::

### 管理型レコード形式

`apiKeys[]` 項目には `id: string`、`name: string`、生成された `key: string`、ISO 形式の
`createdAt: string` が入ります。`codexAccounts[]` 項目には必須の `id`、`email`、`isMain` と選択
`plan`、`chatgptAccountId`、個人情報のない `logLabel` 文字列が入ります。通常ダッシュボードで管理します。

### `tokenGuardian`（`OcxTokenGuardianConfig`）

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | proactive refresh 全体スイッチ。 |
| `tickSeconds?` | `number` | `21600` | sweep 間隔（6 時間、最小 60 秒）。 |
| `jitterSeconds?` | `number` | `300` | sweep 前に加えるランダム遅延。 |
| `concurrency?` | `number` | `3` | sweep 1 回で同時に更新する最大数。 |
| `leadSeconds?` | `number` | `900` | 1 tick に加える先行更新余裕時間。 |
| `failureBackoffBaseSeconds?` | `number` | `300` | 初回一時的失敗 backoff。 |
| `failureBackoffMaxSeconds?` | `number` | `3600` | backoff 上限と恒久失敗遅延。 |
| `codexWarmupEnabled?` | `boolean` | `false` | 合成 Codex pool アカウント検証 opt-in。 |
| `codexWarmupMaxAgeSeconds?` | `number` | `691200` | アカウントを再検証する最大期間（8 日）。 |
| `codexWarmupModel?` | `string` | `gpt-5.4-mini` | 選択型 warmup に使うネイティブモデル。 |

## リモートアクセス

opencodex はデフォルトで `127.0.0.1`（loopback 専用）にバインドします。`hostname` を `0.0.0.0` のような
非 loopback アドレスに設定すると管理 API（`/api/*`）とデータプレーン（`/v1/responses`）の **両方** に token
認証を強制します。

起動前に `OPENCODEX_API_AUTH_TOKEN` 環境変数を設定してください。

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

非 loopback バインドではこの変数がないとプロキシは起動しません。LAN アクセス用のバックグラウンド
サービスをインストールするときも同じ変数を先に export したのち `ocx service install` を実行し、launchd、
systemd、Task Scheduler に渡す必要があります。クライアントはすべてのリクエストの `x-opencodex-api-key` ヘッダーに
token を入れる必要があります。

```
x-opencodex-api-key: your-secret-token
```

`Authorization: Bearer …` ヘッダーも許可します。起動後はダッシュボードで生成した `apiKeys` を環境変数
token の代わりに使えます。すべての候補は timing side channel を防ぐため定数時間
（`timingSafeEqual`）で比較します。

:::caution[LAN 公開]
`0.0.0.0` にバインドするとプロキシと設定されたすべてのプロバイダー認証情報がローカルネットワークにさらされます。
信頼できるネットワークでのみ使い、強力な `OPENCODEX_API_AUTH_TOKEN` を必ず設定してください。
:::

## プロバイダー（`OcxProviderConfig`）

| Field | Type | Meaning |
| --- | --- | --- |
| `adapter` | `string` | `openai-chat`、`openai-responses`、`anthropic`、`google`、`kiro`、`cursor`、`azure-openai`（または別名 `azure`）のいずれか。 |
| `baseUrl` | `string` | 上流 API base URL。 |
| `responsesPath?` | `string` | `key` 認証の `openai-responses` リクエストに使う任意の相対 resource path。`/` で始め、URL scheme、query、fragment を含めてはいけません。省略時は従来の `/v1/responses` URL 構築を維持します。 |
| `disabled?` | `boolean` | 設定はディスクに残すがルーティングとモデル/カタログ一覧から除外します。 |
| `apiKey?` | `string` | API キーまたはリクエスト時に解釈する `${ENV_VAR}` / `$ENV_VAR` 参照。 |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` | 複数キーを納める pool。`apiKey` はアクティブ項目を反映します。各項目には `id`、`key`、選択 `label`、選択数値 `addedAt` があります。 |
| `defaultModel?` | `string` | 明示的なモデルなしでこのプロバイダーを選んだときに使うモデル。 |
| `models?` | `string[]` | seed/fallback モデル一覧。`liveModels` が `false` ならここにあるモデルだけが発見されます。 |
| `liveModels?` | `boolean` | 起動/同期時にプロバイダーのリアルタイム `/models` カタログを取得します（デフォルト `true`）。`false` なら設定された `models` だけを使います。 |
| `selectedModels?` | `string[]` | モデル発見後に適用するカタログ allowlist。空でなければその id だけを Codex に公開し、空または省略なら発見したモデルをすべて公開します。 |
| `contextWindow?` | `number` | ルーティングカタログ項目に表示するプロバイダー単位の context-window cap。リアルタイム metadata がより小さければそのままにします。 |
| `modelContextWindows?` | `Record<string,number>` | モデル別 context-window cap。一致するモデルでは `contextWindow` より優先し、より小さいリアルタイム metadata を上げません。 |
| `modelInputModalities?` | `Record<string,string[]>` | `["text"]`、`["text", "image"]` のようなモデル別カタログ input hint。 |
| `headers?` | `Record<string,string>` | 追加の上流ヘッダー。Authorization、cookie、API-key ヘッダー、改行を含む値、誤ったヘッダー名は拒否します。 |
| `authMode?` | `"key" \| "forward" \| "oauth"` | 認証方式（デフォルト `key`）。[プロバイダー](/opencodex/ja/guides/providers/#認証モード) 参照。 |
| `codexAccountMode?` | `"pool" \| "direct"` | canonical `openai` 専用。省略すると Pool で Direct は pool 状態を飛ばします。 |
| `refreshPolicy?` | `"proactive" \| "lazy-only" \| "disabled"` | この OAuth プロバイダーの Token Guardian ポリシー override。 |
| `reasoningEfforts?` | `string[]` | 公表・送信するプロバイダー単位の Codex reasoning ラベル（`low`、`medium`、`high`、`xhigh`、`max`、`ultra`）。 |
| `modelReasoningEfforts?` | `Record<string,string[]>` | モデル別 reasoning ラベル。空配列はそのモデルの effort control を隠します。 |
| `modelSupportsReasoningSummaries?` | `Record<string,boolean>` | モデル別 reasoning summary capability。`false` にすると summary 対応を広告せず、`openai-responses` リクエスト前に summary-delivery フィールドを除去します。 |
| `reasoningEffortMap?` | `Record<string,string>` | プロバイダー単位の reasoning ラベル wire alias。上流が別の値を要求するときだけ使います。 |
| `modelReasoningEffortMap?` | `Record<string,Record<string,string>>` | モデル別 reasoning ラベル wire alias。 |
| `noReasoningModels?` | `string[]` | reasoning/thinking パラメータを拒否するモデル。アダプターが `reasoning_effort` を削除します。 |
| `noTemperatureModels?` | `string[]` | 呼び出し元が指定した `temperature` を拒否するモデル。 |
| `noTopPModels?` | `string[]` | 呼び出し元が指定した `top_p` を拒否するモデル。 |
| `noPenaltyModels?` | `string[]` | presence/frequency penalty を拒否するモデル。 |
| `parallelToolCalls?` | `boolean` | 並列ツール呼び出しをオン/オフします。OpenAI Chat はデフォルト on で、chat 以外のアダプターは明示的な `true` でのみサポートを公表します。 |
| `autoToolChoiceOnlyModels?` | `string[]` | `tool_choice` で `auto` または `none` だけを受け付けるモデル。強制/指定選択は downgrade します。 |
| `preserveReasoningContentModels?` | `string[]` | 前の assistant `reasoning_content` を chat history に維持すべきモデル。 |
| `thinkingToggleModels?` | `string[]` | effort 段階の代わりに vendor `thinking.enabled` toggle を使う chat モデル。 |
| `thinkingBudgetModels?` | `string[]` | 整数 `thinking_budget` を使う chat モデル。effort を budget 比率にマッピングします。 |
| `noVisionModels?` | `string[]` | テキスト専用モデル。[ビジョンサイドカー](/opencodex/ja/guides/sidecars/) が画像を説明します。Ollama の `:size` タグも一致させます。 |
| `escapeBuiltinToolNames?` | `boolean` | Umans のような Anthropic 互換 gateway が wire でツール名 escaping を要求するときに使います。opencodex はツール呼び出しを Codex に戻す前に prefix を削除します。 |
| `googleMode?` | `"ai-studio" \| "vertex" \| "cloud-code-assist"` | Google 伝送/認証モード。デフォルト `ai-studio`。 |
| `project?` | `string` | Vertex project id または Antigravity Cloud Code Assist project id。 |
| `location?` | `string` | Vertex location。環境変数 fallback は `GOOGLE_CLOUD_LOCATION`。 |
| `mcpServers?` | `Record<string,CursorMcpServerConfig>` | **Cursor 専用。** stdio で起動する、または Streamable HTTP で接続する MCP server。フィールドは下で説明します。 |
| `desktopExecutor?` | `DesktopExecutorConfig` | **Cursor 専用。** 外部 computer-use/record-screen コマンド。フィールドは下で説明します。 |
| `unsafeAllowNativeLocalExec?` | `boolean` | **Cursor アダプター専用。** Cursor サーバーが指示したローカル `read` / `write` / `delete` / `ls` / `grep` / `shell` / `fetch` 実行を許可する opt-in escape hatch。デフォルト `false` なのでリモート Cursor メッセージが Codex の承認と sandbox を迂回できません。下記 [Cursor プロバイダー](#cursor-プロバイダー-adapter-cursor) 参照。 |

## Cursor プロバイダー（`adapter: "cursor"`）

Cursor bridge は実験的です。`ocx login cursor` を実行したのち
`~/.opencodex/config.json`（Windows: `%USERPROFILE%\.opencodex\config.json`）の `providers` 以下に
`cursor` 項目を追加または編集してください。

Cursor サーバーが指示するネイティブローカルツールはデフォルトで **オフ** です。Codex は自身のツール
（`apply_patch`、`exec_command` など）を既存の承認・ sandbox ポリシーに従って引き続き使います。Cursor が
Codex の承認経路なしにローカルファイルを読み、書き、消去、一覧、または grep/shell/fetch を実行してもよい
信頼されたローカル実験でのみ `unsafeAllowNativeLocalExec` を設定してください。

```json
{
  "providers": {
    "cursor": {
      "adapter": "cursor",
      "baseUrl": "https://api2.cursor.sh",
      "authMode": "oauth",
      "defaultModel": "auto",
      "unsafeAllowNativeLocalExec": true
    }
  }
}
```

このフラグは最上位 `config.json` ではなく **プロバイダーオブジェクト**（`providers.cursor`）に置きます。

[ウェブダッシュボード](/opencodex/ja/guides/web-dashboard/) でも設定できます。**Providers →
Cursor → Edit JSON** で `"unsafeAllowNativeLocalExec": true` を追加して保存し、プロキシを
再起動してください（`ocx restart` または `ocx stop` + `ocx start`）。

MCP、画面録画、computer-use は別の `mcpServers` / `desktopExecutor` 設定を使い、このフラグの影響を
受けません。

### Cursor 統合レコード

各 `mcpServers.<name>` 値は `command`（stdio）または `url`（Streamable HTTP）のいずれかを受け取ります。
stdio 項目には `args?: string[]`、`env?: Record<string,string>`、`cwd?: string` も置け、HTTP
項目には `headers?: Record<string,string>` を置けます。両形式とも
`enabled?: boolean`（デフォルト true）と `toolPrefix?: string` をサポートします。

`desktopExecutor` は `computerUseCommand?`、`recordScreenCommand?`、`cwd?`、
`env?: Record<string,string>`、`timeoutMs?`（デフォルト `30000`）を受け取ります。コマンドは `sh -c` で実行され、
stdin から JSON リクエストを 1 つ読み、stdout に JSON 結果を 1 つ書く必要があります。

:::caution[セキュリティ]
Codex の承認と sandbox ルールを迂回する Cursor ネイティブローカル実行が明確に必要な場合を除き、
`unsafeAllowNativeLocalExec` を省略するか `false` にしてください。
:::

## 静的モデル allowlist

一部のプロバイダーはリアルタイムモデルカタログが非常に大きいか遅いです。Codex に `models` で固定したモデルだけ
見せるには `liveModels` を `false` に設定してください。

`liveModels` が `false` で `models` が空または省略されると opencodex はそのプロバイダーのルーティング
モデルを 1 つも公開しません。

`selectedModels` は目的が異なります。モデル発見は引き続き実行しますが選択した id だけを Codex カタログと
`/v1/models` に公開します。ダッシュボードには全モデル一覧が残るため、後で allowlist を変えられ
ます。

プレビュー GPT-5.6 fallback 項目も同じ方式を使います。OpenAI API キー preset は base と Pro id を
context `1050000`、max input `922000` で seed し、OpenRouter preset は
`openai/gpt-5.6-sol`、`openai/gpt-5.6-terra`、`openai/gpt-5.6-luna` を context `1050000` で
seed します。Pool/Direct Codex catalog 契約は `372000` です。同期された Codex カタログでは `max`
reasoning を公表しますが `xhigh` と区別します。リアルタイムプロバイダー結果とこの明示項目をマージするには
`liveModels` をオンにし、`models` だけを公開するには `false` に設定してください。

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "liveModels": false,
      "models": ["deepseek/deepseek-v4-flash", "qwen/qwen3-coder-plus"]
    }
  }
}
```

## サイドカー

### `webSearchSidecar`（`OcxWebSearchSidecarConfig`）

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | 選択したバックエンドが使えるとき on | 全体スイッチ。ウェブ検索サイドカーをオフにするには `false` に設定します。 |
| `backend?` | `"openai" \| "anthropic"` | 自動 | 実行バックエンド。明示した値が優先し、省略すると使える Anthropic OAuth アカウントがあるとき `anthropic`、ないとき `openai` を選びます。 |
| `model?` | `string` | バックエンド別デフォルト | 検索モデル。`openai` は `gpt-5.6-luna`、`anthropic` は `claude-sonnet-5` を使います。明示的に残った旧 `gpt-5.4-mini` 値は起動時にマイグレーションします。 |
| `reasoning?` | `string` | `low` | サイドカー reasoning effort（`minimal` はウェブ検索と併用不可）。 |
| `maxSearchesPerTurn?` | `number` | `3` | メインモデル 1 ターンで実行する実際の検索の総数（loop guard）。 |
| `routedModelStallTimeoutMs?` | `number` | `200000` | 設定ファイルからだけ指定できる、ルーティングモデル反復ごとの raw レスポンス byte 連続無活動 deadline。`1` から `2147483647` までの整数でなければならず、空でないレスポンス body chunk が来るたびに再開します。 |
| `timeoutMs?` | `number` | `200000` | ホステッドウェブ検索リクエスト 1 つを制限する別の deadline。 |

`openai` バックエンドはアクティブな ChatGPT `forward` プロバイダーでホステッド検索を実行するため、ChatGPT
ログインと該当プロバイダーが両方必要です。Claude Code から来たルーティングリクエストは内部サイドカー呼び出しにメイン ChatGPT 認証を注入するため、この経路に接続できます。`anthropic` バックエンドは
アクティブな Anthropic OAuth プロバイダーの保存されたアクティブ認証情報で Claude の
`web_search_20250305` ツールを実行します。`backend: "anthropic"` を明示したのにアクティブアカウントが使えない、または `needsReauth` 状態なら、OpenAI に切り替えず失敗して止まります。

ウェブ検索経路には 4 つの clock があります。デフォルト bridge event stall 予算（`stallTimeoutSec`）、
DNS/TCP/TLS/最終 header 予算（`connectTimeoutMs`）、ルーティングモデルの raw byte 無活動
（`routedModelStallTimeoutMs`）、ホステッド検索 1 つの制限（`timeoutMs`）です。実際の bridge watchdog は
`max(デフォルト stall, connect timeout, ルーティングモデル stall, サイドカー timeout) + 30秒` です。ルーティングモデル
stall は無活動監視装置で全体生成 timeout ではありません。

### `visionSidecar`（`OcxVisionSidecarConfig`）

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | 選択したバックエンドが使えるとき on | 全体スイッチ。画像説明をオフにするには `false` に設定します。 |
| `backend?` | `"openai" \| "anthropic"` | 自動 | 実行バックエンド。ウェブ検索と同じ明示値優先、Anthropic 認証情報検出ルールを使います。 |
| `model?` | `string` | バックエンド別デフォルト | 画像説明モデル。`openai` は `gpt-5.4-mini`、`anthropic` は `claude-sonnet-5` を使います。 |
| `maxDescriptionsPerTurn?` | `number` | `8` | メインモデル 1 ターンで新規実行する説明（cache miss）の最大数。`0` なら説明呼び出しをせず、誤った値はデフォルトを使います。 |
| `timeoutMs?` | `number` | `45000` | サイドカー fetch timeout。 |

ビジョンサイドカーはプロバイダーの `noVisionModels` 一覧に該当するモデルに画像が来たときだけ
動作します。OpenAI バックエンドはウェブ検索と同様に ChatGPT ログインと forward プロバイダーが両方
必要です。Anthropic バックエンドは保存された OAuth を使い、使える認証情報がないのに明示すると
失敗して止まります。成功した `data:` 画像説明はバックエンド、モデル、detail、画像バイト、正規化した
メッセージ文脈をキーにしてサイズ制限付きプロセスキャッシュに保存します。キャッシュヒットと同じターンの重複
リクエストは `maxDescriptionsPerTurn` の枠を使いません。リモート `https:` 画像と失敗または空の説明は
キャッシュしません。

Anthropic OAuth 検出と画像説明リクエストは opencodex で既に使っている Claude Code OAuth
fingerprint 方式をそのまま踏襲します。保存所の既存 OAuth 先例の中にありますが、実際に使うアカウントと
作業量で十分に soak test するのがよいでしょう。

<!-- TODO(WP5 GUI): GUI コントロールが完成したらサイドカー設定画面の案内を追加してください。 -->

## 全体例

```json
{
  "port": 10100,
  "defaultProvider": "openai",
  "providers": {
    "openai": {
      "adapter": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "authMode": "forward"
    },
    "anthropic": {
      "adapter": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "authMode": "oauth",
      "defaultModel": "claude-sonnet-4-6"
    },
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "defaultModel": "glm-5.2",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  },
  "subagentModels": ["anthropic/claude-opus-4-8", "ollama-cloud/glm-5.2"],
  "disabledModels": [],
  "websockets": false,
  "webSearchSidecar": {
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 200000
  },
  "visionSidecar": { "enabled": true }
}
```

:::tip[シークレット]
キーには `${ENV_VAR}` 参照を使い `config.json` にシークレットが残らないようにしてください。OAuth と forward
プロバイダーはキーを保存しません。
:::

:::note[アトミック書き込み]
すべての設定・カタログファイル（`config.toml`、`opencodex-catalog.json`）は `atomicWriteFile`（一時ファイル +
名前変更）でアトミックに書き込みます。`ocx stop` とプロキシ自身の終了 handler のように複数 writer が
同時に Codex を復元しても、ファイルが半分だけ書かれるのを防ぎます。
:::
