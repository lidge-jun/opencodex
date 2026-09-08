---
title: エージェント構成
description: マルチエージェント サーフェス、委任ガイダンス、優先モデル、フォールバック チェーン、ネイティブとデフォルトの同期、およびエフォート キャップ。
---

エージェント設定は、どの Codex コラボレーション サーフェスをアドバタイズするか、および opencodex が委任された作業をどのようにガイド、ルーティング、制限するかを制御します。

## エージェントフィールド

|フィールド |タイプ |デフォルト |意味 |
| --- | --- | --- | --- |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | `v1` はすべてのカタログ モデルを v1 としてスタンプします。 `v2` はすべてのモデルを v2 としてスタンプします。 `default` はアップストリーム ピン (Sol/Terra v2、Luna v1) を復元し、それ以外の場合はネイティブの `multi_agent_v2` フラグに従います。新しいセッションに適用されます。 |
| `subagentModels?` | `string[]` | `gpt-6-astra`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5` |最大 5 つの bare native id、account-qualified `<selector>/<native-openai-model>` id、または routed `provider/model` id をサブエージェント ピッカーで優先表示します。Subagents ページで選べるのは bare native id と routed id だけで、保存時には exact account-qualified の選択が除外されます。exact の選択には `ocx agent subagents set` を使用するか、設定を直接編集してください。[Astra への一度限りの移行](/reference/configuration/agents/#astra-roster-upgrade)後は、明示的な空リストも保持されます。 |
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

## 常時プロアクティブ委任

Subagents → 詳細設定の **常時プロアクティブ委任**（旧 **Ultra mode**）は、推論のエフォートを変更せず、委任を開始する条件だけを変更します。推奨プリセットでも、ユーザーの指示、権限の境界、タスクの範囲、ツールの規則は維持されます。

`GET` と `PUT /api/v2` は、追加で `multiAgentModeHintRecommendation: { text, revision }` を返します。ダッシュボードはプリセットの有効化と復元にサーバー提供のテキストを使い、固定文へのフォールバックは行いません。旧サーバーが推奨値を返さない場合や値の形式が不正な場合、プリセットの適用と復元は利用できませんが、既存のカスタムヒントの編集と削除は引き続き利用できます。プリセットの復元はローカルの下書きだけを変更し、保存操作で確定します。

設定の読み取り、無関係な更新、アップグレードでは、保存済みのヒントは移行されません。ヒントを明示的に更新し、その本文が既知の旧 OpenCodex プリセット2種類のいずれかとバイト単位で完全一致する場合に限り、現在の推奨文に置き換わります。それ以外の有効なカスタムテキストは、空白だけが異なるものも含め、バイト単位で保持されます。既存の v2 有効化、機能サポート確認、ヒント削除の規則は変わらず、変更は新しい Codex セッションに適用されます。

## ロスターとガイダンス

有効な v2 ロスターは、設定済みでピッカーに表示され、優先順位で並べ替えられた最初の 5 つのモデルのうち、挿入されたカタログに存在し、明示的に `"disabled"` とされていないモデルです。明示的な `"v2"` ピンは再帰的なワーカーをサポートし、`"v1"`、`null`、ピンの省略はリーフワーカーとして引き続き適格です。除外されたエントリは設定に残るため、後で適格になる可能性があります。

表面検出はツール形状を使用します。 `send_input`、`resume_agent`、または `close_agent` を持つ名前空間付き `spawn_agent` は v1 です。 `send_message`、`followup_task`、`interrupt_agent`、または `list_agents` を備えたフラット `spawn_agent` は v2 です。

V1 ガイダンスは、`max` または `ultra` でのみプロアクティブ テキストです。 V2 は、優先モデル、適格なロスター、またはフォールバック チェーンが存在する場合にのみ、プロキシ作成の開発者メッセージを受信します。組み込みの v2 ガイダンスには 700 文字のバジェットがあり、必要に応じて最初にロスターが削除されます。ガイダンスはリプレイ プレフィックス全体で重複排除され、後続の `compaction_trigger` の前に挿入されます。

組み込みの v2 サブエージェントガイダンスとカスタム `injectionPrompt` 本文は、どちらも `<opencodex_subagent_guidance>` を使用し、Codex ネイティブの `<multi_agent_mode>` メッセージとは区別されます。組み込みテキストは、解決済みの優先モデル、ロスター、フォールバックチェーンを示しますが、委任、モデルのオーバーライド、`fork_turns` は指示しません。カスタム本文のプレースホルダー置換と内容は維持されます。`injectionModel` および `injectionEffort` は、ネイティブデフォルト同期が有効になっていない限り推奨事項であり、カスタムプレースホルダーの欠落値は引き続き空の文字列に置き換えられます。

リプレイの重複排除では、タグの種類ごとに最新のテキストとの完全一致を確認します。両方の値が新しいプロキシのタグを使用する場合、カスタムガイダンスから組み込み形式へ戻すと、その時点の内容が追加されます。途中でネイティブモードが変わっても、変更のないプロキシガイダンスは重複追加されません。既存のネイティブメッセージと旧タグ付きの履歴は保持されます。ラッパーの変更によって過去のメッセージの作成者が判明したり、以前の指示が取り消されたりするわけではありません。複数バージョンが混在する履歴は、旧タグだけでは分類できず、そのような履歴での設定変更の検出は保証されません。

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

opencodex は、無効、ルーティング不能、異常、冷却期間、またはクォータしきい値の候補をスキップします。可用性スナップショットは `subagentModelFallbackPollMs` に対してキャッシュされます。暗号化された子タスクでは、チェーンを正規のネイティブ ChatGPT ターゲットと、`allowEncryptedV2AgentTasks: true` で明示的に信頼された直接のキー認証 Responses ルートに制限します。暗号化されたペイロードを処理できる対象がない場合、読み取り不可能な暗号文を別の場所へ送らず、リクエストは失敗します。コンボはまず利用可能な正規ネイティブ対象を試し、選択できるネイティブ対象がなく `agentTaskRecovery` が有効な場合、暗号化された `NEW_TASK` をルーティングされたコンボ送信の前に一度だけ復旧します。

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
