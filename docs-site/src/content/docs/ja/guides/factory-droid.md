---
title: Factory Droid ブリッジ
description: ローカルの Responses 互換ブリッジを通じて、Factory Droid のモデルを opencodex に接続します。
---

Factory Droid はエージェント実行環境であり、公開仕様のある OpenAI 互換推論エンドポイントではありません。カスタムプロバイダーを Factory の内部 LLM URL に向けて `403 Forbidden` が返る場合、opencodex のアダプターだけを変えたりプロバイダーヘッダーを足したりしても、その非公開経路がサポート対象の公開 API になるわけではありません。

動作する連携は次のとおりです。

```text
Text-only Responses client
  -> opencodex (http://127.0.0.1:10100/v1/responses)
  -> local Responses bridge (http://127.0.0.1:11435/v1/responses)
  -> official droid exec command
  -> Factory account and selected model
```

これにより Factory の資格情報は公式 Droid クライアント内に保持されます。OpenCodex が受け取るのは別の、ローカル専用ブリッジトークンです。

## 失敗例とその理由

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| Factory LLM URL から `403 Forbidden` | その URL はサードパーティークライアント向けの汎用 OpenAI エンドポイントとして文書化されていない | 公式 Droid CLI または SDK 経由で Factory を呼び出す |
| `/models/models` で `404` | プロバイダーのベース URL が既に `/models` で終わっていた | API のルートを `baseUrl` に使い、検出用パスは含めない |
| モデル検索に失敗する | ブリッジが完全なライブカタログを公開していない | `liveModels: false` を設定し、静的な `models` 一覧を指定する |
| ループバックのプロバイダーが拒否される | プライベートネットワークへのアクセスが既定で拒否されている | ループバックブリッジに限って `allowPrivateNetwork: true` を設定する |
| `${DROID_BRIDGE_TOKEN}` が解決されない | opencodex サービスの環境変数に値がない | 対話シェルだけでなくサービスプロセスへ渡す |
| `OutputTextDelta without active item` | 出力アイテムとコンテンツパートを開始する前にブリッジがテキスト差分を送った | Responses SSE の全ライフサイクルを順番どおりに送る |

このため、同じ Factory 資格情報で `droid exec` は動作しても、文書化されていない LLM URL への直接リクエストは `403` を返すことがあります。両者は異なる製品を試しているため、矛盾ではありません。

## 前提条件

1. [Droid CLI](https://docs.factory.ai/droid-cli/quickstart) をインストールし、サインインします。
2. 範囲を限定したヘッドレスリクエストが動作することを確認します。

   ```bash
   droid exec --model glm-5.2 --output-format json "Reply with DROID_OK only."
   ```

3. `droid exec` または公式 Droid SDK を呼び出し、次を公開するローカルブリッジを実行します。

   - `GET /healthz`
   - `GET /v1/models`
   - `POST /v1/responses`

Factory は `droid exec` を非対話的な自動化の手段として文書化し、スクリプトでは JSON 出力を推奨しています。長期間運用する連携向けには、ストリーム JSON-RPC と公式 TypeScript・Python SDK も [Droid Exec ガイド](https://docs.factory.ai/droid-exec/overview)に記載されています。

## ブリッジの契約

ブリッジは `127.0.0.1` にバインドし、ランダムに生成した bearer トークンを要求し、リクエストサイズに上限を設け、モデル ID を許可リストで制限します。最小構成のブリッジが受け入れる Responses `input` は次の形式だけです。

- 空ではない文字列。または
- `message` アイテムだけを含む配列。各メッセージは `user`、`developer`、`system`、`assistant` のいずれかのロールを持ち、内容は文字列、またはテキスト専用のコンテンツパートでなければなりません（入力側ロールには `input_text`、assistant の履歴には `output_text`）。

Droid を呼び出す前にリクエスト全体を検証してください。入力パートが画像やファイルである場合、`tools` にツール定義が含まれる場合、または `input` にツール呼び出し・結果（`function_call`、`function_call_output`、`custom_tool_call`、`custom_tool_call_output`）が含まれる場合は、Responses 形式の `invalid_request_error` と HTTP `400` を返します。`unsupported_bridge_input` のような安定したブリッジ固有のコードを使い、メッセージで拒否したフィールドを示します。`stream: true` の場合も SSE を開始する前に行い、未対応の内容を捨てたり文字列化したり、プロンプトへ平坦化したりしないでください。

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "unsupported_bridge_input",
    "param": "tools",
    "message": "The minimal Droid bridge does not accept tool definitions."
  }
}
```

受け入れたリクエストについては、ブリッジが次を実行します。

1. 受け入れた Responses `input` をプロンプトに変換する。
2. `droid exec --model <id> --output-format json <prompt>` を呼び出す。
3. 最終的な `result` と `session_id` を解析する。
4. OpenAI Responses のエンベロープを返す。
5. 継続が必要な場合、`previous_response_id` を Droid のセッション ID に対応付ける。

ストリーミング応答では、次のライフサイクルを順に送信します。

```text
response.created
response.output_item.added
response.content_part.added
response.output_text.delta
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

ブリッジを `0.0.0.0` で公開したり、Factory の資格情報をブリッジの bearer トークンとして再利用したりしないでください。

## OpenCodex プロバイダー設定

明示的なプロバイダー ID `droid` でカスタムプロバイダーを作成します。

```bash
ocx provider add droid \
  --adapter openai-responses \
  --base-url http://127.0.0.1:11435/v1 \
  --default-model glm-5.2 \
  --allow-private-network
```

これにより `providers.droid` 設定項目が作られます。ダッシュボードで **Providers → droid → Edit
JSON** を開き、そのプロバイダーの値を次に置き換えます。

```json
{
  "adapter": "openai-responses",
  "baseUrl": "http://127.0.0.1:11435/v1",
  "responsesPath": "/responses",
  "allowPrivateNetwork": true,
  "authMode": "key",
  "apiKey": "${DROID_BRIDGE_TOKEN}",
  "liveModels": false,
  "models": ["glm-5.2", "glm-5.2-fast", "kimi-k3"],
  "defaultModel": "glm-5.2"
}
```

モデル ID は例です。サインイン中の Factory アカウントで `droid exec` が利用できるモデルだけを残してください。このプロバイダーに Factory 固有の推論ヘッダーを追加しないでください。上流は Factory の HTTP エンドポイントではなくローカルブリッジです。

プロバイダーを保存した後や静的カタログを変更した後は、Codex を同期して再起動し、新しいセッションに更新済みカタログを読ませます。

```bash
ocx sync --restart-codex
ocx doctor
```

`--restart-codex` は一致する app-server を再起動し、Codex デスクトップアプリを完全終了して再起動するため、進行中の会話が終わります。デスクトップアプリを起動したままにするには `--restart-app-server-only` を使います。再起動は、それらのセッションを終えるか保存した後にだけ実行してください。

## 経路全体を検証する

境界ごとに確認します。

```bash
curl -fsS http://127.0.0.1:11435/healthz
ocx doctor
ocx access test droid/glm-5.2 --protocol responses
```

プロバイダー行やモデルピッカーの項目が証明するのは、カタログに表示されることだけです。Responses の確認リクエストが `droid/<model>` 経路を通って戻って初めて連携が動作したと言えます。

## 現在の制限

上記の最小構成ブリッジが変換するのは、テキストと Responses SSE のライフサイクルです。双方向の Codex 関数・ツール呼び出しプロトコル全体は実装しません。Codex App と `codex exec` は、プロンプトでツールを呼ばないよう指示しても通常はツール定義を送ります。現行 Codex CLI に、その定義を除去する汎用フラグはありません。最小構成ブリッジは、上記の `400` 契約でそれらのリクエストを拒否する必要があります。ツール定義、ツール呼び出し、ツール結果、権限、キャンセル、豊富な Droid イベントに対応するには、Factory のストリーム JSON-RPC モードか公式 Droid SDK に基づく状態管理付きブリッジが必要です。`ocx access test` の成功はテキスト経路の検証であり、Codex エージェントやツール経路の検証ではありません。
