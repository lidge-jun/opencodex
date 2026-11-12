---
title: リモートリンク
description: SSH で OpenCodex の Home コンピューターと Child コンピューターを接続します。
---

マシンリンクは SSH で OpenCodex の **Home** コンピューターと **Child** コンピューターを接続します。Home は SSH トンネルを通じて Child にサービスを提供し、両方のコンピューターはローカルの OpenCodex サービスを `10100` ポートで維持します。ダッシュボードは Child 専用のリンクキーを SSH で渡すため、トークンを入力する必要はありません。

## 要件

- Home から Child に OpenSSH キーでログインできること。
- Child から開始するリンクでは、Child から Home に OpenSSH キーでログインできる必要があります（パスワードログインには対応していません）。
- Child に OpenCodex 2.66.0 以降がインストールされていること（Child から開始するリンクでは Home にも）。
- 両方のコンピューターで macOS、Linux、Windows x64 を使用できます。Windows には OpenSSH Server と Windows PowerShell が必要です。Git Bash と curl は不要です。
- Home から Child を追加するダッシュボードは Home 上で開くか、ペアリング済みの Hub セッションを使用します。現在のコンピューターを Child にするには、オペレーターがペアリングしたダッシュボードセッションが必要です。認証情報なしのローカルセッションでは、このルーティング変更を確定できません。

パスワード SSH はサポートされません。リンクは Home または Child から開始できます。Windows では検証済みの OpenSSH 接続経由で PowerShell を実行します。

## `#remote` から Child を追加する

1. ダッシュボードで `#remote` を開き、Remote Link をオンにします。
2. **Home** を選び、**Continue** を押します。SSH ホストの一覧が開きます。
3. SSH の候補からホストを選ぶか、SSH 設定のエイリアスを入力します。
4. 接続テストを実行し、表示されたホストフィンガープリントを接続先コンピューターのものと比較します。比較すると、SSH がホストを信頼する前に、別のコンピューターや変更されたホストキーを検出できます。
5. フィンガープリントを確認して Child を接続します。

ダッシュボードはトークンの入力を求めません。先にホストをプローブし、フィンガープリントを明示的に確認するまでリンクを適用しません。

Child 追加画面には、Child が SSH 経由でこの Home のプロバイダーを使用することと、上記の前提条件が表示されます。別名は OpenCodex を実行する Home の `~/.ssh/config` から取得し、ブラウザーを表示するコンピューターとは限りません。検索が成功してもホストがない場合は、次のような `Host` エントリを追加して再検索してください。既存の別名の手入力も可能です。別名を選択または入力すると接続テストが有効になります。このガイドへのリンクもあります。

```sshconfig
Host devbox
  HostName devbox.example.com
  User you
  IdentityFile ~/.ssh/id_ed25519
```

検索に失敗した場合、空の一覧と表示せず、読み込み失敗、取得できた理由、再試行ボタンを表示します。接続テストの失敗理由とサニタイズ済み SSH ヒントは開いている画面だけに表示され、背後には重複しません。理由と下記の SSH 診断を確認して再試行してください。再検索では入力した別名を保持しますが、接続前にフィンガープリントの再確認が必要です。

## このコンピューターを Child として接続する

Home のプロバイダーを使うコンピューターで次の操作を行います。

1. ダッシュボードで `#remote` を開き、Remote Link をオンにします。
2. **Child** を選びます。SSH ホストの一覧が開きます。
3. Home の SSH ホストを選び、接続テストを実行してから、ホストのフィンガープリントを比較して確認します。
4. 注意事項を読み、**Connect as Child** を選びます。

接続すると、このコンピューターの OpenCodex が再起動します。すでに実行中の Codex ターンは先に完了し、再起動中の最大 1 分間は新しいリクエストが失敗することがあります。その後ダッシュボードは自動的に再読み込みされ、Child のリンクを表示します。Codex はこのコンピューターの `http://127.0.0.1:<port>/v1` を使い続け、トークンや環境変数の設定は不要です。ローカルの OpenCodex が各リクエストを Home に中継し、Home が自身のプロバイダーとアカウントで応答します。

**Child** にこのコンピューターを先にペアリングするよう表示された場合は、このコンピューターに設定された HTTP ループバック IP アドレスのダッシュボード（例: `http://127.0.0.1:<configured-port>`）を開いてください。ローカルのペアリングフォームは、ペアリングが必要で、ダッシュボードと API が同じループバックオリジンを使う場合にのみ表示されます。フォームの `ocx gui pair --origin "http://127.0.0.1:<configured-port>"` コマンドをコピーしてこのコンピューターのターミナルで実行し、使い捨てコードをフォームに貼り付けてください。フォームに表示された正確なオリジンを使ってください。プロバイダーの API キーや管理者トークンはペアリングコードではありません。ペアリングの不足と設定されたポートの不一致は別の原因です。

**Child** の役割には、OpenCodex がスタンドアロンモードで設定されたポートで動作していることも必要です。Child はまさにそのポートで再起動するためです。設定されたポートで動作していないとダッシュボードに表示された場合は、先にそのポートで OpenCodex を再起動してください。

## リンクの状態

- **Connected** は SSH トンネルが準備でき、Child が Home のリンクを使える状態です。
- **Reconnecting** はトンネルを再試行している状態です。再試行中はリクエストが `Retry-After` 付きの `503` を一時的に返すことがあります。自分のダッシュボードから接続した Child では、リクエストはまずトンネルの復帰を最大 15 秒待ちます。
- **Failed** は対応が必要な状態です。SSH 認証、確認済みのホストキー、転送、タイムアウトの理由を確認してください。SSH トンネルを張る側が、スリープ、障害、再起動の後も自動で再試行します。Home が追加した Child では Home が、自分のダッシュボードから接続した Child では Child が再試行します。タイムアウトや転送エラーの後は 1 分後に再試行し、失敗が続くたびに間隔を倍にして最大 5 分ごとになります。認証エラーの後は 5 分ごとです。ホストキーが変わった場合は再試行しません。すぐに再接続するには、Home のダッシュボードで **Retry** を選ぶか、Home で `ocx link reconnect --link-id <id>` を実行します。OpenCodex を再起動せずに、そのリンクのトンネルだけを張り直します。

リンクが失敗しても、ローカルプロバイダーへ自動的に切り替わることはありません。

## Child を削除する

Child の **Disconnect** を選び、エイリアスを確認します。Home はトンネルを停止し、その Child のリンクキーを失効させ、保存されたリンク記録を削除します。

Home から Child に接続解除コマンドを実行できない場合は **Remove here only** を選びます。これでこのコンピューターのトンネル、キー、記録だけを削除します。その後 Child にログインして実行します。

```bash
ocx disconnect
```

Child から開始したリンクを切断するには、Child で `ocx disconnect` を実行します。このコマンドはクライアントトンネルを切断し、SSH 経由で Home のリンクを失効させます。Home での失効に失敗すると、次のメッセージが表示されます: `Home revoke failed; run ocx link revoke --link-id <linkId> on the home.`

## セキュリティ

Child はリンクを通じて Home コンピューターのプロバイダーとプロバイダー認証情報を使います。Home は Child ごとに別のリンクキーを作り、リンクを削除するとそのキーを失効させます。確認前にホストフィンガープリントを比較し、別のコンピューターや変更されたホストキーを誤って受け入れないようにしてください。Tailscale の ID から発行されたダッシュボードセッションはマシンリンクを管理できません。 Child ではキーは OpenCodex の中にとどまります。Codex や Claude Code が Child で送る認証情報は Home に転送されず、Child で `127.0.0.1:<port>` に到達できるプログラムはキーなしで Home を使えます。これはスタンドアロン環境がローカルのプログラムに与えるのと同じ信頼です。他のサイトの Web ページは拒否されます。

## CLI リファレンス

```text
ocx link probe <alias> [--json]
ocx link add <alias> [--expect-fingerprint SHA256:…] [--json]
ocx link port [--json]
ocx link issue --alias <alias> --tunnel-port <port> [--json]
ocx link status [--json]
ocx link revoke --link-id <id> [--json]
ocx link reconnect --link-id <id> [--json]
ocx link check (--link-id <id> | --all) [--no-wait] [--json]
ocx link update (--link-id <id> | --all) --yes [--no-wait] [--json]
ocx link sync (--link-id <id> | --all) [--no-wait] [--json]
ocx link sync --link-id <id> (--restart-app-server-only | --restart-codex --yes) [--no-wait] [--json]
ocx link restart-codex --link-id <id> [--scope app-server|codex] --yes [--no-wait] [--json]
```

対話型端末（TTY）でない場合、`--expect-fingerprint` は必須です。対話型端末では省略できますが、提示されたフィンガープリントを明示的に承認する必要があります。

Home で `ocx link check (--link-id <id> | --all)` を実行すると、Home から追加した各 Child のインストール済みバージョン、インストール種別、更新経路を読み取ります。リンクの SSH 経由で Child の `ocx update --plan` を実行し（Child ごとに 60 秒、同時に 3 台まで）、計画を計算するだけで何も変更しません。2.97.0 より古い Child は `owner-action`（`legacy-ocx`）となり、バージョンは macOS と Linux では読み取り専用の SSH 呼び出しをもう 1 回行って、Windows ではリンク経由で報告されたバージョンから取得します。Child 側から接続したリンクと `ocx-child` の Child は SSH なしで報告されます。`ocx link status --json` は各行に `child` ブロック（バージョン、バージョン差、カタログの鮮度、アクティビティ、直近の操作）を追加します。詳細と終了コードは [Child install, catalog and activity](/guides/remote-link/#child-install-catalog-and-activity)（英語）を参照してください。

### Home から Child を操作する

`ocx link sync`、`ocx link restart-codex`、`ocx link update` は、Home から追加した Child に対してリンクの SSH 接続経由で実行され、ジョブを JSON で出力します。`sync` は固定された `ocx sync --expect-link` を実行します（Child は 2.93.0 以降）。`restart-codex` は同期してから Child の Codex app-server を再起動し、実行中の Codex に現在のカタログを読み込ませます。`--scope codex` はデスクトップアプリも再起動します。再起動は 1 つのリンクだけを指定します。`restart-codex` と `--restart-codex` には `--yes` が必要ですが、`ocx link sync --link-id <id> --restart-app-server-only` は確認なしで app-server を再起動します。Home がその Child のモデルリクエストを中継している間は再起動を見送ります（`restart-skipped:link-active`）。2.69 より古い Child では、ストリーミングでないリクエストは応答が始まるまで検出されません。`update --yes` は Child 自身の更新機構で Child の OpenCodex をこの Home のバージョンに更新し、他のバージョンにはしません（Child は 2.97.0 以降。npm と pnpm は Node ランチャー経由で適用するため、`ocx link check` もそこで読み取り専用の `node --version` を実行します）。1 台ずつ処理し、適用が成功、失敗、ロールバックした後に再同期します。結果が不明な適用は再実行も再同期もしないため、`ocx link check` で確認してください。その Child に中継中のリクエストは終了します。Windows の Child は `sync` のみに対応し、`ocx-child` の Child は再起動と更新を非対応として報告します。CLI にはループバックにバインドされた Home が必要です。それ以外の Home ではこれらの操作は使えず、ダッシュボードの Remote Link ページでは、Home から追加した Child に対して同じ操作を提供します。詳細と終了コードは [Operating Children from the Home](/guides/remote-link/#operating-children-from-the-home)（英語）を参照してください。 この保護はベストエフォートです。確認から再起動までの間に始まったリクエストは終了することがあるため、ターンを残す必要がある場合はその Child で新しいリクエストを止めてください。 Home は、Codex がモデルリクエストではなくツールを実行しているターンの途中かどうかも判別できないため、その Child で Codex を再起動したり OpenCodex を更新したりする前に、実行中の Codex ターンが終わるのを待ってください。手動更新はその Child の OpenCodex を再起動し、その Child のために中継中のターンを終了します。自動更新は Child がアイドルになるまで待ちます。 `ocx sync --restart-children`（または `--restart-children=codex --yes`）は、Home の同期を伝播するときに、すべての Child または `--child <linkId>` で指定した Child に同じ規則を適用します。各 Child は同期され、中継中のリクエストがある間は再起動だけがスキップされます（`restart-skipped:link-active`）。

### Child のバージョンと操作

Home では、Remote Link の各行に Home がその Child について最後に把握した内容が表示され、Home から追加した行にはその Child を操作するボタンも表示されます。バッジの意味は次のとおりです。

- Child のバージョンと、その横の `Behind Home (<home version>)`、`Same version as Home`、`Newer than Home`。更新を適用できる場合は `Update available: <home version>` も付きます。Child 自身のダッシュボードから開始したリンクはバージョンのみを表示し、バージョン差のバッジは付きません。`ocx-child` の Child は常に `unknown` と表示されます。
- インストール種別（`Desktop app`、`GOAT`、`Source checkout`）。このリリースで名前のない種類は等幅のトークンで表示されます。
- `Catalog current` または `Catalog out of date`。`Codex restart needed (<n>)` と `Codex not running` は、Child が自身の Codex 状態を報告して初めて表示されます。その報告は今後のリリースで追加されるため、まだ送信する Child はなく、現在この 2 つのバッジは表示されません。
- 最後の操作を `Last <operation>: <state>` として理由を等幅で示し、ジョブがリンクを占有している間は実行中の操作を示します。

Home がその Child を自分で更新できない場合、行には代わりに何をすべきかが表示されます。その Child の OpenCodex Desktop で Check for Updates を使う、手動で更新する、`mise` 経由で更新する、または GOAT に任せる、のいずれかです。不明な理由は推測した文ではなくトークンとして表示されます。

4 つの操作は CLI と同じジョブを開始するため、Child にも同じバージョンが必要です。

- **Check** は `ocx link check` と同様に Child のインストール情報を読み取ります。
- **Sync now** は `ocx link sync` と同様に固定された `ocx sync --expect-link` をそこで実行します。
- **Restart Codex** は範囲の選択を開きます。`Codex app-servers` は Child のバックグラウンド app-server を再起動して現在のカタログを読み込ませます。Codex デスクトップアプリ自身の app-server は更新されないため、その場合はデスクトップアプリを再起動してください。`Codex desktop app` はデスクトップアプリも終了して再起動し、そこで開いている会話が終了します。
- **Update** は `ocx link update` と同様に、Child 自身の更新機構で Child の OpenCodex をこの Home のバージョンにします。確認には、Child の OpenCodex が再起動してその Child のために中継中のターンが終了すること、自動更新は Child がアイドルになるまで待つことが示されます。

**Check all** と **Update all** は対象となるすべての Home 起点リンクに作用します。Update all も 1 台ずつ実行し、別のバージョンを対象にすることはありません。実行中のジョブは Child ごとに 1 行で、状態、移動したバージョン（元と先）、カタログ同期の結果、再起動の結果を表示します。ジョブが終わるとパネルは消え、行が更新されます。Home がもう把握していないジョブ（Home が再起動した場合）はその旨を表示し、各行自身の状態が答えになります。ジョブがリンクを占有している間は、その行の操作と Disconnect は無効になります。サーバーもいずれにせよその要求を拒否します。

一覧の下にある **Child automation** パネルは、`ocx link policy` と同じポリシーファイルを表示・編集します。カタログ配信（既定は自動）、Codex の再起動（既定はなし）、更新（既定はアイドル時に自動、このリリースではまだ有効ではありません）、アイドル期間です。保存では変更した値だけを書き込みます。ポリシーファイルが破損している場合、パネルは自動カタログ配信と自動更新が無効であると表示し、その状態での保存は選択したモードがそのまま残るようすべての設定を書き込みます。これらのコントロールがサーバーを迂回することはありません。サーバーはジョブごとにポリシー、リンク状態、Child の活動を再確認します。

所有していないマシンはリンクしないでください。Home はあなたの SSH キーでそこにコマンドを実行します。

### カタログの自動配信と Child ポリシー

カタログの配信は既定で有効です。Home のカタログが変わると（カタログの自動更新が変更を報告したとき、またはダッシュボードや管理 API での編集を 5 分ごとの確認が検出したとき）、Home は編集が落ち着くまで 60 秒待ちます（最初の変更から最長 5 分）。その後、操作なしで、対象となる各 Child へバックグラウンドで SSH セッションを開き、`ocx link sync` と同じ固定された `ocx sync --expect-link` を実行します。Codex の再起動は、有効にしない限り行いません（後述の `childCodexRestart`）。対象となるのは、Home が開始したリンクで、トンネルが接続中で、ほかの操作が実行されておらず、この Home がその Child で最後に実行した同期が変更より前の Child です。カタログをダウンロードしただけの Child は遅れているものとして扱われます。モデルリクエストを中継中の Child は、Codex 設定がすでに Home と一致し、その設定の適用後に OpenCodex クライアントランタイムが再起動済みの場合にだけ同期されます。そうでなければ、同期がそのランタイムを再起動するためです。それ以外の場合は、アイドルになってから同期されます。失敗した同期は 5 分後に再試行され、間隔は倍々で最長 6 時間まで延びます。2.93.0 より古い Child は、別のバージョンを報告するまで再試行されません。これらのジョブはほかのジョブと同じように表示され、`trigger: "auto"` が付きます。リンクのない Home では、これらは一切動きません。

配信で直るのは Child のカタログファイルです。Child ですでに動いている Codex app-server は、再起動するまで読み込んだ一覧を使い続けます。`ocx link restart-codex --link-id <id> --yes` か `ocx sync --restart-children` を使うか、`ocx link policy --child-codex-restart app-server-when-idle` で Home に app-server を再起動させてください。Home がこれを行うのは、同期の実行時にまだアイドルの Child だけです。この設定は次の自動同期から効きます。カタログがすでに最新の Child は同期されないため再起動もされません。その Child は手動で再起動してください。

ポリシーは Home の `<configDir>/link/child-policy.json` に保存され、`config.json` には入りません。

| 設定 | 既定値 | 値 |
|---|---|---|
| `catalogFanout` | `auto` | `auto`, `manual` |
| `childCodexRestart` | `never` | `never`, `app-server-when-idle` |
| `updates` | `auto-when-idle` | `off`, `notify`, `auto-when-idle` |
| `idleAfterMs` | `600000` (10 分) | 1〜60 分 |

`updates` の既定値は、アイドルの Child を自動的に Home のバージョンにそろえる設定です。自動更新はこのリリースではまだ動作しません。設定は今から保存されるため、`ocx link policy --updates notify` または `--updates off` で無効にしておけば、自動更新が導入されたときもその選択が保たれます。`idleAfterMs` は、中継されたモデルリクエストがない状態がどれだけ続けば Child をアイドルとみなすかを表し、`ocx link status` の `activity.idle` もこれで決まります。

```text
ocx link policy                                    # ポリシーを読む
ocx link policy --catalog-fanout manual            # カタログの自動配信を無効にする
ocx link policy --child-codex-restart app-server-when-idle
ocx link policy --updates off --idle-after-minutes 20 --json
```

`GET` と `PUT /api/link/children/policy` は同じ設定を読み書きします（ループバックでの管理トークン、またはダッシュボードのセッション）。`PUT` は変更する設定だけを送ります。ファイルが壊れているか不明な値を含む場合、カタログの自動配信と自動更新は無効になり、`ocx link policy` がその旨を表示します。保存すると警告は消えますが、指定しなかった設定は無効のままです。`ocx link policy --catalog-fanout auto --updates auto-when-idle` のように明示的に有効にしてください。Home がこのファイルを自分で書き直すことはありません。

自分が所有していないマシンをリンクしないでください。Home はあなたの SSH 鍵でそのマシン上のコマンドを実行します。

## 関連ガイド

- [Remote Hub のデプロイ](/ja/guides/remote-hub/)
- [リモートワークスペース](/ja/guides/remote-workspace/)


端末では `ocx link probe <alias> --json` で指紋とバージョンを確認し、`ocx link add <alias> --expect-fingerprint SHA256:… --json` で接続できます。指紋を省略すると対話端末で明示的な確認が必要です。Home は Child の再起動サポートと curl を事前確認し、接続後に再起動と実際のリレーを検証します。Child 設定が残った場合は Child で `ocx disconnect` と `ocx restart` を実行してください。[詳細（英語）](/guides/remote-link/#add-a-child-from-the-terminal)。
