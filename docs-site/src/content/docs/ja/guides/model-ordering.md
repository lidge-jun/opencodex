---
title: モデルの並び順について
description: opencodex が Codex モデルピッカーと spawn_agent モデルオーバーライドの順序を決める方式。
---

Codex モデルピッカーは opencodex 設定に書かれたプロバイダー宣言順やモデル配列順を保存しません。
最終順序はカタログ priority で決まり、同じ priority を持つルーティングモデルには決定論的
アルファベット順ソートが適用されます。

## Codex が適用するルール

Codex の models-manager はピッカーに表示されるカタログ項目を `priority` 昇順でソートします。
カタログ配列順は捨てるため、生成された JSON 配列で項目を前に動かしてもピッカーでは前に移動しません。この制約は `src/codex/catalog.ts:881-884` に直接記録されています。

そのため opencodex は配列位置ではなくより低い priority を付与してフィーチャー位置を制御します。
関連 priority は次のとおりです。

| カタログ項目 | Priority | 根拠 |
 --- | ---: | --- |
| `subagentModels[i]` | `i`(`0` から `4`) | `src/codex/catalog.ts:885-896` の featured rank map |
| その他のルーティングモデル | `5` | `src/codex/catalog.ts:892-896` のルーティング項目生成 |
| デフォルトネイティブ GPT スラッグ | `9` | `src/codex/catalog.ts:887-890` のネイティブ項目生成 |
| featured リストがあるとき選択されていないネイティブモデル | 最小 `featured.length + 100` | `src/codex/catalog.ts:1348-1355` のネイティブカタログマージ |

管理 API は `src/server/management-api.ts:626-634` の `slice(0, 5)` で `subagentModels` を最大
5 つに制限します。これは最初の 5 モデルオーバーライドだけを広告する Codex `spawn_agent` サーフェスと合致します。
5 つ以降のモデルもメインピッカーに引き続き表示でき、正確な ID で呼び出し可能です。

## 同じ priority 内の順序

一般ルーティングモデルはすべて priority `5` なので同点ソートが必要です。カタログ項目を作る前に
`gatherRoutedModels()` がルーティングモデル一覧をプロバイダー名順、次にモデル ID 順でアルファベットソートします
(`src/codex/catalog.ts:1241-1270`)。

したがって次の設定の順序は最終ソートに影響しません。

- `providers` オブジェクトで key を宣言した順序
- 各プロバイダーの `models` 配列に ID を書いた順序

その後 `orderForSubagents()` が stable sort を使い、フィーチャー済みモデルを `subagentModels` に書いた順に
前に動かします。フィーチャー以外のモデルは前に決定されたプロバイダー/ID アルファベット相対順序を保ちます
(`src/codex/catalog.ts:1307-1321`)。項目生成時の featured rank も priority `0` から `4` に変換されるため
Codex の priority ソートでもこの先頭順序は保存されます。

## 公開可否と順序は別物

`selectedModels` と `disabledModels` はどのルーティングモデルを公開するか決めるだけで、ソートを制御しません。
`filterCatalogVisibleModels()` は 2 つの選択リストを `Set` ルックアップに変換し、配列をランクとして使わず
収集した一覧をフィルタします(`src/codex/catalog.ts:1216-1237`)。

したがって `selectedModels` や `disabledModels` の配列順序を変えてもピッカー位置は変わりません。
変わり得るのはモデルの包含可否だけです。

## 最終ピッカーパターン

featured リストが空でないときの最終順序は次のとおりです。

1. 設定された `subagentModels` 順どおりに、priority `0` から `4` を受けたモデル
2. 残りのすべてのルーティングモデル、プロバイダー順とモデル ID 順アルファベットソート、priority `5`
3. カタログマージ過程で featured ブロックの下に押し下げられた選択されていないネイティブモデル

`subagentModels` がない場合、ルーティングモデルは priority `5` を維持し、ネイティブ GPT 項目は通常 priority
(opencodex が作った項目は通常 `9`)を使います。ルーティンググループ内部は引き続きプロバイダー/ID
アルファベット順です。

## 例

`subagentModels` に次の 5 つの ID がこの順序で入っているとします。

```toml
subagentModels = [
  "gpt-5.5",
  "opencode-go/glm-5.2",
  "anthropic/claude-opus-4-6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]
```

ピッカーの先頭順序は次のとおりです。

| ピッカー位置 | モデル | Priority | この位置に表示される理由 |
 ---: | --- | ---: | --- |
| 1 | `gpt-5.5` | `0` | 最初の `subagentModels` 選択 |
| 2 | `opencode-go/glm-5.2` | `1` | プロバイダーが `anthropic` より後でも 2 番目の選択なのでこの位置に表示 |
| 3 | `anthropic/claude-opus-4-6` | `2` | 3 番目の選択 |
| 4 | `gpt-5.6-sol` | `3` | 4 番目の選択 |
| 5 | `gpt-5.6-terra` | `4` | 5 番目の選択 |
| 6 | `anthropic/claude-fable-5` | `5` | 残りのルーティングモデルのうちプロバイダー/ID アルファベット順の最初 |
| 7 以降 | 残りのルーティングモデル | `5` | プロバイダー アルファベット順、同じプロバイダー内ではモデル ID アルファベット順 |
| ルーティングモデルの後 | 残りのネイティブモデル | `featured.length + 100` 以上 | 選択されていないネイティブモデルは featured ブロックの下に移動 |

最初の 5 項目は `spawn_agent` に広告されるオーバーライドで、残りは通常のピッカー順序に続きます。

## 順序を変える方法

先頭モデルの順序をユーザーが変えられる唯一のサポート手段は `subagentModels` を並び替えることです。
ダッシュボードの **Sub-agents** ページまたは opencodex 設定で変更できます。一覧は最大 5 モデルを
受け付け、配列順序に意味があります。

現在 `OcxConfig` には一般 `modelOrder`、`providerOrder`、priority map 設定はありません。サポートされるソート
フィールドは `subagentModels` です(`src/types.ts:238-246`)。`disabledModels` と各プロバイダーの
`selectedModels` は公開フィールドです(`src/types.ts:276-282`、`src/types.ts:439-446`)。そのため残りの
ピッカー順序を変えるには設定変更ではなくコード動作の変更が必要です。
