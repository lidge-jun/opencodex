---
title: CLI エージェント、ルーティング、および統合
description: マルチエージェント、コンボ、可観測性、アクセス、統合、システム、および構成コマンド。
---

これらのコマンドは、エージェントのポリシーとルーティングを制御し、稼働中のプロキシを検査し、サポートされているクライアントを opencodex に接続します。

## エージェントポリシー

### `ocx agent <status|injection|effort|subagents|fallback|sidecar> ...`

ヘッドレス マルチエージェントロスター、エフォート キャップ、プロンプト インジェクション、フォールバック、サイドカー設定を管理します。現在のポリシーには `status` を使用します。サーフェス モード、委任、エフォート、およびフォールバック動作がどのように組み合わされるかについては、[サブエージェントサーフェス](/guides/sub-agent-surface/) を参照してください。

```bash
ocx agent subagents set ark/model-a,openai/gpt-5.5
```

### `ocx v2 <status|on|off|mode <v1|default|v2>|threads <n>>`

Codex `multi_agent_v2` 機能フラグとスリーステート マルチエージェント サーフェス モードを管理します。

|サブコマンド |アクション |
| --- | --- |
| `status` (デフォルト) |現在の v2 フラグ、マルチエージェント モード、およびスレッドの同時実行性をレポートします。 |
| `on` | `multi_agent_v2` 機能を有効にし、カタログを再同期します。 |
| `off` | `multi_agent_v2` 機能を無効にし、カタログを再同期します。 |
| `mode v1` |すべてのモデルを強制的に v1 にし、ネイティブ v2 を無効にして、アクティブなスレッド制限を保持します。 |
| `mode default` |上流のモデル サーフェス ピンを尊重します。 |
| `mode v2` |すべてのモデルを強制的に v2 にし、ネイティブ v2 を有効にして、アクティブなスレッド制限を維持します。 |
| `threads <n>` |アクティブな v1/v2 スレッド制限を少なくとも 1 の整数に設定します。

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
```

`mode` サブコマンドは、`multiAgentMode` を opencodex 設定に書き込み、Codex カタログを再同期します。モードとフラグの遷移により、現在の数値スレッド制限が有効な v1/v2 Codex キー間で移動します。移行が失敗すると、元の `config.toml` が復元されます。変更は新しい Codex セッションに適用されますが、実行中のセッションでは固定されたサーフェスが維持されます。

## コンボルーティング

### `ocx combo <list|show|set|remove> ...`・`ocx route combo ...`

コンボフェイルオーバーとラウンドロビン仮想モデルを管理します。 `ocx route combo` は階層別名です。 combo は現在サポートされているルーティング リソースです。ターゲットは`provider/model[:weight],provider/model[:weight]`を使用します。

```bash
ocx combo list
ocx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
```

ルーティングの動作と設定ガイダンスについては、「[コンボ](/guides/combos/)」を参照してください。

## 可観測性とデバッグ

### `ocx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...`

プロキシ リクエスト、使用状況、ストレージ、メモリ、およびデバッグ データを検査します。直接のエイリアスは次のとおりです。

|別名 |同等のリソース |
| --- | --- |
| `ocx logs [filters] [--follow] [--json|--jsonl]` | `ocx observe logs` |
| `ocx usage [--range <7d|30d|all>] [--surface <all|codex|claude|grok>] [--json]` | `ocx observe usage` |
| `ocx storage [--json]` | `ocx observe storage` |
| `ocx memory [--json]` | `ocx observe memory` |

```bash
ocx observe usage --range 30d --json
```

### `ocx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>`

実行中のプロキシの管理 API を通じて、ランタイム デバッグ オーバーライドを読み取りまたは変更します。

```bash
ocx debug provider on|off|status|reset
ocx debug provider logs [-f|--follow]
ocx debug usage on|off|status|reset
ocx debug usage logs [-f|--follow]
```

スコープがない場合、`ocx debug` は使用状況を出力し、プロキシが停止すると、次回起動環境がデフォルトになります。プロバイダーのデバッグのデフォルトは `OCX_DEBUG=1` です (従来の `OCX_DEBUG_FRAMES=1` も機能します)。使用法デバッグのデフォルトは `OPENCODEX_USAGE_DEBUG=1` からです。

## APIアクセス

### `ocx access <key|endpoints|models|test> ...`

OpenCodex アドミッション API キーを管理し、外部エンドポイントとモデルを検査します。 `ocx api-key <list|create|remove> ...` は `ocx access key` の別名です。

```bash
ocx access key create deployment
```

## クライアントの統合

### `ocx integration <claude|grok> ...`

サポートされている Claude と Grok の統合を管理します。以下の直接コマンド ファミリは、クライアント固有のコントロールを公開します。

### `ocx claude [claude args...]`

プロキシが実行されていることを確認し、`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`、および `config.claudeCode` のモデル スロットを使用してクロード コードを起動します。ルーティングされたモデルは、Claude Code 2.1.129 以降の安定したスロット エイリアスを介してネイティブ `/model` ピッカーに表示されます。古いバージョンでは、`ANTHROPIC_MODEL` または `/model <id>` で選択します。ユーザーがエクスポートした `ANTHROPIC_*` 変数が常に優先されます。

Claude デスクトップ プロファイル コマンドは次のとおりです。

```text
ocx claude desktop [apply]                         Save and apply the four-family profile
ocx claude desktop show [--json]                   Show routes, families, and defaults
ocx claude desktop move <route> <family> [--default]
ocx claude desktop default <family> <route|none>
ocx claude desktop export <path|->                 Export versioned JSON (`-` = stdout)
ocx claude desktop import <path> [--apply]         Validate and import JSON
```

ファミリは `opus`、`fable`、`sonnet`、および `haiku` です。新しいルートは `opus` で始まります。 `none` は、そのファミリーが空の場合にのみ有効です。従来の適用フラグ `--static`、`--hybrid`、および `--discovery-only` は引き続きサポートされます。クロードコードの設定には`ocx claude config <status|set> ...`を使用してください。

### `ocx opencode [opencode args...]`

プロキシが実行されていることを確認し、OpenCode のインライン ランタイム層 (`OPENCODE_CONFIG_CONTENT`) で生成された `provider.opencodex` ブロックを使用してオープンコードを起動します。既存のインライン設定は保持され、今回の起動では `provider.opencodex` のみが置き換えられます。グローバルまたはプロジェクトの `opencode.json` ファイルは、既存の上書きについて警告するために読み取られることがありますが、ディスク上のファイルは変更されません。ルーティングされたモデルは `opencodex/<provider>/<model>` として表示されます。後でプレーン `opencode` を起動すると、以前とまったく同じように動作します。

### `ocx grok <status|exclude|include|set|clear|apply> ...`

Grok Build モデル フェンスを管理および適用します。

## クライアント設定のエクスポート

### `ocx export --client <opencode|pi>`

実行中のプロキシに接続されているクライアント設定を出力します。 opencode と [円周率](/guides/pi/) は環境変数ではなく独自の JSON 設定からプロバイダーを読み取るため、このコマンドは `opencodex` プロバイダー ブロック (ベース URL、モデル リスト、クライアントの環境参照) をシリアル化し、そのファイルにマージできるようにします。

プロキシが実行されている必要があります。このコマンドはライブ ポートを解決し、`/api/models` を読み取り、Codex が現在認識できるモデルのみを出力します。

|旗 |アクション |
| --- | --- |
| `--client <opencode\|pi>` |必須。クライアント言語を選択します: opencode のキー付き `provider` オブジェクトまたは Pi の `providers` 配列。 |
| `--json` |構成 JSON のみを標準出力に出力するため、リダイレクトはバイト正確な出力をキャプチャします。 `--out` 書き込みメモを含むすべての診断は stderr に送られます。 |
| `--out <path>` |設定を `<path>` に書き込みます。既存のファイルの置き換えを拒否します。 |
| `--force` | `--out` が既存のファイルを置き換えることを許可します。 |

```bash
ocx export --client opencode                     # config plus destination, merge warning, and counts
ocx export --client pi --json > pi-models.json   # byte-exact JSON for a pipe or a diff
ocx export --client opencode --out ~/opencodex-opencode.json
```

`--json` がない場合、JSON が先頭に続き、正規の宛先パス、マージ警告、環境エクスポート行、およびコンテキスト制限を省略する行数を含むモデル数が続きます (クライアントはこれらに対して独自のデフォルトを適用します)。

|クライアント |正規の宛先 |ダウンロードファイル名 |環境変数 |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json` (設定すると `XDG_CONFIG_HOME` が勝ち) | `opencode.json` | `OPENCODEX_OPENCODE_API_KEY` |
| `pi` | `~/.pi/agent/models.json` | `pi-models.json` | `OPENCODEX_API_KEY` |

2 つの環境変数名は異なり、各クライアントは独自の名前のみを補間します。 opencode は `{env:OPENCODEX_OPENCODE_API_KEY}` を読み取ります。 Pi は `$OPENCODEX_API_KEY` を読み取ります。

:::caution[マージし、決して置き換えないでください]
`ocx export` は実際のクライアント設定を書き込むことはありません。宛先は手動でマージできるように出力されます。`--out` は、`--force` なしで既存のファイルを上書きすることを拒否します。これは、設定を置き換えると、その中にすでに含まれている他のプロバイダー、エージェント、および MCP エントリが破壊されるためです。
:::

キーはシリアル化されません。設定にはクライアントの環境参照のみが含まれるため、シークレットは環境内に残ります。ループバック プロキシ (`127.0.0.1`、デフォルト) にはアドミッション キーはまったく必要ありません。参照は単に使用されないだけです。プロキシがループバックを超えてバインドする場合にのみ変数を設定します。アドミッションキーの発行方法については、[リモートアクセス](/reference/configuration/#remote-access) を参照してください。上流プロバイダー自体のキーは完全に別のものであり、[プロバイダー](/guides/providers/) ごとに構成されます。

同じペイロードが `GET /api/client-config` によって提供され、ダッシュボードの [API] タブにレンダリングされるため、CLI、API、および GUI は同じバイトを使用します。

## ランタイムと構成

### `ocx system <status|settings|startup|diagnostics|sync|update> ...`

ヘッドレス ランタイムの設定、起動、同期、診断、更新を管理します。

```bash
ocx system settings --stream-mode eager-relay
```

### `ocx config <show|get|set|unset|validate|export|import> ...`

検証された OpenCodex 設定を検査し、安全に変更します。 `show` および `get` はシークレットをマスクします。インポートは書き込む前に検証され、`--yes` が必要です。
