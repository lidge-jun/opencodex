---
title: エージェント構成
description: マルチエージェント サーフェス、委任ガイダンス、優先モデル、フォールバック チェーン、ネイティブとデフォルトの同期、およびエフォート キャップ。
---

エージェント設定は、どの Codex コラボレーション サーフェスをアドバタイズするか、および opencodex が委任された作業をどのようにガイド、ルーティング、制限するかを制御します。

## エージェントフィールド

|フィールド |タイプ |デフォルト |意味 |
| --- | --- | --- | --- |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | `v1` はすべてのカタログ モデルを v1 としてスタンプします。 `v2` はすべてのモデルを v2 としてスタンプします。 `default` はアップストリーム ピン (Sol/Terra v2、Luna v1) を復元し、それ以外の場合はネイティブの `multi_agent_v2` フラグに従います。新しいセッションに適用されます。 |
| `subagentModels?` | `string[]` | `gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.4-mini` |最大 5 つの bare native id、account-qualified `<selector>/<native-openai-model>` id、または routed `provider/model` id をサブエージェント ピッカーで優先表示します。Subagents ページで選べるのは bare native id と routed id だけで、保存時には exact account-qualified の選択が除外されます。exact の選択には `ocx agent subagents set` を使用するか、設定を直接編集してください。明示的な空リストも保持されます。 |
| `injectionModel?` | `string` | — |プロキシ作成の v2 委任ガイダンスで使用される、優先されるネイティブまたはルーティングされたサブエージェント モデル。 |
| `injectionEffort?` | `string` | — |優先努力 (`low` ～ `ultra`)。`injectionModel` でのみ意味があります。 |
| `injectionPrompt?` | `string` | — | 組み込みの v2 ガイダンス本文を置き換えます。`{{model}}`、`{{effort}}`、`{{roster}}`、`{{fallback}}`をサポートします。`injectionModel` が設定されていればカスタムプロンプトが生成されます。 |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | opencodex が作成した v1/v2 開発者ガイダンスのみを制御します。ネイティブ エージェントのデフォルト、ツール、ルーティング、ロスター、またはエフォート キャップは変更されません。 |
| `syncCodexSubagentDefaults?` | `boolean` | `false` |同期/再起動中に、Codex のネイティブ デフォルトとして `injectionModel` およびオプションの `injectionEffort` を書き込むようにオプトインします。 `injectionModel`が必要です。 |
| `subagentModelFallback?` | `string[]` | `[]` |生成された子ターンの優先順位付きグローバル フォールバック モデル。 |
| `subagentModelFallbackByModel?` | `Record<string, string[]>` | `{}` | 要求されたプライマリ モデル id をキーとするモデル単位のフォールバックチェーン。ロール単位のフォールバックメタデータの推奨場所です。Codex の agent TOML に `model_fallback` を書くと Codex 0.146+ がロールをスキップします（#1190）。 |
| `subagentModelFallbackPollMs?` | `number` | `60000` |可用性プローブのキャッシュ間隔。 1000 ミリ秒未満の値はデフォルトに戻ります。 |
| `effortCap?` | `string` | — | v2 のメイン ターンとマークされた子ターンの条件を満たすためのハード シーリング。 `low` ～ `ultra` を受け入れます。 |
| `subagentEffortCap?` | `string` | — |スポーンされた子のターンのみの追加の上限。両方の上限が適用される場合は、低い方が優先されます。 |

ダッシュボードまたは `ocx v2 status|on|off|mode <v1|default|v2>|threads <n>` でサーフェスを管理します。モードの変更は新しいセッションに適用されます。 `maxConcurrentThreadsPerSession` は `PUT /api/v2` フィールドであり、`config.json` キーではありません。 `ocx v2 threads <n>` は、v2 が有効になった後、Codex の `$CODEX_HOME/config.toml` の `[features.multi_agent_v2]` の下に `max_concurrent_threads_per_session` を書き込みます。

管理 API は、`GET`/`PUT /api/v2`、`/api/injection-model`、`/api/effort-caps`、`/api/subagent-models`、および `/api/subagent-model-fallback` を公開します。インジェクションモデルの更新は部分的です。カスタム プロンプトは、その API の `prompt` フィールドです。

## ロスターとガイダンス

有効な v2 ロスターは、v2 と互換性があり、挿入されたカタログに存在する、構成され、ピッカーに表示され、優先順位で並べ替えられた最初の 5 つのモデルです。 V2 の適格性は、明示的な `"v2"`、`null`、または欠落しているアップストリーム ピンを適格なものとして扱います。実際の `"v1"` ピンは除外されます。除外されたエントリは設定に残るため、後で適格になる可能性があります。

表面検出はツール形状を使用します。 `send_input`、`resume_agent`、または `close_agent` を持つ名前空間付き `spawn_agent` は v1 です。 `send_message`、`followup_task`、`interrupt_agent`、または `list_agents` を備えたフラット `spawn_agent` は v2 です。

V1 ガイダンスは、`max` または `ultra` でのみプロアクティブ テキストです。 V2 は、優先モデル、適格なロスター、またはフォールバック チェーンが存在する場合にのみ、プロキシ作成の開発者メッセージを受信します。組み込みの v2 ガイダンスには 700 文字のバジェットがあり、必要に応じて最初にロスターが削除されます。ガイダンスはリプレイ プレフィックス全体で重複排除され、後続の `compaction_trigger` の前に挿入されます。

`injectionModel` および `injectionEffort` は、ネイティブデフォルト同期が有効になっていない限り、推奨事項です。組み込みの v2 テキストは、サポートされているモデル/エフォートのオーバーライドを `fork_turns: "none"` を使用して `spawn_agent` に渡すように Codex に要求します。カスタム `injectionPrompt` は、欠落している値を空の文字列に置き換えます。

## ネイティブ Codex のデフォルト同期

有効にすると、`syncCodexSubagentDefaults` はマーカー所有の `[agents] default_subagent_model` フィールドと `default_subagent_reasoning_effort` フィールドを書き込みます。既存のマークされていないユーザー所有のターゲット フィールドは競合として扱われ、引き続き権限を持ちます。部分的または曖昧な TOML 書き込みはフェールクローズされます。 `injectionModel` をクリアすると、オプトインもクリアされます。これらのデフォルトは、新しく作成された Codex タスクに影響し、それ自体によって委任が発生することはありません。

## フォールバックチェーン

生成された子のフォールバック順序は次のとおりです。

1. 要求されたプライマリ モデル。
2. `subagentModelFallbackByModel` によるモデル単位のチェーン（プライマリ モデルがキー）;それから
3. グローバル `subagentModelFallback` エントリ。

ロール単位のフォールバックチェーンは opencodex 構成に置く必要があります。`model_fallback` を
`$CODEX_HOME/agents/*.toml` に書くと、Codex 0.146+ が未知フィールドとしてロールファイル全体を
拒否し、ロールをスキップします（#1190）。TOML 内のレガシー `model_fallback` 行は後方互換性の
ために引き続き読み取られますが、`ocx doctor` がそれをフラグ付けします。

opencodex は、無効、ルーティング不能、異常、冷却期間、またはクォータしきい値の候補をスキップします。可用性スナップショットは `subagentModelFallbackPollMs` に対してキャッシュされます。暗号化された子タスクは、チェーンを正規のネイティブ ChatGPT ターゲットに制限できます。暗号化されたペイロードを読み取ることができる人がいない場合、読み取り不可能な暗号文が別の場所にルーティングされる代わりに、リクエストは失敗します。

```json
{
  "multiAgentMode": "v2",
  "subagentModels": ["gpt-5.5", "anthropic/claude-sonnet-5"],
  "injectionModel": "gpt-5.5",
  "injectionEffort": "high",
  "syncCodexSubagentDefaults": true,
  "subagentModelFallback": ["gpt-5.4-mini"],
  "subagentModelFallbackByModel": {
    "gpt-5.5": ["gpt-5.4-mini"]
  },
  "subagentModelFallbackPollMs": 60000,
  "subagentEffortCap": "high"
}
```

## 推論負荷上限

キャップは v2 コラボレーション機能にのみ適用されます。メイン ターンは、そのツールが v2 を公開するときに資格を持ちますが、子ターンは、リーフ ツールがコラボレーションを公開しなくなった場合でも、`x-codex-turn-metadata` に正確な codex-rs `x-openai-subagent: collab_spawn` または `"subagent_kind": "thread_spawn"` マーカーが含まれるときに資格を持ちます。 V1 メイン ターン、`multiAgentMode: "v1"`、圧縮、レビュー、およびメモリ統合ターンはバイパス キャップです。

キャップは労力を軽減するだけです。これらは、キャップまたはキャップの下で宣伝されている最も高い段にスナップします。モデルにエフォート制御がない場合、またはサポートされているラングフィットがない場合、opencodex はエフォートを削除し、プロバイダーのデフォルトを適用します。 `max` および `ultra` が受け入れられますが、ダッシュボードでは `low` から `xhigh` が提供されます。

v1、デフォルト、および v2 の動作に関する初心者向けの説明については、「[サブエージェントサーフェス](/guides/sub-agent-surface/)」を参照してください。
