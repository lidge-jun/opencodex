---
title: CLI ライフサイクル
description: セットアップ、開始、停止、サービス、診断、同期、および更新コマンド。
---

これらのコマンドは、ローカル opencodex プロキシとその Codex 統合をインストール、実行、検査、修復、および更新します。

## 設定

### `ocx init`・`ocx setup`

対話型セットアップ ウィザード (`setup` は `init` のエイリアスです)。プロバイダー (プリセットまたはカスタム)、API キー (リテラルまたは `${ENV}`)、デフォルトのモデル、およびプロキシ ポートの入力を求めるプロンプトが表示されます。 `~/.opencodex/config.json` を保存します。オプションでプロキシを `$CODEX_HOME/config.toml` (デフォルトは `~/.codex/config.toml`) に挿入します。オプションで Codex 自動起動シムをインストールします。

## プロキシのライフサイクル

### `ocx start [--port <port>]`

プロキシ サーバー (優先ポート `10100`) を起動します。そのポートが占有されている場合、opencodex は別の使用可能なポートを選択して記録します。 PID/ランタイムポートの状態を書き込み、2 番目のライブインスタンスの起動を拒否します。開始時に、各プロバイダーのモデルを Codex のカタログに同期します。マネージド サービス (`OCX_SERVICE=1`) として起動されていない限り、シャットダウン時にネイティブ Codex が復元されます。

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

実行中のプロキシを (PID によって) 停止し、PID ファイルを削除して、ネイティブ Codex を復元します。マネージド バックグラウンド サービスがインストールされている場合、`ocx stop` はそれを最初に停止するため、プロキシを再起動できません。Web ダッシュボードの **停止** ボタンは同じ処理 (`POST /api/stop`) を実行しますが、Windows タスク スケジューラだけは例外です。タスク終了後もラッパーがプロキシを再起動しうるため、ダッシュボードは `respawnable_service` で拒否し、何も変更せずに `ocx stop` の実行を促します。

### `ocx restart`

プロキシが実行中の場合、検証済みの正確な PID とポートに対して in-place 再起動を要求し、通常のドレインを待ってから、同じポートに別のランタイム PID が起動したことを確認します。管理対象ルーティングとサービス監視は維持され、不確実な要求を別の stop/start として再実行しません。実行中のプロキシがない場合に限り、通常の `ensure` 起動にフォールバックします。

稼働中のリスナーをランタイム PID に結び付けて検証できない場合（更新前のプロキシを含む）、`ensure` や stop/start へのフォールバックは行わず安全側で失敗します。所有権を確認してから `ocx stop`、`ocx start` の順に一度実行してください。

### `ocx ensure`

バックグラウンド プロキシが実行されていることを冪等的に確認してから、そのライブ モデル カタログを同期します。 `codexAutoStart` が `false` の場合、自動起動が無効であることが出力され、何も行われません。

### `ocx restore [back]`・`ocx eject [back]`

プロキシを停止せずに**ネイティブ Codex を復元します。挿入された設定行とルーティングされたカタログ エントリを削除し、プレーンな `codex` が再びネイティブに動作するようにします。 `eject` は `restore` の別名です。

プロキシのライフサイクルを変更せずに、既に実行されているプロキシでプレーン `codex` を再指定するには、`back` をどちらかのスペルに渡します。

```bash
ocx restore back
ocx eject back
```

### `ocx recover-history --legacy-openai --yes`

可逆バックアップ サポートが存在する前に Codex App 履歴を再マップした古い開発ビルドの明示的なリカバリ。履歴データベースがロックされている場合は、まず Codex を閉じてください。

これは広範囲で破壊的な再ラベル付けです。ユーザーメッセージを持ち、現在 `opencodex` とタグ付けされているすべてのスレッドを `openai` に変更し、`exec` を `cli` に正規化してイベントマーカーを設定します。正当な専用プロバイダー履歴も対象です。状態をバックアップし、この全範囲を意図する場合にのみ実行してください。

### `ocx uninstall`・`ocx remove`

すべての復元手順が成功した場合にのみ、サービスとプロキシを停止し、サービスと Codex シムを削除し、ネイティブ Codex を復元してから、opencodex ローカル設定を削除します。 `remove` は `uninstall` の別名です。設定のクリーンアップには、新規インストールによって作成された所有権メタデータが必要です。従来のディレクトリまたは共有ディレクトリはそのまま残ります。

## ステータスと健康状態

### `ocx status [--json]`

読み取り専用の診断概要を出力します: プロキシ PID、`/healthz` 到達可能性、ダッシュボード URL、構成パス、デフォルト プロバイダー、Codex 自動起動設定、サービス状態、シム状態、および編集された有効な Codex ホーム。明示的で信頼性の高い Windows Orca ランタイム ホーム署名のみが、実用的なアプリとホームの不一致の警告を追加します。 `CODEX_HOME` が自動的に変更されることはありません。

人間の出力には、OAuth ログイン概要の後の **OAuth health** ブロックも含まれます。つまり、既知のすべてのアカウントが正常な場合は `OAuth health: ok`、または正常でないアカウントごとに 1 行が編集された `OAuth health: warning` (プロバイダー、マスクされたアカウント ID、再認証が必要、レートまたはクォータの制限、または更新の競合などのステータス) と、オプションの `Action:` ヒントが含まれます。アカウント ID は編集されます。トークンと電子メールは決して印刷されません。 `--json` 契約には現在、このヘルス ブロックは含まれていません。

```bash
ocx status
ocx status --json
```

省略形の例:

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
  "codexHome": {
    "effectiveCodexHome": "C:\\Users\\[USER]\\.codex",
    "appCodexHome": "C:\\Users\\[USER]\\.codex",
    "mismatch": false,
    "warning": null,
    "action": null
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

実際のオブジェクトには、`listen` (ポート、ホスト名、ランタイム/構成ソース)、構成ロード診断、およびバンドルされた Codex プラグイン診断も含まれています。 JSON スキーマは加算専用です。将来のバージョンではフィールドが追加される可能性がありますが、既存のフィールドは安定したままになるはずです。 API キー、OAuth トークン、認証ヘッダー、リクエスト コンテンツ、電子メール、アカウント ID は意図的に除外されます。

### `ocx health [--json]`

稼働中のプロキシの ID を確認します。ヒューマン出力は PID/ポートをレポートします。 `--json` は `{ok, pid, port}` を出力します。このコマンドは正常な場合のみ 0 で終了し、それ以外の場合は 1 で終了するため、サービス プローブに適しています。

### `ocx ready [--json] [--wait [--timeout <seconds>]]`

認証不要の `GET /readyz` エンドポイントで同期後の準備状態を確認します。準備完了時は `200`、
`pending` または終端状態の `failed` では `Retry-After: 1` とともに `503` を返します。HTTP の
サニタイズ済み識別フィールドは `{service, version, uptime, pid, port, status}` です。`/readyz` がない
旧プロキシは `unreachable` として fail-closed し、`/healthz` は readiness ではなく別の liveness 確認です。
デフォルトでは 1 回だけ probe します。`--wait` は準備完了または timeout まで polling しますが、
終端 `failed` を確認すると即座に終了します。デフォルト timeout は 45 秒で、`--timeout <seconds>` には
`--wait` が必要です（1〜300 秒の正の整数）。CLI JSON は
`{ready, status, pid, port}` を出力し、`status` は `ready`、`pending`、`failed`、`unreachable` の
いずれかです。終了コードは ready が 0、not-ready/pending/failed/timeout/unreachable が 1、
不正な引数が 64 です。

### `ocx doctor`

読み取り専用環境と接続の診断を実行します: 状態パスとファイル システム タイプ、WSL デュアル インストール、プロキシ環境/構成、ChatGPT の到達可能性、Codex プラグインとプロジェクト設定の警告、保留中の履歴の移行。 Codex のアプリとホームのターゲット設定セクションでは、Windows Orca ランタイムとホームの狭い不一致も検出し、該当する場合はサービスの移行について説明します。この診断によって表示されるパスでは、OS ユーザー名が編集されます。医師は修復ヒントを出力しますが、適用しません。

**OAuth の信頼性** セクションでは、資格情報ストレージが書き込み可能かどうか、リフレッシュ シングルフライト/ロック ファイルが `OPENCODEX_HOME` で作成できるかどうか、回復 `Action:` を持つ正常でない OAuth または Codex プール アカウント (編集された ID)、および Codex 転送パスが公式クライアント メタデータを作成しない静的 OK が報告されます。 Doctor は資格情報を変更したり、修復を適用したりすることはありません。

## カタログの同期

### `ocx sync [--restart-codex]`

構成されているすべてのプロバイダーからライブ モデル リストを取得し、マージされたカタログを Codex に再挿入します。プロバイダーを追加した後、または利用可能なモデルを更新するために実行します。

存続期間の長い Codex `app-server` プロセスがまだ実行されている場合、`ocx sync` は、`opencodex-catalog.json` / `models_cache.json` が更新されても、以前のメモリ内モデル リストを提供し続ける可能性があることを警告します。現在のユーザーが所有する一致する `codex … app-server` および `codex-code-mode-host` プロセスにのみ `SIGTERM` を送信するには、`--restart-codex` を渡します (アクティブなターンが中断される可能性があります)。広範な `pkill -f codex` 一致は意図的に回避されます。

### `ocx sync-cache [--restart-codex]`

Codex のローカル モデル ピッカー キャッシュを無効にし、アクティブな opencodex カタログから再構築されるようにします。 `ocx sync` と同じ、古い `app-server` 警告とオプションの `--restart-codex` 動作が適用されます。

## バックグラウンドサービス

### `ocx service [install|repair|restart|start|stop|status|uninstall|remove]`

opencodex を、ログイン時に自動起動し、クラッシュ時に自動再起動するログイン管理バックグラウンド サービス (macOS **launchd**、Linux **systemd ユーザー ユニット**、Windows **タスク スケジューラ**) として実行します。サービスは `OCX_SERVICE=1` を設定して実行されるため、再起動によって Codex 設定が変更されることはありません。

|サブコマンド |アクション |
| --- | --- |
|なし |未インストールなら作成して開始し、既存なら更新して再起動します。正常な Windows タスク スケジューラ定義は再利用しますが、古い定義は再登録され、昇格が必要になる場合があります。 |
| `install` |サービスを作成して開始します。 |
| `repair` | 既存のサービスを更新して再起動します。正常な Windows タスク スケジューラ定義は再利用しますが、古い定義は再登録され、昇格が必要になる場合があります。 |
| `restart` | `repair` の別名です。 |
| `start` |インストールされているサービスを開始します。 |
| `stop` |サービスを停止し、ネイティブ Codex を復元します。 |
| `status` |サービスとプロキシの診断とログ パスをレポートします。 |
| `uninstall` |サービスを削除し、ネイティブ Codex を復元します。 |
| `remove` | `uninstall`の別名。 |

```bash
ocx service
ocx service install
ocx service repair
ocx service restart
ocx service status
ocx service uninstall
```

Windows では、bare `ocx service` は、タスク スケジューラと WinSW の両方について不在が確認された後にのみ、インストール パスを実行します。どちらかのステータス照会が不確実な場合、何も登録せず、`ocx service status` の実行を案内します。不在を確認した後にのみ、明示的な `ocx service install` を使用してください。

Windows では、`ocx service status` は、ID 検証済みの OpenCodex プロキシの到達可能性とは別に、タスク スケジューラの登録を報告します。ローカライズされた `schtasks` テーブルは出力されないため、概要は Windows コード ページ間で読み取れるままです。

Windows では、タスク スケジューラ エントリを作成するには昇格が必要です。認識されたローカライズされたアクセス拒否テキストは、既存のガイダンス パスを維持します。そのテキストが判読できない場合、フォールバックには、所有されているコマンド形状 `/create /tn opencodex-proxy /xml <non-empty-path> /f`、ステータス 1、および確認済みの非昇格トークンが必要です。ダッシュボードのスタートアップ セーフティ アクションは、UAC を自動的に要求できるようになります。そのフォールバックがトークンの状態を判断できない場合、元のスケジューラ エラーが保持されます。外部タスクおよび操作は、自動昇格マーカーを発行することはできません。ダッシュボードの UAC プロンプトを承認するか、管理者特権の PowerShell ウィンドウで `ocx service install` を再実行します。

### `ocx codex-shim <install|status|uninstall|remove>`

軽量の自動起動スクリプトを使用して、スクリプトベースの `codex` ランチャーを PATH 上にラップします。実際の `codex.exe` ターゲットは、正確な実行可能呼び出しの破損を避けるため、変更されないまま残されます。

インストールまたは修復を確定する前に、OpenCodex はサービス起動をバイパスした状態で、保存済みランチャーを `--version` 付きで実行します。ランチャーが `codex` を再び shim に解決する、0 以外で終了する、5 秒を超える、子プロセスを残す、または安全に検証・クリーンアップできない場合、変更を拒否してロールバックします。したがって `codex-shim install` は無条件のインストールではありません。拒否された場合は、PATH エントリが具体的な実行ファイルまたはランチャーを指すよう Codex を再インストールしてから再試行してください。動的コマンドマネージャーのランチャーがこれらの検証を満たせない場合は、代わりに `ocx service install` を使用してください。

アップグレード時には、現在の検証ガードを持たない既存の Unix shim を再生成して検証します。保存済みランチャーが安全でない場合、OpenCodex は危険な wrapper を残さず、古い shim を削除して元のランチャーを復元します。

完了した外部 Codex アップデートがインストールされている shim を上書きした場合、次の通常の `ocx` コマンドは安定した新しいランチャーをバックアップし、ディスパッチ前に shim を復元します。副作用のない検査コマンド `ocx system codex-cli-update check` と、予約された `ocx system codex-cli-update` 名前空間の不正な呼び出しは、この修復を行いません。まだ変更中のランチャーは変更されず、後で再試行されます。修復の失敗は、要求されたコマンドを失敗させることなく警告します。手動フォールバック: `ocx codex-shim install`。 `codexShimAutoRestore` を `false` に設定するか、プロセス レベルのオプトアウトの場合は `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0` を設定します。

|サブコマンド |アクション |
| --- | --- |
| `install` |シムを取り付けます（または古い場合は修理します）。 |
| `uninstall` |シムを削除し、元の Codex バイナリを復元します。 |
| `remove` | `uninstall`の別名。 |
| `status` |シムの状態 (インストール済み、古い、または欠落) を報告します。 |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[サービス vs シム]
常時オンのバックグラウンド プロキシには `ocx service` を使用します (推奨)。デーモンを使用しない軽量のオンデマンド起動には、`ocx codex-shim` を使用します。プロキシは、`codex` が起動された場合にのみ起動します。
:::

### `ocx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]`

Windows ステータス トレイ アイコンをインストールして制御します。 Windows ログイン時に開始され、ワンクリックでプロキシ コントロールを提供します。 `start` および `stop` はアイコンのみを制御します。そのメニューを使用してプロキシを制御します。 `--no-start` は `install` に適用され、トレイをすぐに起動せずにインストールします。

## ダッシュボード

### `ocx gui`

`http://localhost:<port>` で [ウェブダッシュボード](/guides/web-dashboard/) を開き、プロキシが実行されていない場合は自動起動します。

## 更新

`ocx update` は OpenCodex 自体を更新し、Codex CLI は更新しません。[system 検査コマンド](/ja/reference/cli/agents/)の `ocx system codex-cli-update check` を使用すると、設定済みの Codex CLI 候補の provenance を範囲を限定して読み取り専用で確認できます。このコマンドは package registry に問い合わせず、更新をインストールしません。

### `ocx update [--tag latest|preview]`

npm から opencodex を自己更新します。安定したインストールでは `@latest` を使用します。 `--tag latest|preview` を渡さない限り、プレビュー インストールは `@preview` に残ります。ソース チェックアウトを検出し、代わりに `git pull && bun install` を使用するように指示しますが、そのタグの最新バージョンをすでに使用している場合は何もしません。npm インストールでは、何かを停止する前に Unix キャッシュの所有権とアクセスを上限付きで検査します。ネストされたシンボリックリンクは `lstat` で確認しますが追跡しません。Windows では、この Unix 専用検査を明示的にスキップします。検査に失敗した場合、トレイとプロキシを実行したまま更新を中止します。その後、実行中のプロキシはファイルが置き換えられる前に停止されます。インストールされたサービスは再構築されて自動的に開始されますが、フォアグラウンド インストールでは次のステップとして `ocx start` が出力されます。ダッシュボードの更新記録では、保存前にプロファイル／キャッシュのパスと UID/GID 値が秘匿されます。

```bash
ocx update
ocx update --tag preview
```

新しいバージョンは、[リリースワークフロー](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml) が npm に公開すると利用可能になります。
