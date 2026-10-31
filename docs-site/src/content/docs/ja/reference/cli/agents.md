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
ocx agent sidecar web --enabled off
```

`--enabled off` はダッシュボードの **オフ (Off)** 行と同じスイッチです。OpenCodex はサイドカーを
実行しなくなり、Codex 統合は `~/.codex/config.toml` に
`web_search = "disabled"` を書き込むため、MCP 検索サーバーだけを検索経路にできます。
`--enabled on` はその行を再び削除します。保存でスイッチが実際に切り替わったとき、コマンドは
Codex 側の書き込み（`--json` では `codexWebSearch`、それ以外では末尾の
`Codex config:` 行）を報告し、書き込みできなかった場合は `ocx sync` を案内します。
このフラグは `vision` でも機能します。

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
| `ocx usage [--range <today|1d|7d|30d|all>] [--surface <all|codex|claude|grok>] [--provider <name>] [--model <id>] [--json]` | `ocx observe usage` |
| `ocx storage [--json]` | `ocx observe storage` |
| `ocx memory [--json]` | `ocx observe memory` |

```bash
ocx observe usage --range 30d --json
```

一部の使用履歴を集計できない場合、人向けの出力は読み取れる行がない場合も警告を表示します。表示される合計値は読み取れる記録のみを反映します。フィルターに一致する読み取れる記録がない場合は、合計欄の代わりに警告と案内を表示します。除外した記録には一致するものが含まれる可能性があります。`--json` は応答の `usageIncomplete` 診断と理由をそのまま保持します。

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

OpenCodex へのアクセス用 API キーの一覧、外部エンドポイント、モデルを確認します。`ocx api-key` は `ocx access key` コマンド群の別名です。

キーの作成とローテーションの開始では、通常のテキスト出力でも JSON 出力でも、一度だけ表示される平文の認証情報が返されます。エージェントはこれらの手順を実行せず、エージェントセッション外で人が直接操作するターミナルに委ねてください。キーそのものをチャットで求めず、設定と接続の確認結果、および秘密情報ではないキー ID とローテーション ID だけを受け取ってください。

```bash
ocx access key list --json
```

新しいキーの設定と接続の確認は、古いキーの失効承認ではありません。ローテーションの確定や古いキーの削除には、そのキーを失効させるための明示的な承認が別途必要です。承認された操作の後は一覧を再確認してください。API の直接呼び出しでこの手順を回避しないでください。

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

### `ocx codex [codex args...]`

キーは設定とその名前空間が他の主体による変更から保護されている場合にのみ渡します。現在の利用者と特権 OS 主体を信頼します。同じ利用者のプロセスは信頼対象です。その利用者の書き込み権限を持つ主体は、既にその利用者の OpenCodex キーファイルも読めます。検証からネイティブ起動までの同一利用者による設定置換はこの脅威モデルの対象外で、引き渡し時に設定を固定しません。

通常の Windows の既定 ProgramData 権限では他の利用者がディレクトリを作成できます。そのため `ProgramData\OpenAI\Codex` がなくても自動認証情報を保留します。ProgramData 配下のシステム Codex 設定フォルダーは存在し、Administrators/SYSTEM だけが書き込める必要があり、他の利用者による祖先ディレクトリの置換も防ぐ必要があります。管理者にディレクトリポリシーの確認を依頼してください。opencodex 自身は ACL を変更せず、準備用のコマンドも提供しません。

代わりに利用者が自分でキーを指定できます。例えば `OPENCODEX_API_AUTH_TOKEN` を環境変数としてエクスポートすると、`ocx codex` はその値を変更しません。既存のシステム設定ファイルがあれば引き続き自動認証情報を保留し、別途確認が必要です。各保留理由はキー値、キーファイルの内容やパスを含まない短い具体的な stderr 診断一行で示されます。

単語一つのプロンプトの前に `--` を置き、未知の Codex サブコマンド選択を防いでください。

設定ファイルがなくても、machine 設定パスに他の利用者が作成できない必要があります。Windows ProgramData/OpenAI/Codex の保護を確認できなければ注入を保留し、ディレクトリを作成しません。macOS は拒否のみの ACL と読み取り専用の許可を受け入れます。書き込み・追記・削除・属性・セキュリティ・所有者の変更を許可するエントリは、先行する拒否があっても拒否します。不明なタグや検査エラーも拒否します。

新しいサービストークンを読み込むのは、argv が下記の許可リスト内で、空でない HTTP(S)/ALL proxy や `CODEX_*`/`OPENAI_*`/`AZURE_OPENAI_*` 環境変数の上書きがなく（正規の `CODEX_HOME` は許可）、ホーム・設定・システムの名前空間が所有権検査を通過した場合だけです。設定は監査済みキーと正確な管理 loopback provider のみで、追加の資格情報利用先や設定層がない必要があります。`-c`/`--config`、`-p`/`--profile`、未知のフラグ、`resume`/`fork` など許可外の引数ではトークンを保留し、値を含まない診断を出します。明示した資格情報と元の引数は維持します。

正規ホームと `config.toml` は現在の利用者所有である必要があります。POSIX は group/other の書き込みを、Windows は現在の利用者・SYSTEM・Administrators 以外への DACL 書き込み許可を拒否し、所有者 SID を確認します。祖先パスの置換権限も確認し、macOS は強制 Codex 設定 preference がないことも要求します。同じ利用者や管理者の悪意あるプロセスを隔離するものではありません。

| Allowlist | Flags |
| --- | --- |
| Switches | `--no-daemon`, `--json`, `--ephemeral`, `--skip-git-repo-check`, `--no-alt-screen`, `--full-auto`, `--dangerously-bypass-approvals-and-sandbox`, `--search` |
| One value | `--model`/`-m`, `--sandbox`/`-s`, `--ask-for-approval`/`-a`, `--image`/`-i` |



自動認証情報の読み込みでは `CODEX_HOME` の `~` と空白をリテラルなパスとして解釈して検証し、同じ正規絶対パスを子プロセスに渡します。ホームを読めない場合は読み込みません。大文字小文字を問わず、空でない `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` があれば `NO_PROXY` に関係なく自動読み込みを省略します。拒否した起動とユーザーがエクスポートした認証情報は変更しません。新しいトークンを渡す場合、既存の除外項目を保持し、子の `NO_PROXY` と `no_proxy` に `127.0.0.1` と `::1` を追加します。`features.respect_system_proxy` の有効化や `--enable`/`--disable` の転送では自動読み込みを省略します。

元の引数で Codex を起動する前にプロキシの起動を試みます。ルーティングは Codex 設定が所有し、ランチャーは書き換えません。ネイティブと外部ゲートウェイでは起動を省略します。不明なルートでは警告して起動を試み、失敗しても警告後に続行します。ヘルプ、バージョン、`login`、`doctor`、`help` などの内部コマンドは起動と自動トークン読み込みを省略します。

選択した provider の全転送設定が、このインストールのループバックリスナーまたは保存されたローカルクライアント接続向けの管理ブロックと一致する場合だけ、不足する `OPENCODEX_API_AUTH_TOKEN` をこのインストールの `service-api-token` から読みます。名前や注入コメントだけでは許可しません。不明・リモートの接続先、既定 profile、プロジェクト設定、`OPENAI_BASE_URL`、転送した `-c`/`--config`、`-p`/`--profile`、`-C`/`--cd`、`--remote` は自動読み込みを省略します。ユーザーがエクスポートした認証情報と引数を保持し、トークンファイルの上書きと管理トークンの衝突を拒否します。

一致を確認した（`matched`）autostart wrapper だけが背後の Codex を直接実行します。検査例外を含む不明な状態では検証済みのバイパスが必要で、管理対象の Windows CMD wrapper は生成テンプレート全体と一致した場合だけ `OCX_SHIM_BYPASS=1` で実行します。通常の npm ランチャーは利用できます。検証不能または古い wrapper は終了コード 1 で拒否し、Codex は開始しません。`ocx codex-shim install` で更新してください。この起動は shim を修復せず、内容検査は Windows backing ファイルの出所や並行したパス置換を保証しません。

ランチャーのヘルプは `ocx help codex`、Codex のヘルプは `ocx codex --help` です。後で通常の `codex` を起動する動作は変わりません。

### `ocx opencode [opencode args...]`

プロキシが実行されていることを確認し、OpenCode のインライン ランタイム層 (`OPENCODE_CONFIG_CONTENT`) で生成された `provider.opencodex` および `providers.opencodex` ブロックを使用してオープンコードを起動します。既存のインライン設定は保持され、今回の起動ではこの 2 つのキーのみが置き換えられます。グローバルまたはプロジェクトの `opencode.json` ファイルは、既存の上書きについて警告するために読み取られることがありますが、ディスク上のファイルは変更されません。ルーティングされたモデルは `opencodex/<provider>/<model>` として表示されます。後でプレーン `opencode` を起動すると、以前とまったく同じように動作します。

### `ocx grok <status|exclude|include|set|clear|apply> ...`

Grok Build モデル フェンスを管理および適用します。

## クライアント設定のエクスポート

### `ocx export --client <opencode|pi|omp|hermes|openclaw|kimi|gajae|dsh|mcode|zcode|prime|aside|raycast|omo|cline|kilo|commandcode|droid>`

実行中のプロキシに接続するクライアント設定を出力します。このコマンドは、ベース URL、モデル一覧、およびクライアントに応じた認証情報参照または `opencodex-loopback` プレースホルダーを含む `opencodex` プロバイダーブロックを、選択したクライアントのネイティブ形式でシリアル化します。

プロキシが実行されている必要があります。このコマンドはライブ ポートを解決し、`/api/models` を読み取り、Codex が現在認識できるモデルのみを出力します。

|旗 |アクション |
| --- | --- |
| `--client <opencode\|pi\|omp\|hermes\|openclaw\|kimi\|gajae\|dsh\|mcode\|zcode\|prime\|aside\|raycast\|omo\|cline\|kilo\|commandcode\|droid>` |必須。クライアントの設定形式を選択します。 |
| `--json` |構成 JSON のみを標準出力に出力するため、リダイレクトはバイト正確な出力をキャプチャします。 `--out` 書き込みメモを含むすべての診断は stderr に送られます。 |
| `--out <path>` |設定を `<path>` に書き込みます。既存のファイルの置き換えを拒否します。 |
| `--force` | `--out` が既存のファイルを置き換えることを許可します。 |

```bash
ocx export --client opencode                     # config plus destination, merge warning, and counts
ocx export --client pi --json > pi-models.json   # JSON document for a pipe or a diff
ocx export --client omp --out ./omp-models.yml    # native OMP YAML
ocx export --client opencode --out ~/opencodex-opencode.json
```

`--json` がない場合、選択したクライアントのネイティブ形式で生成された設定が先頭に続き、正規の宛先パス、マージ警告、クライアント固有の起動前ガイダンス、およびコンテキスト制限を省略する行数を含むモデル数が続きます (クライアントはこれらに対して独自のデフォルトを適用します)。

|クライアント |正規の宛先 |ダウンロードファイル名 |環境変数 |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json` (設定すると `XDG_CONFIG_HOME` が勝ち) | `opencode.json` | `OPENCODEX_OPENCODE_API_KEY` |
| `pi` | `~/.pi/agent/models.json` (`PI_CODING_AGENT_DIR` が設定時に優先。相対値は拒否されます) | `pi-models.json` | なし - ブロックにリテラル `opencodex-loopback` が入ります |
| `omp` | `~/.omp/agent/models.yml` (デフォルト。空の場合も `OMP_PROFILE` が `PI_PROFILE` より優先されます) | `omp-models.yaml` | なし - リテラル `opencodex-loopback` |
| `hermes` | `~/.hermes/config.yaml` | `hermes-config.yaml` | `OPENCODEX_HERMES_API_KEY` |
| `openclaw` | `~/.openclaw/openclaw.json` | `openclaw.json5` | `OPENCODEX_OPENCLAW_API_KEY` |
| `kimi` | `~/.kimi-code/config.toml` | `kimi-config.toml` | なし - loopback placeholder |
| `gajae` | `~/.gjc/agent/models.yml` | `gajae-models.yaml` | 秘密ではないループバック用プレースホルダー |
| `dsh` | `$DSH_HOME/settings.yaml`（既定 `~/.dsh/settings.yaml`） | `settings.yaml` | なし — 秘密ではないループバック bearer プレースホルダー |
| `mcode` | `~/.minimax/config.yaml` (`MINIMAX_DATA_DIR`、次に旧 `MAVIS_DATA_DIR` が設定時に優先。相対値は拒否されます) | `mcode-config.yaml` | なし — loopback placeholder |
| `zcode` | `~/.zcode/v2/config.json` (既定ホームの `setting.json` にある `dataBaseDir` がルートを移動。`ZCODE_DATA_DIR` が設定時に優先。相対値は拒否されます) | `config.json` | なし — loopback placeholder |
| `prime` | `~/.prime/agent/models.json` (`PRIME_AGENT_CODING_AGENT_DIR` が設定時に優先。相対値は拒否されます) | `prime-models.json` | なし — loopback placeholder |
| `aside` | `~/.aside/u/<account>/models.json`。Aside 自身の `accounts.json` が現在のアカウントとして指す account を使います。マニフェストが読めない場合は、既定のアカウントに落とさず拒否します | `aside-models.json` | なし — loopback placeholder |
| `raycast` | `~/.config/raycast/ai/providers.yaml` (macOS と Windows で同じ。Raycast は `XDG_CONFIG_HOME` を尊重しません) | `raycast-providers.yaml` | なし — loopback のみ。`api_keys` エントリは書き込まれません |
| `omo` | `~/.omo/agent/models.json` (`OMO_CODING_AGENT_DIR`、次に `SENPI_CODING_AGENT_DIR`、次に `PI_CODING_AGENT_DIR` の順で設定時に優先。相対値は拒否されます) | `omo-models.json` | なし — loopback placeholder |
| `kilo` | `~/.config/kilo` 配下で最初に存在する `kilo.jsonc`、`kilo.json`、`opencode.jsonc`、`opencode.json`、`config.json`（`XDG_CONFIG_HOME` が設定されていればその配下）。候補がなければ `kilo.jsonc` | `kilo.jsonc` | `OPENCODEX_KILO_API_KEY` |
| `commandcode` | `~/.commandcode/providers.json` (Windows の既定ホームを使用する場合: `HOME ?? USERPROFILE` が空文字列や空白のみではなく Windows の絶対パスの場合に限り使用し、それ以外は `homedir()`。別途指定されたホームは保持。その配下の `.commandcode\providers.json`) | `providers.json` | ループバックのみ・`apiKey: false`・環境変数不要 |
| `droid` | `~/.factory/settings.json` (`%USERPROFILE%\.factory\settings.json` on Windows) | `factory-settings.json` | ループバックのみ・環境変数不要 |

上記のパスは既定値です。既定のホームにある `~/.zcode/v2/setting.json` に絶対パスの `dataBaseDir` を指定すると、保存先は `<dataBaseDir>/.zcode/v2/provider_config.json` に移ります。`ZCODE_DATA_DIR` は `.zcode` ルートそのものを指定して設定値より優先され、`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` はプロバイダーファイルのパスで優先されます。不正な設定、読み取れない設定、相対パスでは新しい適用と更新を拒否します。既存の所有権と復元記録は保持されます。[パスと復元規則の原文](https://opencodex.me/guides/integrations/#zcode-314-and-later)を参照してください。

Raycast のエクスポートは、`providers` シーケンスに `id: opencodex` 要素を 1 つだけ持つ独立した `providers.yaml` 文書です。内容は `name: OpenCodex`、プロキシの `/v1` ベース URL、および `abilities` 付きのルーティング済み全モデルです (`tools` と `system_message` は常にサポート、`vision` はカタログの入力モダリティから、`reasoning_effort` はモデルに effort ラダーがある場合、`temperature` は推論モデルではオフ)。Custom Providers は Raycast Pro の機能で、Raycast はこのファイルを監視しているため、保存した変更は再起動なしで反映されます。形式は [manual.raycast.com/ai/custom-providers](https://manual.raycast.com/ai/custom-providers) に記載されています。`api_keys` エントリは書き込まれないため、このエクスポートは loopback 専用で、loopback 以外のバインドは拒否されます。

opencode は `{env:OPENCODEX_OPENCODE_API_KEY}` を補間します。opencodex が生成する Pi のエクスポートには環境変数が不要で、リテラルのプレースホルダー `opencodex-loopback` が入ります。この値は必須です。Pi はモデル リストを構築する際に `apiKey` を解決し、既存の設定に未設定の環境変数参照がある場合はプロバイダー全体を隠すためです。ループバックでは、生成されたプレースホルダーをプロキシが検査することはありません。

:::caution[マージし、決して置き換えないでください]
`ocx export` は実際のクライアント設定を書き込むことはありません。宛先は手動でマージできるように出力されます。`--out` は、`--force` なしで既存のファイルを上書きすることを拒否します。これは、設定を置き換えると、その中にすでに含まれている他のプロバイダー、エージェント、および MCP エントリが破壊されるためです。
:::

キーはシリアル化されません。生成される設定には、文書化された環境参照か、秘密ではないループバック用プレースホルダーのいずれかが入ります。ループバックアドレス (`127.0.0.1`) だけでは、キー不要とは判断できません。対象の認証ポリシーとエンドポイントを確認してください。選択したキーを使うモデル・音声 CLI はループバックでも明示的なキー入力が必要です。クライアントの設定形式が対応しており、プロキシがループバック以外のアドレスにバインドする場合にのみ、参照される環境変数を設定してください。アドミッション キーの発行方法は [Remote access](/ja/reference/configuration/server/#リモートアクセス) を参照してください。上流プロバイダー自体のキーは別の設定です。[Providers](/guides/providers/) を参照してください。

生成される gjc 連携は秘密ではないループバック用の値を使うため、環境変数は不要です。ループバック専用で、リモート接続の認証情報は設定しません。

同じペイロードが `GET /api/client-config` によって提供され、ダッシュボードの [API] タブにレンダリングされるため、CLI、API、および GUI は同じバイトを使用します。

## ランタイムと構成

### `ocx system <status|settings|startup|diagnostics|sync|codex-app-server|codex-restart|update|codex-cli-update> ...`

ヘッドレス ランタイムの設定、起動、同期、診断、更新を管理します。

`ocx system codex-restart --yes` は `ocx sync --restart-codex` と同じモジュールで Codex app-server を再起動します。モデル ピッカーは起動時に構築されるため、デスクトップ アプリを完全に終了して再起動するのは、現在のモデル カタログが書き込まれる前にアプリが起動していた場合、またはこのリクエストで `model_catalog_json` の参照先が変わった場合です。それ以外の場合、アプリは開いたまま自身の app-server を再起動し、未送信の下書きや保留中の承認を保持します。アプリまたはカタログの状態を読み取れない場合は完全な再起動を行います。プロキシ自体が Codex アプリ内で動いている場合、デスクトップの再起動は完了できない引き渡しを約束せず、実行可能な案内とともに拒否します。

このリクエストで `model_catalog_json` の参照先が変わった場合も、シェルがカタログファイルの書き込み後に起動していてもデスクトップを再起動します。

```bash
ocx system settings --stream-mode eager-relay
```

`ocx system update` は OpenCodex 自体を更新します。Codex CLI は次の独立した読み取り専用コマンドで検査します。

```bash
ocx system codex-cli-update check --json
```

`check` はレジストリへの問い合わせも Codex の実行も行いません。POSIX では、公開ランチャーが記録した環境候補とランタイムリゾルバーが選ぶ正規パスが一致すると `selectionAttested: true` になり、リンクされた npm-global パッケージのマニフェストで所有権を確認でき、候補バージョンが報告されている場合はそれがマニフェストのバージョンと一致するときに `managed: true` になります。永続化された候補は認証されません。Windows x64 は、証明にバインドされた絶対パスの標準 npm `codex.cmd` と保持ハンドルにバインドされた Node/npm ツールチェーン（存在する場合はプレフィックスローカル、存在しないことが確認された場合はランチャーアーキテクチャにアンカーされたキャプチャ済み PATH ペア）、検証済みのインプレフィックスプラットフォームバッキングもサポートし、リパースを拒否する保持ハンドルを使用します。他の Windows レイアウトは引き続き延期または非管理です。Windows の `managed` 結果は観測されたインストールレイアウトのみを分類し、バインドされた Node/npm はアップデーターの読み取り専用メタデータツールチェーンであって、後の `codex.cmd` 呼び出しがどのインタープリターを解決するかを保証するものではありません。Bun やソースからの直接実行にはランチャーの証明がありません。`plan` は分離した一時 npm 設定・キャッシュ・ログで公式レジストリに問い合わせ、実行中のセッションや不完全なプロセス観測を拒否します。インストールやプロセスへのシグナル送信は行いません。Windows x64 の apply には、検証済みのプライベート書き込み権限を持つ制限付き npm プレフィックスが必要で、無関係なパッケージ・shim を保持します。適用条件を満たさない観測レイアウトは `applicable: false` と `refusal: windows_apply_disabled` を返し、PATH のみの選択・OpenCodex 自動起動ラッパー・global/vendor フォールバックは引き続き延期されます。[コマンドと拒否理由の詳細（英語）](/reference/cli/agents/#read-only-codex-cli-update-plan)を参照してください。

Windows で `CODEX_CLI_PATH=codex` のような単純なコマンド名、リモートパス、デバイスパスが候補としてキャプチャされた場合は、`candidate_path_unavailable` を報告します。候補は取得されていますが、そのパスはこの検査の対象になりません。

#### Windows x64 インストールの明示的な観測

```text
ocx system codex-cli-update attest [--json]
ocx system codex-cli-update attest --candidate <absolute-path> --npm-prefix <absolute-path> --npm-cli <absolute-path> --node <absolute-path> [--json]
```

`attest` は、選択済みまたは明示した Windows x64 の npm インストールを読み取り専用で観測する任意の操作です。オプションなしでは、証明済みランチャースナップショットが特定した選択候補（設定済み `CODEX_CLI_PATH` または取り込み PATH 上の最初の `codex`）を観測し、opencodex ラッパーは名前を変えた `codex.opencodex-real.cmd` npm バックアップに解決します。4 個の絶対パスをすべて指定すると検出を上書きします。検出はパスを提案するだけで、ハンドル保持による観測が最終的な権威です。`--candidate` は標準 npm の `<prefix>/codex.cmd` または `<prefix>/node_modules/@openai/codex/bin/codex.js` を指定します。`--npm-cli` は `node_modules/npm/bin/npm-cli.js` で終わり、`--node` は明示的な `node.exe` を指定します。アプリのバンドル、認識済みバージョン管理ツールの配置、npm バックアップのない opencodex 所有の shim、独自ラッパーは拒否されます。

制限付き読み取り中、ネイティブハンドルで親ディレクトリとファイルを保持します。未対応プラットフォーム、再解析ポイント・junction、競合する書き込み、安全でないパス、上限を超えるファイルは拒否されます。固定形式のレポートにパスは含まれません。`status` は `observed` または `refused` で、`installationIdentityObserved` を返します。`selectionAttested`、`managed`、`applyAllowed` は常に `false` です。拒否の報告でも終了コード 0 になり得るため、`status` を確認してください。

識別値やダイジェストは観測時点のファイルを表し、持続的な更新許可ではありません。選択されたランタイム、過去のインストーラー、実効 npm 設定、ツールの真正性は証明しません。指定した Node も観測するだけで、ランチャーが選ぶ Node だとは証明しません。対象の実行、レジストリ要求、インストール、設定の書き込み、プロセス制御は行いません。既存の Windows `check` は引き続き候補・設定のファイルシステム I/O を行いません。

### `ocx config [show|get|set|unset|validate|export|import] ...`

`ocx config [show] [--json] [--source]` は、プロキシを起動せずにローカル設定を表示します。`show` を省略しても、どちらかのフラグ、または両方を任意の順序で指定できます。`--source` は診断のソース、エラー、警告を含め、表示時のみ使用できます。`--json` は明示的な操作の前にも指定でき、実行する操作を変更しません。`--json` または `--source` の重複と不明な引数は拒否されます。

検証された OpenCodex 設定を検査し、安全に変更します。 `show` および `get` はシークレットをマスクします。インポートは書き込む前に検証され、`--yes` が必要です。

### Forced Claude Code subagent model

The Subagents page offers **Force all subagents onto one model**, off by default. Select an exposed roster-style id, such as `combo/tev-auto`, then enable the switch. The roster is offered first; unavailable saved roster entries cannot be force targets.

`ocx agent subagents force combo/tev-auto` sets `claudeCode.subagentModelForce`; `ocx agent subagents force -` clears it. `ocx agent status` reports the setting. `GET /api/subagent-models` returns `force`, `forceAvailable`, and `forceStatus`; `PUT` accepts `{ "force": "combo/tev-auto" }` or `{ "force": null }` without changing the roster. Omitting `force` leaves it unchanged. Invalid or unexposed targets are rejected on write; stale targets are reported and skipped at launch.

This takes effect on the **next routed `ocx claude` launch**, injecting `CLAUDE_CODE_SUBAGENT_MODEL` as an explicit proxy alias (with `[1m]` only for an authoritative million-token window; native Claude targets use a reversible native alias) and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Each nonempty shell-exported variable independently wins. Native launches inject neither variable; plain `claude` is not affected. No plugin files or `settings.json` are modified by this setting.

Claude Code **2.1.257 or newer** is required for FORCE. Plugin and built-in agents (including Explore/Plan) and per-call model arguments are overridden. Forks and subagent skills with `model: inherit` keep the main conversation model. The main loop and Haiku/small-fast sidecars are unaffected. Existing roster files remain available.

The dashboard warns about old or unknown CLI versions, unavailable targets, and either variable already present in `settings.json` → `env` (which overrides launch env). Detection is read-only and server-local: it cannot inspect another launch shell, another machine, or project-local settings. An unknown result is not proof of force support.

## Hermes / Command Code: model names

Hermes and Command Code support `--model-names alias|routed` (API: `modelNames`).
The default is `routed`, independent of `preferModelAliasIds`. A connection
stores its mode; later Apply without the option preserves it. Alias mode uses
only provider-qualified aliases that the router proves equivalent; missing,
unsafe or colliding aliases fall back to routed keys. Combos keep their keys.
Removed/renamed aliases migrate on the next successful managed refresh, with
foreign-edit refusal. Named Hermes profiles need explicit Apply.

`ocx export --client hermes --model-names alias --json` previews a current
already loaded catalog without writing client files or managed state; a cold or
stale catalog returns unavailable. Explicit `--out` writes an export artifact.
See the [English integration guide](/guides/integrations/#opt-in-alias-model-names)
for the canonical workflow.
