---
title: サーバーとランタイムの構成
description: リスナー、リモート アクセス、アドミッション キー、タイムアウト、ストレージ、サイドカー、シャドウ コール、および起動動作。
---

サーバー設定は、ローカル プロキシがリッスンする方法、リモート トラフィックを保護する方法、リソースを管理する方法、およびプロバイダー要求に関するヘルパー機能を実行する方法を制御します。

## サーバーフィールド

|フィールド |タイプ |デフォルト |意味 |
| --- | --- | --- | --- |
| `port` | `number` | `10100` |プロキシリッスンポート。 |
| `hostname?` | `string` | `"127.0.0.1"` |バインドアドレス。非ループバック バインドには `OPENCODEX_API_AUTH_TOKEN` が必要です。 |
| `proxy?` | `string` | — |送信 HTTP(S) プロキシ URL または `${ENV_VAR}`。これらの変数が設定されていない場合にのみ、`HTTP_PROXY` / `HTTPS_PROXY` に適用されます。ループバックは `NO_PROXY` に残ります。 |
| `emptyCompletionRetry?` | `boolean` | `false` | テキストもツール呼び出しもない Responses ターンを、ターミナルイベント前にストリームが終了した場合も含め、同一リクエストで 1 回再試行するよう明示的に有効化します。再試行は課金対象になる場合があります。`OCX_EMPTY_COMPLETION_RETRY=0` で設定を変更せず無効化できます。combo と routed-compaction turn は対象外です。 |
| `stallTimeoutSec?` | `number` | `300` | `response.incomplete` より前にアップストリーム データがない秒数。最小 1。
| `connectTimeoutMs?` | `number` | `200000` |試行ごとの DNS/TCP/TLS/最終ヘッダーの期限。本体が生成される前に終了します。 |
| `shutdownTimeoutMs?` | `number` | `5000` |アクティブなターンが中止される前の正常な排出期限。 |
| `websockets?` | `boolean` | `false` | クライアント向け Responses WebSocket パスを広告して許可します。false の場合クライアントは HTTP/SSE を使いますが、対象となる canonical ChatGPT upstream WS 最適化は無効にしません。 |
| `corsAllowOrigins?` | `string[]` | `[]` | 追加の正確な CORS origin。ループバック origin は常に許可します。`chrome-extension://<extension-id>` など authority ベースのブラウザー拡張 origin に対応し、`*` はワイルドカードではありません。Firefox と Safari は拡張 UUID を（インストール/ブラウザー起動ごとに）再生成するため、origin が変わったらエントリを更新してください。 |
| `apiKeys?` | `OcxApiKey[]` | `[]` |生成された `ocx_…` 資格情報は、非ループバック バインドでの管理およびデータ プレーン認証によって受け入れられました。ダッシュボードで管理。 |
| `storageCleanupPolicy?` | `StorageCleanupPolicy` |無効 |アーカイブされたセッションのクリーンアップ ポリシーをオプトインします。暗黙的に有効になることはありません。 |
| `appOwnedMemoryBudgetMb?` | `number` | `256` |排除可能なアプリ所有のログ、キャッシュ、BLOB、および継続ペイロードの MiB の上限。範囲は 64 ～ 4096。 RSSキャップではありません。 |
| `codexAutoStart?` | `boolean` | `true` | Codex を起動する前に、Codex シムで `ocx ensure` を実行させます。 False を指定すると、操作が行われないことが保証されます。 |
| `codexShimAutoRestore?` | `boolean` | `true` |完了した外部 Codex アップデートによってインストールされたシムが置き換えられた後、インストールされているシムを復元します。環境オプトアウト: `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`。 |
| `syncResumeHistory?` | `boolean` | `true` | Codex App 履歴の互換性を元に戻すことができます。元のメタデータは `ocx stop` / `ocx restore` によってバックアップおよび復元されます。 |
| `shadowCallIntercept?` | `{ enabled?: boolean; model?: string; sourceModels?: string[] }` |オフ |認識された Codex ヘルパー/シャドウ呼び出しを、リクエストに設定された推論エフォートを維持したまま選択したモデルにリダイレクトします。デフォルトのソースプレフィックスは `gpt-5.6-luna` です。0.144.x 以前のクライアントでは `gpt-5.4-mini` が使われており、`sourceModels` で復元できます。 |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` |使用可能な場合はオン | Web 検索サイドカー オプション。 |
| `visionSidecar?` | `OcxVisionSidecarConfig` |使用可能な場合はオン |画像説明サイドカー オプション。 |
| `images?` | `OcxImagesConfig` | OpenAI の自動選択 | Codex `image_gen` のスタンドアロン イメージ リレー オプション。 |

バックアップ サポートが存在する前に古い開発ビルドで再開履歴メタデータが変更された場合は、`ocx recover-history --legacy-openai --yes` を実行してネイティブ プロバイダーの回復を強制します。
このコマンドは、正当な専用プロバイダー履歴を含む、ユーザーメッセージを持つすべての `opencodex` 行を再ラベル付けします。実行前にライフサイクル リファレンスの全範囲に関する警告を確認してください。

## リモートアクセス

デフォルトの `127.0.0.1` バインドはループバックのみです。 `0.0.0.0` などの非ループバック アドレスには、`/api/*` とデータ プレーンの両方でトークン認証が必要です。開始する前にトークンをエクスポートします。

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

プロキシは、この変数がないとリモート バインドを拒否します。バックグラウンド サービスの場合は、`ocx service install` の前にエクスポートして、launchd、systemd、またはタスク スケジューラがそれを受信できるようにします。クライアントは以下を送信する必要があります:

```text
x-opencodex-api-key: your-secret-token
```

|エンドポイント | `Authorization: Bearer` | `x-opencodex-api-key` | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` |受け入れられません | **必須** |受け入れられません |
| `/v1/chat/completions` |受け入れられません | **必須** |受け入れられません |
| `/v1/messages` |受け入れられました |受け入れられました |受け入れられました |
| `/v1/messages/count_tokens` |受け入れられました |受け入れられました |受け入れられました |
| `/v1/models` |受け入れられました |受け入れられました |受け入れられました |

応答とチャット完了では、Codex Direct パススルーの可能性のために `Authorization` を予約しているため、そこでは専用のアドミッション ヘッダーのみが受け入れられます。ダッシュボードで生成された `apiKeys` は、起動後に環境トークンを置き換える可能性があります。候補値は定数時間で比較されます。

Messages と `count_tokens` はルーティングクライアントとの互換性のために 3 つの admission 形式を引き続き受け入れます。
ただし非ループバック bind のネイティブ Anthropic パススルーでは、プロキシ admission は
`x-opencodex-api-key` のみを使い、`Authorization` と `x-api-key` は Anthropic 認証情報用に
予約されます。これら provider ヘッダー内のプロキシ admission secret は転送前に削除されます。

:::caution[LAN露出]
`0.0.0.0` バインドは、プロキシと構成されたプロバイダーの LAN へのアクセスを公開します。強力なトークンを持つ信頼できるネットワークでのみ使用してください。
:::

### SSHポートフォワーディング

リモート使用にはリモート バインドは必要ありません。ループバックを維持して転送します。

```bash
ssh -L 20100:localhost:10100 you@remote
```

任意のローカル ポートが機能します。ホストが `localhost`、`127.0.0.1`、または `::1` に解決されるリクエストは、ポートに関係なくループバックのままであるため、`http://localhost:20100/v1` が機能します。そのベース URL をクライアントに設定します。 `ocx` は、デフォルトのローカル `127.0.0.1` アドレスのみを管理対象クライアント設定に書き込みます。

プロバイダー OAuth コールバックは、固定リモート ポートでリッスンします。リモート マシンにログインするか、そのポートも転送します。

```bash
ssh -L 20100:localhost:10100 -L 1455:localhost:1455 you@remote
```

:::caution[転送されたループバックは認証されていません]
プレーン `ssh -L` はローカル ループバックでリッスンし、デフォルトの非認証バインドに対して安全です。 `ssh -g -L`、ブロードコンテナパブリッシング、または `0.0.0.0` でクライアント側を公開する転送モードを使用しないでください。不明な場合は、`ssh -L 127.0.0.1:20100:localhost:10100` と明示的にバインドします。
:::

## ストレージのクリーンアップ

`storageCleanupPolicy` はデフォルトでは無効になっています。有効にすると、アーカイブされたバイト数が `trigger.archivedBytesOver` を超えた後、`startup`、`daily`、`weekly`、または `manual` で実行されます。 `target.reduceToBytes` または `target.removeOldestPercent` のいずれかに向かって最も古いアーカイブが選択されます。 `mode` のデフォルトは `quarantine` です。 `permanent` は、明示的な破壊的な選択としてのみ使用してください。ポリシーは `lastRun` および `nextRun` を維持します。 [ストレージ] ページまたは `GET`/`PUT /api/storage/cleanup-policy` で設定します。 `POST /api/storage/cleanup-policy/run` を使用して手動実行をトリガーします。

## Claude Code (`claudeCode`)

これらの設定は、`/v1/messages`、`/v1/messages/count_tokens`、`ocx claude` ランチャー、および Claude ダッシュボード ページを制御します。

|キー |タイプ |デフォルト |説明 |
| --- | --- | --- | --- |
| `claudeCode.bodyStallSec?` | `number` | `90` |合計時間ではなく、読み取り保留中のネイティブ パススルー ボディの非アクティブ バジェット (秒単位)。最小 1。正確には `0` が無効になります。 |
| `claudeCode.bodyMaxBytes?` | `number` | `67108864` |ストリーミングおよびバッファリングされた応答の累積的なネイティブ パススルー ボディ キャップ。まさに `0` が無効になります。 |
| `claudeCode.authMode?` | `"proxy" \| "subscription"` |自動 |起動による `ANTHROPIC_AUTH_TOKEN` の処理方法。起動ごとに認証を自動検出します。明示的な値は決してオーバーライドされません。 |
| `claudeCode.authModeMigratedAt?` | `string` |設定を解除する |内部のワンタイムアップグレードマーカー。手動で設定しないでください。 |
| `claudeCode.subagentEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` |継承 |生成された `~/.claude/agents/ocx-*.md` に書き込まれる作業量。 Codex のガイダンスおよびプロキシの上限とは別のものです。 `ocx claude` を通じて再起動して再生成します。 |

自動認証では、保存されているクロード認証が見つかった場合はサブスクリプションが選択され、見つからない場合はプロキシが選択され、検出が決定的でない場合は警告付きのサブスクリプションが選択されます。 [クロードコード認証モード](/guides/claude-code/#auth-mode)を参照してください。

## シャドウコール

Codex は、タイトルやコミット メッセージなどのタスクに小さなヘルパー モデルを使用します。 `shadowCallIntercept` を有効にして、認識されたソース モデル プレフィックスを別の構成済みモデルにリダイレクトします。置換後も、リクエストに設定された推論エフォートは維持されます。クライアントが異なるヘルパー ID を使用する場合にのみ、`sourceModels` を設定します。

```json
{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "gpt-5.5",
    "sourceModels": ["gpt-5.6-luna"]
  }
}
```

## サイドカー

### `images` (`OcxImagesConfig`)

|フィールド |タイプ |デフォルト |意味 |
| --- | --- | --- | --- |
| `provider?` | `string` | OpenAI の自動選択 | `/v1/images/generations` および `/v1/images/edits` の明示的なカスタム API キー `openai-responses` プロバイダー。レジストリで管理されている ID は拒否されます。 |
| `timeoutMs?` | `number` | `300000` | 1 つのスタンドアロン イメージ リクエストのリクエスト全体のタイムアウト。 |

プロバイダーが見つからない、無効になっている、互換性がない、または使用可能なキーがない場合、明示的な選択は失敗して閉じられます。別の有料アップストリームにフォールバックすることはありません。エンドポイントは、Codex が期待する OpenAI Images API パスと応答形状を実装する必要があります。

### `webSearchSidecar` (`OcxWebSearchSidecarConfig`)

|フィールド |タイプ |デフォルト |意味 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` |使用可能な場合はオン |マスタースイッチ。 |
| `backend?` | `"openai" \| "anthropic" \| "xai" \| "gemini" \| "exa"` | `openai` | 明示設定が優先され、未設定なら常に `openai` です。`anthropic` と `xai` は明示設定時のみ実行され、`gemini` と `exa` は executor が提供されるまで予約値です。 |
| `model?` | `string` |バックエンド依存 | OpenAI は `gpt-5.6-luna`、Anthropic は `claude-sonnet-5`、xAI は `grok-4.6`。従来の明示的な `gpt-5.4-mini` は開始時に移行されます。 |
| `exaApiKey?` | `string` | なし | `exa` バックエンドのオペレーターキー。書き込み専用で、管理 API の読み取りでは保存値を返しません。 |
| `xSearch?` | `object` | 省略 | xAI 専用の hosted `x_search` opt-in。`enabled`、相互排他的な `allowedXHandles` / `excludedXHandles` 配列（最大 20 件）、ISO の `fromDate` / `toDate`（`YYYY-MM-DD`）を指定します。 |
| `reasoning?` | `string` | `low` |サイドカーの取り組み。 `minimal` は Web 検索で拒否されます。 |
| `maxSearchesPerTurn?` | `number` | `3` |メインモデルのターンごとに許可される実際の検索。 |
| `routedModelStallTimeoutMs?` | `number` | `200000` |設定ファイルのみのルーテッド モデルの raw ボディの非アクティブ期限。整数 1 ～ 2147483647。空でないすべてのチャンクがリセットされます。 |
| `timeoutMs?` | `number` | `60000` | 1 つのホストされた検索の期限。 |

OpenAI バックエンドには、ChatGPT ログインと有効な ChatGPT `forward` プロバイダーが必要です。クロードインバウンドのルーティングされたリプレイは、メインの ChatGPT 認証を内部リクエストに挿入します。 Anthropic バックエンドは、有効な Anthropic OAuth プロバイダーからのアクティブに保存された資格情報を使用します。使用可能なアカウントがない、明示的に選択された Anthropic バックエンドは、フォールバックせずに失敗して閉じられます。 Anthropic executor は、ネイティブの `web_search_20250305` ツールを使用します。xAI バックエンドには使用可能な保存済み Grok OAuth アカウントが必要で、hosted `web_search` を使用し、`xSearch.enabled` が true の場合は hosted `x_search` を追加します。不正な `xSearch` 管理入力は `400` を返し、不正な永続化ブロックは計画時に fail closed します。`gemini` と `exa` は資格情報の検出やフォールバックからは決して有効にならず、オペレーターが明示的に選択する必要があります。`exaApiKey` は書き込み時に受け付けますが、管理レスポンスからは省略されます。

検索は 4 つのクロック (ベース `stallTimeoutSec`、`connectTimeoutMs`、ルーテッド モデルの非アクティビティ、ホスト型検索のタイムアウト) によって制御されます。有効なブリッジ ウォッチドッグは、最大プラス 30 秒です。ルート ストールは非アクティブ ガードであり、総生成期限ではありません。

### `visionSidecar` (`OcxVisionSidecarConfig`)

|フィールド |タイプ |デフォルト |意味 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` |使用可能な場合はオン |マスターイメージと説明のスイッチ。 |
| `backend?` | `"openai" \| "anthropic"` |自動 | 明示的な値が優先されます。未設定の場合、使用可能な保存済み Anthropic OAuth 認証情報が優先され、それ以外は `openai` になります。 |
| `model?` | `string` |バックエンド依存 | OpenAI の場合は `gpt-5.4-mini`、Anthropic の場合は `claude-sonnet-5`。 |
| `reasoning?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"low"` | OpenAI Responses の推論負荷。Anthropic は無視します。 |
| `maxDescriptionsPerTurn?` | `number` | `8` |新しい説明のキャッシュミスはメインターンごとに許可されます。 `0` は通話を無効にします。無効な値にはデフォルトが使用されます。 |
| `timeoutMs?` | `number` | `45000` |サイドカーのフェッチタイムアウト。整数 1–2147483647。 |

対応するレベルは、上流プロバイダーの能力と選択したモデルが公表する推論ラダーによって制限されます。 Vision は、プロバイダーの `noVisionModels` のモデルに送信された画像に対してのみアクティブになります。 OpenAI には、検索と同じログイン/転送要件があります。明示的に選択された Anthropic は、使用可能な認証情報がないと失敗します。成功した `data:` 記述では、バックエンド、モデル、詳細、画像バイト、および正規化されたメッセージ コンテキストをキーとした境界付きキャッシュが使用されます。OpenAI のキーには推論負荷も含まれます（Anthropic のキーには含まれません）。ヒットと同じターンの重複は制限を消費しません。リモート `https:` イメージと失敗した説明、または空の説明はキャッシュされません。

Anthropic OAuth サイドカーは、opencodex の既存のクロード コード OAuth フィンガープリントを再利用します。対象のアカウントとワークロードをソークテストします。
