---
title: CLI リファレンス
description: すべての ocx コマンドとフラグ。
---

opencodex CLI は `ocx` です。最上位の使い方は `ocx help`（または `--help` / `-h`）で確認します。
ヘルプ表に登録されたコマンドの詳細な使い方は `ocx help <command>` で見られます。ヘルプとバージョン
コマンドは読み取り専用で、Codex/opencodex の状態を開始、停止、インストール、削除、書き換えしません。

## 設定とライフサイクル

### `ocx init`

対話型設定ウィザードです。プロバイダー（プリセットまたはカスタム）、API キー（直接入力または `${ENV}`）、
デフォルトモデル、プロキシポートを順に尋ね、`~/.opencodex/config.json` を保存します。選択に応じてプロキシを
`$CODEX_HOME/config.toml`（デフォルト `~/.codex/config.toml`）に注入し、Codex 自動起動 shim もインストールします。

### `ocx start [--port <port>]`

プロキシサーバーを起動します（優先ポート `10100`）。そのポートが既に使われていると opencodex が別の空き
ポートを選び、記録します。PID とランタイムポート状態を保存し、生きている 2 つ目のインスタンスは起動しません。起動時に各プロバイダーのモデルを Codex カタログに同期します。管理型サービス
（`OCX_SERVICE=1`）として実行した場合を除き、終了時にネイティブ Codex を復元します。

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

実行中のプロキシを PID で停止し PID ファイルを消したのち、ネイティブ Codex を復元します。管理型
バックグラウンドサービスがインストールされている場合は先にサービスを停止し、プロキシが再び立ち上がらないようにします。ウェブ
ダッシュボードの **Stop** ボタン（`POST /api/stop`）も同じ操作を行います。

### `ocx restore` &nbsp;·&nbsp; `ocx eject`

プロキシはそのままにしてネイティブ Codex を復元します。注入された設定行とルーティングカタログ項目を削除し、通常の `codex` が再びネイティブで動くようにします。`eject` は `restore` の別名です。

どちらの表記でも `back` を付けるとプロキシライフサイクルを変えずに、実行中のプロキシを通常の
`codex` に再接続します。

```bash
ocx restore back
ocx eject back
```

### `ocx recover-history --legacy-openai`

戻せるバックアップに対応する前の Codex App 履歴を再マッピングしていた旧開発ビルド向けの明示的復旧
コマンドです。履歴データベースがロックされている場合は先に Codex を閉じてください。

### `ocx restart`

`stop` のあとに `ensure` を実行します。プロキシ/サービスを停止してネイティブ Codex を復元したのちプロキシを
バックグラウンドで起動し、実際のポートを Codex に再同期します。

### `ocx ensure`

バックグラウンドプロキシが実行中かを冪等に確認し、リアルタイムモデルカタログを同期します。
`codexAutoStart` が `false` なら自動起動がオフである旨のメッセージだけを出力し、何もしません。

### `ocx status [--json]`

プロキシ PID、`/healthz` 接続状態、ダッシュボード URL、設定ファイルパス、デフォルトプロバイダー、Codex 自動起動
設定、サービス状態、shim 状態を読み取り専用の診断要約として出力します。

機械が読める読み取り専用の診断契約は `--json` で受け取ります。

```bash
ocx status --json
```

省略されたオブジェクト形式は次のとおりです。

```json
{
  "schemaVersion": 1,
  "proxy": {
    "running": false,
    "pid": null,
    "health": {
      "ok": false,
      "url": "http://127.0.0.1:10100/healthz",
      "message": "unreachable"
    }
  },
  "dashboard": {
    "url": "http://localhost:10100/"
  },
  "paths": {
    "config": "/Users/example/.opencodex/config.json",
    "pid": "/Users/example/.opencodex/ocx.pid",
    "runtime": "/path/to/bun"
  },
  "runtime": {
    "source": "bundled"
  },
  "codexAutostart": true,
  "defaultProvider": "openai",
  "service": {
    "summary": "not installed (logs: /Users/example/.opencodex/service.log)"
  },
  "codexShim": {
    "summary": "Codex autostart shim: not installed"
  }
}
```

実際のオブジェクトには `listen`（ポート、ホスト名、ランタイム/設定出所）、設定ロード診断、バンドル Codex プラグイン
診断も入ります。JSON スキーマはフィールド追加のみを許すため、以降のバージョンでフィールドは増える可能性がありますが既存
フィールドは維持されます。API キー、OAuth トークン、authorization ヘッダー、リクエスト内容、メール、アカウント識別子は
意図的に除外します。

### `ocx health [--json]`

実行中のプロキシの身元を確認します。通常出力には PID とポートが表示され、`--json` は
`{ok, pid, port}` を出力します。正常時のみ終了コード 0、それ以外は 1 を返すためサービス probe に使えます。

### `ocx uninstall` &nbsp;·&nbsp; `ocx remove`

サービスとプロキシを停止し、サービスと Codex shim を削除したのちネイティブ Codex を復元します。すべての
復元ステップが成功した場合にのみ opencodex のローカル設定まで消します。`remove` は `uninstall` の別名です。

## モデルと Codex

### `ocx sync`

設定されたすべてのプロバイダーからリアルタイムモデル一覧を取得し、マージしたカタログを Codex に再注入します。
プロバイダーを追加したときや利用可能なモデル一覧を最新化したいときに実行してください。

### `ocx sync-cache`

Codex のローカルモデルセレクターキャッシュを無効化し、現在の opencodex カタログで再構築させます。

### `ocx v2 [subcommand]`

Codex の `multi_agent_v2` 機能フラグと 3 段階の multi-agent surface mode を管理します。

| Subcommand | Action |
| --- | --- |
| `status`（デフォルト） | 現在の v2 フラグ、multi-agent mode、thread concurrency を報告します。 |
| `on` | `$CODEX_HOME/config.toml` で `multi_agent_v2` 機能をオンにしカタログを再同期します。 |
| `off` | `multi_agent_v2` 機能をオフにし再同期します。 |
| `mode v1` | すべてのモデルを v1 に強制し native v2 をオフにしたのち thread limit を `[agents] max_threads` に維持します。 |
| `mode default` | 上流の model pin に従います（sol/terra=v2、luna=v1、それ以外=Codex フラグ）。インストールのデフォルトです。 |
| `mode v2` | すべてのモデルを v2 に強制し native v2 をオンにしたのち同じ thread limit を v2 キーに移行します。 |
| `threads <n>` | 現在の v1/v2 thread limit を設定します（1 以上の整数）。 |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
```

`mode` サブコマンドは opencodex 設定に `multiAgentMode` を記録し Codex カタログを再
同期します。`mode v1`/`mode v2` と `on`/`off` は現在の数値を有効な v1/v2 設定キーに
移しながら `codex features enable|disable` で codex-rs 機能フラグを変えます。切り替えに失敗すると
既存の `config.toml` をそのまま復元します。
変更は新しい Codex セッションから適用され、実行中のセッションは固定された surface を維持します。

### `ocx models [--provider <name>] [--json]`

設定されたプロバイダーに静的に seed されたモデルを一覧します。`--provider` は 1 つのプロバイダーだけを選び、
`--json` はモデルメタデータとともに `liveModels` がランタイム専用項目を追加できる旨の案内を
返します。リアルタイムカタログを取得するコマンドではありません。その作業には `ocx sync` やダッシュボードを
使ってください。

### `ocx provider <subcommand>`

非対話型のプロバイダー管理コマンドです。レジストリ項目は名前だけで seed され、カスタム名には
`--adapter` と `--base-url` が両方必要です。

| Subcommand | Supported flags | Action |
| --- | --- | --- |
| `list` | `--json` | 設定されたプロバイダーと、まだ追加していないレジストリ項目を一覧します。 |
| `add <name>` | `--adapter <adapter>`, `--base-url <url>`, `--api-key <key>`, `--default-model <model>`, `--set-default`, `--force`, `--json`, `--sync` | レジストリ/カスタムプロバイダーを追加します。`--force` は上書きし、通常出力モードの `--sync` は実行中のプロキシを更新します。 |
| `show <name>` | `--json` | API キーを隠した設定を表示します。 |
| `remove <name>` | `--json` | デフォルトプロバイダーでない項目を削除します。最後のプロバイダーは削除できません。 |
| `set-default <name>` | `--json` | 既存のプロバイダーをデフォルトに選びます。 |

```bash
ocx provider list --json
ocx provider add anthropic --api-key sk-ant-... --set-default --sync
ocx provider add local-dev --adapter openai-chat --base-url http://localhost:11434/v1
ocx provider show anthropic --json
ocx models --provider anthropic --json
```

### `ocx account <subcommand>`

実行中のプロキシを経由してプロバイダーアカウントと API-key pool を照会・切り替えます。デプロイされたヘルプの
コマンド面は次のとおりです。

```text
Usage: ocx account <list|current|use|refresh|auto-switch|remove|add-key> ...

List and switch provider accounts and API-key pools (GUI parity).

list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).
current <provider>  Show the active account or key.
use <provider> <id> Switch the active credential; 'main' selects the Codex App login.
refresh <provider>  Force-refresh Codex or provider quota reports.
auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.
remove <provider> <id> --yes  Remove a stored account or key after an existence check.
add-key <provider> [--label <label>]  Add a key read only from piped stdin.
Codex pool switches apply to new sessions; running threads keep their account.
```

すべてのサブコマンドはプロキシが実行中である必要があり、CLI が記録されたランタイムポートを自動的に探します。成功は
終了コード 0 を返します。誤った使い方、不明なプロバイダーやアカウント/key id、プロキシ接続失敗、
API エラーは終了コード 1 です。認証情報フィールドは management API が返したまま（API が適用したマスキングを含む）表示し、生の API key と OAuth token は返しません。画面上の利便性の値はダッシュボードと同じ方式で CLI が合成します: `main` は `openai` アカウントプールの Codex App ログイン別名で、メールのない OAuth アカウントは `Account N` と表示され、plan/label 列は plan → マスク済みメール → label → マスク済み key の順で代替します。

`--json` のアカウント行は以下の共通形式を使います（値がない場合は省略可能フィールドは省かれます）。

```json
{
  "provider": "openai",
  "type": "codex | oauth | api-key",
  "id": "__main__",
  "label": "plus",
  "email": "m***@example.com",
  "plan": "plus",
  "masked": "sk-ab****wxyz",
  "active": true,
  "needsReauth": false,
  "quota": null
}
```

#### `ocx account list [provider] [--json] [--all]`

プロバイダーを省略すると Codex pool、OAuth アカウント、設定された API-key pool をすべて一覧します。空の
プロバイダーは `--all` を指定しない限り飛ばし、プロバイダーを指定するとその認証情報 family だけを照会します。通常出力列は `PROVIDER TYPE ID PLAN/LABEL STATUS` で固定 Codex 行には
`next session` が表示されます。保存された Kiro アカウントがある場合、ログインスロットは 1 つで再ログインすると現在のアカウントが差し替わる旨の案内が出ます。結果が空でも成功です。`--json` は次を返します。

```text
{ accounts: AccountRow[], notes: string[] }
```

#### `ocx account current <provider> [--json]`

アクティブなアカウントまたは key を表示します。手動 pin のない Codex pool は使用量が最も低いアカウントを自動選択すると表示します。他の family にアクティブな認証情報がなくてもその状態を知らせ終了コード 0 を返します。`--json` 形式は次のとおりです。

```text
{ provider, type, activeId: string | null, autoSwitchThreshold?: number, account: AccountRow | null }
```

#### `ocx account use <provider> <account-or-key-id|main> [--json]`

既存の Codex アカウント、OAuth アカウント、または API key を選びます。`openai` で `main` は Codex App ログインを
選択します。Codex の選択は **新しいセッション** から適用され、既存の thread は現在のアカウントを維持します。auto-switch
threshold がオンなら後で手動 pin を上書きできます。不明なプロバイダーや id は終了
コード 1 です。`--json` は次を返します。

```text
{ ok: true, provider, type, activeId }
```

#### `ocx account refresh <provider> [--json]`

Codex pool は `ocx account refresh openai [--json]` を使います。アカウント quota を強制的に最新化し、確認可能な週次/月次の割合と reset 時刻を表示します。quota 情報がない場合は 0% ではなく unknown と表示します。JSON envelope は `{ accounts: AccountRow[] }` で各 Codex 行に `quota` が入ります。

OAuth および API-key プロバイダーでは provider quota-report endpoint を強制的に最新化します。token
再ログインや単なる account-list 再照会ではありません。`--json` は
`{ provider, report: ProviderQuotaReport | null }` を返します。対応する quota report がない場合は
`no quota report available for <provider>` を出力し終了コード 0 を返します。不明な
プロバイダーと management API エラーは終了コード 1 で、上流 quota probe が失敗またはタイムアウトした場合はダッシュボードの quota バーと同様に null/古い report に低下して終了コード 0 を
返します。

#### `ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]`

`openai` Codex アカウント pool だけを制御します。`on` は 80%、`off` は 0% に設定し `status` は現在値を読みます。`threshold <n>` は 0 から 100 までの整数だけを受け付けます。他のプロバイダーや誤った値は終了
コード 1 です。`--json` は次を返します。

```text
{ provider, autoSwitchThreshold: number, enabled: boolean }
```

#### `ocx account remove <provider> <id|main> --yes [--json]`

保護された非対話型削除のため `--yes` が必須です。削除前に id の存在を確認し、不明な id は DELETE を送らずに終了コード 1 を返します。メインの Codex App ログインは削除できないため
`remove openai main --yes` も拒否します。削除後に family を再読みします。固定された Codex アカウントを
消すと pin が解除されて自動選択に戻り、OAuth は残りの先頭アカウントをアクティブ化またはアカウントなしと表示し、API-key pool は残りの先頭 key をアクティブ化または key なしと表示します。`--json` の成功/失敗
形式は次のとおりです。

```text
{ ok: true, provider, id, removedActive: boolean, promotedActiveId: string | null }
{ error: string } // stderr, exit 1
```

#### `ocx account add-key <provider> [--label <label>] [--json]`

API-key プロバイダーに key を追加してアクティブ化します。key は TTY でない pipe/redirect stdin からだけ
読みます。対話型 TTY 入力、空入力、OAuth/Codex プロバイダー、API エラーは終了コード 1 です。label
に key が含まれていても key を絶対に echo しません。secret manager や here-string を使ってください。

```bash
ocx account add-key openrouter --label personal <<< "$OPENROUTER_API_KEY"
security find-generic-password -w openrouter | ocx account add-key openrouter --json
```

`--json` は `{ ok: true, id: string | null, label?: string }` を返し key を含みません。

## 認証

### `ocx login <provider>`

プロバイダーに登録されたログイン手順を開始します。OAuth プロバイダーはブラウザを開き、自動更新される
認証情報を `~/.opencodex/` 以下に保存します。API キーログインプロバイダーはキーダッシュボードを開き、キーを
入力させて可能な場合は検証したのち、結果のプロバイダー設定を保存します。名前がない、または不明な名前の場合は現在許可される OAuth および API キープロバイダー id を出力します。

```bash
ocx login xai
```

### `ocx logout <provider>`

プロバイダーに保存された OAuth 認証情報を削除します。

## ダッシュボード

### `ocx gui`

`http://localhost:<port>` で [ウェブダッシュボード](/ja/guides/web-dashboard/) を開きます。
プロキシが実行中でない場合は自動的に起動します。

## バックグラウンドサービス

### `ocx service [subcommand]`

opencodex をログイン管理型のバックグラウンドサービス（macOS **launchd**、Linux **systemd user unit**、
Windows **Task Scheduler**）として実行します。ログイン時に自動的に起動し、異常終了時に再
開始します。サービス実行は `OCX_SERVICE=1` を設定するため、再起動時に Codex 設定を繰り返し
変えません。

| Subcommand | Action |
| --- | --- |
| なし | サービスを作成/更新して起動します。 |
| `install` | サービスを作成して起動します。 |
| `start` | インストールされたサービスを起動します。 |
| `stop` | サービスを停止しネイティブ Codex を復元します。 |
| `status` | サービスの実行状態を報告します。 |
| `uninstall` | サービスを削除しネイティブ Codex を復元します。 |
| `remove` | `uninstall` の別名です。 |

```bash
ocx service
ocx service install
ocx service status
ocx service uninstall
```

### `ocx codex-shim <subcommand>`

PATH 上のスクリプトベース `codex` ランチャーを軽量な自動起動スクリプトで包みます。実際の `codex.exe`
対象は正確な実行ファイル呼び出しが壊れないように触りません。

完了した外部 Codex 更新がインストール済み shim を上書きした場合、次の通常の `ocx` コマンドが
安定した新しいランチャーをバックアップし、コマンド実行前に shim を復元します。まだ変更中の
ランチャーには触れず、後で再試行します。修復失敗は要求されたコマンドを失敗させず警告だけを
表示し、手動の代替手段は `ocx codex-shim install` です。自動修復を無効にするには
`codexShimAutoRestore` を `false` にするか、プロセスで
`OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0` を設定します。

| Subcommand | Action |
| --- | --- |
| `install` | shim をインストールします（古い状態なら修復）。 |
| `uninstall` | shim を削除し元の Codex バイナリを復元します。 |
| `remove` | `uninstall` の別名です。 |
| `status` | shim 状態（インストール済み / 古い / なし）を報告します。 |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[Service vs Shim]
常にプロキシをオンにしておくには `ocx service` を使ってください（推奨）。デーモンなしで必要なときだけ軽く起動したいなら
`ocx codex-shim` を使ってください。この場合プロキシは `codex` を実行したときだけ起動します。
:::

## 診断

### `ocx doctor`

状態パスとファイルシステムの種類、WSL 二重インストール、プロキシ環境/設定、ChatGPT 接続状態、Codex プラグインと
プロジェクト設定の警告、保留中の履歴マイグレーションを読み取り専用で診断します。復旧案内は出力しますが自ら適用はしません。

### `ocx debug [provider|usage …]`

実行中のプロキシの管理 API からランタイムデバッグ override を読むか変えます。

```bash
ocx debug provider on|off|status|reset
ocx debug provider logs [-f|--follow]
ocx debug usage on|off|status|reset
ocx debug usage logs [-f|--follow]
```

スコープを指定しないと `ocx debug` が使い方を出力します。プロキシが止まっているときは次回起動時に
適用される環境変数のデフォルト値も示します。プロバイダーデバッグのデフォルトは `OCX_DEBUG=1` で既存の
`OCX_DEBUG_FRAMES=1` もサポートします。使用量デバッグのデフォルトは `OPENCODEX_USAGE_DEBUG=1` です。

## アップデート

### `ocx update`

npm から opencodex を自己更新します。安定版インストールは `@latest`、プレビューインストールは `@preview` を
維持し `--tag latest|preview` で切り替えできます。ソース checkout では代わりに
`git pull && bun install` を案内し、該当タグの最新版なら何もしません。ファイルを
差し替える前に実行中のプロキシを停止します。インストール済みのサービスは再ビルドして自動起動し、
フォアグラウンドインストールには次のステップとして `ocx start` を案内します。

```bash
ocx update
ocx update --tag preview
```

[Release ワークフロー](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml) が npm に
公開した直後に新しいバージョンが使えるようになります。

## ヘルプ

`ocx help`、`ocx --help`、`ocx -h` — 最上位の使い方と例を出力します。

`ocx help <command>`、`ocx <command> --help`、`ocx <command> -h` — `src/cli/help.ts` に登録された
コマンドの詳細な使い方を出力します。`provider`、`debug`、`v2` のサブコマンド契約全体は上にまとめてあります。

ヘルプフラグがあっても不明なコマンドはエラーとして扱うため、スクリプトは出力文字列を解析せずに終了コードを信頼できます。

## バージョン

`ocx --version`、`ocx -v`、`ocx version` — スクリプトが読みやすい 1 行のバージョンを出力して
終了します。

## 内部コマンド

2 つの dispatch 対象は通常のヘルプで意図的に非表示です。`__refresh-version [preview]` は分離された
プロセスで更新通知キャッシュを更新します。
`__gui-update-worker <job-id> [latest|preview] [restart]` はダッシュボードの更新ジョブを実行します。
実装の詳細であり安定したユーザーコマンドではありません。
