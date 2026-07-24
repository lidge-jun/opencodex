---
title: プロバイダー
description: opencodex が LLM プロバイダーを認証し通信するすべての方式 — OAuth、API キー、ChatGPT 転送、そしてローカル。
---

**プロバイダー**は一つの上流 LLM エンドポイントとそこへの到達方法を合わせたものです: アダプター、ベース URL、認証
モード、そしてオプションのモデル一覧で構成されます。プロバイダーは `~/.opencodex/config.json` の `providers` の下にあります。

## OpenAI アカウントモード

| プロバイダー ID | 用途 | 認証情報/アカウットルール |
 --- | --- | --- |
| `openai` | Codex ログイン | Pool(デフォルト)はメイン + 追加アカウントを選び、Direct は現在の caller/メインログインのみを使います。 |
| `openai-apikey` | OpenAI API | 設定された API キー/キープールのみを使い、Codex アカウントは読みません。 |

bare `gpt-5.6-sol` は Providers ページの Pool/Direct オプションに従い、
`openai-apikey/gpt-5.6-sol` は API を選択します。認証情報経路間のフォールバックはありません。API は context 1,050,000 /
max input 922,000 で `*-pro` virtual ID は公開状態を維持し、wire でベースモデルと
`reasoning.mode: "pro"` に切り替わります。

出荷版 v1 config は marker 2 の単一オプション行に自動移行されます。オリジナルは
`~/.opencodex/config.json.pre-openai-tiers-v2.bak` に一度保存され、次のコマンドで復元します:
`cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json`。

## 認証モード

プロバイダー設定で使える `authMode` は 3 種類で、デフォルトは `key` です。組み込みレジストリは
ローカルプリセットを別に分類します。ローカルプリセットでは通常 `authMode` と `apiKey` を両方使いません。

| `authMode` | 認証方式 | 用途 |
 --- | --- | --- |
| `key` | API キーを送信します(`Authorization: Bearer …`、またはアダプターにより `x-api-key` / `api-key`)。キーはリテラルまたは `${ENV_VAR}` 参照です。 | 大半のプロバイダー。 |
| `forward` | **受け取った Codex 認証ヘッダーを**プロバイダーにそのまま中継します — キーを保存しません。ChatGPT ログインのパススルーです。 | OpenAI(`openai-responses` アダプター)。 |
| `oauth` | 保存された OAuth アクセストークンを読み込み bearer キーとして使い、期限切れ前に自動更新します。 | xAI、Anthropic、Kimi、Kiro、Google Antigravity、Cursor。 |

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

OAuth ログインを使うプロバイダープリセットは 6 つです。認証情報は
`~/.opencodex/auth.json` に保存され、自動更新されます。ログイン CLI は `chatgpt` も受け付けます。
このコマンドは ChatGPT 認証情報を発行し `forward` モードのプロバイダーエントリを作成します。

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login kiro         # kiro-cli 認証情報の取り込み(トークンフォールバック対応)
ocx login google-antigravity
ocx login cursor       # Cursor 専用 PKCE ログイン
ocx login chatgpt      # 別途 ChatGPT OAuth ログイン
ocx logout <provider>
```

| プロバイダー | アダプター | ベース URL | 備考 |
 --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://api.x.ai/v1` | ライブ一覧を優先し、フォールバックのデフォルトモデルは `grok-4.5`。 |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude モデル; ライブモデル一覧は `/v1/models` から取得。 |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2.7/K2.6/K2.5 コーディングモデル。 |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | インストール済み `kiro-cli` ログインを優先取得。 |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | Google OAuth を Cloud Code Assist wire で使用。 |
| `cursor` | `cursor` | `https://api2.cursor.sh` | 実験的 PKCE ログイン、HTTP/2 トランスポート、アカウント別モデル探索をサポート。 |

[ウェブダッシュボード](/ja/guides/web-dashboard/)からも OAuth を開始できます。

### 複数の OAuth アカウント

認証情報に固定アカウント ID やメールがある OAuth プロバイダーはログインを複数保持できます。
Providers ページでアカウントを追加し、別アカウントをログアウトせずにアクティブアカウントだけを切り替えられます。
アカウント識別情報がない Kimi と Kiro はアクティブスロットを差し替え、`chatgpt` は Codex アカウントプールに別の保存場所が
あり常に単一スロットのみ書き込みます。トークンは `~/.opencodex/auth.json` に保存され、
`/api/oauth/accounts` はマスク済みメタデータのみを返します。

## 3. API キーカタログ

opencodex v2.7.1 には組み込みプリセットが 50 個含まれています。キー方式 40、OAuth 6、ローカル 3、
デフォルト ChatGPT 転送プリセット 1 です。ダッシュボードの **Add provider** ピッカーはキー発行ページを開き、
入力したキーを検証した後保存します。主な項目は以下のとおりです:

| プロバイダー | ベース URL |
 --- | --- |
| **OpenAI (API キー)** | `https://api.openai.com/v1` |
| **Anthropic (API キー)** | `https://api.anthropic.com` |
| **OpenRouter** | `https://openrouter.ai/api/v1` |
| **Ollama Cloud** | `https://ollama.com/v1` |
| Google Gemini · Google Vertex AI | `https://generativelanguage.googleapis.com` · `https://aiplatform.googleapis.com` |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai` |
| Umans AI · Neuralwatt | `https://api.code.umans.ai` · `https://api.neuralwatt.com/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| MiniMax · MiniMax (CN) | `https://api.minimax.io/v1` · `https://api.minimaxi.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Cerebras | `https://api.cerebras.ai/v1` |
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| Moonshot (Kimi API) · Kimi (coding) | `https://api.moonshot.ai/v1` · `https://api.kimi.com/coding/v1` |
| Hugging Face | `https://router.huggingface.co/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |
| Z.AI (GLM Coding) | `https://api.z.ai/api/coding/paas/v4` |
| Qwen Cloud | トークンプラン(デフォルト): `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` · 従量課金: `https://dashscope.aliyuncs.com/compatible-mode/v1` · またはカスタム |
| Tencent Cloud Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/v3` |
| SiliconFlow | `https://api.siliconflow.cn/v1` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitHub Copilot · GitLab Duo | `https://api.githubcopilot.com` · `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| …その他多数 | opencode zen、Vercel AI Gateway、Venice、NanoGPT、Synthetic、Qianfan、Alibaba、Parallel、ZenMux、LiteLLM |

大半は bearer キーと共に `openai-chat` アダプターを使い、Anthropic 互換エンドポイントのみを公開する一部
(例: **Xiaomi MiMo**)は `anthropic` アダプター(`x-api-key`)を使います。

> **Tencent Cloud Coding Plan の利用制限:** Tencent はこのサブスクリプションを対話型
> コーディングツール専用としています。一般的な API 自動化、カスタムアプリのバックエンド、
> 非対話型バッチ利用は禁止されており、プランキーが停止される場合があります。

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
 --- | --- | --- |
| Codex ログイン(Pool または Direct) | `gpt-5.6-*` | 372,000 |
| OpenAI (API キー) | `openai-apikey/gpt-5.6-*` と `*-pro` | 1,050,000 (max input 922,000) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`、`openrouter/openai/gpt-5.6-terra`、`openrouter/openai/gpt-5.6-luna` | 1,050,000 |
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

Cursor は別の実験的アダプターとして追跡します。`adapter: "cursor"` は `ocx init` とダッシュボード Add
Provider ピッカーに実験的 local config 項目として表示され、Cursor の静的フォールバックモデルカタログ
メタデータを保存します。Cursor アクセストークンを設定すると opencodex は Cursor ライブ HTTP/2 トランスポートを
使います。v2.7.1 フォールバックリストには 1M コンテキストの `gpt-5.6-sol` / `terra` / `luna` と 500K コンテキストの
`grok-4.5` / `grok-4.5-fast` が含まれ、ライブ探索結果に基づき現在のアカウントに表示するモデルを
決定します。Cursor サーバーが直接送るネイティブ read/write/delete/ls/grep/shell/fetch 実行は Codex
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

Ollama Cloud はホステッド型(ローカルではない)Ollama で、`https://ollama.com/v1` で OpenAI 互換、キーは
[ollama.com/settings/keys](https://ollama.com/settings/keys) で発行されます。opencodex はクラウド
ラインナップをビジョン機能で分類し、[ビジョンサイドカー](/ja/guides/sidecars/)がテキスト専用モデルにのみ
動作するようにします。テキスト専用モデル(例: `glm-5.2`、`deepseek-v4-pro`、`gpt-oss`、`qwen3-coder`、
`minimax-m2.x`、`nemotron-3-*`)は `noVisionModels` に列挙され、ビジョンネイティブモデル(例:
`kimi-k2.6`、`minimax-m3`、`gemma4`、`qwen3.5`、`gemini-3-flash-preview`)は含まれません。マッチングは
Ollama の `:size` タグに寛容なので `gpt-oss` は `gpt-oss:120b` と `gpt-oss:20b` の両方を含みます。

## 4. ローカルプロバイダー

opencodex をローカルの OpenAI 互換サーバーに向けてください — 通常は空キーで使います:

| プロバイダー | ベース URL |
 --- | --- |
| Ollama (local) | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

## すべての OpenAI 互換エンドポイント

プロバイダーが Chat Completions を使うなら `openai-chat` アダプターが処理します — ダッシュボードで
**Custom** を選ぶか `ocx init` で `custom` を選んだ後ベース URL を入力してください。すべてのプロバイダーフィールド
(`headers`、`noReasoningModels`、`noVisionModels`、`models`、…)は
[設定リファレンス](/ja/reference/configuration/)を参照してください。
