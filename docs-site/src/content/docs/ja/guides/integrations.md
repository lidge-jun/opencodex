---
title: クライアント統合
description: ダッシュボードから opencodex を OpenCode、Pi、OMP、Hermes、OpenClaw、Kimi Code、gjc、DeepSeek Harness、MiniMax Code、ZCode、Prime Agent、Aside、Raycast、omo、Cline CLI に接続します。クライアントごとにスイッチがあり、書き込み前には必ずバックアップを取ります。
---

**Integrations** タブは、各クライアントの設定ファイルに opencodex のプロバイダーブロックを書き込み、必要に応じて削除します。次の 15 クライアントは、それぞれのスイッチで管理できます。

| クライアント | 設定ファイル | 形式 | 変更が反映される時点 | 認証情報 |
|---|---|---|---|---|
| OpenCode | `~/.config/opencode/opencode.json` | JSON | 次回の直接起動時 | `OPENCODEX_OPENCODE_API_KEY` |
| Pi | `~/.pi/agent/models.json` | JSON | 新しいセッション | ループバック用プレースホルダー |
| OMP | `~/.omp/agent/models.yml` | YAML | OMP の再起動後 | `opencodex-loopback` プレースホルダー |
| Hermes | `~/.hermes/config.yaml` | YAML | 新しいセッション | `OPENCODEX_HERMES_API_KEY` |
| OpenClaw | `~/.openclaw/openclaw.json` | JSON5 | 稼働中のゲートウェイに直ちに反映 | `OPENCODEX_OPENCLAW_API_KEY` |
| Kimi Code | `~/.kimi-code/config.toml` | TOML | 再起動時または `/reload` 実行時 | ループバック用プレースホルダー |
| gjc | `~/.gjc/agent/models.yml` | YAML | 新しいセッションまたは `/model` を開いたとき | 秘密情報ではないループバック用プレースホルダー |
| DeepSeek Harness (DSH) | `$DSH_HOME/settings.yaml`（デフォルトは `~/.dsh/settings.yaml`） | YAML | ホットリロード時 | 秘密情報ではないループバック用ベアラープレースホルダー |
| MiniMax Code | `~/.minimax/config.yaml` | YAML | 新しいセッションまたはモデル選択画面を開いた後 | ループバック用プレースホルダー |
| Prime Agent | `~/.prime/agent/models.json` | JSON | 新しいセッション | ループバック用プレースホルダー |
| ZCode | `~/.zcode/v2/config.json` | JSON | 再起動時 | ループバック用プレースホルダー |
| Aside | `~/.aside/u/<account>/models.json` | JSON | Aside を完全に終了して開き直した後 | ループバック用プレースホルダー |
| Raycast | `~/.config/raycast/ai/providers.yaml` | YAML | 保存後すぐ。Raycast がファイルを監視 | なし。ループバックのみ |
| omo | `~/.omo/agent/models.json` | JSON | 新しいセッション | ループバック用プレースホルダー |
| Cline CLI | `~/.cline/data/settings/providers.json` と同階層の `models.json` | JSON のペア | Cline の停止と再起動後 | ループバック用プレースホルダー |

生成されるカタログには、各プロバイダーの選択で有効なモデルのみが含まれます。これはダウンロードと管理対象の統合の両方に適用され、Pi と Aside も対象です。管理画面のモデル一覧にはすべてのモデルが表示されるため、追加のモデルを有効にできます。

Gajae の組み込みプリセットでは、ルーティングの選択を `~/.gjc/agent/config.yml` に保持します。

```yaml
modelProfile:
  proxyProvider: opencodex
  proxyMode: always
```

通常の `gjc` 起動時に適用するには、選択した `modelProfile.default` を維持してください。管理対象の統合が所有するのは `models.yml` 内の `providers.opencodex` だけです。プロバイダーの更新や無効化でプリセットの選択は書き換わりません。出力するモデルの選択を変更した後は、統合を更新してください。

管理対象の OpenCode 統合は、`provider.opencodex`（opencode V1）と `providers.opencodex`（opencode V2）の 2 つの部分を所有します。モデルごとの推論負荷の選択肢は V2 ブロックだけに含まれるため、両方を書き込んで同期します。両者は同じプロバイダー ID とモデル ID を指定し、opencode V2 は 1 つのプロバイダー項目に統合します。Apply、Refresh、Disable、Restore は両方に作用し、他のプロバイダー、エージェント、キー割り当て、MCP 項目には触れません。

管理対象の DSH 統合には **DSH 0.1.0-rc.6** 以降が必要です。OpenCodex が所有するのは `llm-pi-ai.providers.opencodex` のみです。Apply と Refresh はその部分を置き換え、Disable はその部分のみを削除し、Restore は記録されたスナップショットを戻します。DSH はプロバイダー変更をホットリロードします。これらの操作はユーザーのデフォルトモデルやネイティブの `deepseek-official` プロバイダーを変更しません。管理対象の DSH 統合は現在ループバック専用で、実際の認証情報は書き込みません。

MiniMax Code は `MINIMAX_DATA_DIR`、次に `MAVIS_DATA_DIR` を参照し、どちらもなければ `~/.minimax` を使います。管理対象ブロックが所有するのは `custom_provider.opencodex` のみです。`defaultModel`、選択済みの MiniMax 認証情報の取得元、ユーザーの MiniMax ログインは変更しません。接続後に MCode で `custom_provider:opencodex/<provider/model>` の項目を選んでください。統合の更新では、モデルごとの信頼できるコンテキストウィンドウと推論負荷の選択肢も更新されます。不明な機能は省略し、MCode のセッションが所有する現在の負荷は維持します。

Prime Agent は `PRIME_AGENT_CODING_AGENT_DIR` を優先し、指定がなければ `~/.prime/agent` を使います。相対値は、プロキシとエージェントが別のファイルを指すおそれがあるため拒否されます。管理対象ブロックが所有するのは `providers.opencodex` だけで、他のプロバイダーや設定済みの `modelOverrides` は維持されます。Prime Agent はセッション開始時に `models.json` を読むため、接続後は新しいセッションを開始してください。

Aside は、ローカルプロファイルも含め、登録済みの各プロファイルに別のモデルカタログを保持します。OpenCodex はローカルを含む全登録プロファイルを一覧表示し、まとめて同期するか、プロファイルごとに管理できます。統合の切り替えでは Aside のアクティブアカウントは変わりません。以前に Aside を接続していれば、全プロファイルがデフォルトで有効になります。個別の除外は後の同期でも維持されます。

Aside 固有の注意点として、稼働中のアプリ自身が `models.json` を書き換えます。適用後は Claude Desktop と同様に、Aside を完全に終了して開き直してください。Aside のブロックはループバック専用で、実際の認証情報は含みません。

管理対象の Raycast 統合は **macOS と Windows** に対応します。Custom Providers は **Raycast Pro** の機能です。無料プランでもファイルは書き込まれますが、Raycast は読み込まないため、`ocx integration client status --client raycast` と Integrations ページに警告が表示されます。macOS または Windows では Raycast → Settings → AI → **Reveal Providers Config** を一度開き、`ai` フォルダーを作成してください。対応する OS では opencodex がそのフォルダーをインストール検出に使い、存在するまでクライアントを未インストールと報告します。フォルダーがあっても Linux は未対応です。

状態フィールド `aiDirPresent` が示すのは、Raycast のインストール状況や OS の対応状況とは無関係に、`~/.config/raycast/ai` の存在だけです。Raycast がインストール済み、または利用可能である証明にはなりません。CLI は `plan` を別行に表示し、`aiDirPresent` が false の場合は macOS/Windows での設定方法を追加します。`--json` は、入れ子の `raycast` ブロックを含む生の状態を維持します。Raycast は macOS と Windows の両方で `~/.config/raycast/ai/providers.yaml` を読み、`XDG_CONFIG_HOME` は尊重しないため、このパスは移動できません。

管理対象ブロックは、ファイルの `providers` 配列にある `id: opencodex` の要素 1 件です。`name: OpenCodex`、`base_url: http://<host>:<port>/v1`、および各ルーティング済みモデルとその `abilities` を含みます。エクスポーターはクライアント向けの慣例として `tools` と `system_message` を `true` に設定します。`vision` はカタログの入力モダリティに従い、`reasoning_effort` はモデルに負荷の段階がある場合に設定され、推論モデルでは `temperature` が無効になります。ファイル内の他のプロバイダーは維持され、無効化では OpenCodex の要素だけを削除します。Raycast はファイル保存直後に変更を反映し、再起動は不要です。モデルは Raycast の選択画面で **OpenCodex** の下に表示されます。Raycast は任意の `api_keys` に対応しますが、OpenCodex は意図的に省略し、ループバック以外や受け入れ認証が必要な接続先を拒否します。この統合では OpenCodex が要求する受け入れヘッダーを提供できません。

macOS の非公開設定は Pro プランを示す参考情報にすぎません。Windows はこれを読まず、プランを不明として報告します。プラン検出によって書き込みが許可または拒否されることはありません。出力メタデータには信頼できるツール対応フラグがないため、`tools: true` でも全ルーティングモデルのツール対応は証明されません。画像と推論負荷のフラグはカタログのメタデータに従います。負荷の段階がある場合に温度を無効にするのは、慎重な出力動作です。プロバイダー値は維持されますが、YAML の書式やコメントの保持は保証されません。形式は [manual.raycast.com/ai/custom-providers](https://manual.raycast.com/ai/custom-providers) に記載されています。

Raycast の CLI 出力とダッシュボードのダウンロードは、設定済みの認証不要ループバックリスナーを含む、稼働中サーバーの接続先と受け入れポリシーを使います。`ocx ensure` は保存済み設定のスナップショットから Raycast を更新しません。実行中サーバーと異なる可能性があるためです。サーバーの起動と明示的な同期が、引き続きカタログ更新の経路です。

Cursor にはタブがありますが、これらのスイッチには含まれません。通常版 Cursor は自社バックエンドからカスタムエンドポイントを呼ぶため、公開トンネルなしではループバックプロキシに届きません。別の Private Inference 版は Cursor 内で設定します。**Cursor** タブは読み取り専用で、インストール済みの版を検出し、Cursor に貼り付ける Base URL と API Key、Cursor からプロキシへの最後のリクエストを表示します。[Cursor Private Inference](/ja/guides/cursor-private-inference/) を参照してください。

パスは、各クライアントに環境変数の上書きがあればそれに従います。OMP では、明示的な空文字列でも `OMP_PROFILE` が存在すれば `PI_PROFILE` より優先されます。名前付きプロファイルは `PI_CONFIG_DIR` をユーザーのホームからの相対ディレクトリ名として使い、`PI_CODING_AGENT_DIR` を無視します。名前付きプロファイルがなければ `PI_CODING_AGENT_DIR` が優先されます。OMP はプロバイダー単位のヘッダーに対応しますが、この初期統合は意図的にループバック専用です。リモートの `x-opencodex-api-key` 設定は後続作業です。移動された `HERMES_HOME`、`KIMI_CODE_HOME`、`XDG_CONFIG_HOME` のパスも推測せずに尊重します。表には各クライアントのデフォルトを示しています。

ネイティブ OpenAI モデルでは、生成される OMP ブロックがモデル単位の Responses API を選び、画像入力と推論負荷の制御を維持します。ルーティングされたモデルは既存アダプターとの互換性のため、プロバイダーの Chat Completions 方言を維持します。

OpenClaw には複数の指定があり、役割も異なります。`OPENCLAW_CONFIG_PATH` はファイルを選びます。`OPENCLAW_STATE_DIR`、`OPENCLAW_PROFILE`、`OPENCLAW_HOME` は状態ディレクトリを選び、検出もそのディレクトリを参照します。このためプロファイルや移動先のホームもインストール済みとして認識されますが、設定パスの上書きはファイルだけを移します。古い `.clawdbot` 構成も検出します。新しいディレクトリがあれば優先し、古いものだけならそれを使います。

これらは**絶対パス**または `~` で始まるパスでなければなりません。相対パスは解決せず拒否します。各プロセスの起動ディレクトリによって意味が変わり、バックアップにも保存されるパスが翌日に別のファイルを指す可能性があるためです。

opencodex は自身の環境からこれらの値を読みます。ゲートウェイがプロファイルや移動されたホームで動作する場合、opencodex も同じ変数を設定して起動してください。そうしないと別のインストール先を参照します。

## 他の 5 つのサーフェスはスイッチではない

**API Keys** は opencodex 自身の認証情報を管理し、クライアントではありません。**Codex CLI** はプロキシサービス自体が接続します。opencodex の起動で適用され、停止でネイティブのルーティングに戻るため、ファイル単位の切り替えはありません。**Claude** は独自の有効化フラグと Desktop の Save/Apply 手順を維持し、**Grok Build** はモデルの選択後に適用する境界を維持します。これらはこの機能以前からある動作で、変わりません。**Cursor** は何も書き込みません。タブには検出結果、ゲートウェイの値、最後に観測したリクエストが表示され、残りは Cursor Private Inference 内で行います。

## ロールバック

成功するすべての書き込みでは、*先に*ファイルのスナップショットを取るため、元の状態を復元できます。

- ファイルが書き込み後の内容と一致していれば、最新の操作に **Undo** が表示されます。
- 古い操作、または操作後にファイルが変わった場合は **Restore this point…** が表示されます。変更をまたいで復元する場合は、新しい編集を置き換える前に再確認し、その編集もバックアップするため復元自体も取り消せます。
- クライアントごとにバックアップを 10 件保持します。それを超えると最古のスナップショットファイルが削除され、履歴行には **Backup expired** と表示されます。

Disable は opencodex が自身のものとして記録した項目だけを削除します。書き込み後にファイルが変更された場合の動作は、管理対象項目が無傷かどうかとファイル形式によって異なります。厳密な JSON 設定（OpenCode、Pi）では、管理対象ブロックの*隣*に MCP サーバーや独自プロバイダーを追加すると **Update needed** と表示されます。更新時はそれらの項目を維持しながらマージしますが、書式は正規化されることがあります。例外は JSON が正確に書き直せない値です。`1e999` のような非有限数、書き直しで丸められる数（非常に大きな整数やゼロに潰れるほど小さい数）、`-0`、同一オブジェクト内で重複するキー、1000 階層を超える入れ子はスイッチをロックし、値が黙って変更・欠落するのを防ぎます。**OMP、DSH、Hermes** は別の理由で隣接する編集の影響を受けません。各書き込み処理が管理対象プロバイダーの範囲だけをバイト単位で変更し、ファイルの残りを書き直さないためです。コメントを含められる残りの形式（OpenClaw、Kimi Code、gjc、MiniMax Code、Raycast。文書全体を書き込む JSON5 と TOML、またはソース保持のない一般的な YAML）、あるいは管理対象項目自体が編集された場合は、どの編集を残したいか推測せず、スイッチをロックして Disable を拒否します。

ロックされても操作不能ではありません。競合したクライアントには、概要カードとクライアントページの両方で、スイッチの横に **Replace** が表示されます。管理対象設定が置かれている内容を opencodex のブロックで置き換える操作で、先に確認を求めます。ダイアログにはファイル名、失われる内容、元に戻すためのスナップショットが示されます。スイッチ自体はロックされたままです。どの編集を維持するか判断できるのは利用者だけだからです。それ以外の制約は緩めません。解析できないファイルや、構造を安全に判断できないファイルは引き続き拒否されます。

## 変更内容を確認して確定する

Apply、Replace、Disable、Restore はプレビューから始まります。ダイアログには、変更対象の管理設定が、範囲を限定した変更パスと値の追加・更新・削除の区別とともに表示されます。確定前に内容を確認してください。

計画に変更がない場合、管理対象のクライアント文書は要求した状態にすでになっています。選択された Aside プロファイルでは、文書に変更がなくても、確定によって同期の設定が保存される場合があります。

確認後にファイルが変更されると、古い計画として書き込みが拒否されます。ダイアログは更新された計画に置き換えて再確認を求め、自動再試行はしません。プレビューが一時的に使えない場合は、通常どおりページを再読み込みして操作をやり直してください。

Aside も選択したプロファイル 1 件ずつ同じプレビューと確認の手順を使います。**Sync all profiles** は別の一括操作であり、1 つの統合プレビューには結び付きません。

## 実際に起こること

**通常、書式は保持されません。** 適用時には設定を解析して書き戻すため、JSON、JSON5、TOML は再整形され、JSON5 や TOML のコメントが失われることがあります。OMP、DSH、Hermes は例外です。それぞれの YAML 書き込み処理は `providers.opencodex` と `llm-pi-ai.providers.opencodex` の対象範囲だけを変更し、無関係なプロバイダーのコメントと書式をバイト単位で保持します。その正確な範囲を安全に識別できなければ、操作を拒否します。他のクライアントで以前のファイル内容が必要な場合は Restore を使ってください。スナップショットはバイト単位のコピーです。

**値を忠実に書き直せない場合も、スイッチは拒否します。** 通常使う値の種類は往復処理に対応していますが、たとえば利用可能なパーサーが正確に読み直せない `inf` や `nan` を使う TOML ファイルでは、変更された値を書いて成功とみなさず、適用を停止して理由を示します。ファイル名が表示され、ディスク上の内容は変わりません。手動編集は引き続き可能で、自動書き換えだけが拒否されます。

TOML の日付と時刻も、管理対象の書き換えでは拒否されます。マージ処理で型付きの値が引用符付き文字列に変わるためです。配列やインラインテーブルの値も対象です。引用符付きの日付文字列は利用できます。引用符のない日付は設定を手動で編集して保持してください。

**Pi、Kimi Code、gjc、MiniMax Code、Prime Agent、Aside、Raycast、omo、管理対象の DSH 統合はループバックバインドでのみ動作します。** 最初の 4 クライアントには、ループバック以外のバインドに必要な `x-opencodex-api-key` ヘッダー用の設定項目がありません。DSH には一般的なヘッダーマップがありますが、rc.6 の文書では専用の受け入れヘッダーが対応する統合契約として定義されていません。そのため管理対象の書き込み処理は推測せずに拒否します。Prime Agent のプロバイダーブロックはヘッダーを受け付けますが、リモートの認証情報設定は初期統合から先送りしています。SSH トンネル、またはヘッダーを追加するローカル転送経由でループバックアクセスを提供してください。

**生成される OMP 統合も意図的にループバック専用です。** OMP はプロバイダー単位のヘッダーに対応しますが、この初期統合はリモートの `x-opencodex-api-key` 認証情報を出力しません。リモート OMP の手動設定は、現時点では管理対象の統合の範囲外です。

**Kimi Code は環境変数への参照を保持できません。** そのため設定にはキーではなく `opencodex-loopback` プレースホルダーが入ります。どのクライアント設定にも実際の認証情報は書き込みません。

**`ocx opencode` ではランチャーのプロバイダーブロックが優先されます。** このランチャーは `OPENCODE_CONFIG_CONTENT` を通じて `provider.opencodex` と `providers.opencodex` を注入し、ディスク上の同じ項目より優先します。他の opencode 設定は通常どおり適用されます。このスイッチが重要になるのは `opencode` を直接起動する場合です。

## ターミナルから操作する

同じ操作は GUI を使わずに実行できます。

```bash
ocx integration client status
ocx integration client enable --client hermes
ocx integration client disable --client hermes
ocx integration client history --client hermes
ocx integration client restore --op <opId> [--confirm-drift]
```

`--overwrite-conflict` は **Replace** に相当するターミナル用の指定です。

```bash
ocx integration client enable --client zcode --overwrite-conflict
```

`--confirm-drift` と同様に、この指定は暗黙に適用されません。指定しなければ競合は拒否されます。対象は `enable` のみです。競合した状態で*無効化*を強制すると、自分たちが書いていないブロックを削除する可能性があるため、その組み合わせは拒否されます。

MiniMax Code では、プロバイダーを一度接続し、検証付きラッパーで起動します。

```bash
ocx integration client enable --client mcode
ocx mcode
```

接続後、`ocx sync` と `POST /api/sync` は、所有する MCode、Pi、Aside、Raycast、omo のカタログを現在のモデル選択、コンテキストウィンドウ、推論負荷の段階で更新します。プロキシ起動時には所有する Raycast カタログを更新します。モデルの表示設定、プロバイダーの選択、プリセットの変更でも、接続済みの Pi、Aside、Raycast、omo カタログが更新されます。存在しないブロック、他者が編集したブロック、安全でないブロック、および手動で削除した以前の所有ブロックには触れません。

有効な Aside プロファイルは、通常の「所有済みのみ更新」の例外です。アカウントディレクトリが存在し、まだ所有ブロックがなく、その場所が空であれば、同期時に最初のブロックを作れます。以前の Aside 接続があれば、登録済みの全プロファイルでこの動作がデフォルトで有効になります。同期は存在しないアカウントディレクトリを作らず、手動のブロックも置き換えません。拒否または重複する更新は、クライアントごとに別々に報告されます。更新されたファイルを読み込むには、新しい Pi セッションを開始するか、Aside を完全に終了して開き直してください。Aside の更新には[対応する稼働中のプロキシ](#aside-プロファイルの管理)が必要です。

Models に **“Model selection saved”** とクライアント更新の警告が一緒に表示された場合、モデルの選択自体はすでに保存されていますが、1 件以上のクライアントファイルを更新できていません。警告には該当するクライアントと、必要に応じて Aside プロファイル、拒否理由が示されます。新しいセッションを始める前に **Integrations** で対象を確認してください。報告された問題を解消して `ocx sync` を再試行します。重複する操作は先に完了させてください。警告にバックアップパスがある、または復旧が未完了と表示される場合は、再試行前にその状態を調べてください。モデル選択の保存成功だけでは、クライアントファイルの復旧は確認できません。

別製品の MiniMax プラットフォーム CLI（`mmx`）は、ファイル切り替え式の統合ではありません。そのテキストコマンドは MiniMax の Anthropic 互換エンドポイントを使うため、OpenCodex は認証情報を分離したループバック専用ランチャーを提供します。

```bash
ocx mmx text chat --model anthropic/claude-opus-5 --message "Hello"
ocx mmx text repl --model openai/gpt-5.6-sol
```

プロキシされるのは `mmx text chat` と `mmx text repl` だけです。MiniMax 固有の image、video、speech、music、vision、search、quota、auth、config、file、update コマンドには通常の `mmx` を実行してください。ラッパーは秘密情報ではないループバック用プレースホルダーだけを含む一時設定を使います。`~/.mmx` の OAuth や API キーの認証情報は読み込まず、`--api-key`、`--base-url`、`--region` による上書きも拒否します。手順と制限の詳細は [MiniMax クライアント](/ja/guides/minimax/) を参照してください。

`--confirm-drift` は暗黙に適用されません。復元対象の操作後にファイルが変わっていれば、コマンドは拒否して通知します。新しい編集を置き換えるかどうかは利用者が決めるためです。

各クライアントの設定形式は、それぞれのプロジェクトを参照して検証しました。確認内容と時期は `devlog/_fin/260802_client_toggle_api/002_client_toggle_matrix.md` の調査メモを参照してください。

## Aside プロファイルの管理

Aside プロファイルの操作と `ocx sync` による Aside 更新には、Aside プロファイル API に対応する稼働中の ocx プロキシが必要です。CLI だけを更新しても、稼働中のプロキシは更新されません。プロキシが利用できない、または古い場合、Aside の操作は完了できず、CLI がローカルの Aside プロファイルファイルに直接書き込むこともありません。

プロキシが使う ocx を更新し、プロキシを再起動してください。停止中なら起動します。その後 `ocx sync` またはプロファイルコマンドを再試行します。プロファイルファイルの更新が成功したら、Aside を完全に終了して開き直し、新しいカタログを読み込ませてください。

```bash
ocx integration client status --client aside --json
ocx integration client enable --client aside
ocx integration client disable --client aside --profile 1
ocx integration client history --client aside --profile 1
ocx integration client restore --client aside --profile 1 --op <opId>
```

プロファイル番号は status コマンドが表示するアカウント ID です。Aside の切り替えで `--profile` を省略すると、登録済みの全プロファイルに希望する状態が適用されます。プロファイル単位の変更では、他のプロファイルはそのままです。希望する同期設定はファイル変更前に保存され、実際の状態と拒否はプロファイルごとに報告されます。一括操作が部分的に成功しても、全件成功とはみなされず、CLI はゼロ以外で終了します。Undo は選択したプロファイルのファイルに加えて同期の意図も復元するため、後の同期で取り消しが黙って覆ることはありません。

[プロファイル API](/reference/management-api/#aside-profile-controls) は、一括操作が成功した場合 HTTP 200、いずれかのプロファイルが拒否した場合 `ok: false` を伴う HTTP 207 を返します。`results` の各項目を確認してください。他が失敗しても、成功したプロファイルはロールバックされません。希望する設定は保存されたままなので、全体が失敗したと決めつけず、対象の問題を解消して再試行してください。設定の保存自体に失敗した場合、プロファイルファイルは変更されません。

各プロファイルの所有権と履歴は別々です。既存のユーザー編集、安全でないパス、リンクされたカタログは拒否されます。明示的な上書きと変更確認のコントロールは引き続き使えます。変更後のモデルファイルを読み込むには、Aside を完全に終了して開き直してください。

## ZCode 3.14 以降

ZCode 3.14 はカスタムプロバイダーの保存先を `~/.zcode/v2/provider_config.json` に移しました。`~/.zcode/v2/config.json` からは、新しいファイルがない場合に一度だけ行われるインポートでしか参照されません。ZCode は初回起動時に新しいファイルを作るため、一度でも起動した環境ではインポートは済んでおり、`config.json` に書いても反映されません。

opencodex は可能な場合、`provider_config.json` に直接書き込みます。統合を有効にすると `opencodex` プロバイダーの規則が追加され、カタログ更新でその内容が更新され、無効化では opencodex が書いた内容だけを削除します。ファイル内のその他の規則は維持されます。他のプロバイダーが opencodex と同じモデル ID に対して保持する規則も対象です。opencodex が書いていない `opencodex` ID の規則は、引き継ぐ対象ではなく競合です。ZCode 内で解決するか、明示的な上書きを使ってください。

プロバイダーストアが読めない、またはファイルではない場合も書き込みを拒否します。旧式のインポートを許す「ストアなし」とは扱いません。

さらに 2 つの場合は書き込みを拒否します。ZCode が保存先を移す前に opencodex が適用したブロックは、統合を `config.json` に保持します。まずそこで無効にしてから、新しい保存先へ書くために再度有効にしてください。また、`provider_config.json` の `schemaVersion` が opencodex の確認済みの値と異なる場合は、マージせず報告します。このファイルには ZCode の全プロバイダーが入っており、未確認の形式を押し付けると、黙って反映されない問題が黙ったデータ損失に変わるためです。統合が書き込まない場合、status は ZCode が読むファイルを示します。

後者の場合は ZCode 自身の設定画面でプロバイダーを追加します。ベース URL は `http://127.0.0.1:10100/v1`（バインドに合わせてポートを変更）、キーは空でない任意の値、モデル ID は `ocx export --client zcode` の出力を使います。インポートを再実行するために `provider_config.json` を削除する方法には対応していません。ZCode がそこに保持するすべてのプロバイダーが失われます。

## Cline CLI

この統合の対象は、ネイティブスキーマに `version: 1` を持つ現在の Cline CLI/共有 SDK のプロバイダーストアです。旧式の VS Code 拡張機能の `globalState` やシークレットストアは、この統合では移行も検出もしません。先に Cline を一度実行して設定ディレクトリを初期化してください。

**統合の有効化、同期、無効化、復元の前に Cline を停止してください。** OpenCodex は `providers.json` と同階層の `models.json` の両方に `providers.opencodex` を書き込みます。前者には秘密情報ではないループバック用プレースホルダーを使う OpenAI Responses 接続、後者には利用可能なコンテキストと画像メタデータを含む、絞り込まれたルーティングモデルカタログが入ります。既存のプロバイダー項目とデフォルトのプロバイダー選択は変わりません。

```bash
ocx integration client list --json
ocx integration client enable --client cline
ocx integration client history --client cline
ocx integration client restore --op <operation-id>
```

有効化後は Cline を再起動して OpenCodex を選ぶか、`cline --provider opencodex --model <provider/model>` で起動します。外部カタログの変更は Cline の再起動時に読み込まれます。Cline は無人のカタログ更新の対象外です。ルーティングモデルの選択を変えた後は、Cline を停止し、`ocx sync` または統合の再有効化で更新してください。選択中のモデルが引き続きルーティング対象なら維持され、出力カタログから削除されると選択は解除されます。

`CLINE_PROVIDER_SETTINGS_PATH` は主要ファイルを上書きします。それ以外では `CLINE_DATA_DIR` がデータディレクトリ、次に `CLINE_DIR` がルートを選び、最後に `~/.cline` が使われます。モデルファイルは常に、選択したプロバイダーファイルの横の `models.json` です。上書きパスは絶対パスか `~` で始まる必要があります。コマンドごとの Cline の `--config` パスを使う場合は、OpenCodex 起動時の `CLINE_PROVIDER_SETTINGS_PATH` に合わせてください。両ファイルを区別する必要があるため、主要ファイル名が `models.json` の場合は拒否されます。

各ファイルの置き換えはアトミックですが、両方を同時に置き換えるファイルシステム操作はありません。1 件のジャーナル操作が元の両ファイルのスナップショットを取り、書き込みや記録処理の失敗時は両方を補償します。中断した操作は非公開の復旧記録を残します。status は未完了の復旧を安全でない状態として報告します。次の明示的な変更は、どちらのファイルにも所有権にも無関係な編集がない場合だけ復旧します。復旧が拒否されたら、操作が報告したファイルと復旧パスを保持し、競合を解消してから再試行してください。

Undo は、もともと存在しなかったファイルも含め、**元の両方のバイト列**を復元します。操作後の編集には、既存の明示的な `--confirm-drift` が必要で、編集済みのペアも先にバックアップされます。すでに使われている OpenCodex 項目には、既存の `--overwrite-conflict` による同意が必要です。Disable は 2 つの管理対象項目を削除しますが、以前の他者の項目は復元しません。その場合は Undo を使ってください。スナップショットの保持件数と期限は他の統合と同じ規則です。

ダウンロードされる `cline-config-bundle.json` には、`providers.json` 用の `settings` と `models.json` 用の `catalog` という 2 つのネイティブ文書要素が含まれます。それ自体は Cline の設定ファイルではありません。ジャーナル付きのマージとロールバックには統合コマンドを使ってください。生成された統合はリモートの受け入れ認証に対応せず、認証不要のループバックアクセスが必要です。

## GitHub Copilot アプリ

GitHub Copilot デスクトップアプリでは、opencodex を OpenAI 互換のモデルプロバイダーとして利用できます。これは手動で設定するクライアントで、Integrations タブのスイッチはありません。また、opencodex がバックエンドとして Copilot サブスクリプションを使う上流の `github-copilot` プロバイダーとは別のものです。

1. opencodex を起動し、応答することを確認します。

   ```bash
   curl http://127.0.0.1:10100/healthz
   curl http://127.0.0.1:10100/v1/models
   ```

2. Copilot アプリで **Settings → Model providers → Add provider** を開き、次の値を入力します。

   | 項目 | 値 |
   |---|---|
   | 名前 | 任意のラベル（例: `OpenCodex`） |
   | Base URL | `http://127.0.0.1:10100/v1`（バインドに合わせてポートを変更） |
   | API key | ループバック接続では空欄 |

3. エンドポイントからモデルを同期するか、`provider/model` 形式の ID でモデルを追加し、選択します。

アプリはモデルの検出に `GET /v1/models`、リクエストの処理に `POST /v1/chat/completions` を使います。リクエストは opencodex の通常のモデルルーティングを通るため、他のクライアントと同じように、プロバイダーの認証情報、OAuth アカウント、コンボが適用されます。受け付けるリクエストフィールドは[プロキシ形式のリファレンス](/reference/proxy-formats/)を参照してください。

モデルが見つからないと表示される場合は、Base URL が `/v1/chat/completions` ではなく `/v1` で終わっていることと、`/v1/models` が空でない `data` 配列を返すことを確認してください。opencodex がループバック以外のアドレスで待ち受けている場合は、アプリの API key 欄にデータ受け入れキー（[リモートアクセス](/reference/configuration/server/#remote-access)に記載されたトークン、またはダッシュボードで生成した `ocx_…` キー）を入力します。アプリはこれを `Authorization: Bearer` として送信します。`/v1/chat/completions` はこれをプロキシの受け入れ認証にだけ使い、上流には転送しません。詳しくは[認証マトリクス](/reference/proxy-formats/#authentication-matrix)を参照してください。
