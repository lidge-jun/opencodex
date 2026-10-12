---
title: ルーティングプロファイルエディター
description: OpenCodex ダッシュボードでルーティングポリシーのプロファイルを作成、編集、検証、試行、削除します。
---

OpenCodex ダッシュボードの **Models → Routing** タブでは、`config.json` を手動編集せずに `config.routingProfiles` を管理できます。

## プロファイルを作成する

1. ダッシュボードで **Routing** を開きます。
2. **Create profile** を選びます。
3. `id` を入力します。正規のモデル ID は `policy/<id>` です。
4. 明示的なプロバイダー/モデル候補を 1 件以上追加します。
5. 任意の要件、スコアの重み、コスト上限（`maxEstimatedCostUsd`、任意の `onUnknownCost`）、不明な証拠の扱いを設定します。
6. プロファイルを保存します。

作成後にプロファイル ID は変更できません。別の ID を使う場合は、新しいプロファイルを作成し、呼び出し元を更新した後で古いものを削除してください。

## 検証と保存

ダッシュボードは `config.routingProfiles` と同じプロファイルオブジェクトを管理 API に送ります。サーバーは書き込む前に候補全体を検証します。

- ID とエイリアスは、ルーティングプロファイルの命名規則と衝突規則に従う必要があります。
- 候補の各プロバイダーは存在し、有効である必要があります。
- 重複した候補は拒否されます。
- 数値上限と要件は対応範囲内でなければなりません。
- 最適化の重みの少なくとも 1 つは正でなければなりません。

保存に成功すると、通常の設定書き込み処理でプロファイルが永続化され、実行中の状態とモデルカタログが更新されます。検証に失敗すると以前の設定は変わらず、エディターにエラーが表示されます。

`limits.maxEstimatedCostUsd` を設定すると、`limits.onUnknownCost` のデフォルトは `"allow"` です。コスト見積もりが不明なだけでは上限による除外は行われず、試行と実際のルート判断のトレースに `cost.capOutcome: "unknown-allowed"` が記録されるため、上限が確認されていないことが分かります。上限に対して安全側で拒否する必要がある場合は `"exclude"` を設定します（`cost-limit-unknown`、`cost.capOutcome: "unknown-excluded"`）。`onUnknownCost` だけを設定しても効果はなく、上限の結果も出力されません。これは `unknownEvidence.cost` とは別で、後者は不明な価格を独立して除外または減点できます。

## 保存済みプロファイルを試行する

候補の機能は、レジストリの上書きを適用した後の実効プロバイダー設定を使います。そのため、ローカル性の要件（`localOnly` と `remoteAllowed`）には実効アップストリームアドレスが使われます。アドレスを分類できない場合は、プロファイルの `unknownEvidence.capability` 設定が適格性を決めます。解決できない無効なプロバイダー設定は、不明な機能を許容する場合でも、常に `route-unavailable` で除外されます。存在しない、または無効なプロバイダーも、スコア計算前に `route-unavailable` で除外されます。

保存済みプロファイルを選び、**Dry-run evaluation** でコンテキストウィンドウのサイズ、ツール使用、画像入力、構造化出力などのリクエスト情報を追加します。試行では適格性とスコアを評価しますが、アップストリームモデルへのリクエストは送信しません。

未保存の編集は試行に使われません。表示されるリビジョンと評価が同じ設定を参照するよう、先に保存してください。

## 管理 API

エディターは次のエンドポイントを使います。

- `GET /api/routing-profiles` は正規化されたプロファイルとリビジョンを一覧表示します。
- `PUT /api/routing-profiles` はプロファイルを作成または更新します。`mode: "create"` または `mode: "update"` を送ります。作成モードでは既存 ID の上書きを拒否します。
- `DELETE /api/routing-profiles?id=<id>` はプロファイルを 1 件削除します。
- `POST /api/routing-profiles/dry-run` はアップストリームに送信せず、保存済みプロファイルを評価します。

保存ペイロードの例:

```json
{
  "id": "fast",
  "mode": "create",
  "profile": {
    "alias": "ocx/fast",
    "candidates": [
      { "provider": "anthropic", "model": "claude-sonnet-5" },
      { "provider": "openai", "model": "gpt-5.6" }
    ],
    "require": { "tools": true, "minContextWindow": 128000 },
    "optimize": { "latency": 0.55, "health": 0.25, "cost": 0.1, "quota": 0.1 },
    "limits": { "maxEstimatedCostUsd": 0.5, "onUnknownCost": "allow" },
    "unknownEvidence": {
      "capability": "exclude",
      "health": "penalize",
      "quota": "penalize",
      "cost": "penalize"
    }
  }
}
```
