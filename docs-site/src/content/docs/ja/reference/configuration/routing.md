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

1. 設定済みの `policy/<id>` または routing-profile alias。policy evaluator を実行して選択した候補へ routing します。未解決の `policy/<id>` は後続のルールへフォールスルーします。
2. 設定済みの `<account-selector>/<native-openai-model>` namespace。対応する保存済み Codex アカウントだけに routing され、無効または利用不能な exact target は fail closed します。
3. 正規の `combo/<id>` または構成されたコンボ エイリアス。正規 ID は、エイリアスが一致する前に優先されます。
4. 構成されたプロバイダーを示すプレフィックスを持つ明示的な `<provider>/<model>` 名前空間。
5. `gpt-*`、`o1-*`、`o3-*`、`o4-*` などのベア ネイティブ OpenAI ファミリ ID。
   正規対応の `openai` プロバイダー。
6. プロバイダーの `defaultModel` と完全に一致します。
7. 既知のプロバイダー ファミリ モデル プレフィックス。
8. プロバイダーの構成された `models` リスト内の正確なモデル。
9. `defaultProvider`、要求されたモデル ID を保持します。

無効なプロバイダーは除外されます。無効なプロバイダーの明示的な名前空間は、フォールスルーではなく失敗します。プロバイダー エントリは、複数のプロバイダーに一致する可能性のあるルールの JSON 挿入順序でチェックされるため、ベア モデルがあいまいな可能性がある場合は明示的な名前空間を使用します。

## Codex アカウントの明示的な selector

`codexAccountNamespaces` は `side` のような公開 selector を保存済み Codex アカウント 1 つに
対応付けます。`side/gpt-5.6-sol` のような request は、canonical `openai` provider が Direct mode
の場合でもそのアカウントだけを使用し、上流には bare な `gpt-5.6-sol` model id を送信します。
selector の後には bare native OpenAI-family id だけを指定できます。

明示的な選択は Pool assignment strategy と通常の thread affinity を迂回します。対応する account が
存在しない、一時停止中、cooldown 中、利用不能、または再認証が必要な場合、request は別の account
へ切り替えず fail closed し、active Pool account も変更しません。適格な selector が 1 つ以上
設定されると、Codex catalog は bare native picker row を非表示にし、selector ごとに個別の
`<selector>/<native-openai-model>` row を表示します。bare native model id は明示的に無効化されない
限り通常の Pool / Direct routing を維持し、raw `/v1/models` にも残ります。対応する保存済み account
が存在しない selector は表示されません。selector の検証、衝突規則、privacy guidance は
[プロバイダーの構成](/reference/configuration/providers/)を参照してください。

Codex Auth ページではこの picker 動作を opt-in できます。無効化すると selector-qualified row は非表示に
なり通常の GPT row が戻りますが、mapping と exact `<selector>/<model>` routing は残るため、再有効化で
同じ公開 label が復元されます。mutation は bounded catalog refresh より先に保存され、`ocx sync` warning は
picker catalog の convergence だけが保留中で routing change は失われていないことを示します。

## コンボ (`config.combos`)

各コンボ キーは `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` に一致する ID です。これは常に `combo/<id>` として直接アドレス指定可能であり、1 つの `alias` を公開することもあります。エイリアスは一意である必要があり、`combo/` 名前空間を占有することはできず、通常は `gpt-*`、`o1-*`、`o3-*`、`o4-*`、または `codex-*` などの予約された bare native family を使用できません。明示的な `nativeAlias: true` Desktop 互換契約だけが例外です。

|キー |タイプ |デフォルト |意味 |
| --- | --- | --- | --- |
| `targets` | `{ provider: string; model: string; weight?: number }[]` |必須 |具体的なルートを指示しました。 `weight` は 1 ～ 10000 で、デフォルトは `1` です。 |
| `strategy?` | `"failover" \| "round-robin"` | `"failover"` |選択戦略。ターゲットの順序はフェイルオーバーの優先順位です。重みはスムーズな重み付きラウンドロビンを形成します。 |
| `stickyLimit?` | `number` | `1` |成功したリクエストは 1 つのラウンドロビン バッチに保持されます。範囲は 1 ～ 100。 |
| `defaultEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra" \| null` |設定を解除する |呼び出し元が努力を省略し、選択されたターゲットが要求されたラングをアドバタイズする場合にのみ適用されます。 |
| `alias?` | `string` | — |正規のピッカー スラグの代わりのオプションのパブリック モデル ID。 |
| `nativeAlias?` | `boolean` | `false` | 現在サポートされている bare native id に限り、その未修飾 id で優先します。アカウント修飾およびプロバイダー修飾の OpenAI ルートは別のままです。 |
| `displayName?` | `string` | — | catalog 表示専用ラベル。native alias では空でない値が必須です。 |

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

## ルーティングポリシープロファイル（`config.routingProfiles`）

明示的に要求された `policy/<id>`（または設定されたエイリアス）が、固定された候補許可リストの中から、ハードな能力要件と決定的で説明可能なスコアリングで選択します。既存のモデル ID が暗黙的にプロファイルを通ることはありません。`candidates`（明示的な許可リスト）、オプションの `alias`、`require`（`minContextWindow`、`minQuotaHeadroom`、`tools`、`imageInput`、`structuredOutput`、`localOnly`、`remoteAllowed`、`encryptedCodexTasks`、`reasoningEffort`、`serviceTier`）、`optimize`（latency/health/cost/quota の重み）、`limits.maxEstimatedCostUsd`、`unknownEvidence`（allow/penalize/exclude）をサポートします。未知はゼロや無料にはなりません。

CLI: `ocx route policy list`、`ocx route policy show <id>`、`ocx route policy dry-run <id> --model-context <tokens> --tools`、`ocx route policy evaluate <id>`。

コンボは明示的な順序・重み付きターゲットのルーティングとフェイルオーバーです。ポリシープロファイルは、候補間の証拠に基づく選択です。

## リクエスト履歴とルーティング分析

- `GET /api/request-history` - 派生インデックス（`routing-history.sqlite`）からのカーソルページング付き全履歴。フィルタ: `provider`、`model`、`requestedModel`、`status`、`conversationId`、`surface`、`inboundProtocol`、`apiKeyId`、`profileId`、`fallback`、`from`、`to`。
- `GET /api/request-history/:requestId/route-decision` - このルートが選ばれた理由（トレース、候補、除外、スコア、プロファイル+リビジョン、実行試行、結果）。
- `GET /api/routing-analytics` - 成功率・失敗率・フォールバック率、p50/p95/p99 の所要時間と TTFT、不完全ストリーム率、クールダウン失敗数、成功あたりの推定コスト、カバレッジ、信頼度、切り捨てフラグ。
- `GET /api/routing-profiles`、`POST /api/routing-profiles/dry-run` - プロファイル参照とドライラン評価（上流への送信なし）。

返される履歴とルート決定ペイロードは、マスク済みのリクエストメタデータのみを公開します（例: 不透明な `apiKeyId` ラベル）。資格情報、生のプロンプト本文、プロバイダのシークレットは含みません。

CLI: `ocx logs explain <request-id>`、`ocx logs rebuild-index`、`ocx logs index-status`。

## 移行

`routingProfiles` は任意の追加設定です。既存の設定ファイルと古い `usage.jsonl` 行はそのまま読み込めます。インデックスは使い捨てで、削除すると次回クエリ時に `usage.jsonl` から自動再構築されます。自動チューニングは行われません。
