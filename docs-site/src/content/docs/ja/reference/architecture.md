---
title: アーキテクチャ
description: opencodex の内部構造 — モジュールマップ、AdapterEvent ブリッジ、リクエストパーサー、そしてキャッシュ。
---

opencodex は単一の Bun プロセスです。リクエストは OpenAI Responses として入り、内部モデルに正規化され、ルーティングされたのち、アダプターを経由してプロバイダーに送信され、再び Responses SSE にブリッジされます。エンドツーエンドのフローは [動作の仕組み](/opencodex/ja/getting-started/how-it-works/) を参照してください。

## モジュールマップ

```
src/
├── cli/                # ocx command dispatch, init, status, provider commands
├── server/             # Bun.serve, /v1/* proxy, /api/* management API, WS bridge
├── codex/              # Codex config injection, catalog sync, auth/account integration
├── providers/          # provider metadata, API-key pool, quota and labels
├── adapters/           # 7つの wire adapter, 共通 guard/util, Cursor protobuf transport
├── oauth/              # OAuth providers, API-key catalog, token store/refresh
├── usage/              # usage extraction, JSONL logs, summaries, totals
├── lib/                # runtime, process, retry, privacy, token estimate helpers
├── web-search/         # web-search sidecar (synthetic tool, loop, executor, parser)
├── vision/             # vision sidecar (describe + plan)
├── config.ts           # ~/.opencodex/config.json, defaults, PID, env resolution
├── router.ts           # model id → provider + adapter
├── bridge.ts           # AdapterEvent stream → Responses SSE / JSON
├── reasoning-effort.ts # reasoning-effort translation, clamping, and catalog levels
├── responses/
│   ├── parser.ts       # Responses request → OcxParsedRequest
│   ├── schema.ts       # Zod validation
│   └── compaction.ts   # remote compaction prompts, envelopes, compact history
├── service.ts          # launchd / systemd / Task Scheduler background service
├── types.ts            # core interfaces + helpers (modelInList, namespacedToolName)
└── index.ts            # public entry
```

以前の大規模なエントリーファイル 3 つは、現在は互換性 facade です。`codex/catalog.ts` は
7 個の `codex/catalog/*.ts` モジュールを、`server/management-api.ts` は 9 個の
`server/management/*.ts` モジュールを、`server/responses.ts` は 5 個の
`server/responses/*.ts` モジュールを接続します。

## リクエスト処理フロー

HTTP の境界は `server/index.ts` が担い、Responses データプレーンは `server/responses.ts` facade と
`server/responses/*.ts` モジュールに渡します。

1. `server/index.ts` で CORS と API 認証を確認し、終了待ち状態なら新規リクエストを拒否したのち、リクエストのライフサイクルを記録します。ここで `GET /v1/models`、`POST /v1/responses`、
   `POST /v1/responses/compact`、`POST /v1/images/generations` / `POST /v1/images/edits`
   （Codex 組み込み `image_gen` ツール用 — `server/images.ts` が OpenAI 系の上流に中継）、
   `POST /v1/live` / `POST /v1/realtime/calls`（ChatGPT / Codex App 音声と OpenAI Realtime
   の call-create、`server/live.ts` が中継）と `/v1/live/{callId}` サイドバンド WebSocket、
   `/v1/responses` のオプション WebSocket アップグレードを提供します。
2. `server/responses/core.ts` が展開し JSON を読みます。覚えておいた `previous_response_id` 入力があれば展開したのち `responses/parser.ts` に渡します。
3. `router.ts` が通常のモデル id または `provider/model` id を解決します。続いて Codex アカウント affinity を決定し、必要ならプロバイダー OAuth を更新して選択された認証情報を route に適用します。
4. 本リクエストの前に `vision/` が `noVisionModels` モデル用の画像説明を作ります。安全なサイドカー経路がないときはテキスト専用の上流に画像を送らず取り除きます。
5. `server/adapter-resolve.ts` がモデル別の wire override を適用し、7つのアダプターのいずれかを作ります。
   Responses passthrough は元の body を中継し、Cursor は双方向 `runTurn` transport を使い、
   残りの変換型アダプターは上流リクエストを build/fetch/parse します。
6. ルーティングモデルがホステッド `web_search` を要求すると `web-search/` が合成関数を公開します。実際の検索は ChatGPT サイドカーで実行し、結果をルーティングモデルに戻し、設定された回数の中で繰り返します。
7. `bridge.ts` が Responses SSE または JSON を作ります。`server/request-log.ts` と `usage/` はレスポンスに触れずに終了ステータス、レイテンシー、プロバイダー/モデル、最善推定トークン使用量を記録します。

## パーサー

`responses/parser.ts` は入ってくるリクエストを `responses/schema.ts`（Zod）で検証したのち
`OcxParsedRequest` を構成します:

- **Messages** — `input` 項目は正規化された `OcxMessage[]` になります: user / developer / assistant /
  toolResult。`reasoning` 項目は thinking ブロックになり、`function_call`、`custom_tool_call`、
  `tool_search_call` 項目はツール呼び出しになり、それに対応する `*_output` はツール結果になります。
- **Tools** — function ツールはそのまま通過します。**名前空間付き (MCP) ツールは平坦化され**、
  `namespace__name` になります（返却時に復元）。**freeform** ツール（例: `apply_patch`）と
  **tool_search** ディスカバリーツールにはフラグが立ちます。**ホステッドツール**（`web_search`、image gen、…）は削除され、それを処理するサイドカーがある場合だけ再注入されます。
- **Images** — 実際の content part（data URL またはリモート https）として保存され、テキストにインライン化されることはありません。
- **Feature flags** — `_webSearch`（ホステッドウェブ検索要求）、`_structuredOutput`（`text.format` が json_schema / json_object）、`_compactionRequest`（remote compaction v2）。

## ブリッジ

`bridge.ts` はアダプターの内部 `AdapterEvent` ストリームを Codex が理解する Responses SSE に再変換します:

| AdapterEvent | Responses SSE emitted |
| --- | --- |
| `text_delta` | `response.output_text.delta` → `…done`、`response.content_part.done`、`response.output_item.done` |
| `thinking_delta` | `response.reasoning_summary_text.delta` → `…done`、item close |
| `reasoning_raw_delta` | raw `reasoning_text` 項目または隠しラウンドトリップ envelope |
| `thinking_signature` / `redacted_thinking` | `encrypted_content` reasoning envelope に保存 |
| `tool_call_start` | `response.output_item.added`（type: `function_call` / `custom_tool_call` / `tool_search_call`） |
| `tool_call_delta` | `response.function_call_arguments.delta`（freeform / tool_search はスキップ） |
| `tool_call_end` | `response.function_call_arguments.done` → `response.output_item.done` |
| `web_search_call_begin` / `web_search_call_end` | リアルタイム `web_search_call` 項目 1 つと URL citation |
| `heartbeat` | 上流の活動表示。ユーザーに見える出力項目はなし |
| `done` | `response.completed`（usage 付き） |
| `error` | `response.failed`（`last_error` 付き） |

ブリッジは **ハートビートキープアライブ**（RC3）も実行します。上流からデータが来ないとき 2 秒ごとにパーサーが無視する `response.heartbeat` SSE イベントを送り、Codex のアイドルタイマーを再開します。デフォルトの **stall deadline** は 300 秒（`stallTimeoutSec`）です。この時間を超えると上流を中断し、理由が `upstream_stall_timeout` の `response.incomplete` を送り、接続が延々とぶら下がらないようにします。

ツール呼び出しはパーサーが取得した名前空間マップ、freeform 集合、tool-search 集合を使って 3 種類の Responses 項目タイプに振り分けます — そのため MCP 名前空間、`apply_patch` スタイルの freeform ツール、クライアントが実行する `tool_search` がすべてラウンドトリップします。`buildResponseJSON()` 変種は同じイベントから単一の非ストリーミングレスポンスオブジェクトを生成します。

## 伝送と compaction

`server/index.ts` はデフォルトで `/v1/responses` を HTTP/SSE で提供します。`websockets` が `false` の状態で Codex が Responses WebSocket アップグレードを試みると、opencodex は `426 upgrade_required` を返し、Codex はそのセッションで HTTP にフォールバックします。`"websockets": true` を設定すると同じエンドポイントがアップグレードを受け入れ WebSocket ブリッジを使います。

Codex コンテキスト compaction はルーティングされたモデルでも動作します。`server/responses/compact.ts` は
`POST /v1/responses/compact` を内部ルーティング要約ターンとして扱い、圧縮されたヒストリーを返します。
`responses/parser.ts` と `bridge.ts` は remote compaction v2 の `compaction_trigger` ターンを扱い、合成 `compaction` 出力項目を正確に 1 つ送ります。

## キャッシュとカタログ

- `codex/model-cache.ts` はリアルタイム `/models` 結果をプロバイダー別にメモリで TTL キャッシュし（デフォルト 5 分、Codex 自身のキャッシュと一致）、fetch が失敗すると stale-fallback を提供します。
- `codex/catalog.ts` facade が公開する `codex/catalog/sync.ts` は、ルーティングされたモデルを名前空間項目として Codex のカタログにマージし、おすすめの [サブエージェントモデル](/opencodex/ja/guides/codex-integration/#the-subagent-picker) を先にランク付けし、`disabledModels` をフィルタし、一回限りのバックアップから元のカタログを完全に復元できます。

## Reasoning effort

`reasoning-effort.ts` は Codex の reasoning ラベルを各プロバイダーの wire 値に変換します。
Codex カタログは Codex が受け入れるラベル（`low` / `medium` / `high` / `xhigh` / `max`）を公表しますが、上流プロバイダーはより小さなサブセットしかサポートしなかったり、実際の alias が必要だったりします。このモジュールは:

- 標準 `CODEX_REASONING_LEVELS` とその整列順序を定義します。
- 要求された effort を正確なレベルがないとき最も近いサポート段階にクランプします。
- カスタム wire マッピングのためのモデル別・プロバイダー別 `reasoningEffortMap` override を解釈します。
- `noReasoningModels` に列挙されたモデルについては effort を完全に削除します。

## コア型

内部モデルは `types.ts` にあります: `OcxParsedRequest`、`OcxContext`、`OcxMessage` ユニオン、
`OcxContentPart`（text / image）、`OcxToolCall`、`OcxTool`、`AdapterEvent`、そして設定型
（`OcxConfig`、`OcxProviderConfig`）。2 つのヘルパーが広く使われます: `namespacedToolName()` と
`modelInList()`（`noVisionModels` / `noReasoningModels` に対する寛容な `:size` タグマッチング）。
