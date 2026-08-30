---
title: 管理 API
description: opencodex コントロール プレーンの認証、エラー、エンドポイント参照。
---

Management API は opencodex のコントロール プレーンです。 `http://localhost:10100` のダッシュボードはそのクライアントの 1 つです。 headless `ocx` プロバイダー、モデル、コンボ、アカウント、設定、診断、ライフサイクル コマンドもクライアントです。 API はプロキシの実行中にのみ使用できます。

対話型クライアントには [ウェブダッシュボード](/guides/web-dashboard/) を使用するか、自動化を構築する場合はこのリファレンスを使用します。永続値は最終的に [構成](/reference/configuration/) に従います。

## 認証モデル

Management API には、データプレーン API キーとは独立した独自の管理者資格情報があります。起動時に、opencodex は次の順序で解決します。

1. `OPENCODEX_ADMIN_AUTH_TOKEN`、設定時。
2. 強化されたシークレット ファイル内に生成された `ocx_admin_*` トークン。

ファイルベースのトークンは、そのディレクトリとファイルのアクセス許可または ACL が強化された後にのみ受け入れられます。それが保証できない場合、環境トークンが提供されるかファイルの状態が修復されるまで、管理認証は失敗して閉じられ、API は 503 を返します。

管理者トークンを次のいずれかの形式で送信します。

```http
X-OpenCodex-API-Key: <admin-token>
```

```http
Authorization: Bearer <admin-token>
```

:::caution
管理者トークンは、すべてのデータプレーン認証情報とは異なる必要があります。スタートアップは、プロキシ アドミッション キーと競合する管理資格情報を拒否します。管理者トークンを Codex、Claude Code、または別のモデル クライアントに配置しないでください。コントロールプレーンの変更を許可します。
:::

### ループバック ダッシュボード セッション

ループバック バインドでは、ダッシュボード ブートストラップは有効期間の短い `ocx_session_*` 資格情報を受け取ることができます。各セッションは 5 分間続き、正確なダッシュボードのオリジンにバインドされます。安全なリクエストはそのオリジンと一致する必要があります。安全でないメソッドには、ブラウザ `Origin` とセッションの CSRF トークンも必要です。

リモート バインドを含むデータ プレーン認証が必要な場合、セッションの発行は無効になります。リモート オペレーターは、生の管理トークンを使用して認証する必要があります。ループバック スタイルの GUI セッションは作成されません。

## よくあるエラー

以下のすべてのエンドポイント行は、これらの境界エラーを継承します。 「注目すべきエラー」列には、この表を繰り返すのではなく、追加のルート固有の結果がリストされます。

|ステータス |タイプまたはコード |意味 |
| --- | --- | --- |
| 401 | `opencodex admin token required` |管理者トークンまたは GUI セッションが欠落している、無効である、期限切れである、オリジンが一致しない、または CSRF 証拠が欠落している。
| 403 | `cross-origin request blocked` |リクエストの送信元が管理許可リストの外にあります。
| 404 | `not_found` |メソッドとパスに一致する管理ルートはありません。
| 413 | `request body too large` | POST、PUT、または PATCH 本文が 2 MiB の管理制限を超えています。
| 503 | `management API unavailable` |管理者の資格情報の初期化または強化は利用できません。
| 503 | `oauth_mutation_busy` |別の OAuth 資格情報の突然変異により、ライターが保持されます。応答には `Retry-After: 1` | が含まれます。
| 503 | `catalog_busy` |カタログ収集はすでに定員に達しています。応答には `Retry-After: 1` | が含まれます。

## エンドポイントマトリックス

### エージェントとクライアントの設定

|メソッドとパス |目的 |注目すべきエラー |
| --- | --- | --- |
| `GET, PUT /api/v2` |ネイティブ マルチエージェント v2 モードおよびスレッド設定の読み取りまたは変更 | 400 の無効な設定。 502 移行または永続化の失敗 |
| `GET, PUT /api/injection-model` |挿入されたサブエージェント モデル、作業量、プロンプト、およびガイダンス設定を読み取りまたは設定します。 400 無効なモデル、エフォート、またはボディ |
| `GET, PUT /api/effort-caps` |グローバルおよびサブエージェントの推論工数の上限を読み取りまたは設定する | 400 無効なラダー値 |
| `GET, PUT /api/subagent-models` |サブエージェントにアドバタイズされたモデルを読むか注文する | 400 の無効なリストまたは 5 つ以上のモデル |
| `GET, PUT /api/subagent-model-fallback` |順序付けされたフォールバック チェーンとポーリング間隔を読み取るか設定します。 400 無効なリストまたはポーリング間隔 |
| `GET /api/grok` | Grok 管理対象設定のステータスと候補モデルを読む | 400 ステータス読み取り失敗 |
| `PUT /api/grok/selection` |除外された Grok モデルを永続化します。 400 個の無効な選択またはサイズが大きすぎる選択 |
| `POST /api/grok/apply` |管理された同期を通じて永続的な Grok 設定を適用する | 409 `grok_apply_busy`; 400/500 適用失敗 |
| `GET, PUT /api/claude-desktop` | Claude Desktop のルーティング/ネイティブ プロファイルを読み取るか永続化する | 400 無効または使用できない割り当て |
| `POST /api/claude-desktop/apply` |保存したプロファイルを Claude Desktop の管理対象設定に書き込みます。 400/500 書き込み失敗 |
| `GET /api/claude-desktop/status` |保存済みプロファイルと適用済みプロファイルおよびデスクトップの健全性を検査する | 400 ステータス読み取り失敗 |
| `GET, PUT /api/claude-code` |クロード コードのゲートウェイ、認証モード、モデル マップ、コンテキスト、エージェント、サイドカー設定の読み取りまたは更新 | 400 無効なフィールドまたは図形 |

モデルロスターと暗号化されたワーカータスクの動作の背後にある概念については、「[サブエージェントサーフェス](/guides/sub-agent-surface/)」を参照してください。

### コンボ

|メソッドとパス |目的 |注目すべきエラー |
| --- | --- | --- |
| `GET /api/combos` |正規化されたコンボとその公開モデル ID をリストします。カタログ作業は `catalog_busy` を返すことができます |
| `PUT /api/combos` | 1 つのコンボを作成、置換、または名前変更する | 400 無効な ID、ターゲット、構成、名前変更、または通常の衝突。 409 Codexとアカウントの名前空間の衝突 |
| `DELETE /api/combos?id=...` |コンボを 1 つ削除し、その選択/クールダウン状態をクリアします | 400 ID がありません。 404 未知のコンボ |

ターゲット戦略、クールダウン、エイリアス、およびルーティングの失敗については、[コンボ](/guides/combos/) を参照してください。

### 設定、起動、同期、更新

|メソッドとパス |目的 |注目すべきエラー |
| --- | --- | --- |
| `GET /api/config` |編集された、管理上安全な構成 DTO を返します。 — |
| `PUT /api/config` |フルコンフィグ置換ガードを無効にする | 405;代わりにフォーカスされたエンドポイントを使用してください。
| `GET, PUT /api/settings` |ランタイム/起動設定の読み取り、または自動起動、ストリーム モード、アプリ所有のメモリ バジェット、`codexAccountPickerEnabled` の更新 | 400 無効、object 以外、または空の更新 |
| `GET /api/startup-health` |キャッシュされたサービス/シムの起動状態を読み取る | — |
| `POST /api/startup-action` |サービスまたは Codex シムをインストールまたは修復する | 400 無効なアクション。 500 アクション失敗 |
| `GET, POST /api/windows-tray` | Windows トレイの状態を読み取るか、インストール/起動/停止/アンインストールする | 400 のサポートされていないプラットフォーム/アクション。 500 操作失敗 |
| `GET /api/diagnostics/project-config` |キャッシュされたプロジェクト設定の読み取りに関する警告 | — |
| `POST /api/sync` |現在のモデル カタログを Codex に同期する | 500 回の同期に失敗しました |
| `GET /api/update/check` | `latest` または `preview` 更新チャネルを確認してください。 400 無効なタグ |
| `POST /api/update/run` |更新ジョブを開始し、必要に応じて再起動します。 400 無効な本文。ジョブ固有の競合/エラーのステータス |
| `GET /api/update/status` | ID によって更新ジョブをポーリングする | 404 不明なジョブ |
| `GET, PUT /api/sidecar-settings` | Web 検索およびビジョンのサイドカー モデル/バックエンド設定の読み取りまたは更新 | 400 無効な形状、バックエンド、または制限 |
| `GET, PUT /api/shadow-call-settings` |シャドウ コール インターセプト設定の読み取りまたは更新 | 400 無効な形状または値 |

### ログ、使用状況、およびストレージ

|メソッドとパス |目的 |注目すべきエラー |
| --- | --- | --- |
| `GET /api/logs` |フィルタリングされたメモリ内リクエスト ログのクエリ | — |
| `GET, PUT /api/debug` |デバッグフラグを読み取ります。キャプチャ カテゴリを設定、クリア、またはリセットする | 400 無効または空の更新 |
| `GET /api/debug/logs` |制限されたプロバイダー/デバッグ ログ エントリを読み取る | — |
| `GET /api/debug/usage-logs` |制限された使用法デバッグ エントリを読み取る | — |
| `GET /api/debug/injection-logs` |制限付きガイダンス挿入デバッグ エントリを読み取る | — |
| `GET /api/claude/inbound-debug` | Claude インバウンドのデバッグ状態とエントリを読む | — |
| `GET /api/usage` |範囲とクライアント サーフェスごとの使用状況を要約する |ストレージを読み取れない場合は、`error: "read_failed"` 概要を返します。
| `GET /api/storage` |バケットごとの Codex ストレージ使用量をスキャン |スキャン失敗時に `error: "scan_failed"` ペイロードを返します。
| `POST /api/storage/cleanup/preview` |アーカイブされたセッションのクリーンアップをプレビューし、バインディング ダイジェストを返します。 400 `invalid_json` または `invalid_percent` |
| `POST /api/storage/cleanup` |プレビューされたアーカイブ セットを隔離または完全に削除します。 400 無効な入力。 409 古い/ビジー/参照状態。 500 ファイルシステム/データベース障害 |
| `GET /api/storage/trash` |隔離されたクリーンアップ エントリを一覧表示する | 500`trash_list_failed` |
| `POST /api/storage/trash/restore` |隔離されたエントリを 1 つ復元する | 400 無効な ID; 404 ゴミが行方不明。 409 ビジー/宛先の競合。 500 復元の失敗 |
| `GET /api/storage/trash/restore/test-stream` |テストのみの復元ストリーム フック | 404 `not_available` テストフックがオフの場合 |
| `GET, PUT /api/storage/cleanup-policy` |スケジュールされたクリーンアップ ポリシーとジョブの状態を読み取りまたは更新します。 400 無効なポリシー |
| `POST /api/storage/cleanup-policy/run` |手動クリーンアップ ポリシーの実行を開始します。 409 `already_running`; 500`cleanup_failed` |
| `GET /api/storage/cleanup-policy/test-stream` |テスト専用ポリシー ストリーム フック | 404 `not_found` 利用できない場合 |

`models`、`providers`、および `days[].models` の各行にも `cacheHitRate` が含まれます。これは、プロバイダーのプロンプト キャッシュから供給された入力トークンの割合で、`[0, 1]` の範囲に制限されます。プロバイダーがキャッシュ テレメトリを報告しなかった場合、または行に入力トークンがない場合は、`0` ではなく `null` になります。「キャッシュ データなし」と「実際のヒット率 0%」は異なる事実であり、それらを同じように描画するチャートは誤解を招くためです。

:::caution
ストレージ クリーンアップ エンドポイントは、アーカイブされたセッション データを移動または完全に削除できます。必ず最初にプレビューして、返されたダイジェストを送信してください。回復が必要な場合は隔離を優先します。
:::

### モデルとカタログ

|メソッドとパス |目的 |注目すべきエラー |
| --- | --- | --- |
| `GET /api/catalog` |インストールされている Codex カタログ ドキュメントを返します | 404 カタログが見つかりません |
| `GET /api/models` |ダッシュボード/CLI モデルの行を返す |収集が飽和したときの `catalog_busy` |
| `GET /api/client-config?client=...` |サポートされているファイル連携の読み取り専用クライアント設定を作成する | 400 クライアントがサポートされていません。 503 カタログは利用できません |
| `PUT /api/disabled-models` |共有の無効モデル リストを置き換える | 400 無効な JSON |
| `PUT /api/model-visibility` |プロバイダーレベルまたはモデルレベルの可視性をアトミックに変更 | 400 プロバイダー、スコープ、ターゲット、または本文が無効です。
| `GET, POST /api/custom-models` |カスタム モデルをリストするか追加する | 400 個の無効なフィールド。 404 プロバイダーがありません。 409 複製モデル |
| `PUT, DELETE /api/custom-models/{id}` | 1 つのカスタム モデルを編集または削除する | 400 個の無効な ID/フィールド。 404 が見つかりません。 409 複製モデル |
| `GET, PUT /api/selected-models` |プロバイダーのホワイトリストと可用性を読み取るか、1 つのホワイトリストを置き換えます。 400 のプロバイダー/本体が欠落しています。 404 不明なプロバイダ |

### OAuth アカウント、プロバイダー キー、およびデータプレーン キー

|メソッドとパス |目的 |注目すべきエラー |
| --- | --- | --- |
| `GET /api/oauth/providers` |パブリック OAuth ログイン フローを持つプロバイダーをリストする | — |
| `GET /api/key-providers` | API キー ログインを通じて構成されたプロバイダーをリストする | — |
| `POST /api/oauth/login` | OAuth ログインまたはアカウント追加フローを開始する | 400 不明または無効なプロバイダー。 `oauth_mutation_busy` |
| `POST /api/oauth/login/code` |手動コールバック URL または認証コードを送信する | 400 無効なプロバイダー/コード。 `oauth_mutation_busy` |
| `POST /api/oauth/login/cancel` |進行中のパブリック OAuth フローをキャンセルする | 400 不明なプロバイダー |
| `GET /api/oauth/status` | 1 つのプロバイダーの OAuth フローをポーリングする | 400 不明なプロバイダー |
| `POST /api/oauth/logout` |選択したプロバイダー資格情報を削除します | 400 不明なプロバイダー。 `oauth_mutation_busy` |
| `GET, DELETE /api/oauth/accounts` |マスクされたアカウントを一覧表示するか、アカウントを 1 つ削除する | 400 無効なプロバイダー/ID。 404 アカウントがありません。 `oauth_mutation_busy` |
| `PUT /api/oauth/accounts/active` |アクティブな OAuth アカウントを選択します | 400 無効なプロバイダー/アカウント。 `oauth_mutation_busy` |
| `GET, PUT, PATCH /api/oauth/accounts/pool` | Anthropic OAuth プール ポリシーの読み取りまたは更新 | 400 非 Anthropic プロバイダーまたは無効なポリシー |
| `POST /api/oauth/accounts/clear-cooldown` | 1 つの OAuth アカウントのランタイム クールダウンをクリアする | 400 無効なプロバイダー/アカウント |
| `PUT /api/oauth/accounts/alias` | OAuth アカウント エイリアスを設定またはクリアする | 400 無効なプロバイダー/アカウント/エイリアス |
| `GET, POST, DELETE /api/providers/keys` |マスクされたプロバイダー キーを一覧表示し、1 つを追加/アクティブ化するか、1 つを削除します。 400 無効な入力。 404 プロバイダー/キーがありません |
| `PUT /api/providers/keys/active` |プロバイダーのアクティブなキーを選択します | 400 無効な入力。 404 プロバイダー/キーがありません |
| `PUT /api/providers/keys/alias` |プロバイダー キー エイリアスを設定またはクリアする | 400 無効な入力。 404 プロバイダー/キーがありません |
| `GET, POST, PATCH, DELETE /api/keys` |データ プレーン アドミッション キーの一覧表示、作成、編集、または削除 | 400 無効な本文/ID。 404 キーがありません |

資格情報リストの応答は意図的にマスクされます。 OAuth アクセス トークンと完全なプロバイダー API キーはダッシュボード クライアントに返されません。

### プロバイダー

|メソッドとパス |目的 |注目すべきエラー |
| --- | --- | --- |
| `GET /api/providers` |編集されたプロバイダー設定と検出状態をリストする | — |
| `POST /api/providers` |検証済みプロバイダーを 1 つ追加または置換し、必要に応じてそれをデフォルトにします。 400 無効または危険な宛先または構成。 409 名前空間の衝突 |
| `PATCH /api/providers?name=...` |許可されたプロバイダー フィールド（マージされる `headers` ブロックを含む）、有効/デフォルト状態、または OpenAI アカウント モードを更新します。 400 無効なフィールドまたは遷移。 404 不明なプロバイダ |
| `DELETE /api/providers?name=...` |プロバイダーを削除し、可能な場合はデフォルトを再割り当てします。 404 不明なプロバイダー。 409 `last_provider`; 409 `provider_has_dependent_combos` |
| `POST /api/providers/test?name=...` |制限されたライブプロバイダー接続/モデル検出プローブを実行する | 404 不明なプロバイダー。障害は通常、`ok: false` の証拠として返されます。
| `GET /api/provider-quotas` |プロバイダー クォータ レポートを読む。 `refresh=1` 強制更新 | — |
| `GET, PUT /api/provider-context-caps` |グローバル、全プロバイダー、または 1 つのプロバイダーのコンテキスト キャップを読み取りまたは更新します。 400 無効なリクエスト。 404 不明なプロバイダ |
| `GET /api/provider-presets` |ランタイム レジストリから派生した GUI プロバイダー プリセットを返します。 — |

`provider_has_dependent_combos` は安全バリアです。プロバイダーを削除する前に、依存するコンボを削除または編集してください。

### サイドバーと同意に基づくアクション

|メソッドとパス |目的 |注目すべきエラー |
| --- | --- | --- |
| `GET /api/github/star` |ユーザーの `gh` セッションを通じてリポジトリのスター ステータスを読み取ります。ステータス固有の固定結果コード |
| `POST /api/github/star` |認証された人間のアクションからのみリポジトリにスターを付けます。 403 `agent_consent_required` ダッシュボード セッションの証拠がないエージェント主導の発信者向け |
| `GET /api/update/badge` |安価なサイドバーの更新バッジの状態を読む | — |

:::caution
管理認証はプロキシへのアクセスを証明します。ユーザーの ID を使用することに同意したことを証明するものではありません。エージェントは `agent_consent_required` を迂回してルーティングしてはなりません。ユーザーはリポジトリにスターを付けるかどうかを選択する必要があります。
:::

### システムのライフサイクル

|メソッドとパス |目的 |注目すべきエラー |
| --- | --- | --- |
| `GET /api/system/memory` |スカラー プロセス、ヒープ、ストリーム、応答状態、ウォッチドッグ、およびアクティブ ターン メトリックを返します。 — |
| `POST /api/system/restart` |クライアント インジェクションを削除せずに、ドレイン対応プロセスの再起動を開始します。 202 を返します。繰り返しの呼び出しにより、既存の排水が報告されます。
| `POST /api/stop` |サービスを停止し、ネイティブ Codex を復元し、マネージド Grok インジェクションを削除し、プロキシをドレインします。 409 サービス所有権の競合 |

### Codex認証の委任

`GET /api/settings` は有効な `codexAccountPickerEnabled` boolean を返します。この strict boolean を
`PUT` すると、空の map を有効化する場合は privacy-safe selector を初期化し、既存 label を保持したまま
先に永続化し、有効な picker 表示が変わったときだけ bounded catalog convergence を 1 回要求します。
成功応答の `catalogRefreshPending: true` は設定は保存済みだが `POST /api/sync` による再試行が必要という意味です。

ルート管理ディスパッチャーは、すべての `/api/codex-auth/*` リクエストを Codex アカウント マネージャーに委任します。そのルートは次のとおりです。

|メソッドとパス |目的 |注目すべきエラー |
| --- | --- | --- |
| `GET, POST, DELETE /api/codex-auth/accounts` | Codex アカウントの一覧表示/更新または削除。POST は無効化された互換エンドポイントとしてのみ残り、成功した DELETE は `catalogRefreshPending` を返します。 | POST は常に 403 `manual_import_disabled`。DELETE の入力が無効な場合は 400。 |
| `PUT /api/codex-auth/accounts/alias` |アカウント エイリアスの設定またはクリア | 400 無効なアカウント/エイリアス |
| `PUT /api/codex-auth/accounts/pause` | 1 つのアカウントを一時停止または再開する | 400 無効なアカウント/状態。 404 アカウントが見つかりません |
| `PUT /api/codex-auth/accounts/pause-exhausted` |クォータを使い果たしたアカウントを一時停止する |ミューテーションロックの失敗は 503 になります |
| `POST /api/codex-auth/accounts/clear-cooldown` | 1 つのアカウントまたはすべてのアカウントのランタイム クールダウンをクリアする | 400 無効な ID |
| `GET, PUT /api/codex-auth/active` |アクティブなアカウントを読み取るか選択します | 400 アカウントが無効または欠落しています。 409 一時停止/レガシー行の競合 |
| `PUT /api/codex-auth/auto-switch` |自動アカウント切り替えのクォータしきい値を設定する | 400 無効なしきい値 |
| `PUT, PATCH /api/codex-auth/pool-strategy` | Codex アカウントプールの選択戦略を更新 | 400 無効な戦略/構成 |
| `PUT /api/codex-auth/failover` |アカウントのフェイルオーバーしきい値を設定する | 400 無効なしきい値 |
| `GET /api/codex-auth/quota` |キャッシュされたクォータ状態をアカウントごとに読み取る | — |
| `GET /api/codex-auth/reset-credits` |アカウントのリセット クレジット資格を検査する | 400 アカウント ID がありません。アップストリームステータスパススルー。 500 検索失敗 |
| `POST /api/codex-auth/reset-credits/consume` |対象となるリセット クレジットを消費する | 400 アカウント ID がありません。アップストリームステータスパススルー。 503 `server_busy`; 500 消費失敗 |
| `POST /api/codex-auth/login` | Codex のログインまたは再認証を開始する | 400 無効なリクエスト。競合/ビジー ログイン状態 |
| `POST /api/codex-auth/login/code` | Codex ログイン フローの手動コードを送信する | 400 無効なフロー/コード |
| `POST /api/codex-auth/login/cancel` | Codex ログイン フローをキャンセルする | — |
| `GET /api/codex-auth/login-status` |フローまたはアカウントのログイン状態をポーリングする。新規アカウント完了時は回復が必要な場合だけ `catalogRefreshPending: true` を含みます。 |不明なフローは `expired` を報告します。アクティブなフローは `idle` を報告しません |

新規 account の config row は保存されたものの credential setup を完了できない場合、OAuth の
`login-status` は `status: "error"` と
`code: "codex_credential_persistence_failed"`、`accountId`、`needsReauth: true`、必要に応じて
`catalogRefreshPending: true` を含み、storage error の詳細は公開しません。account row は保存済みなので、
account 作成を再試行する前に再認証するか削除してください。

この委任されたファミリーでの構成ライターまたは資格情報の更新ロックのタイムアウトは、コード `CONFIG_MUTATION_LOCK_UNAVAILABLE` の HTTP 503 を返します。クライアントは、その応答を永久的なアカウント障害として扱うのではなく、すぐに再試行する必要があります。

アカウント作成と削除は catalog convergence より先に永続化されます。失敗または延期された catalog 処理は
保存済み mutation をロールバックせず、内部 provider/account/path/credential detail も返しません。削除した
account の selector binding は残るため、欠落中の exact route は fail closed し、同じ id の再追加で同じ selector が戻ります。

## クライアントの選択

通常の管理では、[ウェブダッシュボード](/guides/web-dashboard/) が最も安全なガイド付きワークフローを提供します。ヘッドレス ホストとオートメーションの場合は、対応する `ocx` コマンドを使用します。これらのコマンドは、これと同じライブ API を呼び出し、プロキシに到達できない場合、または操作が失敗した場合にゼロ以外の結果を返します。ダイレクト HTTP は、上記の正確なエンドポイント コントラクトを必要とする統合に最も役立ちます。
