---
title: プロバイダーの構成
description: プロバイダー エントリ、認証、エンドポイント、モデル カタログ、クォータ、コンテキスト キャップ、およびプロバイダー固有のオプション。
---

プロバイダーは、opencodex に、モデルが存在する場所、モデルが通信するワイヤー アダプター、およびリクエストの認証方法を伝えます。

## プロバイダー関連のトップレベルフィールド

|フィールド |タイプ |デフォルト |意味 |
| --- | --- | --- | --- |
| `providers` | `Record<string, OcxProviderConfig>` | — |プロバイダー名からプロバイダー設定へのマップ。 |
| `openaiProviderTierVersion?` | `2` |移行によって設定される |単一のオプション対応 OpenAI プロジェクションを完了としてマークします。 |
| `disabledModels?` | `string[]` | — | Codex catalog と `/v1/models` から非表示にする model。直接の proxy 呼び出しはブロックしません。routed id は一覧から削除されます。account-qualified native id は該当する selector row だけを非表示にし、bare native GPT id は bare row とその model の全 account-selector row を非表示にします。Models ページに表示されるのは bare native 行と routed 行だけです。selector-qualified 行を 1 つだけ非表示にするには、この設定フィールドを直接編集してください。 |
| `providerContextCaps?` | `Record<string, number>` | `{}` |プロバイダーごとの Codex に表示されるコンテキストの上限。キャップは既知のコンテキスト ウィンドウを下げるだけです。 |
| `contextCapValue?` | `number` | `350000` |ダッシュボードのコンテキストキャップ コントロールで使用される既定値。「すべてのルーティング済みプロバイダーに適用」がオンになっている場合のみ、変更によってすべてのルーティング済みプロバイダー（`providerContextCaps` エントリがまだないプロバイダーを含む）に値が適用されます。それ以外では各プロバイダーは独自のキャップを保持します。 |
| `codexAccounts?` | `CodexAccount[]` | `[]` | ChatGPT/Codex プール アカウントのメタデータは Codex Auth によって管理されます。秘密は`codex-accounts.json`に別に住んでいます。 |
| `pausedCodexAccountIds?` | `string[]` | `[]` |再開するまでプールの選択から除外されるアカウント (一時停止時のメイン `__main__` アカウントを含む)。 |
| `codexAccountNamespaces?` | `Record<string, string>` | — | 任意の公開 model selector を保存済み Codex アカウント target に対応付ける任意の map。account-qualified picker row が有効な場合、target が存在する各 selector は Codex picker に個別の `<selector>/<native-openai-model>` row を追加し、各 row はそのアカウントだけを使用します。selector が 1 つでも有効な場合、bare native row は picker で非表示になりますが、明示的に無効化されない限り id は引き続き routing でき、raw `/v1/models` にも表示されます。 |
| `codexAccountPickerEnabled?` | `boolean` | map が空なら off | 有効な `codexAccountNamespaces` mapping から account-qualified Codex picker row を生成するかを制御します。`true` は mapping された行の表示を許可します。空でない map で省略した場合は後方互換性のため有効として扱われ、map が空なら off です。`false` は mapping を削除せず、明示的な `<selector>/<native-openai-model>` routing も無効にせずに、生成行を非表示にして picker の bare native 行を復元します。 |
| `activeCodexAccountId?` | `string` | — |次のリクエスト用に手動で選択されたプール アカウント。選択するとスレッドのアフィニティがクリアされます。実行中のリクエストでは、取得された資格情報が保持されます。 |
| `codexAccountPriorities?` | `Record<string,number>` | — | Codex pool のアカウント別選択順。アカウント ID → `-100` から `100` の整数で、**大きいほど先に使われ**、未設定は `0` です。これは eligibility ではなく順序の境界です。選択は適格なアカウントを、まだ quota に余裕がある最上位 tier に絞り込み、その tier の中を `accountPoolStrategy` が選びます。tier が飛ばされるのは、そのメンバー全員が `autoSwitchThreshold` 超過、cooldown 中、soft-avoid、一時停止、または再認証待ちのときだけで、usage 不明が tier を drain させることはありません。順序付けが不適格なアカウントを選択可能にすることはなく、すでにアカウントが結び付いた thread を再 bind することもありません。メインの `__main__` も同じ条件で参加するため、Codex Desktop ログインを最後に使わせられます。エントリが 1 つもなければ挙動は従来どおりです。map が不正な場合は警告を出して順序付けを無効にします（config の修復処理は走りません）。`ocx account priority` と Codex Auth ページで管理します。 |
| `autoSwitchThreshold?` | `number` | `80` | 使用量ベースのプロアクティブ切り替えしきい値。`quota` は紐付け済み/未紐付けタスクの次のリクエストを再評価でき、`fill-first` は未紐付け割り当ての使い切り基準としてのみ使用し、通常の `round-robin` 選択は使用しません。既知の 5 時間、週次、30 日 quota window の最大スコアを使います。`0` は使用量ベースの切り替えだけを無効にし、未紐付け割り当てや障害回復は無効にしません。 |
| `accountPoolStrategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | 新規/未紐付け Codex リクエストの割り当て戦略。live な `(parent thread id, quota scope)` affinity がなければ未紐付けで、プロキシ再起動や affinity リセット後は既存の表示タスクも未紐付けになり得ます。`quota` はアクティブアカウントがなければ既知 usage 最小の適格アカウントを選び、適格なアクティブアカウントが `autoSwitchThreshold` 未満なら維持します。しきい値到達後は、未紐付けリクエストまたは紐付け済みタスクの次のリクエストを usage の低い適格アカウントへ移せます。`round-robin` は未紐付けリクエストを均等分散し、`fill-first` は cooldown、使用不可、または drain threshold までアクティブアカウントへ割り当てます。 |
| `accountPoolStickyLimit?` | `number` | `1` | 1 回の round-robin 選択で次へ進む前に保持する新規/未紐付けタスク割り当て数。カウンターは上流の成功後ではなくタスクの紐付け時に増えます。範囲 1–100。`accountPoolStrategy` が `round-robin` のときのみ。 |
| `upstreamFailoverThreshold?` | `number` | `3` |今後の新しいセッションがフェイルオーバーする前に一時的なエラーが連続して発生する。 `0` を無効に設定します。通常のResponses送信とネイティブcompact送信では、実証済みの接続前DNS/TCP到達不能障害はprovider-host単位で記録され、アカウントの健全性、アカウントのクールダウン、スレッド/セッションの親和性、アクティブアカウントの選択、Poolルーティングには影響せず、この閾値にもカウントされません。 |
| `upstreamHostCircuitThreshold?` | `number` | `0` | ネイティブOpenAI forwardのResponses送信とcompact送信で、実証済みの接続前DNS/TCP障害に適用するオプトインのサーキットしきい値です。`0`で無効、`1`〜`20`ではその回数の終端論理リクエストが失敗するとprovider-originを30秒間遮断します。遮断中はアカウント選択やupstream送信の前に`Retry-After`付き`503`を返し、時間経過後はhalf-openリクエストを1件だけ許可します。タイムアウトとHTTP応答は数えず、HTTP応答が1件でもあれば回路を閉じます。 Codex Pool ルーティングでアカウントが固定されていない場合にのみ適用され、`codexAccountMode: "direct"` とアカウント修飾セレクターでは動作しません。 |
| `modelCacheTtlMs?` | `number` | `300000` |プロバイダーごとの `/models` キャッシュの鮮度ウィンドウ。 |
| `cacheRetention?` | `"none" \| "short" \| "long"` | `"short"` | Anthropic プロンプト キャッシュ ポリシー: 無効、5 分間の一時的、または 1 時間の延長。 |
| `tokenGuardian?` | `OcxTokenGuardianConfig` |オフ |オプションのプロアクティブな OAuth 更新および Codex アカウントのウォームアップ ポリシー。 |

selector 名はユーザーが選ぶ公開 label であり、opencodex はアカウント role の意味を付与しません。
`codexAccountNamespaces` のキーは長さ 1〜64 文字、先頭と末尾は ASCII
英数字、内部には英数字、`.`、`_`、`-` を使用でき、予約済み JavaScript object 名は拒否されます。
値は有効な pool account id（内部 `__main__` は不可）、または Codex Desktop アカウントを示す
`"@main"` です。provider と予約済み `openai` / `combo` / `policy` との衝突は大文字小文字を区別せず検査され、
namespace 付き combo または routing-profile alias はその namespace prefix に selector を再利用できません。設定済み pool id
や他の selector target も selector と再利用できません。raw account id と email は
非公開のままにし、selector を公開名として使ってください。明示的な選択の動作と優先順位は
[ルーティング構成](/reference/configuration/routing/)を参照してください。

Codex Auth dashboard が管理する map には明示的な `codexAccountPickerEnabled` field があります。空の
managed map を有効にすると privacy-safe selector が作られ、その後の account 追加は picker を非表示に
している間も既存 label を変えずに map を拡張します。flag を省略した手書き map は自動拡張されません。
account を削除しても mapping は保持され、同じ id を再追加すると新しい selector ではなく既存 selector が戻ります。

## 予約済み OpenAI プロバイダー

`openai` および `openai-apikey` は固定予約 ID です。 `openai.codexAccountMode` はデフォルトでは `"pool"` で、メインアカウントと追加アカウント全体を選択します。 `"direct"` は、現在の呼び出し元/メイン ログインのみを使用します。 API は、設定された API キーまたはキー プールのみを使用します。ベア モデルまたは `openai-apikey/<model>` を使用します。クロスルート認証情報のフォールバックはありません。 API GPT-5.6 行は 922,000 コンテキスト / 最大 922,000 入力メタデータを伝送し、Pro 仮想 ID は `reasoning.mode: "pro"` を使用してベース ワイヤー モデルに書き換えられます。

`openaiProviderTierVersion: 2` は、現在の単一プロバイダーの投影をマークします。出荷された v1 設定を移行する前に、opencodex は別のバックアップを置き換えずに `config.json.pre-openai-tiers-v2.bak` を作成し、既知の名前空間で選択された既知のレガシー ID を裸の ID に書き換えます。

## プロバイダーエントリー (`OcxProviderConfig`)

|フィールド |タイプ |意味 |
| --- | --- | --- |
| `adapter` | `string` | `openai-chat`、`openai-responses`、`anthropic`、`google`、`kiro`、`cursor`、`ollama-native`、`azure-openai` (または別名 `azure`) のいずれか。 |
| `baseUrl` | `string` |アップストリーム API のベース URL。ほとんどの組み込み固定エンドポイントは不一致を無視します。衝突安全キー プリセットは、古い同じ名前のカスタム宛先を保持します。 |
| `requestPacing?` | `{ enabled, requestsPerMinute?, minIntervalMs?, models? }` | 上流の使用量、請求、レート制限表示とは別の、クライアント側の送信開始間隔調整です。プロバイダー制限は全モデルに適用され、`models` は上流の正確なモデル ID に一致し、遅延を増やす場合のみ有効です。キュー待機は応答ヘッダーのタイムアウトを消費しません。HTTP、Responses WebSocket、明示的なアダプターの `fetchResponse`/`runTurn` 送信を対象にします。 |
| `responsesPath?` | `string` |キー認証 `openai-responses` リクエストの相対リソース パス。 `/` で始まり、スキーム、クエリ、またはフラグメントが含まれていない必要があります。 |
| `upstreamWebsocket?` | `boolean` | `openai-responses` リクエストで使用するアップストリーム Responses WebSocket トランスポート（既定値は無効）。アップストリームがこのプロトコルに対応している場合、ストリーミング POST は設定済みの Responses パス（既定値 `/v1/responses`）へ HTTPS の WSS で接続し、通常の処理向けに SSE へ再エンコードされます。forward プロバイダーは `{baseUrl}/responses`、キー認証プロバイダーは `responsesPath`（未設定時は従来の `/v1/responses`）を使用します。HTTP のベース URL は SSE のままとなり、Responses 以外のパスと `openai-chat` リクエストは HTTP を使用します。 |
| `supportsServiceTier?` | `boolean` | `service_tier` ケイパビリティの 3 状態です。`true`: fast モードが注入でき、呼び出し元の値も保持されます。`false`: フィールドは削除され、注入もされません (非対応と文書化されたアップストリームには送りません)。未設定: 未分類 — 呼び出し元の値はそのまま保持され、fast モードは注入しません。レジストリは正規 OpenAI (`true`)、DeepSeek、Volcengine Ark (`false`) を分類します。実際にティアをサポートするカスタム ゲートウェイにのみ明示的に設定してください。 |
| `preserveResponsesReasoningContent?` | `boolean` | リプレイされる Responses reasoning アイテムの平文 reasoning コンテンツを消去せずに保持します (消去は ChatGPT バックエンドのルールです)。DeepSeek のように reasoning リプレイを受け入れるアップストリームで有効にしてください。プロキシ生成の `ocxr1` エンベロープは常に削除されます。 |
| `disabled?` | `boolean` |プロバイダーをディスク上に保持しますが、ルーティングおよびモデル/カタログのリストからは除外します。 |
| `apiKey?` | `string` | API キー、またはリクエスト時に解決される `${ENV_VAR}` / `$ENV_VAR` 参照。 |
| `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Anthropic キーのヘッダー スタイル。デフォルトはネイティブ `x-api-key` です。キー認証 `anthropic` プロバイダーにのみ有効です。 |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` |マルチキープール。 `apiKey` はアクティブなエントリをミラーリングします。各項目には `id`、`key`、オプションの `label`、およびオプションの数値 `addedAt` があります。 |
| `defaultModel?` | `string` |このプロバイダーが明示的なモデルなしで選択された場合に使用されるモデル。 |
| `models?` | `string[]` |シード/フォールバック モデルのリスト。 `liveModels: false` では、発見されたモデルはこれらのみです。 |
| `liveModels?` | `boolean` |開始/同期時にライブ カタログをフェッチします (デフォルトは `true`)。カスタムプロバイダーは `${baseUrl}/models` を使用します。組み込みはレジストリ URL とフィルターを使用する場合があります。 |
| `selectedModels?` | `string[]` |検出後のカタログ許可リスト。空でない場合は、それらの ID のみが公開されます。空または省略すると、検出されたすべてのモデルが公開されます。 |
| `modelDisplayNames?` | `Record<string, string>` | このプロバイダーの正確なネイティブモデル ID をキーにした、永続的な表示専用ラベルです。大文字と小文字は区別されます。ラベルはプロバイダーカタログのメタデータより優先され、認証、アダプター、ルーティング、課金、上流リクエストには影響しません。マップは検出上限と同じ 2,000 件までです。 |
| `contextWindow?` | `number` | アップストリームのメタデータが無い場合に使うプロバイダー全体のコンテキスト値。メタデータがある場合は上限として働き、より小さいライブ値をそのまま残します。Models ダッシュボードでは `providerContextCaps` とは別に設定します。 |
| `modelContextWindows?` | `Record<string, number>` | モデルごとのコンテキスト値および上限。`contextWindow` より優先され、ウィンドウが不明なら設定値を使い、より小さいライブメタデータがあればそちらが優先されます。 |
| `modelInputModalities?` | `Record<string, string[]>` | `["text"]` や `["text", "image"]` などのモデルごとの入力ヒント。 |
| `modelMaxInputTokens?` | `Record<string, number>` |カタログの自動圧縮ヒントに使用されるモデルごとの正の最大入力制限。 |
| `modelAutoCompactTokenLimits?` | `Record<string, number>` | モデルごとの正の安全な整数によるソフト自動圧縮予算。実効値であるコンテキストまたは最大入力の 90% の上限を下げることだけができ、信頼できるコンテキストウィンドウが不明な場合は出力されません。canonical `openai` では、キーは provider や account-selector の接頭辞を含まない、サポート対象の正確なネイティブモデル ID でなければなりません。provider PATCH はエントリをマージし、キーを `null` にするとそのキーを削除し、フィールド全体を `null` にするとマップを消去します。これらの `null` tombstone は PATCH 専用です。 |
| `defaultMaxOutputTokens?` | `number` |クライアントが `max_output_tokens` を省略した場合の、プロバイダー全体の `openai-chat` フォールバック。 |
| `modelMaxOutputTokens?` | `Record<string, number>` |モデルごとの `openai-chat` フォールバック バジェットがプラスになります。正確な/パターン一致はプロバイダーのデフォルトを上回ります。 |
| `modelCosts?` | `Record<string, Cost4>` | モデルごとの表示価格（100万トークンあたりの米ドル）。そのプロバイダーの正確なアップストリーム モデル ID をキーにします（プロバイダー識別子やルーティングされた `provider/model` ラベルではありません）。値は `input`, `output`, `cacheRead`, `cacheWrite` の 4 フィールドです（例: `{ "deepseek-v4-flash": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028, "cacheWrite": 0 } }`）。組み込みカタログにないモデル ID も、任意の OpenAI 互換エンドポイントを対象とするカスタムプロバイダーや、ローカル・内部プロバイダーで有効です。ユーザー設定の価格は Logs の `~$` と Usage の見積もりで組み込みカタログより優先されます。過去のエントリも現在のオーバーレイで再計算されるため、価格を編集すると過去の合計が変わることがあります（フォールバック順: ユーザー設定 → jawcode カタログ → expected-price オーバーレイ → モデル別ベンダー価格）。全ゼロのエントリは次のソースにフォールバックします。各レートは 0 以上の有限数で、最大 1,000,000（100万トークンあたりの米ドル）です。範囲外の行は管理境界で拒否され、読み込み時に破棄されます。表示専用の見積もりであり、ルーティング・アカウント選択・クォータ・請求には影響しません。 |
| `headers?` | `Record<string, string>` |追加の上流ヘッダー。認証、Cookie、API キー ヘッダー、埋め込まれた改行、および無効な名前は拒否されます。 |
| `openRouterRouting?` | `OpenRouterProviderRouting` |デフォルトの OpenRouter `order`、`only`、および `allowFallbacks` 設定。 `openai-chat` を持つ正規 OpenRouter に対してのみ有効です。 |
| `modelOpenRouterRouting?` | `Record<string, OpenRouterProviderRouting>` |プロバイダー全体の OpenRouter 設定を置き換える正確なモデル ID のオーバーライド。 |
| `vercelGatewayRouting?` | `VercelGatewayRouting` |デフォルトの Vercel AI Gateway `order`、`only`、および `sort` (`"cost"` \| `"ttft"` \| `"tps"`) 設定。`openai-chat` を使用する正規の Vercel AI Gateway に対してのみ有効です。 |
| `authMode?` | `"key" \| "forward" \| "oauth" \| "local"` |認証モード (デフォルトは `key`)。 OAuth/サブスクリプション認証情報は `config.json` の外部に保存されます。 `local` は、レジストリ エントリで許可されているプロバイダーに限定されます。 |
| `codexAccountMode?` | `"pool" \| "direct"` |正規の `openai` のみ。デフォルトはプールです。直接はプール状態をバイパスします。 |
| `refreshPolicy?` | `"proactive" \| "lazy-only" \| "disabled"` |この OAuth プロバイダーの Token Guardian ポリシーをオーバーライドします。 |
| `reasoningEfforts?` | `string[]` |プロバイダー全体の Codex 推論ラベルをアドバタイズして送信します。 |
| `modelReasoningEfforts?` | `Record<string, string[]>` |モデルごとのラベル。空のリストは努力制御を非表示にします。 |
| `modelSupportsReasoningSummaries?` | `Record<string, boolean>` |モデルを `false` に設定して、概要の広告を停止し、概要配信フィールドを削除します。 |
| `modelReasoningSummaryDelivery?` | `Record<string, "sequential" \| "sequential_cutoff" \| "concurrent" \| "concurrent_cutoff">` |モデルごとの応答配信列挙型。既存の配信フィールドを書き換えます。 |
| `modelAdapters?` | `Record<string, string>` | 混合配線ゲートウェイのモデルごとの `openai-chat` または `openai-responses` 配線オーバーライド。明示的なエントリはレジストリのデフォルトを破ります。DeepSeek のプリセットは `deepseek-v4-flash` のネイティブ Responses を選択でき、GitHub Copilot は GPT-5 ファミリー (`gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`) を Responses 専用デフォルトとして宣言します。これらのモデルはエージェント トラフィックで `/chat/completions` を拒否するためです。`gpt-5.4-nano` のようなビルトイン デフォルトのないモデルはここでオプトインできます。単線アップストリーム ピンと正規の ChatGPT 転送はオーバーライドを拒否します。 |
| xAI Responses オプトイン（ダッシュボード） | スイッチ | `xai` のみで、`grok-4.5` と `grok-4.6` の `modelAdapters` エントリを原子的に設定または削除します。片方だけの場合は、次のスイッチ操作で両方が正規化されるまで混合状態を表示します。他のオーバーライドと tier 動作は変わりません。 |
| `xaiResponsesXSearch?` | `boolean` | デフォルトでは無効です。xAI Responses の宛先では、最終的なリクエスト正規化後もライブの `web_search` ツールが残っている場合にのみ、プロバイダーがホストする `x_search` 宣言を追加します。既存の宣言は重複させず、呼び出し元の `tool_choice` / `allowed_tools` セレクターの範囲を拡張することもありません。また、これは `search.xSearch` オプションを持つウェブ検索サイドカーとは別です。 |
| `modelPreferHostedTools?` | `Record<string,string[]>` | hosted tool namespace を予約する非 forward Responses gateway 向けの完全一致モデル opt-in。現在は `["image_generation"]` のみを受け付けます。一致したモデルは `openai-responses` wire を使い、その hosted tool をサポートする必要があります。競合するクライアント `image_gen` 宣言を除去し、呼び出し元の tool choice を維持するため selector も書き換えます。OpenAI API の仮想 `-pro` モデルでは、まず選択した公開 ID に一致させ、解決後のベース wire-model ID をフォールバックとして使用します。`modelAdapters` は公開 ID、次にベース ID の順に解決し、後者の結果が最終 wire を決めます。未設定のモデルは通常の alias 動作を維持します。 |
| `annotateEmptyToolOutputs?` | `boolean` | 存在するものの空であるツール結果を、モデルに届く前に短いマーカーへ置き換え、空白の結果が欠落した結果として解釈されないようにします。空文字列とテキストのみのパーツ配列に適用されます。画像、ファイル、暗号化されたパーツには一切手を加えません。組み込みレジストリでは `DeepSeek` のデフォルトが `true` で、それ以外は未設定です。プロバイダーを対象外にするには `false` を設定します。明示的な `false` は、後続の編集でこのフィールドが省略されても保持されます。`PATCH /api/providers?name=<provider>` は `true`、`false`、またはオーバーライドを消去してレジストリのデフォルト動作へ戻すための `null` を受け付けます。 |
| `reasoningEffortMap?` | `Record<string, string>` |ラベルを推論するためのプロバイダー全体のワイヤ エイリアス。 |
| `modelReasoningEffortMap?` | `Record<string, Record<string, string>>` |推論ラベルのモデルごとのワイヤ エイリアス。 |
| `reasoningWireFormat?` | `"gateway-object"` | `reasoning_effort` ではなく `reasoning: { enabled, effort }` を受け取る OpenAI 互換ゲートウェイ用です。ClinePass プリセットが自動設定します。 |
| `noReasoningModels?` | `string[]` |推論/思考パラメーターを拒否するモデル。 |
| `noTemperatureModels?` | `string[]` |発信者指定の`temperature`を拒否するモデル。 |
| `noTopPModels?` | `string[]` |発信者指定の`top_p`を拒否するモデル。 |
| `noPenaltyModels?` | `string[]` |存在/周波数ペナルティを拒否するモデル。 |
| `noStructuredOutputModels?` | `string[]` | `openai-chat` エンドポイントが `response_format` を拒否する正確なモデル ID。要求モデルが項目と完全一致する場合だけフィールドを省略し、その他の `openai-chat` モデルでは structured-output 変換を維持します。 |
| `parallelToolCalls?` | `boolean` |並列ツール呼び出しを切り替えます。 OpenAI Chat はデフォルトでオンになっています。非チャット アダプターは明示的な `true` でのみアドバタイズします。 |
| `responsesItemIdRepair?` | `{ message?: string[]; reasoning?: string[]; repairMissingTerminalIds?: boolean; repairInvalidIds?: boolean }` |正確なプレースホルダー ID、欠落している端末 ID、および（`repairInvalidIds` で）正規の `msg_`/`rs_` 接頭辞を欠く message/reasoning ID に対するダウンストリーム SSE 修復はデフォルトで無効になっています。関数呼び出し ID は決して書き換えられません。組み込み DeepSeek は最後の 2 つをデフォルトで有効にします。 |
| `responsesSnapshotRepair?` | `boolean` | デフォルトで無効のクライアント向け修復です。SSE と JSON の Responses ライフサイクルで欠落した status、output、ツールメタデータを補完し、raw 検査と永続化は変更しません。 |
| `retryOn429?` | `{ enabled?: boolean; attempts?: number; intervalMs?: number; maxIntervalMs?: number; respectRetryAfter?: boolean }` | API-key プロバイダーのみ(`authMode: "key"`)。オプトインの同一ターゲット 429 リトライ: `retryOn429` が無ければ無効で、オブジェクトがあれば `enabled: false` でない限り有効になります。429 時に待機(上流の `Retry-After` または固定間隔)してから、キー フェイルオーバーの前に同一キーで同一リクエストを再送します — メインのテキストターン回復ループ、Responses passthrough、画像/動画ブリッジ、web-search サイドカー、ターミナル継続要求をすべてカバーします。再送の対象はプリストリームの HTTP 429 応答のみで、カスタム `runTurn` トランスポートは HTTP リトライループの対象外です。`attempts` は最初の 429 以降の同一キー再送回数(合計送信数 = `attempts` + 1)で、メインの回復ループ・ターミナルガード継続・ブリッジ再試行で共有されるリクエスト単位の予算です。`attempts` を使い切っても同一キーでの再送が止まるだけで、通常のキー フェイルオーバーまたは最終エラー処理が利用可能なターゲットに応じて続きます — キー認証の passthrough ワイヤにはフェイルオーバーがないため、使い切った 429 はそのまま返ります。Codex 自体は 429 をリトライしないため、単一キーのプロバイダーでは唯一の防御です。デフォルト: `enabled: true`、`attempts: 3`、`intervalMs: 5000`、`maxIntervalMs: 60000`(1回の待機は `maxIntervalMs` で上限、その上限は 600000)、`respectRetryAfter: true`。 |
| `transientRetryOn5xx?` | `{ enabled?: boolean; attempts?: number }` | キー認証の `openai-chat` プロバイダーのみ。ストリーム開始前に上流から返される一時的なステータス（500、502、503、504、520、521、522）に対するオプトインの再試行です。設定がなければ無効で、オブジェクトを指定すると `enabled: false` でない限り有効になります。最初の Responses リクエスト、ターミナルガード継続、ネイティブの `/v1/chat/completions`、および 429／アカウント回復時の再取得が対象です。`attempts` は最初の送信を含め、1 回のリクエストで許可される上流への送信総数です（1～10、デフォルトは 3）。接続リセット回復と共有するリクエスト単位の単一予算であるため、`3` を指定した場合、プロバイダーに到達する実リクエストは最大 3 回です。待機には 400 ms を基準とする固定式の指数バックオフを使用し、上限は 5 秒で、`Retry-After` に従います。レート制限を扱う `retryOn429` とは別の機能であり、ストリーム開始後の失敗は再送されません。 |
| `autoToolChoiceOnlyModels?` | `string[]` | `tool_choice` が `auto` または `none` のみを受け入れるモデル。強制的な選択は格下げされます。 |
| `preserveReasoningContentModels?` | `string[]` |チャット履歴に以前のアシスタント `reasoning_content` が必要なモデル。 |
| `reasoningDetailsModels?` | `string[]` | thinking を構造化された `reasoning_details` 配列で返すモデル（`reasoning_split` 使用の MiniMax M シリーズ）。ストリーム差分は累積スナップショットとして prefix-diff され、保持された reasoning は `reasoning_content` 文字列ではなく `reasoning_details` 配列としてリプレイされます。 |
| `requiresReasoningPlaceholderModels?` | `string[]` | `reasoning_content` を欠いた tool_call 継続を上流が拒否するモデル（DeepSeek thinking モード）。リプレイキャッシュが外れた場合に最小プレースホルダーを注入。未設定時は `preserveReasoningContentModels` を引き継ぎ、`[]` で明示的に無効化。 |
| `thinkingToggleModels?` | `string[]` |エフォート ラダーではなく `thinking.enabled` を使用してモデルをチャットします。 |
| `thinkingBudgetModels?` | `string[]` |整数 `thinking_budget` を使用したチャット モデル。労力は予算の一部にマッピングされます。 |
| `noVisionModels?` | `string[]` |ビジョン サイドカーを通じて送信されるテキストのみのモデル。マッチングでは、Ollama `:size` タグが許容されます。 |
| `escapeBuiltinToolNames?` | `boolean` | Anthropic 互換ゲートウェイの組み込みツール名をエスケープし、返された呼び出しで復元します。 |
| `anthropicEofTolerance?` | `boolean` | `message_stop` 前にストリームが終了しても、可視テキストまたは完全な JSON オブジェクトのツール入力が受信済みの場合に限り完了を許可します（Anthropic 互換ゲートウェイ向け）。デフォルトはオフ。 |
| `googleMode?` | `"ai-studio" \| "vertex" \| "cloud-code-assist"` | Google トランスポート/認証モード。デフォルトは`ai-studio`です。 |
| `project?` | `string` | Vertex または Antigravity Cloud Code Assist プロジェクト ID。 |
| `location?` | `string` |頂点の位置。環境フォールバックは `GOOGLE_CLOUD_LOCATION` です。 |
| `mcpServers?` | `Record<string, CursorMcpServerConfig>` |カーソルのみ: 標準入出力またはストリーミング可能な HTTP MCP サーバー。 |
| `desktopExecutor?` | `DesktopExecutorConfig` |カーソルのみ: 外部コンピュータ使用および画面録画コマンド。 |
| `unsafeAllowNativeLocalExec?` | `boolean` |カーソルのレガシー ブール値。新しいフィールドが設定されていない場合のみ、`nativeLocalExec: "on"` と同等です。 |
| `nativeLocalExec?` | `"off" \| "codex-sandbox" \| "on"` |カーソルのローカル実行ポリシー。 `off` がデフォルトです。 `codex-sandbox` は現在、`off` と同様にフェールクローズされます。 |

API キープロバイダーは、リテラルキーまたは環境参照を保持する場合があります。 OAuth プロバイダーは、`ocx login` によって設定された資格情報ストアを使用します。サブスクリプションに基づくクロード コードの起動動作は、[`claudeCode.authMode`](/reference/configuration/server/#claude-code) で構成されます。

## プロバイダーによるアウトバウンドの安全性診断

ダッシュボード接続テストとライブ モデル検出では、制限された GET 専用トランスポートが使用されます。送信プロキシを使用しない場合、opencodex はホスト名を一度解決し、その検証されたアドレスにのみ接続します。 HTTPS は元のホスト、SNI、および証明書の検証を保持します。プロバイダー設定では証明書チェックを無効にすることはできません。

`HTTP_PROXY`、`HTTPS_PROXY`、または `ALL_PROXY` が適用される場合、これらの操作は Bun のネイティブ フェッチを維持します。 URL とリテラル アドレスのチェックは引き続き実行されますが、プロキシが最終ルート、DNS 応答、ピアを選択するため、opencodex はそのピアを固定したり検証したりできません。これは明示的なセキュリティ制限です。

プライベート/ローカル宛先には `allowPrivateNetwork: true` が必要で、送信プロキシがアクティブな場合は、一致する `NO_PROXY` エントリが必要です。ループバックは自動的に追加されます。 CIDR エントリは解釈されないため、各 LAN ホストを明示的にリストします。マッチャーは、正確なホスト、ドメイン サフィックス、オプションのポート、括弧で囲まれた IPv6、および `*` をサポートします。たとえば、`192.168.1.50` を明示的にリストします。メタデータとリンクローカル宛先はブロックされたままになります。診断リクエストはリダイレクトを拒否し、資格情報が剥奪されたターゲットを報告します。通常のプロバイダー要求のリダイレクト レビューは、この診断ガードとは独立したままになります。

## Codexアカウントプール

pool アカウントの追加と quota 更新はダッシュボードの **Codex Auth** ページで処理してください。設定には secret で
ないアカウント metadata だけを保存し、access/refresh token は強化された Codex アカウント credential store に別途
保管します。Pool routing は新規/未紐付け割り当て、使用量ベースのプロアクティブ切り替え、障害回復に分かれます。
紐付け済みタスクは通常 affinity を維持しますが、`quota` はしきい値超過後の次のリクエストで再紐付けでき、
pause、cooldown、再認証、障害処理も独立して routing を消去または変更できます。未紐付けリクエストには
プロキシ再起動や affinity リセット後の既存タスクも含まれます。出力前の **429/402** は使用量ベースの
切り替えがオフでも同じリクエストで適格な代替アカウントへ 1 回再試行できます。アカウント変更後も会話
コンテキストは保持・再生されますが、アカウント間の provider prompt cache 再利用は保証されません。
一時停止したアカウントと quota metadata は表示されたままですが、自動切り替え、再試行/failover 選択、cooldown 復旧プローブ、手動有効化の対象外です。
一時停止するとそのアカウントの thread affinity map も消去されます。処理中のリクエストは取得済み credential を維持しますが、以降のターンは再ルーティングされ、一時停止中のアカウントは再利用できません。
状態は再起動後も保持され、すべてのアカウントが一時停止中なら Pool ルーティングは別のアカウントを暗黙に選ばず失敗します。
**上限到達を一括停止** は credential がある適格アカウントだけを先に更新し、関連する quota window が今回 100% と確認できたアカウントだけを停止します。credential がないアカウントや、quota が不明、または更新に失敗したアカウントは変更しません。
**401/403** では、そのアカウントへのプロセスローカルな affinity を解除し、再認証を要求します。
**429** では `Retry-After` を尊重してアカウントの cooldown を開始し、affinity を解除したうえで、
別の適格な Pool アカウントへリクエストを切り替えることがあります。これらの障害回復は
`autoSwitchThreshold: 0` でも有効であり、`0` が無効にするのは使用量に基づく予防的な切り替えだけです。

**割り当てとプロアクティブ切り替え戦略：** `quota`（既定）はアクティブアカウントがない場合に最小 usage の適格アカウントを選び、適格なアクティブアカウントが `autoSwitchThreshold` 未満なら維持します。`autoSwitchThreshold` 超過後は紐付け済みタスクの次のリクエストも再紐付けできます。`round-robin` は
未紐付けリクエストを均等分散し、しきい値は通常の rotation を変えません。`accountPoolStickyLimit`
（既定 `1`、1–100）は成功応答ではなく割り当て/紐付け数を数えます。`fill-first` は未紐付けリクエストを
cooldown、再認証、または drain threshold までアクティブアカウントへ割り当て、正常な紐付け済みタスクは
affinity を維持します。これらの戦略は provider enforcement を回避しません。

### `anthropicAccountPool` (実験的)

このオプトインは、`auth.json` に既に保存されている複数の Anthropic OAuth アカウントをプールします。デフォルトではオフになっており、実戦テストは行われていません。同じ組織内のアカウントがクォータを共有する場合があり、自動ローテーションによってプロバイダーの制限がトリガーされる場合があります。

|キー |タイプ |デフォルト |説明 |
| --- | --- | --- | --- |
| `anthropicAccountPool.enabled?` | `boolean` | `false` |スティッキー アフィニティと 429 クールダウン フェイルオーバーを有効にします。 |
| `anthropicAccountPool.autoSwitchThreshold?` | `number` | `80` |新しいセッションでは、アクティブなアカウントがこのしきい値に達すると、設定した期間で既知のキャッシュ使用量が最も低いアカウントを選択します。 `0` はクォータ選択を無効にします。 |
| `anthropicAccountPool.strategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` |新しいセッション戦略。`quota` は `quotaWindow` で指定した期間（既定は 5 時間足）でアカウントを順位付けし、`fill-first` も同じ期間で使い切りのしきい値を判定します。 |
| `anthropicAccountPool.quotaWindow?` | `"five-hour" \| "weekly" \| "max-utilization"` | `"five-hour"` |使用量ベースのアカウント選択で使う、プロバイダー報告のキャッシュ済み使用率です。`five-hour` は従来の動作を維持します。`weekly` は週次使用量を使い、他に対象アカウントが残る間だけ 5 時間使用量が上限に達したアカウントを除外し、残らない場合はそれらへフォールバックします。`max-utilization` は判明している値のうち最も高いものを使うため、週次使用量が未取得でも 5 時間使用量を利用できます。どちらも不明なら unknown の順位付けに従います。既知の使用量は unknown より先ですが、対象がすべて unknown でも対象順の先頭を選択します。記載した 5 時間使用量による同点判定後も完全に同点なら、対象順を維持します。正常な affinity セッションを先回りして再配置することはありません。新規セッションの割り当てと、対象となる 429 代替後のルーティング復旧では、`quota` はこの期間で対象候補を直接順位付けし、`fill-first` はこの期間のしきい値と上限到達ルールを使って安定順に進み、`round-robin` はこの設定を無視します。クールダウン、フェイルオーバー上限、再認証の適格性は別のローカル状態です。アカウント別の週次使用量は、ダッシュボードのプロバイダーページで取得した後にのみ利用できます。 |
| `anthropicAccountPool.stickyLimit?` | `number` | `1` |成功した新しいセッションのバインドは 1 つのラウンドロビン選択で保持されます。範囲は 1 ～ 100。 |

有効にすると、429 レコードは `Retry-After` またはデフォルトのバックオフからの制限されたクールダウンを記録し、リクエスト内でローテーションする可能性があります。アフィニティはプロセスローカルであり、サイズ制限があります。資格情報 401/403 は、アカウントに再認証が必要であることをマークします。すべての対象となるアカウントが冷却されている場合、クライアントは、既知の場合、認証エラーではなく、`Retry-After` を含む 429 を受け取ります。

:::caution[実験的]
Anthropic アカウント ポリシーのリスクを理解していない限り、これは無効のままにしてください。不明な場合は、`ocx account use anthropic <id>` を手動で切り替えることをお勧めします。
:::

### 管理されたレコードの形状

`apiKeys[]` エントリには、`id`、`name`、生成された `key`、および ISO `createdAt` 文字列が含まれます。 `codexAccounts[]` エントリには `id`、`email`、および `isMain` が必要で、オプションの `plan`、`chatgptAccountId`、およびプライバシー セーフな `logLabel` が必要です。これらのレコードは通常、ダッシュボードで管理されます。

### `tokenGuardian` (`OcxTokenGuardianConfig`)

|フィールド |タイプ |デフォルト |意味 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` |グローバル プロアクティブ リフレッシュ スイッチ。 |
| `tickSeconds?` | `number` | `21600` |スイープ間隔 (6 時間、最小 60 秒)。 |
| `jitterSeconds?` | `number` | `300` |スイープ前のランダムな遅延。 |
| `concurrency?` | `number` | `3` |最大同時リフレッシュ数。 |
| `leadSeconds?` | `number` | `900` | 1 ティックを超える余分なリフレッシュ リード タイム。 |
| `failureBackoffBaseSeconds?` | `number` | `300` |初期の過渡障害バックオフ。 |
| `failureBackoffMaxSeconds?` | `number` | `3600` |バックオフの上限と永続的な障害による遅延。 |
| `codexWarmupEnabled?` | `boolean` | `false` |合成 Codex プールアカウント検証をオプトインします。 |
| `codexWarmupMaxAgeSeconds?` | `number` | `691200` | 8 日後にアカウントを再認証します。 |
| `codexWarmupModel?` | `string` | `gpt-5.4-mini` |オプションのウォームアップに使用されるネイティブ モデル。 |

## 固定プロバイダーエンドポイント

ルーティングは、アダプターの前にプロバイダー エンドポイントを解決します。ほとんどの組み込みでは、レジストリ エンドポイントが構成された `baseUrl` よりも優先されます。 4 つのエントリ タイプでは、構成された URL が保持されます。

- オーバーライドが有効なプロバイダー: `ollama`、`vllm`、`lm-studio`、`litellm`、`qwen-cloud`、および
`alibaba-token-plan-intl`;
- `azure-openai` や `cloudflare-ai-gateway` など、ユーザーが入力したレジストリ テンプレート。
- 古い同じ名前のカスタム宛先を保持する固定 API キー プリセットを昇格しました。そして
- プロバイダーがレジストリに存在しません。

アダプターは、解決された URL を後で調整できます。たとえば、Kiro は、インポートされた資格情報の正規 `runtime.{region}.kiro.dev` の API リージョンに従います。 [アダプター](/reference/adapters/)を参照してください。

ルーティングで `baseUrl` が破棄されると、opencodex はレジストリ エンドポイントと構成された起点のみをログに記録します。構成されたパス自体に資格情報が含まれる場合があります。未使用の URL を削除するか、目的のリージョンに一致するプロバイダー エントリを選択します。 `alibaba-token-plan` は北京に固定されていますが、`alibaba-token-plan-intl` は国際エンドポイントをカバーしています。

壊れた `openai-responses` ゲートウェイの場合、修復はプロバイダー オブジェクトに属します。

```json
{
  "providers": {
    "custom-gateway": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example/v1",
      "apiKey": "${GATEWAY_KEY}",
      "responsesItemIdRepair": {
        "reasoning": ["rs_0"],
        "message": ["msg_0"],
        "repairMissingTerminalIds": true
      }
    }
  }
}
```

プレースホルダー リストは完全に一致します。通常/ステートフル応答プロバイダーのフィールドを未設定のままにして、パススルーがバイトごとに同一になるようにします。

## Cursor プロバイダー (`adapter: "cursor"`)

カーソルブリッジは実験的なものです。 `ocx login cursor` の後に、`providers.cursor` を追加または編集します。ピッカーはカーソル固有のモデル パラメーターをレンダリングできないため、カーソル ルーターの最適化ラダーは別の Codex ID として公開されます。

|Codexモデル |カーソル ルーターモード |
| --- | --- |
| `cursor/auto` |チーム/アカウントのデフォルト |
| `cursor/auto-cost` |コスト |
| `cursor/auto-balance` |バランス |
| `cursor/auto-intelligence` |インテリジェンス |

明示的なバリアントは、Cursor の `default` モデルを `optimization` パラメータとともに送信し、リクエストごとに選択を保持します。ライブディスカバリーで `default` を省略しても、これらは引き続き使用できます。

カーソル サーバー駆動のローカル ツールは、デフォルトでは無効になっています。 Codex は、独自の承認とサンドボックス ポリシーを備えた `apply_patch` や `exec_command` などの独自のツールを引き続き使用します。

- `"off"` (デフォルト) は、カーソルネイティブの `read`、`write`、`delete`、`ls`、`grep`、`shell`、および
`fetch`実行。
- `"on"` は、信頼できるローカルでの実行を選択し、Codex 承認/サンドボックス セマンティクスをバイパスします。
- `"codex-sandbox"` は互換性のために残されていますが、`"off"` と同様にフェールクローズされます。散文のリクエストは
信頼できるサンドボックス証明書ではありません。

```json
{
  "providers": {
    "cursor": {
      "adapter": "cursor",
      "baseUrl": "https://api2.cursor.sh",
      "authMode": "oauth",
      "defaultModel": "auto",
      "nativeLocalExec": "off"
    }
  }
}
```

最上位ではなく、`providers.cursor` にフィールドを設定します。ダッシュボードで **プロバイダー > カーソル > JSON の編集** を使用し、保存して再起動します。従来の `unsafeAllowNativeLocalExec: true` は、`nativeLocalExec` が設定されていない場合にのみ `nativeLocalExec: "on"` と等しくなります。 MCP、画面録画、およびコンピューターの使用は、`mcpServers` および `desktopExecutor` によって個別に制御されます。

各 `mcpServers.<name>` は、`command` (stdio) または `url` (ストリーミング可能な HTTP) のいずれかを受け入れます。 Stdio は `args`、`env`、および `cwd` も受け入れます。 HTTP は `headers` を受け入れます。どちらも `enabled` (デフォルトは true) と `toolPrefix` をサポートします。 `desktopExecutor` は、`computerUseCommand`、`recordScreenCommand`、`cwd`、`env`、および `timeoutMs` (デフォルトは `30000`) を受け入れます。コマンドは `sh -c` を通じて実行され、stdin から 1 つの JSON リクエストを読み取り、1 つの JSON 結果を stdout に書き込む必要があります。

:::caution[安全]
デフォルトのループバック バインドでは、マルチユーザー ホスト上の他のユーザーを含む、認証なしのローカル プロセスを許可します。すべてのデータプレーン呼び出し元が信頼されており、Codex 承認とサンドボックス セマンティクスのバイパスを意図的に受け入れる場合を除き、ローカル exec はオフのままにしておきます。
:::

## OpenRouter プロバイダーのルーティング

OpenRouter は、複数の推論プロバイダーを通じて 1 つのモデルを提供できます。 `openRouterRouting` は優先プロバイダーでリクエストを保持します。 `modelOpenRouterRouting` は、正確なモデル ID に置き換えられます。キャッシュのサポート、保持、ヒット率、価格は推論プロバイダーによって異なるため、これはプロンプト キャッシュ アフィニティに役立ちます。

プロバイダー名は OpenRouter スラッグです。 `allowFallbacks: false` はフェールクローズされます。 `true` では、順序付きリストの後に別の適格なプロバイダーを許可します。 `only` は常に許可リストです。

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "openRouterRouting": {
        "order": ["deepseek"],
        "allowFallbacks": false
      },
      "modelOpenRouterRouting": {
        "anthropic/claude-sonnet-5": {
          "only": ["anthropic"],
          "allowFallbacks": false
        }
      }
    }
  }
}
```

モデル キーは、外部の opencodex プロバイダー プレフィックスを除いた、正確なネイティブ OpenRouter ID です。 `openrouter/anthropic-claude-sonnet-5` を選択すると、モデル ルールを適用する前のネイティブ `anthropic/claude-sonnet-5` が復元されます。

## Vercel AI Gateway プロバイダーのルーティング

Vercel AI Gateway は、1 つのモデルを複数の基盤となる推論プロバイダーへルーティングできます。`vercelGatewayRouting` はプロバイダー全体の設定を構成し、`modelVercelGatewayRouting` は正確なモデル ID ごとにそれを置き換えます。両方とも未設定の場合、`resolveVercelGatewayRouting()` は `undefined` を返すため、Chat リクエスト ビルダーは `provider` フィールドを省略し、Vercel AI Gateway のデフォルトの動的ルーティング動作が維持されます。

- `order`: 優先順位順の Vercel AI Gateway アップストリーム プロバイダー スラッグ。
- `only`: 対象となる Vercel AI Gateway アップストリーム プロバイダーを制限する明示的な許可リスト。
- `sort`: 対象となるプロバイダーを `"cost"` (最安コスト)、`"ttft"` (最初のトークンまでの時間)、または `"tps"` (1 秒あたりのトークン数) で自動的に並べ替えます。

```json
{
  "providers": {
    "vercel-ai-gateway": {
      "adapter": "openai-chat",
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKey": "${VERCEL_AI_GATEWAY_KEY}",
      "vercelGatewayRouting": {
        "sort": "ttft"
      },
      "modelVercelGatewayRouting": {
        "zai/glm-5.2": {
          "only": ["novita", "deepinfra"],
          "order": ["novita", "deepinfra"]
        }
      }
    }
  }
}
```

モデル キーは、外側の opencodex プロバイダー プレフィックスを除いた Vercel の公開モデル セレクターです。`vercel-ai-gateway/zai-glm-5.2` を選択すると、モデル ルールを適用する前にネイティブの `zai/glm-5.2` が復元されます。ネイティブの `vercel/<model-id>` セレクターにも同じマッピングが適用されます。opencodex ではエンコードされた `vercel-ai-gateway/vercel-<model-id>` セレクターを使用し、モデル キーには `vercel/<model-id>` を指定してください。

## 静的モデルのホワイトリスト

`models` のみを公開するように `liveModels: false` を設定します。 `models` が空であるか省略されている場合、プロバイダーはルーティングされたモデルを公開しません。ライブ ディスカバリは、キャッシュする前に 4 MiB または 2,000 を超える生のモデル行を拒否します。組み込みのプリセットは下限を使用し、チャットに適した行にフィルターをかけることができます。サイズが大きすぎる、または形式が正しくない結果は、古い/構成されたフォールバックに続きます。ゼロに適格な有効な結果は引き続き権威を持ち、暗黙的に置き換えられたり切り捨てられたりすることはありません。

検出を実行する必要があるが、選択した ID のみが Codex および `/v1/models` に表示される必要がある場合は、`selectedModels` を使用します。ダッシュボードには、後で許可リストを変更できるように、検出された完全なリストが保持されます。

表示名には `modelDisplayNames` を使用します。優先順位は、運用者が設定した `modelDisplayNames`、プロバイダーカタログのメタデータ、通常の `provider/model` 表示の順です。キーはこのプロバイダー内の正確なネイティブモデル ID です。例えば `xai/grok-4.6` のキーは `grok-4.6` です。ラベルは表示専用で、正確なルーティング ID や上流モデル ID を変更しません。`config.json` の既存プロバイダー設定にこのフィールドだけを追加し、他のすべてのフィールドを残してください。`PUT /api/providers/:provider/model-display-names` に `{ "modelId": "grok-4.6", "displayName": "Grok 4.6" }` を送ると保存され、`displayName: null` を送るとその名前だけがリセットされます。

プレビュー GPT-5.6 フォールバック エントリは同じメカニズムを使用します。 OpenAI API キー プリセットは、ベース ID と Pro ID にコンテキスト `922000` と最大入力 `922000` をシードします。 OpenRouter は、コンテキスト `922000` を持つ `openai/gpt-5.6-sol`、`openai/gpt-5.6-terra`、および `openai/gpt-5.6-luna` をシードします。プール/ダイレクトは `922000` をアドバタイズします。同期されたカタログは、`xhigh` を区別しつつ、`max` をアドバタイズします。

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

## 完全な例

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
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "defaultModel": "glm-5.2",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  },
  "subagentModels": ["anthropic/claude-opus-5", "ollama-cloud/glm-5.2"],
  "disabledModels": [],
  "websockets": false,
  "webSearchSidecar": {
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 60000
  },
  "visionSidecar": { "enabled": true }
}
```
