---
title: サブエージェントサーフェス(v1 / base / v2)
description: すべてのモデルの Codex サブエージェント生成・管理方式をグローバルに制御します。
---

opencodex ではカタログの全モデルが使うマルチエージェントコラボサーフェスを選択できます。ダッシュボードとモデルページの **サブエージェント** トグルがこの値をグローバルに制御します。

:::note
v2 サーフェス(`multi_agent_v2`)のサブエージェントは**デフォルトで**親モデルを継承します。`fork_turns` のデフォルトが `all` で、全体履歴 fork がオーバーライドを拒否するためです。v2.7.2 から opencodex が継承を破る方法をガイドとして注入します。`fork_turns` を `"none"`(または `"3"` のような部分 fork)に指定した `spawn_agent` 呼び出しは `model` / `reasoning_effort` 引数を渡せ、公開されたツールスキーマにこの引数が見えなくても Codex ランタイムはパースして適用します。既知の制限:**ネイティブ**の親が**非ネイティブ**(ルーティング)プロバイダーの子をスポーンすると Codex クライアントが `NEW_TASK` ペイロードをバックエンド暗号化の `encrypted_content` でのみ送れず、子が空のタスク本文を受け取る可能性があります([#92](https://github.com/lidge-jun/opencodex/issues/92))。モデルオーバーライドは適用されますがタスクテキストが失われる可能性があるため、異種プロバイダー委任には v1 サーフェスが安定です。
:::

## モード

| モード | サーフェス | 動作 |
 --- | --- | --- |
| **v1** | `multi_agent_v1` | 名前空間方式のクラシックエージェントツールと `send_input` / `close_agent` / `resume_agent` を使います。`spawn_agent` モデルオーバーライドで別モデルのサブエージェントを起動できます。 |
| **base**(デフォルト) | 上流 pin | 上流モデル pin を復元します。gpt-5.6-sol と gpt-5.6-terra は v2、gpt-5.6-luna は v1 を使い、pin のないモデルは Codex `multi_agent_v2` 機能フラグに従います。実際のスポーン動作は各モデルに決定されたサーフェスに従います。 |
| **v2** | `multi_agent_v2` | フラット `spawn_agent` ツールと同時セッション、`send_message` / `followup_task` / `wait_agent` / `interrupt_agent` を使います。全体履歴 fork では子が親モデルを継承し、`fork_turns: "none"`(または部分 fork)では `model` / `reasoning_effort` オーバーライドが適用されます。ネイティブ→ルーティング子はタスク本文が暗号化状態で到着する可能性があります([#92](https://github.com/lidge-jun/opencodex/issues/92))。 |

## 動作方式

選んだモードは Codex が読む全カタログ項目の `multi_agent_version` フィールドを設定します。

- **v1 モード**: 全項目に `multi_agent_version = "v1"` を強制し上流 pin を上書きします。
- **base モード**: 上流デフォルトを復元します。pin があるモデルはスナップショット値を使い、pin のないモデルはフィールドを削除して Codex 機能フラグに決定させます。
- **v2 モード**: 全項目に `multi_agent_version = "v2"` を強制し上流 pin を上書きします。

このオーバーライドはライブ `/v1/models` カタログ応答とディスクカタログ同期の両方で最後のパスとして実行されます。したがって項目がどの経路で作られても新規セッションから同じモードが適用されます。

### 委任モデルと推論強度

ダッシュボードの **サブエージェント委任** セレクターは `injectionModel` とオプションの `injectionEffort` を保存します。この値は委任ガイドを作る設定であり、プロキシがスポーンリクエストを別モデルに再ルーティングする設定ではありません。`injectionPrompt` を指定すると内蔵ガイド文言全体を希望テキストに差し替えできます。

`multiAgentGuidanceText` はリクエストに入ってきたツール一覧でサーフェスを判定します。Codex Desktop の WebSocket 経路(`responses_lite`)のようにツールがリクエストの `tools` 配列ではなく `additional_tools` input 項目として届く場合も認識します。

**v2** リクエスト(base モードの Sol/Terra、v2 モードでは全モデル)では、有効な注入モデルが設定されているか実効サブエージェントロスターが空でないとき、700 字以内の簡潔なガイドを注入します。ガイドは `model` / `reasoning_effort` が現在のスキーマに表示されるかを断定せず条件付きで override を説明し、`fork_turns: "none"`(または部分 fork)ルール、有効な正規 slug の推奨モデル、Codex の picker-visible・v2 互換・priority 順の先頭 5 件に含まれる設定済みモデルと利用可能な effort ラダーだけを表示します。

**v1** リクエストでは最上位推論段階(max / ultra)で上流と同じ能動委任文言のみミラーリングします。モデル指定、ロスター、カスタムプロンプトは v1 に追加されません。

内蔵 v2 ガイドを差し替えるには `injectionPrompt`(config キーまたは `PUT /api/injection-model` の `prompt` 値)を設定してください。`{{model}}`、`{{effort}}`、`{{roster}}` プレースホルダが設定された注入モデル、推論強度、解釈されたロスターに置換されます。発火条件はそのままのため、カスタムプロンプトが本来沈黙すべきリクエストを発火させることはありません。

## モード変更

### GUI

- **ダッシュボード** → 最初のスタットセルで **v1**、**base**、**v2** を選択します。
- **モデル** ページ → 上部セグメントコントロールで選択します。
- 両ページとも **?** ボタンを押すとこのドキュメントに繋がるヘルプモーダルが開きます。
- **ダッシュボード** → **サブエージェント委任** で推奨モデルとオプションの推論強度を選びます。v2 では注入ガイドが `fork_turns: "none"` スポーンを指示しモデルオーバーライドを適用させます — ただしネイティブ→ルーティング子はタスク本文が暗号化状態で到着する可能性があります([#92](https://github.com/lidge-jun/opencodex/issues/92))。

### CLI

```bash
ocx v2 mode v1       # 全モデルを v1 に強制
ocx v2 mode default  # 上流 pin を復元
ocx v2 mode v2       # 全モデルを v2 に強制
ocx v2 status        # 現在のモード + Codex 機能フラグを確認
```

### API

```bash
# サーフェスモード、機能フラグ、スレッド制限を参照
curl http://localhost:10100/api/v2

# サーフェスモードを設定
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode": "v2"}'
```

`/api/v2` PUT エンドポイントは `enabled`(ブール、Codex 機能フラグ)と `maxConcurrentThreadsPerSession`(整数)も受け付けます。リクエストを検証してモードを保存した後カタログを再同期し、変更は新規セッションから適用されます。

委任セレクターは別エンドポイントを使います。

```bash
# 現在のモデル/推論強度と選択可能な値を参照
curl http://localhost:10100/api/injection-model

# 両方の値を設定
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": "anthropic/claude-sonnet-5", "effort": "xhigh"}'

# カスタムガイドプロンプトを設定({{model}}/{{effort}}/{{roster}} プレースホルダ)
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": "anthropic/claude-sonnet-5", "prompt": "{{model}}に委任して。{{roster}}"}'

# 両方の値を解除
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": null}'
```

`GET /api/injection-model` は `model`、`effort`、`prompt`、グローバル `efforts` 段階、有効化されたネイティブ・ルーティングモデルである `available` を返します。PUT で `effort` や `prompt` を省略すると既存値を維持し、`null` なら消去します。`model` を消去すると推論強度も常に一緒に消去されます。API はグローバル Codex 段階に合う推論強度か検証し、Codex はスポーン時に対象カタログ項目がその強度をサポートするか再検証します。

## 推論強度

サブエージェント推論強度は `injectionEffort` に保存され注入モデルがあるときのみ意味を持ちます。この値は注入 v2 ガイドに `reasoning_effort` 指示を追加し、親セッションの推論強度は変えません。オーバーライドが許可される fork では `spawn_agent` に渡された `reasoning_effort` を Codex がそのまま適用します。

`ultra` は Codex カタログで `max` より高い段階で自動委任の意味が加わりますが、プロバイダー wire に `ultra` という値がそのまま渡るわけではありません。Codex がクライアント境界で `ultra` を `max` に変え、opencodex がプロバイダーに合う有効な値に調整します。

| モデル | wire の `max` | `ultra` 選択時の wire 値 |
 --- | --- | --- |
| gpt-5.5、gpt-5.4、gpt-5.4-mini | xhigh | xhigh(max 変換後 `nativeEffortClamp`) |
| gpt-5.6-sol、gpt-5.6-terra | max | max |
| gpt-5.6-luna | max | 正確な上流段階には公開されない |
| ルーティングモデル | アダプターがマッピングまたはクランプ | max に変換後アダプターがマッピングまたはクランプ |

カタログにどの推論強度を公開するかは v1/v2 モードと無関係です。推論可能な生成項目には直接指定されたサブエージェント強度が検証を通過できるよう `max` が入り、現在生成されるルーティング項目には `ultra` も入ります。ただし正確な上流モデル段階はそのまま保存するため gpt-5.6-luna は `max` で終わります。

## コンテキスト上限

グローバルコンテキスト上限値のデフォルトは 350k です。上限をオンにしたルーティングプロバイダーの `context_window` のみ制限し、ネイティブ OpenAI モデルは実際のコンテキストウィンドウをそのまま使います。

モデルページで値や全体プロバイダー設定を変えるか、各プロバイダーグループヘッダーの隣で上限を個別にオン/オフできます。
