---
title: CLI プロバイダー、アカウント、およびモデル
description: プロバイダー構成、資格情報、クォータ、およびモデル カタログ コマンド。
---

これらのコマンドは、上流プロバイダーの構成、アカウントの認証、資格情報プールの管理、Codex に公開されるモデル カタログの制御を行います。

## プロバイダー

### `ocx provider <subcommand>`

非対話型のプロバイダー管理。レジストリ エントリは名前によってシードされます。カスタム名には `--adapter` と `--base-url` の両方が必要です。

|サブコマンド |サポートされているフラグ |アクション |
| --- | --- | --- |
| `list` | `--json` |構成されたプロバイダーと残りのレジストリ エントリを一覧表示します。 |
| `add <name>` | `--adapter <adapter>`、`--base-url <url>`、`--api-key <key>`、`--default-model <model>`、`--set-default`、`--force`、`--json`、`--sync` |レジストリ/カスタムプロバイダーを追加します。 `--force` は上書きします。 `--sync` は、実行中のプロキシを人間出力モードで更新します。 |
| `edit <name>` |プロバイダーフィールドフラグ、`--headers <json>`、`--json` |キー プールを置き換えずに、検証済みのライブ プロバイダー フィールドを編集します。`--headers` はカスタム要求ヘッダーをマージします。`{}` または `-` を渡すとクリアします。 |
| `test <name>` | `--json` |実際の上流モデルのエンドポイントを調査します。 |
| `show <name>` | `--json` | API キーをマスクして設定を表示します。 |
| `remove <name>` | `--json` |デフォルト以外のプロバイダーを削除します。最後のプロバイダーは削除できません。 |
| `set-default <name>` | `--json` |既存のプロバイダーをデフォルトとして選択します。 |
| `selected <name>` | `--set <ids>`、`--clear`、`--json` |プロバイダー モデルのホワイトリストを読み取るか更新します。 |
| `quota` | `--refresh`、`--json` |プロバイダー クォータ レポートを読み取ります。 |
| `presets` | `--json` |ダッシュボードプロバイダーのプリセットを一覧表示します。 |
| `account-mode` | `pool`、`direct`、`--json` |プールされた Codex アカウント ルーティングまたは直接の Codex アカウント ルーティングを選択します。 |

```bash
ocx provider list --json
ocx provider test ark
ocx provider add anthropic --api-key sk-ant-... --set-default --sync
ocx provider add local-dev --adapter openai-chat --base-url http://localhost:11434/v1
ocx provider show anthropic --json
ocx models --provider anthropic --json
ocx models live --provider ark --json
```

:::caution[カスタムヘッダーは認証情報の経路ではありません]
`--headers` は秘密ではないリクエストメタデータ用です — ルーティングヒント、テナントや
プロジェクトのセレクター、トレース ID など。認証情報を入れる場所ではなく、バリデーターは
標準的な認証ヘッダー名（`Authorization`、`X-Api-Key`、`Cookie` など）を
`apiKey` / `authMode` を使うよう案内して拒否します。

ただし `X-My-Token` のような任意の名前までは判別できないため、その境界は利用者が守る
必要があります。理由は 2 つです。

- JSON はコマンドライン引数なので、秘密を入れるとシェル履歴とプロセス一覧に残ります。
  CLI が何かを伏せるより先に、同じマシンの別プロセスが読み取れます。
- ヘッダー値は `config.json` に平文で保存されます。専用の保存・マスキング経路を持つ
  API キーとは異なります。

秘密にあたる値は `--api-key` か OAuth ログインを使ってください。
:::

## 認証

### `ocx login <provider>`

プロバイダーの登録済みログイン フローを開始します。 OAuth プロバイダーはブラウザを開き、自動更新された認証情報を `~/.opencodex/` に保存します。 API キー ログイン プロバイダーは、キー ダッシュボードを開き、キーの入力を求め、可能な場合は検証し、結果のプロバイダー設定を保存します。名前が欠落しているか不明な場合、このコマンドは現在受け入れられている OAuth および API キーのプロバイダー ID を出力します。

`ocx status` / `ocx doctor` が再認証が必要であるか、端末の更新失敗を報告した後、同じコマンドを使用して **再認証**します (またはダッシュボードで再認証を使用します)。 Codex プール アカウントはパブリック `ocx login` プロバイダーではありません。代わりに、ダッシュボード Codex アカウント プール (再認証) またはヘッドレス `ocx account reauth` フローを介して再認証します。

```bash
ocx login xai
ocx login anthropic
```

### `ocx logout <provider>`

保存されているプロバイダーの OAuth 資格情報を削除します。

## アカウントとキープール

### `ocx account <subcommand>`

実行中のプロキシを介してプロバイダー アカウントと API キー プールを一覧表示し、切り替えます。出荷されたヘルプ画面は次のとおりです。

```text
Usage: ocx account <list|current|use|refresh|auto-switch|priority|login|reauth|code|cancel|remove|add-key|reset-credits> ...

list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).
current <provider>  Show the active account or key.
use <provider> <id> Switch the active credential; 'main' selects the Codex App login.
refresh <provider>  Force-refresh Codex or provider quota reports.
auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.
priority <provider> <id|main> [first|earlier|normal|later|last|-100..100|reset]  Selection order; omit the value to read it.
remove <provider> <id> --yes  Remove a stored account or key after an existence check.
add-key <provider> [--label <label>]  Add a key read only from piped stdin.
login/reauth/code/cancel  Run browser or manual-code auth from a headless shell.
reset-credits <id|main> [--consume --yes]  Inspect or consume Codex reset credits.
Codex pool selection applies to the next request after clearing existing affinity; in-flight requests keep their captured account.
```

すべてのサブコマンドではプロキシが実行されている必要があります。 CLI は、記録されたランタイム ポートを自動解決します。操作が成功した場合は 0 で終了します。無効な使用法、不明なプロバイダーまたはアカウント/キー ID、到達不能なプロキシ、または API エラーが発生した場合は 1 で終了します。資格情報フィールドは、管理 API が返したとおりに表示されます (マスキングを含む)。生の API キーと OAuth トークンは決して返されません。表示の利便性は、ダッシュボードと同様にクライアント側で合成されます。`main` は、`openai` アカウント プール内の Codex アプリ ログインの CLI エイリアスであり、電子メールのない OAuth アカウントは `Account N` として表示され、プラン/ラベル列はプラン、マスクされた電子メール、ラベル、およびマスクされたキーにわたってフォールバックされます。

`--json` アカウント行では、次の一般的な形状が使用されます (オプションのフィールドが使用できない場合は省略されます)。

```json
{
  "provider": "openai",
  "type": "codex | oauth | api-key",
  "id": "__main__",
  "label": "plus",
  "email": "m***@example.com",
  "plan": "plus",
  "priority": 0,
  "masked": "sk-ab****wxyz",
  "active": true,
  "needsReauth": false,
  "quota": null
}
```

### `ocx account list [provider] [--json] [--all] [--quota [--refresh]]`

プロバイダーを使用しない場合、Codex プール、OAuth アカウント、および設定された API キー プールが一覧表示されます。 `--all` が存在しない限り、空のプロバイダーはスキップされます。プロバイダーを使用すると、その資格情報ファミリーのみがリストされます。人間の出力では `PROVIDER TYPE ID PLAN/LABEL PRIORITY STATUS` を使用します。手動で選択した Codex 行には `selected` というマークが付けられます。利用可能な Kiro アカウントが 2 つ以上保存されている場合、既定では 429 を受けると別のアカウントへ自動的に切り替え、既知の残り利用枠が最も多いアカウントを優先します。この切り替えはアカウントの存在によって有効になり、`oauthAccountFailover.enabled: false` で無効にできます。`ocx account login kiro` はアカウントを 1 件ずつプールへ追加します。結果が空であっても成功です。 `--json` は次を返します:

```text
{ accounts: AccountRow[], notes: string[] }
```

### `ocx account current <provider> [--json]`

アクティブなアカウントまたはキーを表示します。手動ピンのない Codex プールは、優先度を考慮した自動選択を報告します。最も優先度の高い適格ティアが選ばれ、そのティア内でクォータルーティングのもと最低使用量のアカウントが選ばれます。アクティブな認証情報を持たない別のファミリーは、その状態を報告し、依然として 0 を終了します。`--json` は次を返します。

```text
{ provider, type, activeId: string | null, autoSwitchThreshold?: number, account: AccountRow | null }
```

### `ocx account use <provider> <account-or-key-id|main> [--json]`

既存の Codex アカウント、OAuth アカウント、または API key を選びます。`openai` で `main` は Codex App ログインを
選択します。Codex Pool の選択は process-local affinity を消去し、既存の表示タスクを含む次のリクエストから適用されます。プロキシ再起動や affinity eviction 後もタスクは未紐付けになり得ますが、処理中のリクエストは取得済みアカウントを維持します。この選択は Pool routing のみを制御し、Direct mode は caller-owned/native main credential を使い続けます。使用量ベースのプロアクティブ切り替え、401/403 再認証、429/retry-after cooldown、除外、出力前 429/402 の障害回復により、後で別の適格 Pool アカウントが選ばれる場合があります。これらの回復経路は使用量ベース切り替えが off でも有効です。アカウント変更後も OpenCodex は会話コンテキストを再生しますが、provider prompt cache は再ウォームアップが必要な場合があります。
不明なプロバイダーや id は終了コード 1 です。`--json` は次を返します。
**401/403** では、そのアカウントへのプロセスローカルな affinity を解除し、再認証を要求します。
**429** では `Retry-After` を尊重してアカウントの cooldown を開始し、affinity を解除したうえで、
別の適格な Pool アカウントへリクエストを切り替えることがあります。これらの障害回復は
`autoSwitchThreshold: 0` でも有効であり、`0` が無効にするのは使用量に基づく予防的な切り替えだけです。

```text
{ ok: true, provider, type, activeId }
```

### `ocx account refresh <provider> [--json]`

Codex プールの場合は、`ocx account refresh openai [--json]` を使用します。アカウント クォータを強制的に更新し、利用可能な週次/月次のパーセンテージとリセット時間を出力します。不足しているクォータ データは、0% ではなく不明として報告されます。その JSON エンベロープは `{ accounts: AccountRow[] }` で、Codex の各行に `quota` があります。

OAuth プロバイダーと API キー プロバイダーの場合、これによりプロバイダー クォータ レポート エンドポイントが強制的に更新されます。これは、トークンの再ログインや単純なアカウント リストの再読み取りではありません。 `--json` は `{ provider, report: ProviderQuotaReport | null }` を返します。サポートされているクォータ レポートがないプロバイダーは、`no quota report available for <provider>` を出力して 0 を終了します。不明なプロバイダーと管理 API のエラーは 1 を終了します。失敗またはタイムアウトしたアップストリーム クォータ プローブは、代わりに null または古いレポートに劣化し (終了 0)、ダッシュボードのクォータ バーと一致します。

### `ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]`

`openai` Codex アカウント プールのみを制御します。 `on` は 80% を設定し、`off` は 0% を設定します。`status` は現在の値を読み取り、`threshold <n>` は 0 ～ 100 の整数を受け入れます。他のプロバイダーと無効な値は 1 を終了します。`--json` は次を返します。

```text
{ provider, autoSwitchThreshold: number, enabled: boolean }
```

### `ocx account priority <provider> <account-id|main> [<-100..100|first|earlier|normal|later|last|reset>] [--json]`

Codex pool のアカウント別選択順を読み書きします。**値が大きいほど先に使われ**、既定は `0`、範囲は
`-100` から `100` です。順序を持つのは `openai` の Codex pool だけなので、他のプロバイダーは終了コード
1 です。`main` は Codex Desktop ログインを指し、他の pool アカウントと同じように並べ替えられます。
`ocx account priority openai main last` とすれば予備として最後に回せます。

プリセット語は小さな整数の別名です。`first` が `+2`、`earlier` が `+1`、`normal` が `0`、`later` が
`-1`、`last` が `-2` です。`reset` は既定に戻し、保存されたエントリを削除します。**値を省略すると
読み取り**になり、現在の順序を書き換えません。

順序が決めるのは「どのアカウントから見るか」であって「どれが使えるか」ではありません。選択は引き続き
適格なアカウントの中で行われ、まだ quota に余裕がある最上位 tier を取り、その中は
`accountPoolStrategy` が選びます。一時停止、cooldown、再認証には影響しません。変更は新しいセッションだけでなく **次の未バインドリクエスト** から適用されます。上位の順序に余裕が戻れば
preemption が未バインドリクエストを直ちに引き上げます。既にアカウントに紐づいた thread は、通常はそのアカウントを
使い切るまで維持します。ただし再認証エラー、quota cooldown、一時的な失敗の連続はそれより早く紐付けを解除します。受理された書き込みは、どのアカウントの手動の「今すぐこのアカウントを使う」固定も解除します。すでに設定済みの順序を書き込んだ場合も同様で、これは現在選択中のアカウントを保ったまま固定を解除する唯一の方法です（管理 API でアクティブアカウントを解除しても固定は解除されますが、その選択自体も失われます）。プロキシに接続できない場合、
不明なアカウント id、受け付けない値はいずれも終了コード 1 です。`--json` は次を返します。

```text
{ ok: true, provider, id, priority: number, preset: string | null }
```


### `ocx account login|reauth|code|cancel ...`

ヘッドレス シェルからブラウザベースまたは手動コードのアカウント認証を実行します。プロバイダー固有のコマンド形式には `ocx account --help` を使用します。Codex account login は保存済みでも catalog refresh が保留中なら成功終了し、human output の stderr に固定の `ocx sync` 案内を出します。`--json` は案内を混ぜず、完了 state に `catalogRefreshPending: true` を保持します。

### `ocx account remove <provider> <id|main> --yes [--json]`

この保護された非対話型削除には `--yes` が必要です。削除する前に、ID が存在することが確認されます。 ID が欠落している場合は、DELETE を送信せずに 1 が終了します。メインの Codex App ログインは削除できないため、`remove openai main --yes` は拒否されます。削除後、ファミリーは再度読み取られます。固定された Codex アカウントを削除すると、ピンがクリアされ、自動選択に戻ります。 OAuth は最初に残ったアカウントを昇格させるか、何も報告しません。 API キー プールは、最初に残っているキーを昇格するか、何も報告しません。 `--json` の成功と失敗の形状は次のとおりです。

```text
{ ok: true, provider, id, removedActive: boolean, promotedActiveId: string | null, catalogRefreshPending?: boolean }
{ error: string } // stderr, exit 1
```

`catalogRefreshPending` は Codex 削除だけに含まれます。`true` でも削除は保存済みで、human output は
stderr に `ocx sync` の案内を出して終了コード 0 のままです。OAuth account と API key の削除形状は変わりません。

### `ocx account add-key <provider> [--label <label>] [--json]`

API キー プロバイダーのキーを追加してアクティブ化します。キーは、非 TTY パイプ/リダイレクトされた標準入力からの読み取り専用です。インタラクティブ TTY 入力、空の入力、OAuth/Codex プロバイダー、および API エラー終了 1。キーがラベル内に表示される場合も含め、キーがエコーされることはありません。シークレット マネージャーまたはヒア文字列を使用することをお勧めします。

```bash
ocx account add-key openrouter --label personal <<< "$OPENROUTER_API_KEY"
security find-generic-password -w openrouter | ocx account add-key openrouter --json
```

`--json` は `{ ok: true, id: string | null, label?: string }` を返しますが、キーは決して含まれません。

### `ocx account reset-credits <id|main> [--consume --yes]`

アカウントの Codex リセット クレジットを検査します。クレジットの消費は破壊的であり、`--consume` と `--yes` の両方が必要です。

### `ocx account main <subcommand>`

OpenCodex のアカウントプールルーティングを変更せずに、名前付きのネイティブ Codex メインログインプロファイルを管理します。

```text
ocx account main doctor [--json]
ocx account main list [--json]
ocx account main register <label> [--json]
ocx account main add <label>
ocx account main switch <profile-id-or-label> --yes [--json]
ocx account main recover [--rollback --yes] [--json]
```

各変更コマンドは、実行中のプロキシが返す正規化済みの有効な `CODEX_HOME` を表示します。このパスは
呼び出し元の `CODEX_HOME` と異なる場合があり、JSON 対応コマンドは同じ値を
`effectiveCodexHome` として返します。

バージョン 1 はファイルベースの Codex 認証をサポートし、保存したプロファイルを AES-256-GCM で暗号化し、暗号鍵を OS の資格情報ストアに保持します。`add` は、生成された資格情報を取り込む前に公式 Codex ログインをステージングします。プロファイルを切り替える前に Codex を終了してください。切り替えに成功するとローカルのタスクと履歴は保持されますが、続行する前に Codex の再起動が必要です。`doctor` でプロファイル状態を確認し、`recover` で中断した切り替えを完了またはロールバックできます。`switch` にはプロファイル ID またはラベルを指定できます。

v1 の復旧マトリクスが対象とするのは、トランザクションファイルの rename による公開後に OpenCodex プロセスが終了した場合です。OS またはカーネルのクラッシュや突然の電源断に対する永続性は保証しません。`atomicWriteFileAsync()` はファイルまたは親ディレクトリに `fsync` を実行しません。

暗号化された vault、切り替えジャーナル、復旧マーカー、および journal-quarantine ファイルは、正規の `<real CODEX_HOME>/.opencodex-native-main-profiles` ディレクトリに保存されます。そのため、その Codex ホームを共有するすべての OpenCodex インスタンスは、同じ 1 つの所有者と同じ 1 つの復旧状態を参照します。平文のログインステージングは、各 `<OPENCODEX_HOME>/native-main-profile-staging` ディレクトリ配下にそれぞれ分離されたままです。

native-main トラフィックまたはジャーナル復旧を受け入れる前に、ライフタイム所有者が資格情報に対する排他的な権利を取得し、名前が正確に `auth.json.ocx.<pid>.<sequence>.tmp` と一致するクラッシュ残留ファイルだけを削除します。各候補は、変更されていない正規の `CODEX_HOME` 配下にあり、ハードリンク数が 1 の通常ファイルであり続けなければなりません。その内容を切り詰め、フラッシュしてからリンクを解除します。リンクまたは再解析ポイントへのすり替え、ファイル識別情報の変化、その他の曖昧さがある場合は native-main トラフィックを引き続き拒否し、名前が似ているだけのファイルは自動的には決して削除しません。これは、協調動作する OpenCodex のクラッシュから保護するためのものであり、同じ OS ユーザーとしてすでに実行中の悪意あるプロセスから保護するものではありません。そのユーザーと `CODEX_HOME` を格納するファイルシステムは引き続き信頼対象であり、切り詰めによってコピーオンライト方式のストレージ、スナップショット、または SSD の残留データから物理的に消去されることは保証されません。

プレビュー版では `<OPENCODEX_HOME>/native-main-profiles` を使用していました。このレイアウトが暗黙にインポートされることはありません。`doctor` が旧形式のプロファイル状態を報告した場合は、同じ `CODEX_HOME` を共有するすべての OpenCodex プロキシを停止してください。そのうえで、該当する `*.vault.json`、`*.journal.json`、復旧マーカー、および参照されている journal-quarantine ファイルをバックアップし、所有者だけがアクセスできる権限を維持したまま、すべて一緒に正規ディレクトリへ移動してください。別の方法として、古いプレビュー版の一式を削除し、`ocx account main register` を再度実行することもできます。同じ `CODEX_HOME` を共有するプロキシが 1 つでも稼働している間は、複数の旧ルートから 1 つを選ぶことも、両方のレイアウトを併用することも避けてください。Windows では、以前の大文字小文字を区別しないホーム識別子に紐付いたプレビュー状態は、移動せずリセットする必要があります。暗号化された AAD と OS キーリングの識別子は、意図的に再利用されないためです。

## モデル

### `ocx models [subcommand]`・`ocx model <subcommand>`

`ocx model` は `ocx models` の別名です。サブコマンドを使用しない場合、構成されたプロバイダーに静的にシードされたモデルを一覧表示します。 `--provider` は 1 つの構成済みプロバイダーをフィルターし、`--json` はモデル メタデータを返します。 `live` は実行中のカタログを読み取ります。 `add`、`edit`、`remove`、および `list-custom` は手動カタログ エントリを管理します。 `enable`、`disable`、および `provider` は可視性を制御します。 `selected` はプロバイダー許可リストを制御します。 `context` はプロバイダーのコンテキストの上限を制御します。 `shadow` はバックグラウンドのシャドウ コール インターセプトを管理します。

ダッシュボードが提供するモデルごとの操作はすべてここで利用できるため、ヘッドレスインストールではカタログを管理するために GUI が必要ありません。 `add`、`remove`、および `list-custom` は設定ファイルに対して機能し、カタログ同期を通じて実行中のプロキシに適用されます。残りはライブ管理 API と通信し、プロキシが実行されている必要があります (`ocx start`、またはインストールされたサービス)。

|サブコマンド |サポートされているフラグ |アクション |
| --- | --- | --- |
| `list` (デフォルト) | `--provider <name>`、`--json` |構成されたプロバイダーにシードされたモデルをリストします。 |
| `live` | `--provider <name>`、`--json` |実行時に検出されたモデルを含む、実行中のカタログを読み取ります。行には、`native`/`routed`、`custom`、および `enabled`/`disabled` というフラグが付けられます。 |
| `add <provider> <modelId>` | `--display-name <name>`、`--context-window <tokens>`、`--modalities <text,image,audio>` |プロバイダー カタログが宣伝していないモデルを登録します。 |
| `edit <custom-id>` | `--model-id <id>`、`--display-name <name\|->`、`--context-window <tokens\|0>`、`--modalities <text,image,audio\|->`、`--json` |カスタムモデルを編集します。 `-` はフィールドをクリアします。 `0` はコンテキスト ウィンドウをクリアします。 |
| `remove <custom-id\|provider/modelId>` | `--yes` |カスタムモデルを削除します。標準入力が対話型端末ではない場合は、`--yes` が必要です。 |
| `list-custom` | `--json` |他のサブコマンドで取得される `custom-id` を持つすべてのカスタム モデルを表示します。 |
| `enable <provider/model\|native-model>` | `--native`、`--json` | 1 つのモデルを Codex に表示できるようにします。 |
| `disable <provider/model\|native-model>` | `--native`、`--json` | Codex から 1 つのモデルを非表示にします。 |
| `provider <name> <on\|off>` | `--json` | 1 つのプロバイダーのすべてのモデルを 1 回の書き込みで有効または無効にします。 |
| `selected <provider>` | `--set <id,id...>`、`--clear`、`--json` |プロバイダー モデルのホワイトリストを読み取るか置き換えます。 `--clear` はホワイトリストを削除し、すべてのモデルが提供されるようにします。 |
| `context <status\|value <tokens> [--set-all]\|provider <name> on [--value <tokens>]\|provider <name> off\|all <on\|off>>` | `--json` |コンテキスト ウィンドウ キャップをグローバルに、またはプロバイダーごとに読み取りまたは設定します。 `value <tokens> --set-all` はすべてのルーティング済みプロバイダーにも値を再適用します（ダッシュボードのトグルと同様）。指定しない場合は既定値のみが変更されます。 `provider ... on --value <tokens>` はそのプロバイダーのみに個別のキャップを設定します（`--value` は `on` でのみ使用できます）。 |
| `shadow <status\|set> [model\|-]` | `--enabled <on\|off>`、`--json` | Codex のバックグラウンド ヘルパー呼び出しの置換モデルを読み取るか、設定します。 `-` はモデルをクリアします。 `status` は `sourceModels` も報告し、プロキシがインターセプトするヘルパースラッグを示します (デフォルト: `gpt-5.6-luna`; 0.144.x 以前のクライアントが使用した `gpt-5.4-mini` は明示的な `sourceModels` オーバーライドで復元できます)。 |

```bash
ocx models live --json                                  # what Codex can actually see right now
ocx models disable anthropic/claude-haiku-4             # hide one routed model
ocx models enable gpt-5.6-sol                           # no slash, so it is treated as native
ocx models provider zenmux off                          # hide a noisy provider wholesale
ocx models selected anthropic --set claude-opus-5,claude-fable-5
ocx models selected anthropic --clear                   # drop the allowlist again
ocx models add deepseek deepseek-v4 --display-name 'DeepSeek V4' --context-window 128000 --modalities text,image
ocx models list-custom --json                           # read the custom-id for edit/remove
ocx models remove deepseek/deepseek-v4 --yes
```

スラッシュの付いたモデル セレクターはルーティングされます (`anthropic/claude-opus-5`)。裸の ID はネイティブ OpenAI モデルとして扱われるため、`--native` は、ルーティングされているように見える ID の読み取りを強制する場合にのみ必要です。

`--modalities` は、`text`、`image`、および `audio` のみを受け入れます。 Codex はそのフィールドを閉じた列挙型として解析し、他の値を含むカタログ全体を拒否するため、`add`、`edit`、および管理 API はすべて、カタログ作成者が後で削除する必要があるものを保存するのではなく、不正な値を拒否します (#759)。
