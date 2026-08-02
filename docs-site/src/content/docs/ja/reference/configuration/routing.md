---
title: ルーティング構成
description: デフォルトのプロバイダーの選択、モデルの解決順序、コンボ エイリアス、ターゲットの順序、およびエフォートのデフォルト。
---

ルーティングは、クライアントから送信されたモデル ID を 1 つの具体的なプロバイダーと上流モデルに変換します。

## トップレベルのルーティングフィールド

|フィールド |タイプ |デフォルト |意味 |
| --- | --- | --- | --- |
| `defaultProvider` | `string` | `"openai"` |以前のモデルのルールが一致しない場合に使用される最終プロバイダー。有効な構成済みプロバイダーを指定する必要があります。 |
| `combos?` | `Record<string, OcxComboConfig>` | `{}` |注文されたプロバイダー/モデル ターゲットから構築された仮想 `combo/<id>` モデル。 |

## モデルの解決順序

opencodex は、要求されたモデルを次の順序で解決します。

1. 設定済みの `<account-selector>/<native-openai-model>` namespace。対応する保存済み Codex アカウントだけに routing され、無効または利用不能な exact target は fail closed します。
2. 正規の `combo/<id>` または構成されたコンボ エイリアス。正規 ID は、エイリアスが一致する前に優先されます。
3. 構成されたプロバイダーを示すプレフィックスを持つ明示的な `<provider>/<model>` 名前空間。
4. `gpt-*`、`o1-*`、`o3-*`、`o4-*` などのベア ネイティブ OpenAI ファミリ ID。
正規対応の `openai` プロバイダー。
5. プロバイダーの `defaultModel` と完全に一致します。
6. 既知のプロバイダー ファミリ モデル プレフィックス。
7. プロバイダーの構成された `models` リスト内の正確なモデル。
8. `defaultProvider`、要求されたモデル ID を保持します。

無効なプロバイダーは除外されます。無効なプロバイダーの明示的な名前空間は、フォールスルーではなく失敗します。プロバイダー エントリは、複数のプロバイダーに一致する可能性のあるルールの JSON 挿入順序でチェックされるため、ベア モデルがあいまいな可能性がある場合は明示的な名前空間を使用します。

## Codex アカウントの明示的な selector

`codexAccountNamespaces` は `side` のような公開 selector を保存済み Codex アカウント 1 つに
対応付けます。`side/gpt-5.6-sol` のような request は、canonical `openai` provider が Direct mode
の場合でもそのアカウントだけを使用し、上流には bare な `gpt-5.6-sol` model id を送信します。
selector の後には bare native OpenAI-family id だけを指定できます。

明示的な選択は Pool assignment strategy と通常の thread affinity を迂回します。対応する account が
存在しない、一時停止中、cooldown 中、利用不能、または再認証が必要な場合、request は別の account
へ切り替えず fail closed し、active Pool account も変更しません。bare native model id は通常の
Pool / Direct routing を維持します。namespace map 自体は model picker row を作成しません。
selector の検証、衝突規則、privacy guidance は
[プロバイダーの構成](/reference/configuration/providers/)を参照してください。

## コンボ (`config.combos`)

各コンボ キーは `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` に一致する ID です。これは常に `combo/<id>` として直接アドレス指定可能であり、1 つの `alias` を公開することもあります。エイリアスは一意である必要があり、`combo/` 名前空間を占有することはできず、`gpt-*`、`o1-*`、`o3-*`、`o4-*`、または `codex-*` などの予約されたベア ネイティブ ファミリを使用することはできません。

|キー |タイプ |デフォルト |意味 |
| --- | --- | --- | --- |
| `targets` | `{ provider: string; model: string; weight?: number }[]` |必須 |具体的なルートを指示しました。 `weight` は 1 ～ 10000 で、デフォルトは `1` です。 |
| `strategy?` | `"failover" \| "round-robin"` | `"failover"` |選択戦略。ターゲットの順序はフェイルオーバーの優先順位です。重みはスムーズな重み付きラウンドロビンを形成します。 |
| `stickyLimit?` | `number` | `1` |成功したリクエストは 1 つのラウンドロビン バッチに保持されます。範囲は 1 ～ 100。 |
| `defaultEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra" \| null` |設定を解除する |呼び出し元が努力を省略し、選択されたターゲットが要求されたラングをアドバタイズする場合にのみ適用されます。 |
| `alias?` | `string` | — |正規のピッカー スラグの代わりのオプションのパブリック モデル ID。 |

```json
{
  "defaultProvider": "openai",
  "combos": {
    "coding": {
      "targets": [
        { "provider": "anthropic", "model": "claude-sonnet-5" },
        { "provider": "openrouter", "model": "qwen/qwen3-coder-plus" }
      ],
      "strategy": "failover",
      "defaultEffort": "high",
      "alias": "coding-primary"
    }
  }
}
```

戦略の動作、再試行可能な失敗、クールダウン、暗号化された v2 タスクの制限、および管理コマンドについては、[コンボ](/guides/combos/) を参照してください。

### カタログの適格性

コンボは、リストに表示できない場合でも、直接ルーティング可能です。 `ocx sync`、`/v1/models`、および Codex ピッカーは、すべてのターゲットが交差できる機能を公開している場合にのみリストします。

- ライブメタデータ、レジストリヒント、またはプロバイダーからの正の `contextWindow`
`modelContextWindows` / `contextWindow`;そして
- 空ではない `inputModalities` 交差。省略されたメンバー値を `["text"]` として扱います。

コンテキスト メタデータのない裸のリレー ID、または接続されていないモダリティを持つターゲットは、カタログからコンボを削除します。同期によって概要の警告が表示され、ダッシュボードで **注意が必要** とマークされます。コンテキスト メタデータを追加し、モダリティを調整したり、検出可能な互換性のある機能を備えたターゲット モデルを追加したりできます。
