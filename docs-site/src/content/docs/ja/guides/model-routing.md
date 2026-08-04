---
title: モデルルーティング
description: opencodex が与えられたモデル ID をどのプロバイダーが処理するか決定する方式。
---

Codex がモデルを要求すると `router.ts` がこれを正確に一つの設定されたプロバイダーに解釈します。ルールは
**順番に**検査され、最初に一致したものが適用されます。

OpenAI の bare `gpt-*` は単一の `openai` プロバイダーを選択します。`codexAccountMode` が
Pool(デフォルト、メイン + 追加アカウント)または Direct(現在の caller/メイン bearer)を決め、モデル ID はそのままです。
`openai-apikey/<model>` は API キートランスポートを明示的に選択し、2 つの認証情報経路はフォールバックしません。

## 優先順位

1. **明示的 `provider/model`** — ID に `/` が含まれ、その前部が設定されたプロバイダー名なら、
   該当プロバイダーが使われ、ID はスラッシュの後部に切り詰められます。

   ```text
   anthropic/claude-opus-5     →  provider "anthropic",   model "claude-opus-5"
   ollama-cloud/glm-5.2        →  provider "ollama-cloud", model "glm-5.2"
   openrouter/openai/gpt-5.6-sol → provider "openrouter",  model "openai/gpt-5.6-sol"
   ```

   これは明確な形式で、Codex のモデルピッカーがルーティングモデルに使う形式です。指定したプロバイダーが
   無効の場合はルーティングせずエラーになります。

2. **プロバイダーの `defaultModel`** — いずれかのプロバイダーの `defaultModel` が ID と一致すればそのプロバイダーが
   使われます(ID は変更なくそのまま渡されます)。

3. **組み込みプレフィックスパターン** — ID を既知のモデルファミリプレフィックスと照合し、該当名(または名前
   プレフィックス)の設定されたプロバイダーにルーティングします:

   | プレフィックス | プロバイダー |
   --- | --- |
   | `claude-`、`claude-sonnet-`、`claude-opus-`、`claude-haiku-` | `anthropic` |
   | `gpt-`、`o1-`、`o3-`、`o4-` | bare ID は設定された `openai` アカウントモード、API キーは `openai-apikey/` を明示 |
   | `llama-`、`mixtral-`、`gemma-` | `groq` |

   この検査は名前のみを見ます。`defaultModel` / `models[]` 検査と異なり、現在は名前が一致したプロバイダーの
   `disabled` 値が true でもスキップしません。

4. **プロバイダーの `models[]`** — プレフィックスルールに一致せず、有効なプロバイダーの `models[]` に ID が
   あればそのプロバイダーを使います。順序に注意してください。OpenAI 名のプロバイダーが設定されていると
   名前空間なしの
   `gpt-*` ID は他のプロバイダーの `models[]` より先に OpenAI 側に行きます。

5. **デフォルトプロバイダー** — いずれも一致しなければ ID は変更なく `config.defaultProvider` に送信されます。
   (デフォルトプロバイダーがない、または無効の場合はエラーになります。)

## API キーと環境変数

どの経路が選ばれても、プロバイダーの `apiKey` は `resolveEnvValue()` で解釈されます:
`${OPENAI_API_KEY}` または `$OPENAI_API_KEY` の値はリクエスト時に環境から展開されるため、秘密値を
`config.json` に置く必要はまったくありません。

## カタログ表示とコンテキスト制限

リクエストルーティングとカタログ公開は異なる設定です。

- `disabledModels` にプロバイダー名前空間付き ID を入れると Codex カタログと `/v1/models` から
  外れます。名前空間なしのネイティブ GPT スラッグはカタログに残りますが `visibility: "hide"` に切り替わります。
  この設定だけでは該当モデルの直接リクエストを
  ブロックしません。
- プロバイダーの `selectedModels` が空でなければカタログ許可リストとして動作します。ライブモデル探索と
  直接ルーティングはそのままに、カタログと `/v1/models` に公開するモデルだけ絞ります。
- `provider.disabled: true` のプロバイダーはカタログ探索から除外されます。明示的 `provider/model` リクエストは
  失敗し、`defaultModel` / `models[]` 検査でもスキップします。
- `providerContextCaps` はプロバイダーごとに Codex に表示するコンテキスト上限を指定します。
  `contextCapValue` はダッシュボードが併用する値でデフォルトは 350,000 です。ただしこの値だけを設定しても
  変化はなく、`providerContextCaps` にプロバイダーが含まれていて初めて適用されます。既知のコンテキスト
  サイズを下げるだけで、上げたり上流モデルの実際の上限を変えたりはしません。

```json
{
  "contextCapValue": 350000,
  "providerContextCaps": {
    "anthropic": 350000,
    "cursor": 350000
  }
}
```

## ヒント

- **ルーティングモデルは明示的に書いてください。** `provider/model`(ルール 1)を推奨 — 明確でカタログ
  同期後に Codex がピッカーに表示するものと一致します。
- プロバイダーに **`models[]` または `defaultModel` を事前入力しておくと**、短い ID(ルール 2/4)が `provider/`
  プレフィックスなしで解釈されます。
- **プレフィックスパターンは便利機能**であり保証ではありません: 該当名(例: `anthropic`、`openai`、`groq`)の
  プロバイダーが実際に設定されているときのみ解釈されます。

これらのルールが読むプロバイダーフィールドは[設定](/ja/reference/configuration/)を参照してください。
