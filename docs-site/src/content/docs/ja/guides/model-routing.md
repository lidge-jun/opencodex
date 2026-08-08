---
title: モデルルーティング
description: opencodex が与えられたモデル ID をどのプロバイダーが処理するか決定する方式。
---

Codex がモデルを要求すると `router.ts` がこれを正確に一つの設定されたプロバイダーに解釈します。ルールは
**順番に**検査され、最初に一致したものが適用されます。

OpenAI では、設定済みの `<selector>/gpt-*` ID は、combo や provider の namespace より先に
`codexAccountNamespaces` を通じて 1 つの保存済み Codex アカウントに対応付けられます。bare
`gpt-*` ID は代わりに canonical `openai` provider を選択します。その `codexAccountMode` が
Pool（デフォルト、メイン + 追加アカウント）または Direct（現在の caller/メイン bearer）を決め、
model ID は変更しません。`openai-apikey/<model>` は API key transport を明示的に選択します。
これらの credential route は相互にフォールバックしません。

## 優先順位

1. **Codex account の exact selector** — ID が `<selector>/<native-openai-model>` で、その
   selector が `codexAccountNamespaces` に設定されている場合、request は対応する保存済み account
   だけを使用し、bare native model を upstream に送ります。exact target が利用不能なら、Pool、
   Direct、provider routing の次の規則へ進まず fail closed します。

   ```text
   side/gpt-5.6-sol → provider "openai", model "gpt-5.6-sol", account selector "side"
   ```

2. **Combo ID または alias** — 1 つ以上の combo が設定されている間は、canonical `combo/<id>`
   または設定済み combo alias が provider namespace より先に concrete target を選択します。
   combo が 1 つも設定されていない場合、文字どおり `combo` という名前の legacy physical provider
   は通常の provider namespace として残ります。target selection と failover の動作は
   [Combos](/ja/guides/combos/)を参照してください。

3. **明示的 `provider/model`** — ID に `/` が含まれ、その前部が設定されたプロバイダー名なら、
   該当プロバイダーが使われ、ID はスラッシュの後部に切り詰められます。

   ```text
   anthropic/claude-opus-5     →  provider "anthropic",   model "claude-opus-5"
   ollama-cloud/glm-5.2        →  provider "ollama-cloud", model "glm-5.2"
   openrouter/openai/gpt-5.6-sol → provider "openrouter",  model "openai/gpt-5.6-sol"
   ```

   これは routed provider を明示する形式で、Codex のモデルピッカーがルーティングモデルに使う
   形式です。同じ public ID が設定済み combo alias でもある場合はルール 2 が優先されます。指定した
   provider が無効の場合はルーティングせずエラーになります。

4. **Bare native OpenAI-family ID** — `gpt-*`、`o1-*`、`o3-*`、`o4-*` などの ID は、canonical
   かつ有効な `openai` provider と、その Pool または Direct account mode を使用します。

5. **プロバイダーの `defaultModel`** — いずれかのプロバイダーの `defaultModel` が ID と一致すればそのプロバイダーが
   使われます(ID は変更なくそのまま渡されます)。

6. **組み込みプレフィックスパターン** — ID を既知のモデルファミリプレフィックスと照合し、該当名(または名前
   プレフィックス)の設定されたプロバイダーにルーティングします:

   | プレフィックス | プロバイダー |
   --- | --- |
   | `claude-`、`claude-sonnet-`、`claude-opus-`、`claude-haiku-` | `anthropic` |
   | `llama-`、`mixtral-`、`gemma-` | `groq` |

   この検査は名前のみを見ます。`defaultModel` / `models[]` 検査と異なり、現在は名前が一致したプロバイダーの
   `disabled` 値が true でもスキップしません。

7. **プロバイダーの `models[]`** — プレフィックスルールに一致せず、有効なプロバイダーの `models[]` に ID が
   あればそのプロバイダーを使います。ルール 4 により、bare `gpt-*` ID は別の provider の
   `models[]` が一致する前に canonical かつ有効な `openai` provider に送られます。

8. **デフォルトプロバイダー** — いずれも一致しなければ ID は変更なく `config.defaultProvider` に送信されます。
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
  変化はなく、`providerContextCaps` にプロバイダーが含まれていて初めて適用されます。ダッシュボードの値を
  変更すると、「すべてのルーティング対象プロバイダーに適用」がオンになっている場合にのみ、有効なすべての
  プロバイダーに再適用されます。それ以外の場合、各プロバイダーは独自の上限を維持します。既知のコンテキスト
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

- **Codex account を明示的に指定するには** `<selector>/<native-openai-model>`（ルール 1）を
  使用します。この route は exact かつ fail closed であり、別の account に暗黙に切り替わりません。
- **ルーティングモデルは明示的に書いてください。** exact public ID が combo alias でない場合は
  `provider/model`(ルール 3)を推奨します。provider を直接指定し、catalog 同期後に Codex が
  picker に表示するものと一致します。
- プロバイダーに **`models[]` または `defaultModel` を事前入力しておくと**、短い ID(ルール 5/7)が `provider/`
  プレフィックスなしで解釈されます。
- **プレフィックスパターンは便利機能**であり保証ではありません: 該当名(例: `anthropic`、`groq`)の
  プロバイダーが実際に設定されているときのみ解釈されます。

これらのルールが読むプロバイダーフィールドは[設定](/ja/reference/configuration/)を参照してください。
