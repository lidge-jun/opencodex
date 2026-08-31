---
title: プロバイダー
description: opencodex が LLM プロバイダーを認証し通信するすべての方式 — OAuth、API キー、ChatGPT 転送、そしてローカル。
---

**プロバイダー**は一つの上流 LLM エンドポイントとそこへの到達方法を合わせたものです: アダプター、ベース URL、認証
モード、そしてオプションのモデル一覧で構成されます。プロバイダーは `~/.opencodex/config.json` の `providers` の下にあります。

## OpenAI アカウントモード

| プロバイダー ID | 用途 | 認証情報/アカウットルール |
| --- | --- | --- |
| `openai` | Codex ログイン | Pool(デフォルト)はメイン + 追加アカウントを選び、Direct は現在の caller/メインログインのみを使います。 |
| `openai-apikey` | OpenAI API | 設定された API キー/キープールのみを使い、Codex アカウントは読みません。 |

bare `gpt-5.6-sol` は Providers ページの Pool/Direct オプションに従い、
`openai-apikey/gpt-5.6-sol` は API を選択します。認証情報経路間のフォールバックはありません。API は context 922,000 /
max input 922,000 で `*-pro` virtual ID は公開状態を維持し、wire でベースモデルと
`reasoning.mode: "pro"` に切り替わります。

組み込み `openai` が欠落または無効な場合、ダッシュボードの Accounts ピッカーと Codex Auth から復元できます。欠落行は正規プリセットから作成され、正規の無効行は保存済みのモードやモデル設定を置き換えずに再有効化され、非正規の `openai` 行にはその復元経路は出ません。

### プロバイダー概要のプール容量

Codex login を Pool モードで使うと、Providers の概要には任意の 1 アカウントではなく、
プール全体の使用済み容量の推定値が表示されます。同じ行には現在の有効アカウントの
生のクォータ使用率も表示されるため、プールの推定値と次のリクエストで使われる
アカウントの状態を区別できます。

リセット情報がある場合は、次のリセット時刻と、その時点で回復するプール容量が表示されます。
**対象範囲が不完全**という警告は、プランやクォータが不明、読み取りが古い、アカウントが
一時停止中、または再認証が必要などの理由で、安全に推定へ含められないアカウントがあることを示します。

**期間別の対象範囲が一部不完全**という警告は、含まれるアカウントの一部が、表示中の
クォータ期間のうち一部だけを報告したことを示します。概要では各期間を分けたまま、影響を受ける
期間を個別に不完全と表示し、欠けた値をその期間の使用量として扱いません。

この推定値は表示専用です。アカウント選択、セッション affinity、自動切り替え、cooldown、
その他のルーティング判断には影響しません。個別アカウントの状態とルーティング設定は
[Codex Auth のアカウントプール](/ja/guides/web-dashboard/#codex-auth-and-account-pools)を参照してください。

出荷版 v1 config は marker 2 の単一オプション行に自動移行されます。オリジナルは
`~/.opencodex/config.json.pre-openai-tiers-v2.bak` に一度保存され、次のコマンドで復元します:
`cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json`。

## 認証モード

プロバイダー設定で使える `authMode` は 3 種類で、デフォルトは `key` です。組み込みレジストリは
ローカルプリセットを別に分類します。ローカルプリセットでは通常 `authMode` と `apiKey` を両方使いません。

| `authMode` | 認証方式 | 用途 |
| --- | --- | --- |
| `key` | API キーを送信します(`Authorization: Bearer …`、またはアダプターにより `x-api-key` / `api-key`)。キーはリテラルまたは `${ENV_VAR}` 参照です。 | 大半のプロバイダー。 |
| `forward` | **受け取った Codex 認証ヘッダーを**プロバイダーにそのまま中継します — キーを保存しません。ChatGPT ログインのパススルーです。 | OpenAI(`openai-responses` アダプター)。 |
| `oauth` | 保存された OAuth アクセストークンを読み込み bearer キーとして使い、期限切れ前に自動更新します。 | xAI、Anthropic、Kimi、Kiro、Google Antigravity、Cursor、Command Code、GitHub Copilot、Nous Portal。 |

[`retryOn429`](/ja/reference/configuration/)（同一キーでの 429 リトライ）は API キー プロバイダー
（`authMode: "key"`）のみに適用されます。OAuth・forward・ローカル プリセットは除外されます —
同じトークンを再送すべきではなく、ローカルランタイムには保存すべきリモートキーがありません。
オプトインです: オプションが無ければ無効、オブジェクトがあれば `enabled: false` でない限り有効です。

## 1. ChatGPT ログイン(forward / パススルー)

デフォルトプロバイダーは**API キー不要**です。既存の `codex login` の認証情報を OpenAI Responses バックエンドに
そのまま転送します:

```json
{
  "openai": {
    "adapter": "openai-responses",
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "authMode": "forward"
  }
}
```

厳選されたヘッダーセットのみ転送されます(`FORWARD_HEADERS`: authorization、ChatGPT アカウント ID、
OpenAI beta/originator/session — [アダプター](/ja/reference/adapters/)参照)。この経路は
[ウェブ検索とビジョンのサイドカー](/ja/guides/sidecars/)を動かす経路でもあります。

ChatGPT パススルーカタログには GPT-5.6 Sol/Terra/Luna の名前空間なしスラッグ
(`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`)も含まれます。実際の呼び出し可否はアカウント権限に
依存します。

## 2. アカウントログイン(OAuth)

OAuth ログインを使うプロバイダープリセットは 8 つで、これに実験的な非公式デバイスフロー
ブリッジ経由の GitHub Copilot が加わります。認証情報は `~/.opencodex/auth.json` に保存され、
自動更新されます。ログイン CLI は `chatgpt` も受け付けます。このコマンドは ChatGPT 認証情報を
発行し `forward` モードのプロバイダーエントリを作成します。

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login nous         # Nous Portal (デバイスグラント; 無料 + 有料モデル)
ocx login kiro         # kiro-cli 認証情報の取り込み(トークンフォールバック対応)
ocx login google-antigravity
ocx login cursor       # Cursor 専用 PKCE ログイン
ocx login command-code # Command Code のブラウザ OAuth (または ~/.commandcode/auth.json を取り込み)
ocx login github-copilot  # GitHub デバイスフロー → Copilot トークン (Copilot Pro/Business)
ocx login chatgpt      # 別途 ChatGPT OAuth ログイン
ocx logout <provider>
```

| プロバイダー | アダプター | ベース URL | 備考 |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://cli-chat-proxy.grok.com/v1` | OAuth は独立した Grok CLI サブスクリプションゲートウェイを使用します。API キーのオーバーライドは `https://api.x.ai/v1` を使用し、Priority Processing を注入する場合があります。ライブ一覧を優先し、フォールバックのデフォルトモデルは `grok-4.5`。 |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude モデル; ライブモデル一覧は `/v1/models` から取得。 |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2.7/K2.6/K2.5 コーディングモデル。 |
| `nous` | `openai-chat` | `https://inference-api.nousresearch.com/v1` | Nous Research サブスクリプションゲートウェイ（Hermes Agent と同じバックエンド）。`portal.nousresearch.com` へのデバイスグラントログイン; access トークンはリクエストごとの inference JWT。有料 + `:free` モデルの混在カタログ（`tencent/hy3:free`、`stepfun/step-3.7-flash:free` など）はサインイン中のアカウントからライブ探索されます。Refresh トークンは単回使用で、更新のたびにローテーションされます。 |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | 初回ログインは、インストール済みでサインインした `kiro-cli` セッションを取り込みます（Unix では `curl -fsSL https://cli.kiro.dev/install` &#124; `bash`、Windows PowerShell では `irm 'https://cli.kiro.dev/install.ps1'` &#124; `iex` でインストールしてから `kiro-cli login` を実行）。**アカウントを追加**は `kiro-cli` をログアウトして新しいブラウザログインを開始し、`kiro-cli` 自体のアカウントを切り替えてアカウント別プロファイルメタデータを保存します。既存の OpenCodex アカウントは保持され、キャンセルまたは失敗時には以前の `kiro-cli` セッションが復元されます。 |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | Google OAuth を Cloud Code Assist wire で使用。ライブ探索は認証済みの CCA `v1internal:fetchAvailableModels` エンドポイントを使用し、ログイン中のアカウントで利用可能な agent モデルのみを公開します。管理されたカタログはフォールバックとして残ります。 |
| `cursor` | `cursor` | `https://api2.cursor.sh` | 実験的 PKCE ログイン、HTTP/2 トランスポート、アカウント別モデル探索をサポート。 |
| `github-copilot` | `openai-chat` | `https://api.githubcopilot.com` | 実験的。GitHub デバイスフロー + `copilot_internal` 交換（VS Code OAuth クライアント）。有効な Copilot サブスクリプションが必要で、公式のサードパーティ API ではありません。 |

Nous の refresh が終端失敗した場合は、再認証に `ocx login nous` を実行してください。

正規の Kimi Coding Plan プリセット（`kimi` アカウントログインと `kimi-code` API key）では、
opencodex は呼び出し元が指定した安定した `prompt_cache_key` だけを Chat Completions リクエストへ
転送し、自ら生成しません。Kimi のドキュメントでは、Code Plan のキャッシュヒット率を高めるために
安定したセッション/タスク key が必須とされています。key のないリクエストは keyless のままです。
opt-in した上流がこのフィールドを拒否しても、opencodex はフィールドを削除して再試行したり、保存済み
設定を変更したりしません。他のプロバイダーは deny-by-default のままです。

[ウェブダッシュボード](/ja/guides/web-dashboard/)からも OAuth を開始できます。

### 複数の OAuth アカウント

認証情報に固定アカウント ID やメールがある OAuth プロバイダーはログインを複数保持できます。
Providers ページでアカウントを追加し、別アカウントをログアウトせずにアクティブアカウントだけを切り替えられます。
アカウント識別情報がない Kimi 認証情報は通常のログインではアクティブスロットを差し替えますが、明示的な **アカウントを追加** では既存スロットを保持し、別の新しいスロットをアクティブにします。Kiro アカウントはプロファイル ARN をキーに保存されます。
`chatgpt` は Codex アカウントプールに別の保存場所があり、常に単一スロットのみ書き込みます。トークンは `~/.opencodex/auth.json` に保存され、
`/api/oauth/accounts` はマスク済みメタデータのみを返します。

### Cockpit Tools Antigravity のインポート

v1 で OpenCodex がインポートできるのは、`google-antigravity` プロバイダー向けの **Cockpit Tools Antigravity** JSON エクスポートのみです。Providers ダッシュボードでそのプロバイダーの Accounts タブを開き、ローカル JSON ファイルを選択します。ダッシュボードはファイル内容や認証情報の値を表示せず、インポート、更新、失敗、未対応の件数だけを表示します。他の Cockpit プロバイダーは v1 では未対応です。

CLI はファイルまたは標準入力からのみエクスポートを受け取り、コマンド引数への貼り付けはできません。

```bash
ocx account import google-antigravity --format cockpit-tools --file <path> [--json]
cat accounts.json | ocx account import google-antigravity --format cockpit-tools --stdin [--json]
```

インライン JSON と余分な位置引数は拒否されます。エクスポートファイルは非公開に保ち、インポート後は削除するか安全に保管してください。

### Kiro 認証情報の取り込み

Kiro のログインには Kiro CLI が必要です。Unix では `curl -fsSL https://cli.kiro.dev/install | bash`、Windows PowerShell では `irm 'https://cli.kiro.dev/install.ps1' | iex` でインストールしてから、先に `kiro-cli login` でサインインしてください。`kiro-cli` セッションがない場合、`ocx login kiro` は貼り付けたアクセストークンまたは `KIRO_ACCESS_TOKEN` 環境変数にフォールバックします。

通常の `ocx login kiro` 取り込みは CLI の SQLite データベースを読み取り専用で開き、データベース、WAL、SHM を変更しません。

- `KIROCLI_DB_PATH` は標準外の Kiro CLI SQLite データベースを選択します。指定するデータベースは既に存在している必要があります。
- `KIROCLI_TOKEN_KEY` は複数の曖昧なトークン行がある場合に、取り込む正確な `auth_kv` 行のキーを指定します。選択がない場合、推測せずログインに失敗します。

取り込んだ認証情報は `~/.opencodex/auth.json` に保存されます。**アカウントを追加**のロールバックは別処理で、以前のスナップショットを復元する際にデータベースを置き換え、現在の WAL、SHM、journal サイドカーを削除します。

ロールバックはスナップショットがある場合にのみ可能なため、セッションストアが存在するのに取得できない場合（ファイルが読めない、スキーマの不一致、トークン選択があいまい）、`KIROCLI_DB_PATH` / `KIRO_CLI_DB_FILE` が実際の CLI ストアと異なるインポート先を指す場合、またはプライマリ CLI データベースに認識できるトークン行がない場合、**アカウントを追加**は `kiro-cli` のログアウトを拒否します。通常の `kiro-cli` データパス上の壊れたデータベースを修復または削除し、インポート専用セレクタが設定されていれば解除してから再試行してください。既存の `kiro-cli` セッションがまったくない環境には影響しません。

## 3. API キーカタログ

opencodex には組み込みプリセットが 79 個含まれています。キー方式 67、OAuth 8、ローカル 3、
デフォルト ChatGPT 転送プリセット 1 です。ダッシュボードの **Add provider** ピッカーはキー発行ページを開き、
入力したキーを検証した後保存します(検証はプロバイダー固有です)。主な項目は以下のとおりです:

**ClinePass** は Cline API キーで[公式サブスクリプションカタログ](https://docs.cline.bot/getting-started/clinepass)と
[Chat Completions エンドポイント](https://docs.cline.bot/api/chat-completions)に接続します。運営主体は
[Cline の利用規約](https://cline.bot/tos)に記載された Cline Bot Inc. です。`cline-pass/cline-pass/kimi-k3` のようなルーティング ID は
意図した形式です。先頭は opencodex のプロバイダー、残りの `cline-pass/kimi-k3` は upstream に送信する
完全なモデル slug です。使用量はアカウントのローリング 5 時間、週次、月次の各上限で共有されます。
2026-08-13 の実機検証で、すべての静的 ClinePass モデルが gateway input で `low`、`medium`、`high`、`xhigh`、`max` を受け付けることを確認しました。
opencodex は要求された tier をそのまま保持し、バックエンド固有の正規化は ClinePass 側に委ねます。

**Cline** は同じ API キー・エンドポイントを従量課金で使い、100 以上のモデルにアクセスできます
(OpenRouter 形式の ID、例: `anthropic/claude-sonnet-4-6`)。Cline の期間限定無料モデルは
Cline IDE/CLI のみで API からは使えません。`minimax/minimax-m2.5` は API で利用できる
無料試用モデルとして文書化されています。

| プロバイダー | ベース URL |
| --- | --- |
| **OpenAI (API キー)** | `https://api.openai.com/v1` |
| **Anthropic (API キー)** | `https://api.anthropic.com` |
| **OpenRouter** | `https://openrouter.ai/api/v1` |
| **Cline** | `https://api.cline.bot/api/v1` |
| **ClinePass** | `https://api.cline.bot/api/v1` |
| **Ollama Cloud** | `https://ollama.com/v1` |
| Google Gemini · Google Vertex AI | `https://generativelanguage.googleapis.com` · `https://aiplatform.googleapis.com` |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai` |
| Umans AI · Neuralwatt | `https://api.code.umans.ai` · `https://api.neuralwatt.com/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| MiniMax · MiniMax (CN) | `https://api.minimax.io/v1` · `https://api.minimaxi.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Cerebras | `https://api.cerebras.ai/v1` |
| Chutes | `https://llm.chutes.ai/v1` |
| DeepInfra | `https://api.deepinfra.com/v1/openai` |
| Hyperbolic | `https://api.hyperbolic.xyz/v1` |
| Nscale Serverless Inference | `https://inference.api.nscale.com/v1` |
| Vultr Serverless Inference | `https://api.vultrinference.com/v1` |
| Baseten Model APIs | `https://inference.baseten.co/v1` |
| Command Code | `https://api.commandcode.ai/provider/v1` |
| SambaNova Cloud | `https://api.sambanova.ai/v1` |
| Nebius Token Factory | `https://api.tokenfactory.nebius.com/v1` |
| DigitalOcean Serverless Inference | `https://inference.do-ai.run/v1` |
| Scaleway Generative APIs | `https://api.scaleway.ai/v1` |
| Featherless AI | `https://api.featherless.ai/v1` |
| Novita AI | `https://api.novita.ai/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| Moonshot (Kimi API) · Kimi (coding) | `https://api.moonshot.ai/v1` · `https://api.kimi.com/coding/v1` |
| Hugging Face | `https://router.huggingface.co/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |
| Z.AI (GLM Coding) | `https://api.z.ai/api/coding/paas/v4` |
| Zhipu AI (BigModel) | `https://open.bigmodel.cn/api/paas/v4` |
| Qwen Cloud | トークンプラン(デフォルト): `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` · 従量課金: `https://dashscope.aliyuncs.com/compatible-mode/v1` · またはカスタム |
| Tencent Cloud Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/v3` |
| SiliconFlow | `https://api.siliconflow.cn/v1` |
| Volcengine Ark · Coding Plan · Agent Plan | `https://ark.cn-beijing.volces.com/api/v3` · `https://ark.cn-beijing.volces.com/api/coding/v3` · `https://ark.cn-beijing.volces.com/api/plan/v3` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Xiaomi MiMo (OpenAI Chat) | `https://api.xiaomimimo.com/v1` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitLab Duo | `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| …その他多数 | opencode zen、Vercel AI Gateway、Venice、NanoGPT、Synthetic、Qianfan、Alibaba、Parallel、ZenMux、LiteLLM |

**OpenCode Zen**（`opencode-zen`）とキー不要の **OpenCode Free** プリセットは
`https://opencode.ai/zen/v1` を共有します。このゲートウェイ上の無料モデルは、しばしばおおよそ毎分 15–20 リクエストの短時間レート制限に当たります（コミュニティ計測。OpenCode は RPM を公表しません）。Zen は `Retry-After` / `X-RateLimit-*` ヘッダーなしの汎用 429 を返すことがあります。これはキー不要デスクトップ枠（`opencode-free` で Big Pickle/無料モデル約 200 回 / 5 時間）とは別です。Zen がそのような 429 で `Retry-After` を省略した場合、opencodex はクライアント向けエラーに案内を足し、合成 `Retry-After` を付けます（上流の `Retry-After` があればそれが優先されます）。同一キーの待機再試行は [`retryOn429`](/ja/reference/configuration/) でオプトインします。

大半は bearer キーと共に `openai-chat` アダプターを使い、Anthropic 互換エンドポイントのみを公開する一部
(例: **Xiaomi MiMo**)は `anthropic` アダプター(`x-api-key`)を使います。
Volcengine Agent Plan は `openai-responses` アダプターでネイティブ Responses エンドポイントを使用します。

> **Volcengine の 3 つの課金経路:** `volcengine` は従量課金 Ark API、
> `volcengine-coding-plan` は Coding Plan の割り当て、`volcengine-agent-plan` は Agent Plan
> の割り当てを使用します。同じ製品で発行されたキーとエンドポイントを組み合わせてください。
> Plan 契約があっても通常の `/api/v3` 呼び出しには従量課金が発生する場合があります。
> 3 つの preset は選別済みの静的モデルカタログを使用します。Ark の `/models` はテキストに加えて
> Embedding、画像、動画、3D リソースも返し、Coding ゲートウェイも同じ広範なカタログを返します。
> Agent Plan ゲートウェイには `/models` リソースがありません。従量課金のデフォルトは
> `doubao-seed-2-1-pro-260628` で、静的カタログには現在の DeepSeek と GLM のテキストモデルも
> 含まれます。Coding Plan のデフォルトは `ark-code-latest`、Agent Plan は
> `deepseek-v4-pro` です。

**Chutes の discovery:** `chutes` preset は Chutes の固定された共有 OpenAI 互換 LLM gateway を使います。
公開 `/v1/models` catalog から `supported_features` が `tools` を示す行だけを残し、スラッシュを含む
model id と安全な live metadata を保持します。discovery は 256 KiB と raw 128 行に制限されます。
catalog は公開されているため、入力したキーの有効性は証明できませんが、chat request は設定済みの
Bearer キーで認証されます。ユーザーが deploy した custom Chute host と LLM 以外の API は custom
provider の範囲です。キーは [Chutes dashboard](https://chutes.ai/auth/start) で作成します。

**DeepInfra の discovery:** キー方式の OpenAI Chat Completions プロバイダー `deepinfra` は、
`openai-chat` アダプターと Bearer API キーを使います。registry が所有する DeepInfra のモデル一覧 URL から
`chat` タグを持つ行だけを残し、スラッシュを含むネイティブモデル ID を保持します。live discovery は
512 KiB、raw 512 行に制限します。キーは [DeepInfra dashboard](https://deepinfra.com/dash/api_keys) で作成します。

**Hyperbolic の discovery:** preset は設定済みの bearer キーで `/v1/models` を読み、スラッシュを含む
ネイティブモデル ID を保持し、live discovery を 256 KiB と raw 256 行に制限します。serverless text /
vision-language chat のみを対象とし、別系統の image、audio、GPU endpoint は対象外です。キーは
[Hyperbolic](https://app.hyperbolic.ai) で作成します。

**Nscale と Vultr の discovery:** どちらの preset も認証付き `/v1/models` カタログを読み、ネイティブ ID を
保持し、discovery を 256 KiB と raw 256 行に制限します。Nscale のカタログには modality フィールドなしで
chat、image、embedding が混在するため、公式の tool-calling API 例で使われる
`meta-llama/Llama-3.1-8B-Instruct` のみを許可します。Vultr は現在 `kimi-k2-instruct` だけに tool calling を
明記しているため、そのモデルのみを公開します。ほかの行は同等の agent-tool 証拠が公開されるまで非表示です。
Nscale の service token は [Nscale Console](https://console.nscale.com) で作成し、Vultr の inference key は
[Vultr Console](https://my.vultr.com) の subscription overview から取得します。

**Command Code の discovery:** preset は Command Code の `/provider/v1/models` リストを固定の
Provider API ホストから読み、スラッシュを含むネイティブモデル ID を保持し、live discovery を
256 KiB と raw 256 行に制限します。`ocx login command-code` はブラウザーでの OAuth サインインを
サポートします(既存の Command Code CLI ユーザー向けに `~/.commandcode/auth.json` からのローカル
CLI 資格情報の取り込みも可能)。モデルカタログはアカウント単位で、ログイン後に認証済みの
discovery エンドポイントから取得します。チャットリクエストは設定済みの bearer キーを使います。
キーは [Command Code Studio](https://commandcode.ai/studio/) で作成します。

**Command Code の quota:** ダッシュボードと `ocx account refresh` は、正規ホスト `https://api.commandcode.ai` 上の `/alpha/billing/credits` ウィンドウ（5時間と週次）を照会します。OAuth プリセット (`command-code`) は保存済みアカウント bearer を使い、Provider-API キープリセット (`commandcode`) は設定済みの有効キーを使います。ユーザーが編集した類似ホストは照会しません。期間支出が返る場合は、残りの monthly / purchased / free credits を USD ウィンドウとして表示します。

**SambaNova Cloud の discovery:** preset は固定 API ホスト上の SambaNova Cloud の公開 `/v1/models` 一覧を読み、
プロバイダー固有の ID を保持し、discovery を 128 KiB と raw 128 行に制限します。カタログは認証不要のため、
CLI の login flow は公開レスポンスをキーの有効性の証拠にせず、キーを検証不能として報告します。chat リクエストは
引き続き設定済み Bearer キーを使い、SambaNova がまだ対応していない並列 function call は無効にします。
非公開の SambaStudio deployment endpoint は対象外です。キーは
[SambaNova Cloud](https://cloud.sambanova.ai/apis) で作成します。

**Nebius Token Factory の discovery:** preset は認証付きの verbose モデルカタログを取得し、architecture
が text を出力する行だけを残して embedding と image-generation モデルを除外します。スラッシュを含む
ネイティブ ID と、報告された context / input modality metadata を保持し、discovery を 512 KiB と raw
512 行に制限します。dedicated deployment のホストは対象外です。キーは
[Nebius Token Factory](https://tokenfactory.nebius.com) で作成します。
**DigitalOcean の discovery:** preset は model access key を固定の共有 Serverless Inference ホストで使い、
認証済み `/v1/models` の応答と DigitalOcean の公式ドキュメントで確認した Chat Completions allowlist の
積集合だけを公開します。未知、Responses 専用、embedding、media generation の id は fail closed で除外し、
discovery を 256 KiB と raw 256 行に制限します。agent 固有 host と dedicated host は対象外です。キーは
[DigitalOcean Control Panel](https://cloud.digitalocean.com/model-studio/manage-keys) で作成します。

**Scaleway の discovery:** 認証済みモデル一覧と公式ドキュメントで確認した Serverless Chat Completions
allowlist の積集合だけを公開します。未知、Responses 専用、embedding、transcription、その他の media-model
id は fail closed で除外し、discovery を 128 KiB と raw 128 行に制限します。default Project の共有
endpoint を使用します。Project id 付き URL と dedicated deployment は custom provider で設定してください。
API キーは [Scaleway console](https://console.scaleway.com/generative-api) で作成します。

**Featherless の discovery:** 固定の OpenAI 互換ホストで認証し、chat と現在の plan に絞った人気順の
先頭 100 model だけを取得します。各 row が plan で利用可能、Hugging Face gate なし、かつ
`features.tool_use: true` と独立して報告しない限り fail closed で除外します。discovery は 128 KiB と
raw 100 行が上限で、数万件の catalog 全体を download / cache しません。`/v1/models` は認証あり・なしの両方で呼び出せると文書化されているため、入力したキーの有効性は証明できませんが、chat request は設定済みの Bearer キーで認証されます。個人 plan は interactive / prototype
用途に限られ、任意の application には Scale plan が必要です。キーは
[Featherless dashboard](https://featherless.ai/account/api-keys) で作成します。

**Novita の discovery:** キー方式のプリセットは `openai-chat` adapter を使用し、Bearer key は
Novita の固定 OpenAI 互換 host にだけ送信します。公開 model list から `model_type: chat` と
`chat/completions` endpoint の両方を報告する row だけを残し、discovery を 512 KiB と raw 256 行に
制限します。catalog は公開されているため、login は list 成功を key の証明にせず「検証不能」と報告します。
model ごとに capability が異なるため、provider 全体の parallel tool call と OpenAI
`reasoning_effort` は宣伝しません。キーは
[Novita key manager](https://novita.ai/settings/key-management) で作成します。

> **Baseten の対象範囲:** このプリセットは Baseten の共有 [Model APIs](https://docs.baseten.co/inference/model-apis/overview)
> のみを対象とします。ローカル利用では個人の [API キー](https://docs.baseten.co/organization/api-keys)を、
> 共有/本番利用では **Call Model APIs** 権限を持つチームキーを使用してください。専用 Truss `predict`
> エンドポイントはホストとスキーマが異なるため、このプリセットではルーティングされません。
> このプリセットのライブディスカバリーは、レスポンス 1 MiB、モデルの生行 256 件が上限です。

### A6API クレジットクォータ

`openai-chat`、`authMode: "key"`、正規の `https://api.a6api.com` または
`https://api.a6api.com/v1` を使うカスタムプロバイダーでは、ダッシュボードと
`ocx account refresh <provider>` に A6API クレジット使用量が表示されます。プロバイダー名は任意です。
アカウントの hard credit limit を基準にトークン単位を USD に換算し、使用率と残高を表示します。トークン期限は補充を意味しないため、クォータの
リセットとしては表示しません。アクティブキーだけを正規ホストへ送信し、リダイレクトを拒否します。負数や
整合しない請求合計からはレポートを生成しません。

> **Tencent Cloud Coding Plan の利用制限:** Tencent はこのサブスクリプションを対話型
> コーディングツール専用としています。一般的な API 自動化、カスタムアプリのバックエンド、
> 非対話型バッチ利用は禁止されており、プランキーが停止される場合があります。

> **GLM の経路は 2 つあります:** `zai` は Z.AI の国際コーディングプラン契約、`zhipu-bigmodel`
> は Zhipu の中国国内向け BigModel 従量課金エンドポイントです。ホストもキーも課金も別で、
> 一方で発行したキーはもう一方では認証されません。

### 複数の API キー

キーベースのプロバイダーも複数キーを保持できます。Providers ページでキーを追加すると
`provider.apiKeyPool` に保存してアクティブ化し、ルーティングとアダプターが以前と同じフィールドを読むように
`provider.apiKey` にも反映します。同じドロップダウンでキーの切り替えや削除ができます。管理 API は
`/api/providers/keys` でマスク済みキーのみを返します。

### ターミナルでアカウントを切り替え

ダッシュボードを開かずに `ocx account list`、`ocx account current`、`ocx account use` で同じ Codex、
OAuth、API キープールを確認・切り替えできます。完全なコマンド、JSON 出力、新規セッション適用方式は
[CLI リファレンス](/ja/reference/cli/#ocx-account-subcommand)を参照してください。

### GPT-5.6 プレビュー経路

ライブモデルカタログの更新が遅れても `ocx sync` でモデルが消えないよう、GPT-5.6
Sol/Terra/Luna をフォールバックリストに入れています。

| Codex 経路 | 事前登録されたモデル ID | Codex に表示されるコンテキスト |
| --- | --- | --- |
| Codex ログイン(Pool または Direct) | `gpt-5.6-*` | 922,000 |
| OpenAI (API キー) | `openai-apikey/gpt-5.6-*` と `*-pro` | 922,000 (max input 922,000) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`、`openrouter/openai/gpt-5.6-terra`、`openrouter/openai/gpt-5.6-luna` | 922,000 |
| Cursor | `cursor/gpt-5.6-sol`、`cursor/gpt-5.6-terra`、`cursor/gpt-5.6-luna` | 1,000,000 |

ネイティブ GPT-5.6 項目は固定の上流推論段階に従います。例えば Luna には
`max` はありますが `ultra` はありません。ルーティングモデルは各プロバイダーのメタデータと推論マッピングを
使います。4 経路すべてで実際の利用権は上流アカウントが決定し、Cursor はライブ探索結果に基づき現在のアカウントで使えるモデルのみ残します。

:::note[ゲートウェイとサブスクリプションプロキシ]
プロバイダー対応可否は「エージェント」製品かどうかではなく、opencodex に合う wire アダプターがあるかで
決まります。現在のアダプター ID は `openai-chat`、`openai-responses`、`anthropic`、`google`(AI Studio、
Vertex、Antigravity/Cloud Code Assist モード)、`azure` / `azure-openai`、`kiro`、`cursor` です。
Amazon Bedrock ネイティブ API のような、これらの実装のいずれにも合わない独自プロトコルは直接サポートしません。
**GitHub Copilot** と **GitLab Duo** は独自の汎用 OpenAI 互換エンドポイントにマッピングされたマルチモデル
ゲートウェイです。Copilot は `ocx login github-copilot` で GitHub デバイスフロー OAuth ログインを
サポートします(非公式ブリッジ — VS Code 公開クライアント ID でログイン後、短期 Copilot API トークンに
交換し、有効な Copilot サブスクリプションが必要で GitHub ポリシー変更でブロックされる可能性あり)。GitLab Duo は Bearer
**サブスクリプショントークン**(通常の API キーではない)で認証します。**Cloudflare AI
Gateway** は URL にアカウント + ゲートウェイ ID を埋める必要があります。

Copilot は混在 wire カタログを提供します。GPT-5 系モデル（`gpt-5.3-codex`、`gpt-5.4`、
`gpt-5.4-mini`、`gpt-5.5`、`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`）はエージェント
通信の `/chat/completions` を拒否するため、opencodex はこれらのモデルを組み込みデフォルトで
Responses API 経由にルーティングし、他の Copilot モデルはすべて chat completions のままです。
優先順位は次のとおりです: ハード wire ピン → 明示的な
[`modelAdapters`](/ja/reference/configuration/providers/) エントリ → レジストリのデフォルト →
プロバイダー全体の adapter。組み込みデフォルトのないモデル（例: `gpt-5.4-nano`）を Responses
に移すには、`"modelAdapters": { "gpt-5.4-nano": "openai-responses" }` を設定してください。

Cursor は別の実験的アダプターとして追跡します。`adapter: "cursor"` は `ocx init` とダッシュボード Add
Provider ピッカーに実験的 local config 項目として表示され、Cursor の静的フォールバックモデルカタログ
メタデータを保存します。Cursor アクセストークンを設定すると opencodex は Cursor ライブ HTTP/2 トランスポートを
使います。バンドル済みフォールバックリストには 1M コンテキストの `gpt-5.6-sol` / `terra` / `luna`、500K コンテキストの
Grok 4.5 / 4.6 の通常・Fast 行、262K コンテキストの `kimi-k3` が含まれ、ライブ探索結果に基づき現在の
アカウントに表示するモデルを決定します。Grok 4.6 は両形式で `low` / `medium` / `high` / `xhigh` を公開し、
4.5 は `high` までです。Fast リクエストは対応する Grok ベースモデルを、独立した `effort` と `fast=true` の
`requested_model` パラメータとともに送信します。平坦化された `cursor-grok-{version}-{effort}-fast` id は
探索と picker の識別子としてのみ使われます。Cursor は Kimi K3 を effort サフィックス付きの wire id
としてのみ提供するため、`cursor/kimi-k3` は `low` / `high` / `max` のラダーを公開し、既定値はモデル
ドキュメントの API 既定値と同じ `max` です。Cursor サーバーが直接送るネイティブ read/write/delete/ls/grep/shell/fetch 実行は Codex
承認とサンドボックス経路をバイパスするためデフォルトで無効です。信頼できるローカル実験でのみ
`~/.opencodex/config.json` の `providers.cursor` に `unsafeAllowNativeLocalExec: true` を設定してください。
ダッシュボードからは **Providers → Cursor → Edit JSON** で設定できます。完全な例は
[設定リファレンス](/ja/reference/configuration/#cursor-provider-adapter-cursor)を参照してください。
MCP、画面録画、computer-use はエグゼキューターフックで開かれており、ローカル
エグゼキューターがない場合はポリシー遮断ではなく typed no-executor 結果を返します。Cursor OAuth とライブ
モデルディスカバリはこの実験的アダプターで有効化されており、Cursor は引き続きキーログイン一覧には
表示されません。
:::

### Ollama Cloud

Ollama Cloud はホステッド型(ローカルではない)Ollama です。`https://ollama.com/v1` を設定し、キーは
[ollama.com/settings/keys](https://ollama.com/settings/keys) で発行します。opencodex は OpenAI 互換
サーフェスではなく Ollama 自身の REST API(`POST /api/chat`)で接続し、モデル一覧はプロバイダーから
動的に取得するため、新しい Ollama Cloud モデルは設定変更なしで現れます。opencodex はクラウド
ラインナップをビジョン機能で分類し、[ビジョンサイドカー](/ja/guides/sidecars/)がテキスト専用モデルにのみ
動作するようにします。テキスト専用モデル(例: `glm-5.2`、`deepseek-v4-pro`、`gpt-oss`、`qwen3-coder`、
`minimax-m2.x`、`nemotron-3-*`)は `noVisionModels` に列挙され、ビジョンネイティブモデル(例:
`kimi-k2.6`、`minimax-m3`、`gemma4`、`qwen3.5`、`gemini-3-flash-preview`)は含まれません。マッチングは
Ollama の `:size` タグに寛容なので `gpt-oss` は `gpt-oss:120b` と `gpt-oss:20b` の両方を含みます。

Ollama は現在、構造化出力は Ollama Cloud では未対応であるとドキュメントしています。正規の
`ollama-cloud` に対する構造化出力リクエスト（`text.format`）は、自由文を黙って返す代わりに
opencodex が明示的なエラーで拒否します。ローカル / カスタムの `ollama-native` エンドポイントは
Ollama ネイティブの `format` 動作を保持します。

## 4. ローカルプロバイダー

opencodex をローカルの OpenAI 互換サーバーに向けてください — 通常は空キーで使います:

| プロバイダー | ベース URL |
| --- | --- |
| Ollama (local) | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

## すべての OpenAI 互換エンドポイント

プロバイダーが Chat Completions を使うなら `openai-chat` アダプターが処理します — ダッシュボードで
**Custom** を選ぶか `ocx init` で `custom` を選んだ後ベース URL を入力してください。すべてのプロバイダーフィールド
(`headers`、`noReasoningModels`、`noVisionModels`、`models`、…)は
[設定リファレンス](/ja/reference/configuration/)を参照してください。
